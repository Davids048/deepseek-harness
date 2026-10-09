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
 * Calls: reads records, the record IDs of the list (`lineIds`), the line and moves through the record store. The service
 * calls `undo`, `redo` and `moveTo` while it holds the project lock; the runner calls `discardedSteps` before each write.
 *
 * @module @dv/project/history
 */
import type { RecordStore } from './record-store.ts'
import { ProjectError } from './shared.ts'
import type { HistoryEntry, HistoryQuery, ProjectId, ProjectLine, ProjectRecord, RecordId } from './types.ts'

/**
 * The steps that a write now discards: the records of the history list after the current position.
 * @param store - the record store.
 * @param project - the project.
 * @returns the records, oldest first; empty when the current position is the last step.
 */
export function discardedSteps(store: RecordStore, project: ProjectId): ProjectRecord[] {
  const { ids, atIndex } = store.lineIds(project)
  return ids.slice(atIndex + 1).map(id => store.getRecord(project, id))
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
    const line = this.store.requireLine(project)
    const { ids, atIndex } = this.store.lineIds(project)
    const parent = ids[atIndex - 1]
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
    const line = this.store.requireLine(project)
    const { ids, atIndex } = this.store.lineIds(project)
    const next = ids[atIndex + 1]
    if (next === undefined) throw new ProjectError('nothing_to_redo', `Project ${project} has no step to redo.`)
    this.store.moveTo(project, next)
    return { tip: line.tip, at: next }
  }

  /**
   * Move the current position to a step of the history list, before or after it. A move to the current position
   * changes nothing. The caller holds the project lock.
   * @param project - the project.
   * @param to - a record of the history list.
   * @returns the line after the move. Throws `unknown_record`, or `invalid_params` for a discarded record.
   */
  moveTo(project: ProjectId, to: RecordId): ProjectLine {
    const line = this.store.requireLine(project)
    this.store.getRecord(project, to)
    if (to === line.at) return line
    if (!this.store.lineIds(project).ids.includes(to)) {
      throw new ProjectError('invalid_params', `Record ${to} was discarded and is not in the history of project ${project}.`)
    }
    this.store.moveTo(project, to)
    return { tip: line.tip, at: to }
  }

  /**
   * List the steps of the history list newest first, after the query's filters, each with its place relative to the
   * current position. Discarded records are not listed. Takes no lock.
   * @param query - the project and the filters.
   * @returns the entries.
   */
  list(query: HistoryQuery): HistoryEntry[] {
    const { ids, atIndex } = this.store.lineIds(query.project)
    let end = ids.length
    if (query.before !== undefined) {
      end = ids.indexOf(query.before)
      if (end < 0) throw new ProjectError('unknown_record', `The history of project ${query.project} has no record ${query.before}.`)
    }
    const limit = query.limit === undefined ? Infinity : Math.max(0, query.limit)
    const only = query.records === undefined ? null : new Set(query.records)
    const entries: HistoryEntry[] = []
    // Newest first; every filter that the query sets must match; unset filters match every record.
    for (let index = end - 1; index >= 0 && entries.length < limit; index -= 1) {
      const id = ids[index]
      if (id === undefined || (only !== null && !only.has(id))) continue
      const record = this.store.getRecord(query.project, id)
      if ((query.actor !== undefined && record.actor !== query.actor)
        || (query.component !== undefined && record.component !== query.component)
        || (query.operation !== undefined && record.operation !== query.operation)
        || (query.kind !== undefined && record.kind !== query.kind)
        || (query.status !== undefined && record.status !== query.status)
        || (query.session !== undefined && record.session !== query.session)
        || (query.turn !== undefined && record.turn !== query.turn)
        || (query.tool_call !== undefined && record.tool_call !== query.tool_call)) continue
      let place: HistoryEntry['place'] = 'before'
      if (index === atIndex) place = 'current'
      else if (index > atIndex) place = 'after'
      entries.push({ record, place })
    }
    return entries
  }
}
