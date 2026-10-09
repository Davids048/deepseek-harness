/**
 * Grouping of a project's images and videos, with the images that shot renders output apart. The assets come from the
 * project state: every asset the current state holds, and every asset the project imported anywhere in its history,
 * each with this project's own import name and time and the operation that made it (`made_by`). A generated asset of a
 * step that an undo went back past is not listed; an imported asset always is.
 *
 * @module @dv/ui-asset-pool/library
 */
import type { ProjectAsset, WireState } from '@dv/ui-kit/types.ts'

/** The shot render operations whose image outputs (the last stills of takes) the panel lists under `extracted`. */
const RENDER_OPERATIONS: ReadonlySet<string> = new Set(['shot.render_ref2va', 'shot.render_t2va'])

/** The panel's view of one project's assets: every image and video once, grouped, newest first. */
export interface AssetLibrary {
  /** Assets whose media type is `image/*`, except the images in `extracted`. */
  images: ProjectAsset[]
  /** Assets whose media type is `video/*`. */
  videos: ProjectAsset[]
  /** Images that a `shot.render_ref2va` or `shot.render_t2va` record made. */
  extracted: ProjectAsset[]
}

/**
 * Group a project's images and videos, with the images of shot renders apart; assets of other media types are left out.
 * @param current - the project's current state.
 * @returns the groups.
 */
export function assetLibrary(current: WireState): AssetLibrary {
  const assets = [...current.assets].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const images = assets.filter(asset => asset.mime.startsWith('image/'))
  const videos = assets.filter(asset => asset.mime.startsWith('video/'))
  const rendered = (asset: ProjectAsset): boolean => asset.made_by !== null && RENDER_OPERATIONS.has(asset.made_by)
  return { images: images.filter(asset => !rendered(asset)), videos, extracted: images.filter(rendered) }
}
