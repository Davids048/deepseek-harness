/**
 * Grouping of a project's images and videos, with the images that shot renders output apart. The assets come from the
 * project state, which lists every asset any record of the project's history created or names, so the panel shows every
 * asset the project ever had: the asset pool keeps them all.
 *
 * @module @dv/ui-asset-pool/library
 */
import type { Asset, ProjectRecord, WireState } from '@dv/ui-kit/types.ts'

/** The shot render operations whose image outputs (the last stills of takes) the panel lists under `extracted`. */
const RENDER_OPERATIONS: ReadonlySet<string> = new Set(['shot.render_ref2va', 'shot.render_t2va'])

/** The panel's view of one project's assets: every image and video once, grouped, newest first. */
export interface AssetLibrary {
  /** Assets whose media type is `image/*`, except the images in `extracted`. */
  images: Asset[]
  /** Assets whose media type is `video/*`. */
  videos: Asset[]
  /** Images that a `shot.render_ref2va` or `shot.render_t2va` record outputs. */
  extracted: Asset[]
}

/**
 * Group a project's images and videos, with the images of shot renders apart; assets of other media types are left out.
 * The records of the current state and `history` (records an undo went back past) tell which images are render stills
 * and give each import its name, read oldest first.
 * @param current - the project's current state.
 * @param history - more records of the project, such as the history list; records of the state may repeat.
 * @returns the groups.
 */
export function assetLibrary(current: WireState, history: readonly ProjectRecord[] = []): AssetLibrary {
  const byId = new Map<string, Asset>()
  for (const asset of current.assets) if (!byId.has(asset.id)) byId.set(asset.id, asset)
  const records = new Map([...current.components.proj.records, ...history].map(record => [record.id, record]))
  const oldestFirst = [...records.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const renderOutputs = new Set<string>()
  for (const record of oldestFirst) {
    if (record.operation !== null && RENDER_OPERATIONS.has(record.operation)) for (const id of record.outputs) renderOutputs.add(id)
    // The asset pool keeps the name and time of the first import of identical bytes in any project; show this
    // project's own import name and time, read from its `asset.import` records.
    if (record.status !== 'done' || record.operation !== 'asset.import') continue
    const name = record.params['name']
    for (const id of record.outputs) {
      const asset = byId.get(id)
      if (asset === undefined) continue
      byId.set(id, { ...asset, created_at: record.created_at, ...(typeof name === 'string' && name.length > 0 ? { name } : {}) })
    }
  }
  const assets = [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const images = assets.filter(asset => asset.mime.startsWith('image/'))
  const videos = assets.filter(asset => asset.mime.startsWith('video/'))
  return {
    images: images.filter(asset => !renderOutputs.has(asset.id)),
    videos,
    extracted: images.filter(asset => renderOutputs.has(asset.id)),
  }
}
