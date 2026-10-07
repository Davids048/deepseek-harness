/**
 * The pure reducer of the `shot` slice: a finished render record (`shot.render_ref2va` or `shot.render_t2va`) that is
 * `based_on` an earlier render is a new take of the same shot, grouped under the root record of its `based_on` chain.
 *
 * @module @dv/shot-render/reducer
 */
import type { Reducer } from '@dv/project'
import type {} from './types.ts'

/** The render operations of Shot render, one per render mode; every one of them produces takes. */
export const RENDER_OPERATIONS: readonly string[] = ['shot.render_ref2va', 'shot.render_t2va']

/** The `shot` reducer: the takes of a shot, which are the renders that are `based_on` its root record. */
export const shotReducer: Reducer<'shot'> = {
  initial: () => ({ takes: {}, roots: {} }),
  reduce(slice, record) {
    const take = record.operation !== null && RENDER_OPERATIONS.includes(record.operation) && record.status === 'done'
    if (!take || record.based_on === null) return slice
    const root = slice.roots[record.based_on] ?? record.based_on
    return {
      takes: { ...slice.takes, [root]: [...slice.takes[root] ?? [root], record.id] },
      roots: { ...slice.roots, [record.id]: root },
    }
  },
}
