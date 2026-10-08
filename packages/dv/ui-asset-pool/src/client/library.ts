/**
 * Grouping of a project's images and videos, with the images that shot renders output apart, read from the state of
 * the project's current branch and, when the panel shows them, the assets that only other branches or the current
 * branch's redo steps hold.
 *
 * @module @dv/ui-asset-pool/library
 */
import { entryBranch } from '@dv/ui-kit/state.ts'
import type { Asset, ProjectRecord, WireHistory, WireState } from '@dv/ui-kit/types.ts'

/** The assets outside the current branch's head: what the history lists for other branches and for redo steps. */
export interface OtherBranchAssets {
  /** The assets, each once. */
  assets: Asset[]
  /** The records that output them, for import names and render stills; none of them outputs only listed assets. */
  records: ProjectRecord[]
  /** Asset ID → the name of the branch the asset comes from. */
  branchOf: Map<string, string>
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
}

/**
 * The assets that the history lists outside the current branch's head, without the ones the current state lists. An
 * asset belongs to the branch of the record that output it (`entryBranch`), so a redo step's asset belongs to the
 * current branch.
 * @param history - the `redo` and `branch` entries of the project's history.
 * @param current - the state of the current branch.
 * @returns the assets, their records, and the branch of each asset.
 */
export function otherBranchAssets(history: WireHistory, current: WireState): OtherBranchAssets {
  const shown = new Set(current.assets.map(asset => asset.id))
  const known = new Map(history.assets.map(asset => [asset.id, asset]))
  const branchOf = new Map<string, string>()
  const records: ProjectRecord[] = []
  for (const entry of history.entries) {
    const branch = entryBranch(entry, current.current)
    if (branch === null) continue
    const added = entry.record.outputs.filter(id => !shown.has(id) && known.has(id) && !branchOf.has(id))
    for (const id of added) branchOf.set(id, branch)
    // Only a record that adds an asset can name it; the current branch's own records name the assets it lists.
    if (added.length > 0) records.push(entry.record)
  }
  return { assets: [...branchOf.keys()].flatMap(id => known.get(id) ?? []), records, branchOf }
}

/**
 * Group a project's images and videos, with the images of shot renders apart; assets of other media types are left out.
 * @param current - the state of the project's current branch.
 * @param others - the assets of other branches and redo steps, when the panel shows them.
 * @returns the groups.
 */
export function assetLibrary(current: WireState, others: OtherBranchAssets | null = null): AssetLibrary {
  const byId = new Map<string, Asset>()
  for (const asset of [...current.assets, ...others?.assets ?? []]) if (!byId.has(asset.id)) byId.set(asset.id, asset)
  const renderOutputs = new Set<string>()
  for (const record of [...current.components.proj.records, ...others?.records ?? []]) {
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
