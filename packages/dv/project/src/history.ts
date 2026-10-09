/**
 * History: the history list of a project, the current position on it, undo, redo, moves to a step, and the history
 * query. It works like the History panel of an image editor.
 *
 * The list. The history list is the `parents[0]` ancestry of the project's last step (`tip` in `line.json`), oldest
 * first; its first record is `proj.create`. The current position (`at`) is a record of the list, and the project state
 * is the state of the list up to `at`.
 *
 * Moves. Undo moves `at` to its parent, redo moves it to the next record toward `tip`, and a move to a step sets it to
 * that record. A move writes no record. A write after a move follows `at` (the record store's append rule), so the
 * steps that were after `at` leave the list: they are discarded and cannot come back.
 *
 * Calls: reads records, the line and moves through the record store. The service calls `undo`, `redo` and `moveTo`
 * while it holds the project lock; the reducers call `chainTo`; the runner calls `discardedSteps` before each write.
 *
 * @module @dv/project/history
 */
import type { RecordStore } from './record-store.ts'
import { ProjectError } from './shared.ts'
import type { HistoryEntry, HistoryQuery, ProjectId, ProjectLine, ProjectRecord, RecordId } from './types.ts'

/**
 * The records from a project's first record to a record, by `parents[0]`.
 * @param store - the record store.
 * @param project - the project.
 * @param record - the last record of the chain.
 * @returns the records, oldest first; the first is the project's `proj.create` record.
 */
export function chainTo(store: RecordStore, project: ProjectId, record: RecordId): ProjectRecord[] {
  return store.ancestors(project, record)
}

/**
 * The steps that a write now discards: the records of the history list after the current position.
 * @param store - the record store.
 * @param project - the project.
 * @returns the records, oldest first; empty when the current position is the last step.
 */
export function discardedSteps(store: RecordStore, project: ProjectId): ProjectRecord[] {
  const line = store.line(project)
  if (line === undefined || line.at === line.tip) return []
  const list = chainTo(store, project, line.tip)
  return list.slice(list.findIndex(record => record.id === line.at) + 1)
}

/** Undo, redo, moves to a step, and the history list of every project. */
export class History {
  /**
   * @param store - the record store.
   */
  constructor(private readonly store: RecordStore) {}

  /**
   * Move the current position one step back. The caller holds the project lock.
   * @param project - the project.
   * @returns the line after the move. Throws `nothing_to_undo` at the project's first record.
   */
  undo(project: ProjectId): ProjectLine {
    const line = this.requireLine(project)
    const parent = this.store.getRecord(project, line.at).parents[0]
    if (parent === undefined) throw new ProjectError('nothing_to_undo', `Project ${project} has no step to undo.`)
    this.store.moveTo(project, parent)
    return { tip: line.tip, at: parent }
  }

  /**
   * Move the current position one step forward, toward the last step. The caller holds the project lock.
   * @param project - the project.
   * @returns the line after the move. Throws `nothing_to_redo` at the last step.
   */
  redo(project: ProjectId): ProjectLine {
    const line = this.requireLine(project)
    const list = chainTo(this.store, project, line.tip)
    const next = list[list.findIndex(record => record.id === line.at) + 1]
    if (line.at === line.tip || next === undefined) throw new ProjectError('nothing_to_redo', `Project ${project} has no step to redo.`)
    this.store.moveTo(project, next.id)
    return { tip: line.tip, at: next.id }
  }

  /**
   * Move the current position to a step of the history list, before or after it. A move to the current position
   * changes nothing. The caller holds the project lock.
   * @param project - the project.
   * @param to - a record of the history list.
   * @returns the line after the move. Throws `unknown_record`, or `invalid_params` for a discarded record.
   */
  moveTo(project: ProjectId, to: RecordId): ProjectLine {
    const line = this.requireLine(project)
    this.store.getRecord(project, to)
    if (to === line.at) return line
    if (!chainTo(this.store, project, line.tip).some(record => record.id === to)) {
      throw new ProjectError('invalid_params', `Record ${to} was discarded and is not in the history of project ${project}.`)
    }
    this.store.moveTo(project, to)
    return { tip: line.tip, at: to }
  }

  /**
   * The steps that a write now discards: the records of the history list after the current position. Takes no lock.
   * @param project - the project.
   * @returns the records, oldest first; empty when the current position is the last step.
   */
  discardedBy(project: ProjectId): ProjectRecord[] {
    return discardedSteps(this.store, project)
  }

  /**
   * List the steps of the history list newest first, after the query's filters, each with its place relative to the
   * current position. Discarded records are not listed. Takes no lock.
   * @param query - the project and the filters.
   * @returns the entries.
   */
  list(query: HistoryQuery): HistoryEntry[] {
    const line = this.store.line(query.project)
    if (line === undefined) return []
    const records = chainTo(this.store, query.project, line.tip)
    const atIndex = records.findIndex(record => record.id === line.at)
    let end = records.length
    if (query.before !== undefined) {
      end = records.findIndex(record => record.id === query.before)
      if (end < 0) throw new ProjectError('unknown_record', `The history of project ${query.project} has no record ${query.before}.`)
    }
    const only = query.records === undefined ? null : new Set(query.records)
    const entries: HistoryEntry[] = []
    // Newest first; every filter that the query sets must match; unset filters match every record.
    for (let index = end - 1; index >= 0; index -= 1) {
      const record = records[index]
      if (record === undefined) continue
      if ((query.actor !== undefined && record.actor !== query.actor)
        || (query.component !== undefined && record.component !== query.component)
        || (query.operation !== undefined && record.operation !== query.operation)
        || (query.kind !== undefined && record.kind !== query.kind)
        || (query.status !== undefined && record.status !== query.status)
        || (query.session !== undefined && record.session !== query.session)
        || (query.turn !== undefined && record.turn !== query.turn)
        || (query.tool_call !== undefined && record.tool_call !== query.tool_call)
        || (only !== null && !only.has(record.id))) continue
      let place: HistoryEntry['place'] = 'before'
      if (index === atIndex) place = 'current'
      else if (index > atIndex) place = 'after'
      entries.push({ record, place })
    }
    return query.limit === undefined ? entries : entries.slice(0, Math.max(0, query.limit))
  }

  /**
   * @param project - the project.
   * @returns the project's line; throws `nothing_to_undo` for a project without records.
   */
  private requireLine(project: ProjectId): ProjectLine {
    const line = this.store.line(project)
    if (line === undefined) throw new ProjectError('nothing_to_undo', `Project ${project} has no record.`)
    return line
  }
}
