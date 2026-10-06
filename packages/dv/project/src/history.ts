/**
 * History: undo and redo as records, the effective chain that undo and redo records define, and the history list.
 *
 * Effective chain. The raw chain of a record is its `parents[0]` ancestry. The effective chain differs at `proj.undo`
 * and `proj.redo` records: such a record U with `params.to = X` continues the effective chain of X, so
 * `effectiveChain(U) = effectiveChain(X) + [U]`, and the records between X and U drop out. Every other record R gives
 * `effectiveChain(R) = effectiveChain(parents[0] of R) + [R]`. State is always computed from the effective chain.
 *
 * Change units on `main`. Undo moves `main` back by one accepted change. Walking the effective chain of `main`
 * backwards and skipping `proj.undo`, `proj.redo` and `proj.branch_switch` records, the last change is either
 * (a) a `proj.draft_accept` record A, whose unit is every record after `A.params.base` up to A, or (b) any other
 * record R, whose unit is R alone. `proj.create` is never a change unit.
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

/** Records that do not count as a change unit when undo walks `main` backwards. */
const NOT_A_CHANGE = new Set(['proj.undo', 'proj.redo', 'proj.branch_switch'])

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

/** Undo, redo and the history list of every project. */
export class History {
  /**
   * @param store - the record store.
   */
  constructor(private readonly store: RecordStore) {}

  /**
   * Move `main` back by one change unit: append a `proj.undo` record on `main` with `params.to` = the effective-chain
   * record just before the unit's first record. The caller holds the project lock. Throws `nothing_to_undo` when the
   * effective chain of `main` holds no change unit.
   * @param project - the project.
   * @param origin - who undoes, from where.
   * @returns the `proj.undo` record.
   */
  undo(project: ProjectId, origin: RecordOrigin): ProjectRecord {
    const main = this.store.getBranch(project, MAIN_BRANCH)
    const chain = main === undefined ? [] : effectiveChain(this.store, project, main.head)
    // The last change unit ends at the newest record that is not an undo, redo or branch switch.
    let last = chain.length - 1
    while (last >= 0 && NOT_A_CHANGE.has(chain[last]?.operation ?? '')) last--
    const change = chain[last]
    if (main === undefined || change === undefined || change.operation === 'proj.create' || last === 0) {
      throw new ProjectError('nothing_to_undo', `Project ${project} has no change on main to undo.`)
    }
    const base = change.operation === 'proj.draft_accept' ? change.params.base : undefined
    const to = typeof base === 'string' ? brandString<RecordId>(base) : chain[last - 1]?.id
    if (to === undefined) throw new ProjectError('nothing_to_undo', `Project ${project} has no change on main to undo.`)
    return this.appendJump(project, main.head, 'proj.undo', to, origin)
  }

  /**
   * Re-apply the most recently undone change. Take the trailing run of `proj.undo` and `proj.redo` records on the raw
   * chain of `main` (ending at its head), in order; push each undo and pop on each redo. When an undo U remains on the
   * stack, append a `proj.redo` record on `main` with `params.to = U.parents[0]`; otherwise throw `nothing_to_redo`.
   * Any other record on `main` after an undo therefore ends the possibility to redo it. The caller holds the lock.
   * @param project - the project.
   * @param origin - who redoes, from where.
   * @returns the `proj.redo` record.
   */
  redo(project: ProjectId, origin: RecordOrigin): ProjectRecord {
    const main = this.store.getBranch(project, MAIN_BRANCH)
    // Collect the trailing run of undo and redo records, newest first.
    const run: ProjectRecord[] = []
    let current: RecordId | undefined = main?.head
    while (current !== undefined) {
      const record = this.store.getRecord(project, current)
      if (record.operation !== 'proj.undo' && record.operation !== 'proj.redo') break
      run.push(record)
      current = record.parents[0]
    }
    const undone: ProjectRecord[] = []
    for (const record of run.reverse()) {
      if (record.operation === 'proj.undo') undone.push(record)
      else undone.pop()
    }
    const target = undone.at(-1)?.parents[0]
    if (main === undefined || target === undefined) {
      throw new ProjectError('nothing_to_redo', `Project ${project} has no undone change on main to redo.`)
    }
    return this.appendJump(project, main.head, 'proj.redo', target, origin)
  }

  /**
   * List records with their marks, newest first (reverse write order), after the query's filters. Marks: `main` for
   * records on the effective chain of `main`; `draft` for records on the raw chain of an open draft after its
   * `forked_at`; `discarded` for records on the raw chain of a `proj.draft_discard` record after its `params.base`,
   * including that record; `replayed` for records listed in a `proj.draft_accept` record's `params.replayed` as
   * originals; `undone` for records on the raw chain of `main` that are not on its effective chain; `branch` for every
   * other record. The first matching mark in that order wins. Draft names are reused per session, so a specific draft
   * is identified by its fork record (`forked_at`, `params.base`), never by the branch name alone. Takes no lock.
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
      && (only === null || only.has(record.id)))
    const entries = selected.reverse().map(record => ({ record, mark: mark(record.id) }))
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
    const onMain = new Set(mainHead === undefined ? [] : walkEffective(lookup, mainHead).map(record => record.id))
    const onMainRaw = new Set(mainHead === undefined ? [] : rawChainSince(byId, mainHead, null))
    // Open drafts are the branches owned by a chat session.
    const onDraft = new Set(branches.filter(branch => branch.session !== null)
      .flatMap(branch => rawChainSince(byId, branch.head, branch.forked_at)))
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
      if (onMainRaw.has(id)) return 'undone'
      return 'branch'
    }
  }

  /**
   * Append a `proj.undo` or `proj.redo` record on `main`.
   * @param project - the project.
   * @param head - the head of `main`, the new record's parent.
   * @param operation - `proj.undo` or `proj.redo`.
   * @param to - the record whose state `main` returns to.
   * @param origin - who acts, from where.
   * @returns the appended record.
   */
  private appendJump(
    project: ProjectId, head: RecordId, operation: 'proj.undo' | 'proj.redo', to: RecordId, origin: RecordOrigin,
  ): ProjectRecord {
    return this.store.append(project, {
      parents: [head], branch: MAIN_BRANCH, kind: 'operation', component: 'proj', operation, operation_version: '1',
      ...originFields(origin), params: { to }, inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: true,
      status: 'done',
    })
  }
}
