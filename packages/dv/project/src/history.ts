/**
 * History: undo, redo and jumps as records on a branch, the effective chain that those records define, and the
 * history list.
 *
 * Effective chain. The raw chain of a record is its `parents[0]` ancestry. The effective chain differs at `proj.undo`
 * and `proj.redo` records: such a record U with `params.to = X` continues the effective chain of X, so
 * `effectiveChain(U) = effectiveChain(X) + [U]`, and the records between X and U drop out. Every other record R gives
 * `effectiveChain(R) = effectiveChain(parents[0] of R) + [R]`. State is always computed from the effective chain.
 *
 * Steps. Undo and redo act on one branch, the project's current branch. Every record is one step, except `proj.create`,
 * `proj.undo`, `proj.redo`, and the `proj.draft_accept` and `proj.draft_discard` records that projects written before
 * branches replaced drafts still hold.
 *
 * Redo line. The jump run of a branch is the trailing run of `proj.undo` and `proj.redo` records on the raw chain of its
 * head. With H the record just before that run, the redo line is `effectiveChain(H)`, and the redo steps are the steps
 * of the redo line after the head's `params.to`. H is the branch's tip. A write never lands after an undo on the same
 * branch: the branches module forks a new branch first, so the redo steps stay on the old branch.
 *
 * Calls: reads and appends through the record store. The service calls `undo` and `redo` while it holds the project
 * lock; reducers and branches call `effectiveChain`; branches call `position` and `tipOf`.
 *
 * @module @dv/project/history
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RecordStore } from './record-store.ts'
import { ProjectError } from './shared.ts'
import type { HistoryEntry, HistoryQuery, ProjectId, ProjectRecord, RecordId, RecordOrigin } from './types.ts'

/** `proj.*` operations whose records are not steps (see the module comment). */
const NOT_A_STEP = new Set([
  'proj.create', 'proj.undo', 'proj.redo', 'proj.draft_accept', 'proj.draft_discard',
])

/**
 * @param record - a record.
 * @returns whether undo and redo count the record as one step.
 */
function isStep(record: ProjectRecord): boolean {
  return !NOT_A_STEP.has(record.operation ?? '')
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
 * The end of the redo line of a head: the record just before the trailing run of `proj.undo` and `proj.redo` records
 * on its raw chain, or the head itself when it is not such a record.
 * @param lookup - reads a record's current form by ID.
 * @param head - the head of a branch.
 * @returns the record ID.
 */
function lineEnd(lookup: (id: RecordId) => ProjectRecord, head: RecordId): RecordId {
  let end = head
  while (jumpTarget(lookup(end)) !== null) {
    const parent = lookup(end).parents[0]
    if (parent === undefined) break
    end = parent
  }
  return end
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

/**
 * Where a branch head stands: the record whose state the head shows, following `proj.undo` and `proj.redo` targets
 * until a record that is neither. A branch forked there starts from the same state without the jump records.
 * @param store - the record store.
 * @param project - the project.
 * @param head - the head of a branch.
 * @returns the record ID.
 */
export function position(store: RecordStore, project: ProjectId, head: RecordId): RecordId {
  let at = head
  let target = jumpTarget(store.getRecord(project, at))
  while (target !== null) {
    at = target
    target = jumpTarget(store.getRecord(project, at))
  }
  return at
}

/**
 * The tip of a branch head: the end of its redo line (see the module comment).
 * @param store - the record store.
 * @param project - the project.
 * @param head - the head of a branch.
 * @returns the record ID; the head itself when it is not a `proj.undo` or `proj.redo` record.
 */
export function tipOf(store: RecordStore, project: ProjectId, head: RecordId): RecordId {
  return lineEnd(id => store.getRecord(project, id), head)
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
   * @param branch - the branch to move: the project's current branch, or the branch a switch goes to.
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
    const current = position(this.store, project, head)
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
   * @param branch - the branch to move: the project's current branch, or the branch a switch goes to.
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
   * List records with their marks and branch lines, newest first (reverse write order), after the query's filters.
   * Marks: `current` for records on the effective chain of the current branch's head; `redo` for the records of the
   * current branch's line after its head's position (its redo steps and the records between them); `branch` for the
   * records on the line of another branch only; `undone` for every other record. The line of a branch is the effective
   * chain of its tip. The `marks` filter applies after the record filters and before `limit`. Takes no lock.
   * @param query - the project and the filters.
   * @returns the entries.
   */
  list(query: HistoryQuery): HistoryEntry[] {
    const records = this.store.listRecords(query.project)
    const { mark, branches } = this.marks(query.project, records)
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
    const entries = selected.reverse().map(record => ({ record, mark: mark(record.id), branches: branches(record.id) }))
      .filter(entry => marks === null || marks.has(entry.mark))
    return query.limit === undefined ? entries : entries.slice(0, Math.max(0, query.limit))
  }

  /**
   * Compute the mark and the branch lines of every record of a project (rules in {@link History.list}).
   * @param project - the project.
   * @param records - the project's records in write order.
   * @returns functions from record ID to mark and to the names of the branches whose line holds the record.
   */
  private marks(project: ProjectId, records: ProjectRecord[]): {
    mark: (id: RecordId) => HistoryEntry['mark']
    branches: (id: RecordId) => string[]
  } {
    const byId = new Map(records.map(record => [record.id, record]))
    const lookup = (id: RecordId): ProjectRecord => {
      const record = byId.get(id)
      if (record === undefined) throw new ProjectError('unknown_record', `Project ${project} has no record ${id}.`)
      return record
    }
    const current = this.store.currentBranch(project)
    const lines = new Map<RecordId, string[]>()
    let onCurrent = new Set<RecordId>()
    let onCurrentLine = new Set<RecordId>()
    for (const branch of this.store.listBranches(project)) {
      const line = walkEffective(lookup, lineEnd(lookup, branch.head)).map(record => record.id)
      for (const id of line) lines.set(id, [...lines.get(id) ?? [], branch.name])
      if (branch.name !== current) continue
      onCurrent = new Set(walkEffective(lookup, branch.head).map(record => record.id))
      onCurrentLine = new Set(line)
    }
    return {
      mark: (id) => {
        if (onCurrent.has(id)) return 'current'
        if (onCurrentLine.has(id)) return 'redo'
        return lines.has(id) ? 'branch' : 'undone'
      },
      branches: id => lines.get(id) ?? [],
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
    const end = tipOf(this.store, project, head)
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
