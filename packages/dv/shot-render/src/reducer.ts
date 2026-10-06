/**
 * The pure reducer of the `shot` slice: a finished `shot.render` record that is `based_on` an earlier render is a
 * new take of the same shot, grouped under the root record of its `based_on` chain.
 *
 * @module @dv/shot-render/reducer
 */
import type { Reducer } from '@dv/project'
import type {} from './types.ts'

/** The `shot` reducer: the takes of a shot, which are the renders that are `based_on` its root record. */
export const shotReducer: Reducer<'shot'> = {
  initial: () => ({ takes: {}, roots: {} }),
  reduce(slice, record) {
    if (record.operation !== 'shot.render' || record.status !== 'done' || record.based_on === null) return slice
    const root = slice.roots[record.based_on] ?? record.based_on
    return {
      takes: { ...slice.takes, [root]: [...slice.takes[root] ?? [root], record.id] },
      roots: { ...slice.roots, [record.id]: root },
    }
  },
}
