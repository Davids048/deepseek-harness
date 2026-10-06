/**
 * History: undo, redo and jumps as records on a working branch, the effective chain that those records define, and the
 * history list.
 *
 * Effective chain. The raw chain of a record is its `parents[0]` ancestry. The effective chain differs at `proj.undo`
 * and `proj.redo` records: such a record U with `params.to = X` continues the effective chain of X, so
 * `effectiveChain(U) = effectiveChain(X) + [U]`, and the records between X and U drop out. Every other record R gives
 * `effectiveChain(R) = effectiveChain(parents[0] of R) + [R]`. State is always computed from the effective chain.
 *
 * Steps. Undo and redo act on one branch, the caller's working branch (an open draft, an exploration branch, or
 * `main`). Every `operation` record is one step, except `proj.create`, `proj.undo`, `proj.redo`, `proj.draft_accept`,
 * `proj.draft_discard`, `proj.branch_create` and `proj.branch_switch`. An accepted draft's records stay separate steps
 * on `main`: a fast-forward accept keeps them on the effective chain of `main`, and a replay accept copies each one.
 *
 * Redo line. The jump run of a branch is the trailing run of `proj.undo` and `proj.redo` records on the raw chain of its
 * head. With H the record just before that run, the redo line is `effectiveChain(H)`, and the redo steps are the steps
 * of the redo line after the head's `params.to`. Any other record appended to the branch ends the jump run, so a write
 * after an undo drops the redo steps.
 *
 * Calls: reads and appends through the record store. The service calls `undo` and `redo` while it holds the project
 * lock; reducers and drafts call `effectiveChain`.
 *
 * @module @dv/project/history
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RecordStore } from './record-store.ts'
import { MAIN_BRANCH, ProjectError } from './shared.ts'
import type { HistoryEntry, HistoryQuery, ProjectId, ProjectRecord, RecordId, RecordOrigin } from './types.ts'

/** `proj.*` operations whose records are not steps (see the module comment). */
const NOT_A_STEP = new Set([
  'proj.create', 'proj.undo', 'proj.redo', 'proj.draft_accept', 'proj.draft_discard', 'proj.branch_create', 'proj.branch_switch',
])

/**
 * @param record - a record.
 * @returns whether undo and redo count the record as one step.
 */
function isStep(record: ProjectRecord): boolean {
  return record.kind === 'operation' && !NOT_A_STEP.has(record.operation ?? '')
}

/**
 * The record that an undo or redo record continues from.
 * @param record - a record.
 * @returns `params.to` of a `proj.undo` or `proj.redo` record, else null.
 */
function jumpTarget(record: ProjectRecord): RecordId | null {
  if (record.operation !== 'proj.undo' && record.operation !== 'proj.redo') return null
  const to = record.params.to
  return typeof to === 'string' ? brandString<RecordId>(to) : null
}

/**
 * Walk the effective chain backwards from a record, iteratively. Every jump target and parent was written before the
 * record that names it, so the walk visits each record at most once and ends at the project's first record.
 * @param lookup - reads a record's current form by ID.
 * @param head - the last record of the chain.
 * @returns the records, oldest first.
 */
function walkEffective(lookup: (id: RecordId) => ProjectRecord, head: RecordId): ProjectRecord[] {
  const kept: ProjectRecord[] = []
  let current: RecordId | undefined = head
  while (current !== undefined) {
    const record = lookup(current)
    kept.push(record)
    current = jumpTarget(record) ?? record.parents[0]
  }
  return kept.reverse()
}

/**
 * The IDs on the raw chain (`parents[0]`) from a record back to a stop record.
 * @param byId - the project's records by ID.
 * @param head - the record to start from (included).
 * @param stop - the record to stop at (excluded); null walks to the project's first record.
 * @returns the IDs, newest first.
 */
function rawChainSince(byId: Map<RecordId, ProjectRecord>, head: RecordId, stop: RecordId | null): RecordId[] {
  const ids: RecordId[] = []
  let current: RecordId | undefined = head
  while (current !== undefined && current !== stop) {
    ids.push(current)
    current = byId.get(current)?.parents[0]
  }
  return ids
}

/**
 * The six origin fields that every record copies from its call.
 * @param origin - the call's origin; extra fields are dropped.
 * @returns the origin fields.
 */
function originFields(origin: RecordOrigin): RecordOrigin {
  const { actor, surface, session, turn, tool_call, intent } = origin
  return { actor, surface, session, turn, tool_call, intent }
}

/**
 * The effective chain ending at a record (see the module comment).
 * @param store - the record store.
 * @param project - the project.
 * @param head - the last record of the chain.
 * @returns the records, oldest first; the first is the project's `proj.create` record.
 */
export function effectiveChain(store: RecordStore, project: ProjectId, head: RecordId): ProjectRecord[] {
  return walkEffective(id => store.getRecord(project, id), head)
}

/** The redo line of a branch: where its jump run started and where its head stands on it. */
interface RedoLine {
  /** The record just before the jump run (H in the module comment). */
  end: RecordId
  /** `effectiveChain(end)`, oldest first. */
  line: ProjectRecord[]
  /** The index in `line` of the head's `params.to`. */
  at: number
}

/** Undo, redo and the history list of every project. */
export class History {
  /**
   * @param store - the record store.
   */
  constructor(private readonly store: RecordStore) {}

  /**
   * Move a branch back, or jump it to a step. Without `to`, the target is the effective-chain record just before the
   * branch's last step. With `to`, the target is that record when it is on the branch's effective chain (the state
   * returns to just after it), or the redo target of that record when it is one of the branch's redo steps (a jump
   * forward, written as `proj.redo`). Appends a `proj.undo` (or `proj.redo`) record on the branch with
   * `parents: [head]` and `params.to` = the target. The caller holds the project lock.
   * @param project - the project.
   * @param branch - the working branch of the caller.
   * @param origin - who undoes, from where.
   * @param to - a record to return to, or undefined for one step back.
   * @returns the appended record. Throws `unknown_branch`, `unknown_record`, `nothing_to_undo` (no step to undo, or
   * `to` is the current position), or `invalid_params` (`to` is neither on the effective chain nor a redo step).
   */
  undo(project: ProjectId, branch: string, origin: RecordOrigin, to?: RecordId): ProjectRecord {
    const head = this.requireHead(project, branch)
    const chain = effectiveChain(this.store, project, head)
    if (to === undefined) {
      const last = chain.findLastIndex(isStep)
      const target = last > 0 ? chain[last - 1] : undefined
      if (target === undefined) throw new ProjectError('nothing_to_undo', `Branch ${branch} of project ${project} has no step to undo.`)
      return this.appendJump(project, branch, head, 'proj.undo', target.id, origin)
    }
    const record = this.store.getRecord(project, to)
    const current = jumpTarget(this.store.getRecord(project, head)) ?? head
    if (record.id === current || record.id === head) {
      throw new ProjectError('nothing_to_undo', `Branch ${branch} of project ${project} already stands at record ${to}.`)
    }
    if (chain.some(entry => entry.id === record.id)) return this.appendJump(project, branch, head, 'proj.undo', record.id, origin)
    const redo = this.redoLine(project, head)
    const index = redo === null ? -1 : redo.line.findIndex((entry, at) => at > redo.at && entry.id === record.id)
    if (redo === null || index < 0 || !isStep(redo.line[index] ?? record)) {
      throw new ProjectError('invalid_params', `Record ${to} is neither a step of branch ${branch} nor one that redo brings back.`)
    }
    return this.appendJump(project, branch, head, 'proj.redo', this.redoTarget(redo, index), origin)
  }

  /**
   * Move a branch forward by one redo step: append a `proj.redo` record on the branch whose `params.to` is the record
   * just before the redo step that follows the next one, or the end of the redo line when the next step is the last.
   * The caller holds the project lock.
   * @param project - the project.
   * @param branch - the working branch of the caller.
   * @param origin - who redoes, from where.
   * @returns the `proj.redo` record. Throws `unknown_branch` or `nothing_to_redo`.
   */
  redo(project: ProjectId, branch: string, origin: RecordOrigin): ProjectRecord {
    const head = this.requireHead(project, branch)
    const redo = this.redoLine(project, head)
    const next = redo === null ? -1 : redo.line.findIndex((entry, at) => at > redo.at && isStep(entry))
    if (redo === null || next < 0) {
      throw new ProjectError('nothing_to_redo', `Branch ${branch} of project ${project} has no undone step to redo.`)
    }
    return this.appendJump(project, branch, head, 'proj.redo', this.redoTarget(redo, next), origin)
  }

  /**
   * The steps that redo brings back on a branch, oldest first (`ProjectState.redo_steps`).
   * @param project - the project.
   * @param branch - a branch name.
   * @returns the record IDs; empty when the branch's head is not a jump or nothing after its target is a step.
   */
  redoSteps(project: ProjectId, branch: string): RecordId[] {
    const redo = this.redoLine(project, this.requireHead(project, branch))
    return redo === null ? [] : redo.line.slice(redo.at + 1).filter(isStep).map(record => record.id)
  }

  /**
   * List records with their marks, newest first (reverse write order), after the query's filters. Marks: `main` for
   * records on the effective chain of `main`; `draft` for records on the effective chain of an open draft that are not
   * on the effective chain of its `forked_at`; `discarded` for records on the raw chain of a `proj.draft_discard` record
   * after its `params.base`, including that record; `replayed` for records listed in a `proj.draft_accept` record's
   * `params.replayed` as originals; `undone` for records on the raw chain of a branch after its `forked_at` that are not
   * on its effective chain; `branch` for every other record. The first matching mark in that order wins. Draft names
   * are reused per session, so a specific draft is identified by its fork record (`forked_at`, `params.base`), never
   * by the branch name alone. The `marks` filter applies after the record filters and before `limit`. Takes no lock.
   * @param query - the project and the filters.
   * @returns the entries.
   */
  list(query: HistoryQuery): HistoryEntry[] {
    const records = this.store.listRecords(query.project)
    const mark = this.marks(query.project, records)
    let end = records.length
    if (query.before !== undefined) {
      end = records.findIndex(record => record.id === query.before)
      if (end < 0) throw new ProjectError('unknown_record', `Project ${query.project} has no record ${query.before}.`)
    }
    const only = query.records === undefined ? null : new Set(query.records)
    // Every filter that the query sets must match; unset filters match every record.
    const selected = records.slice(0, end).filter(record =>
      (query.branch === undefined || record.branch === query.branch)
      && (query.actor === undefined || record.actor === query.actor)
      && (query.component === undefined || record.component === query.component)
      && (query.operation === undefined || record.operation === query.operation)
      && (query.kind === undefined || record.kind === query.kind)
      && (query.status === undefined || record.status === query.status)
      && (query.session === undefined || record.session === query.session)
      && (query.turn === undefined || record.turn === query.turn)
      && (query.tool_call === undefined || record.tool_call === query.tool_call)
      && (only === null || only.has(record.id)))
    const marks = query.marks === undefined ? null : new Set(query.marks)
    const entries = selected.reverse().map(record => ({ record, mark: mark(record.id) }))
      .filter(entry => marks === null || marks.has(entry.mark))
    return query.limit === undefined ? entries : entries.slice(0, Math.max(0, query.limit))
  }

  /**
   * Compute the mark of every record of a project (rules in {@link History.list}).
   * @param project - the project.
   * @param records - the project's records in write order.
   * @returns a function from record ID to mark.
   */
  private marks(project: ProjectId, records: ProjectRecord[]): (id: RecordId) => HistoryEntry['mark'] {
    const byId = new Map(records.map(record => [record.id, record]))
    const lookup = (id: RecordId): ProjectRecord => {
      const record = byId.get(id)
      if (record === undefined) throw new ProjectError('unknown_record', `Project ${project} has no record ${id}.`)
      return record
    }
    const branches = this.store.listBranches(project)
    const mainHead = branches.find(branch => branch.name === MAIN_BRANCH)?.head
    const effectiveIds = (head: RecordId | null): Set<RecordId> =>
      new Set(head === null ? [] : walkEffective(lookup, head).map(record => record.id))
    const onMain = effectiveIds(mainHead ?? null)
    const onDraft = new Set<RecordId>()
    const undone = new Set<RecordId>()
    for (const branch of branches) {
      // A branch's undone records are on its raw chain after its fork and off its effective chain.
      const effective = effectiveIds(branch.head)
      for (const id of rawChainSince(byId, branch.head, branch.forked_at)) if (!effective.has(id)) undone.add(id)
      // Open drafts are the branches owned by a chat session; their records are the effective ones after the fork.
      if (branch.session === null) continue
      const before = effectiveIds(branch.forked_at)
      for (const id of effective) if (!before.has(id)) onDraft.add(id)
    }
    const discarded = new Set<RecordId>()
    const replayed = new Set<RecordId>()
    for (const record of records) {
      if (record.operation === 'proj.draft_discard') {
        const base = record.params.base
        for (const id of rawChainSince(byId, record.id, typeof base === 'string' ? brandString<RecordId>(base) : null)) discarded.add(id)
      } else if (record.operation === 'proj.draft_accept' && Array.isArray(record.params.replayed)) {
        // `params.replayed` holds `[original, copy]` pairs.
        const pairs: unknown[] = record.params.replayed
        for (const pair of pairs) {
          if (Array.isArray(pair) && typeof pair[0] === 'string') replayed.add(brandString<RecordId>(pair[0]))
        }
      }
    }
    return (id) => {
      if (onMain.has(id)) return 'main'
      if (onDraft.has(id)) return 'draft'
      if (discarded.has(id)) return 'discarded'
      if (replayed.has(id)) return 'replayed'
      if (undone.has(id)) return 'undone'
      return 'branch'
    }
  }

  /**
   * The redo line of a branch head (see the module comment).
   * @param project - the project.
   * @param head - the head of the branch.
   * @returns the line, or null when the head is not a `proj.undo` or `proj.redo` record.
   */
  private redoLine(project: ProjectId, head: RecordId): RedoLine | null {
    const target = jumpTarget(this.store.getRecord(project, head))
    if (target === null) return null
    // Walk the raw chain back over the jump run to the record before it.
    let end: RecordId | undefined = head
    while (end !== undefined && jumpTarget(this.store.getRecord(project, end)) !== null) {
      end = this.store.getRecord(project, end).parents[0]
    }
    if (end === undefined) return null
    const line = effectiveChain(this.store, project, end)
    const at = line.findIndex(record => record.id === target)
    return at < 0 ? null : { end, line, at }
  }

  /**
   * The `params.to` of a redo that brings back the step at `index` of the redo line: the record just before the next
   * step after it, or the end of the line when no step follows.
   * @param redo - the redo line.
   * @param index - the index of a step in `redo.line`.
   * @returns the record ID.
   */
  private redoTarget(redo: RedoLine, index: number): RecordId {
    const following = redo.line.findIndex((entry, at) => at > index && isStep(entry))
    return following < 0 ? redo.end : (redo.line[following - 1]?.id ?? redo.end)
  }

  /**
   * @param project - the project.
   * @param branch - a branch name.
   * @returns the branch's head; throws `unknown_branch`.
   */
  private requireHead(project: ProjectId, branch: string): RecordId {
    const stored = this.store.getBranch(project, branch)
    if (stored === undefined) throw new ProjectError('unknown_branch', `Project ${project} has no branch ${branch}.`)
    return stored.head
  }

  /**
   * Append a `proj.undo` or `proj.redo` record on a branch.
   * @param project - the project.
   * @param branch - the branch.
   * @param head - the head of the branch, the record's parent.
   * @param operation - `proj.undo` or `proj.redo`.
   * @param to - the record whose state the branch returns to.
   * @param origin - who acts, from where.
   * @returns the appended record.
   */
  private appendJump(
    project: ProjectId, branch: string, head: RecordId, operation: 'proj.undo' | 'proj.redo', to: RecordId, origin: RecordOrigin,
  ): ProjectRecord {
    return this.store.append(project, {
      parents: [head], branch, kind: 'operation', component: 'proj', operation, operation_version: '1',
      ...originFields(origin), params: { to }, inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: true,
      status: 'done',
    })
  }
}
