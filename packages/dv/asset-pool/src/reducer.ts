/**
 * The pure reducer of the `asset` slice: which assets are on the canvas. A finished `asset.place` adds its `asset`
 * inputs, a finished `asset.unplace` takes them off, and a finished `asset.import` with `params.place` adds its output.
 * The slice follows the branch's records, so undo, redo and branch switches change the canvas with them.
 *
 * @module @dv/asset-pool/reducer
 */
import type { AssetId, ProjectRecord, Reducer } from '@dv/project'
import type {} from './types.ts'

/**
 * @param record - a placement record.
 * @returns the assets of its `asset` inputs.
 */
function inputAssets(record: ProjectRecord): AssetId[] {
  return record.inputs.flatMap(input => input.role === 'asset' && input.resolved_asset !== null ? [input.resolved_asset] : [])
}

/** The `asset` reducer: the canvas placements of the branch. */
export const assetReducer: Reducer<'asset'> = {
  initial: () => ({ placed: [] }),
  reduce(slice, record) {
    if (record.status !== 'done') return slice
    let added: AssetId[] = []
    if (record.operation === 'asset.place') added = inputAssets(record)
    else if (record.operation === 'asset.import' && record.params['place'] === true) added = record.outputs
    else if (record.operation === 'asset.unplace') {
      const removed = new Set(inputAssets(record))
      return { placed: slice.placed.filter(asset => !removed.has(asset)) }
    }
    if (added.length === 0) return slice
    return { placed: [...slice.placed, ...added.filter(asset => !slice.placed.includes(asset))] }
  },
}
