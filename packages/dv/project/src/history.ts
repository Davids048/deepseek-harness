/**
 * History: the project's one line of records, the effective chain that `proj.undo` records define, undo, and the
 * history list.
 *
 * The line. Every record follows the record written just before it, so the records of a project form one line in
 * write order, and the last record is the head. Nothing is removed from the line and nothing forks from it.
 *
 * Effective chain. The raw chain of a record is its `parents[0]` ancestry. The effective chain differs at `proj.undo`
 * records: such a record U with `params.to = X` continues the effective chain of X, so
 * `effectiveChain(U) = effectiveChain(X) + [U]`, and the records between X and U drop out. Every other record R gives
 * `effectiveChain(R) = effectiveChain(parents[0] of R) + [R]`. The project's state is computed from the effective chain
 * of the head, so an undo makes the state equal to the state at X, and the records after the undo continue from it.
 *
 * Steps. Every record is one step, except `proj.create` and `proj.undo`. Undo without a target returns to the state
 * before the last step of the effective chain, so repeated undos go further back.
 *
 * Calls: reads and appends through the record store. The service calls `undo` while it holds the project lock; the
 * reducers call `effectiveChain`.
 *
 * @module @dv/project/history
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RecordStore } from './record-store.ts'
import { ProjectError } from './shared.ts'
import type { HistoryEntry, HistoryQuery, ProjectId, ProjectRecord, RecordId, RecordOrigin } from './types.ts'

/** `proj.*` operations whose records are not steps (see the module comment). */
const NOT_A_STEP = new Set(['proj.create', 'proj.undo'])

/**
 * @param record - a record.
 * @returns whether undo counts the record as one step.
 */
export function isStep(record: ProjectRecord): boolean {
  return !NOT_A_STEP.has(record.operation ?? '')
}

/**
 * The record that an undo record continues from.
 * @param record - a record.
 * @returns `params.to` of a `proj.undo` record, else null.
 */
export function undoTarget(record: ProjectRecord): RecordId | null {
  if (record.operation !== 'proj.undo') return null
  const to = record.params.to
  return typeof to === 'string' ? brandString<RecordId>(to) : null
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
 * The effective chain ending at a record (see the module comment). Every undo target and parent was written before the
 * record that names it, so the walk visits each record at most once and ends at the project's first record.
 * @param store - the record store.
 * @param project - the project.
 * @param head - the last record of the chain.
 * @returns the records, oldest first; the first is the project's `proj.create` record.
 */
export function effectiveChain(store: RecordStore, project: ProjectId, head: RecordId): ProjectRecord[] {
  const kept: ProjectRecord[] = []
  let current: RecordId | undefined = head
  while (current !== undefined) {
    const record = store.getRecord(project, current)
    kept.push(record)
    current = undoTarget(record) ?? record.parents[0]
  }
  return kept.reverse()
}

/**
 * The record whose state a record shows: the record itself, or for an undo record the target it returns to, followed
 * through undo records until a record that is not one.
 * @param store - the record store.
 * @param project - the project.
 * @param record - a record.
 * @returns the record ID.
 */
export function position(store: RecordStore, project: ProjectId, record: RecordId): RecordId {
  let at = record
  let target = undoTarget(store.getRecord(project, at))
  while (target !== null) {
    at = target
    target = undoTarget(store.getRecord(project, at))
  }
  return at
}

/** Undo and the history list of every project. */
export class History {
  /**
   * @param store - the record store.
   */
  constructor(private readonly store: RecordStore) {}

  /**
   * Return the project to an earlier state by appending a `proj.undo` record with `parents: [head]` and `params.to` =
   * the target. Without `to`, the target is the effective-chain record just before the last step. With `to`, the
   * target is that record, any finished record of the project, so the state becomes the state just after it. The
   * caller holds the project lock.
   * @param project - the project.
   * @param origin - who undoes, from where.
   * @param to - a record to return to, or undefined for one step back.
   * @returns the appended record. Throws `unknown_record`, `nothing_to_undo` (no step to undo, or the project already
   * shows the state of `to`), or `invalid_params` (`to` has not finished).
   */
  undo(project: ProjectId, origin: RecordOrigin, to?: RecordId): ProjectRecord {
    const head = this.store.head(project)
    if (head === undefined) throw new ProjectError('nothing_to_undo', `Project ${project} has no record.`)
    if (to === undefined) {
      const chain = effectiveChain(this.store, project, head)
      const last = chain.findLastIndex(isStep)
      const target = last > 0 ? chain[last - 1] : undefined
      if (target === undefined) throw new ProjectError('nothing_to_undo', `Project ${project} has no step to undo.`)
      return this.appendUndo(project, head, target.id, origin)
    }
    const record = this.store.getRecord(project, to)
    if (record.status === 'pending' || record.status === 'running') {
      throw new ProjectError('invalid_params', `Record ${to} has not finished, so the project cannot return to it.`)
    }
    if (position(this.store, project, record.id) === position(this.store, project, head)) {
      throw new ProjectError('nothing_to_undo', `Project ${project} already shows the state of record ${to}.`)
    }
    return this.appendUndo(project, head, record.id, origin)
  }

  /**
   * List records newest first (reverse write order), after the query's filters. Takes no lock.
   * @param query - the project and the filters.
   * @returns the entries.
   */
  list(query: HistoryQuery): HistoryEntry[] {
    const records = this.store.listRecords(query.project)
    let end = records.length
    if (query.before !== undefined) {
      end = records.findIndex(record => record.id === query.before)
      if (end < 0) throw new ProjectError('unknown_record', `Project ${query.project} has no record ${query.before}.`)
    }
    const only = query.records === undefined ? null : new Set(query.records)
    // Every filter that the query sets must match; unset filters match every record.
    const selected = records.slice(0, end).filter(record =>
      (query.actor === undefined || record.actor === query.actor)
      && (query.component === undefined || record.component === query.component)
      && (query.operation === undefined || record.operation === query.operation)
      && (query.kind === undefined || record.kind === query.kind)
      && (query.status === undefined || record.status === query.status)
      && (query.session === undefined || record.session === query.session)
      && (query.turn === undefined || record.turn === query.turn)
      && (query.tool_call === undefined || record.tool_call === query.tool_call)
      && (only === null || only.has(record.id)))
    const entries = selected.reverse().map(record => ({ record }))
    return query.limit === undefined ? entries : entries.slice(0, Math.max(0, query.limit))
  }

  /**
   * Append a `proj.undo` record after the head.
   * @param project - the project.
   * @param head - the project's head, the record's parent.
   * @param to - the record whose state the project returns to.
   * @param origin - who acts, from where.
   * @returns the appended record.
   */
  private appendUndo(project: ProjectId, head: RecordId, to: RecordId, origin: RecordOrigin): ProjectRecord {
    return this.store.append(project, {
      parents: [head], kind: 'operation', component: 'proj', operation: 'proj.undo', operation_version: '1',
      ...originFields(origin), params: { to }, inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: true,
      status: 'done',
    })
  }
}
