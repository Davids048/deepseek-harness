/**
 * The assets a project imported, and which assets can go on its canvas. An imported asset counts from the whole
 * history, discarded steps included; a generated asset counts only while a record of the current state created it.
 *
 * @module @dv/asset-pool/imports
 */
import type { AssetId, ProjectRecord, ProjectState } from '@dv/project'

/**
 * The project's first finished `asset.import` record of each asset it imported.
 * @param records - every record of the project, oldest first, discarded records included.
 * @returns asset ID → the first finished `asset.import` record that output it.
 */
export function importedAssets(records: readonly ProjectRecord[]): Map<AssetId, ProjectRecord> {
  const imported = new Map<AssetId, ProjectRecord>()
  for (const record of records) {
    if (record.operation !== 'asset.import' || record.status !== 'done') continue
    for (const id of record.outputs) if (!imported.has(id)) imported.set(id, record)
  }
  return imported
}

/**
 * Whether an asset can go on the project's canvas: the project imported it anywhere in its history, or a record of the
 * current state created it.
 * @param state - the project's current state.
 * @param imported - the project's imported assets, as {@link importedAssets} returns them.
 * @param asset - the asset.
 * @returns true when the asset can go on the canvas.
 */
export function placeable(state: ProjectState, imported: ReadonlyMap<AssetId, unknown>, asset: AssetId): boolean {
  return imported.has(asset) || asset in state.components.proj.created_by
}
