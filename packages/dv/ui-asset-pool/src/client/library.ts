/**
 * Grouping of a project's images and videos, with the images that shot renders output apart, read from the state of
 * `main` and the states of the project's open drafts.
 *
 * @module @dv/ui-asset-pool/library
 */
import type { Asset, WireState } from '@dv/ui-kit/types.ts'

/** The state of one open draft branch. */
export interface DraftState {
  /** The `draft/<session>` branch name. */
  branch: string
  state: WireState
}

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
  /** IDs of the listed assets that only an open draft mentions. */
  draft: Set<string>
}

/**
 * Group a project's images and videos, with the images of shot renders apart; assets of other media types are left out.
 * @param main - the state of `main`.
 * @param drafts - the states of the project's open drafts; their assets are listed and flagged as drafts.
 * @returns the groups and draft flags.
 */
export function assetLibrary(main: WireState, drafts: readonly DraftState[] = []): AssetLibrary {
  const states = [main, ...drafts.map(draft => draft.state)]
  const byId = new Map<string, Asset>()
  for (const state of states) {
    for (const asset of state.assets) if (!byId.has(asset.id)) byId.set(asset.id, asset)
  }
  const renderOutputs = new Set<string>()
  for (const state of states) {
    for (const record of state.components.proj.records) {
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
  }
  const assets = [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const onMain = new Set(main.assets.map(asset => asset.id))
  const images = assets.filter(asset => asset.mime.startsWith('image/'))
  const videos = assets.filter(asset => asset.mime.startsWith('video/'))
  return {
    images: images.filter(asset => !renderOutputs.has(asset.id)),
    videos,
    extracted: images.filter(asset => renderOutputs.has(asset.id)),
    draft: new Set([...images, ...videos].map(asset => asset.id).filter(id => !onMain.has(id))),
  }
}
