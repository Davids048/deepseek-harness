/**
 * Sorting of a project's assets into the panel's sections and filters, read from the folded state of `main` and the
 * folded states of the project's open drafts.
 */
import type { WireAsset, WireOp, WireState } from '@video-harness/ui-kit/types.ts'

/** The folded state of one open draft branch. */
export interface DraftState {
  /** The `draft/<session>` branch name. */
  branch: string
  state: WireState
}

/** The panel's view of one project's assets. */
export interface AssetLibrary {
  /** Images that the latest version of a character entity references. */
  characters: WireAsset[]
  /** Uploaded media and other entities' reference images, without characters. */
  references: WireAsset[]
  /** Videos that a generation or edit record produced, newest first. */
  generated: WireAsset[]
  /** Outputs of `asset.upload` records, newest first. */
  uploads: WireAsset[]
  /** IDs of the listed assets that only an open draft mentions. */
  draft: Set<string>
}

/**
 * Merge the open drafts into the state of `main`: records, assets, and entity versions that `main` lacks.
 * @param main - the folded state of `main`.
 * @param drafts - the folded states of the draft branches.
 * @returns the merged records, assets, and entities.
 */
function mergeDrafts(main: WireState, drafts: readonly DraftState[]): Pick<WireState, 'ops' | 'assets' | 'entities'> {
  const ops: WireOp[] = [...main.ops]
  const assets: WireAsset[] = [...main.assets]
  const entities = { ...main.entities }
  const knownOps = new Set(ops.map(op => op.id))
  const knownAssets = new Set(assets.map(asset => asset.id))
  for (const { state } of drafts) {
    for (const op of state.ops) if (!knownOps.has(op.id)) { knownOps.add(op.id); ops.push(op) }
    for (const asset of state.assets) if (!knownAssets.has(asset.id)) { knownAssets.add(asset.id); assets.push(asset) }
    for (const [name, versions] of Object.entries(state.entities)) {
      if ((entities[name]?.length ?? 0) < versions.length) entities[name] = versions
    }
  }
  return { ops, assets, entities }
}

/**
 * Sort a project's assets.
 * @param main - the folded state of `main`.
 * @param drafts - the folded states of the project's open drafts; their assets are listed and flagged as drafts.
 * @returns the sections, filters, and draft flags.
 */
export function assetLibrary(main: WireState, drafts: readonly DraftState[] = []): AssetLibrary {
  const state = mergeDrafts(main, drafts)
  const onMain = new Set(main.assets.map(asset => asset.id))
  const byId = new Map(state.assets.map(asset => [asset.id, asset]))
  // The store keeps the name and time of the first upload of identical bytes in any project; show this project's own
  // upload name and time, read from its `asset.upload` records.
  for (const op of state.ops) {
    if (op.status !== 'done' || op.tool?.name !== 'asset.upload') continue
    const name = op.params['name']
    for (const id of op.outputs) {
      const asset = byId.get(id)
      if (asset !== undefined) byId.set(id, { ...asset, createdAt: op.created_at, ...(typeof name === 'string' && name.length > 0 ? { name } : {}) })
    }
  }
  const pick = (ids: Iterable<string>): WireAsset[] => {
    const seen = new Set<string>()
    const rows: WireAsset[] = []
    for (const id of ids) {
      const asset = byId.get(id)
      if (asset === undefined || seen.has(id)) continue
      seen.add(id)
      rows.push(asset)
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  const characterIds = new Set<string>()
  const entityRefIds = new Set<string>()
  for (const versions of Object.values(state.entities)) {
    const latest = versions.at(-1)
    if (latest === undefined) continue
    for (const ref of latest.refs) (latest.kind === 'character' ? characterIds : entityRefIds).add(ref)
  }
  const uploadIds: string[] = []
  const generatedIds: string[] = []
  for (const op of state.ops) {
    if (op.status !== 'done' || op.tool === undefined) continue
    if (op.tool.name === 'asset.upload') { uploadIds.push(...op.outputs); continue }
    for (const id of op.outputs) {
      if (byId.get(id)?.mime.startsWith('video/')) generatedIds.push(id)
    }
  }
  const generated = pick(generatedIds)
  return {
    characters: pick(characterIds),
    references: pick([...uploadIds, ...entityRefIds].filter(id => !characterIds.has(id) && !generatedIds.includes(id))),
    generated,
    uploads: pick(uploadIds),
    draft: new Set(state.assets.map(asset => asset.id).filter(id => !onMain.has(id))),
  }
}
