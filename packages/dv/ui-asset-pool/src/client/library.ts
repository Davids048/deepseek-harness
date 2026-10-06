/**
 * Sorting of a project's assets into the panel's sections and filters, read from the state of `main` and the states of
 * the project's open drafts.
 *
 * @module @dv/ui-asset-pool/library
 */
import type { Asset, ProjectRecord, StoryBibleState, WireState } from '@dv/ui-kit/types.ts'

/** The state of one open draft branch. */
export interface DraftState {
  /** The `draft/<session>` branch name. */
  branch: string
  state: WireState
}

/** The panel's view of one project's assets. */
export interface AssetLibrary {
  /** Images that the latest version of a character references. */
  characters: Asset[]
  /** Imported files and the reference images of locations and styles, without characters. */
  references: Asset[]
  /** Takes: the videos of `shot.render` records, newest first. */
  rendered: Asset[]
  /** The videos of `deliver.timeline_export` records, newest first. */
  exports: Asset[]
  /** Outputs of `asset.import` records, newest first. */
  imported: Asset[]
  /** IDs of the listed assets that only an open draft mentions. */
  draft: Set<string>
}

/** The records, assets and story bible of `main` with the open drafts merged in. */
interface MergedState {
  records: ProjectRecord[]
  assets: Asset[]
  bible: StoryBibleState
}

/**
 * Merge the open drafts into the state of `main`: records, assets, and character, location and style versions that
 * `main` lacks.
 * @param main - the state of `main`.
 * @param drafts - the states of the draft branches.
 * @returns the merged records, assets, and story bible.
 */
function mergeDrafts(main: WireState, drafts: readonly DraftState[]): MergedState {
  const records: ProjectRecord[] = [...main.components.proj.records]
  const assets: Asset[] = [...main.assets]
  const bible: StoryBibleState = {
    characters: { ...main.components.bible.characters },
    locations: { ...main.components.bible.locations },
    styles: { ...main.components.bible.styles },
  }
  const knownRecords = new Set(records.map(record => record.id))
  const knownAssets = new Set(assets.map(asset => asset.id))
  for (const { state } of drafts) {
    for (const record of state.components.proj.records) {
      if (!knownRecords.has(record.id)) { knownRecords.add(record.id); records.push(record) }
    }
    for (const asset of state.assets) if (!knownAssets.has(asset.id)) { knownAssets.add(asset.id); assets.push(asset) }
    for (const kind of ['characters', 'locations', 'styles'] as const) {
      for (const [id, versions] of Object.entries(state.components.bible[kind])) {
        if ((bible[kind][id]?.length ?? 0) < versions.length) bible[kind][id] = versions
      }
    }
  }
  return { records, assets, bible }
}

/**
 * Sort a project's assets.
 * @param main - the state of `main`.
 * @param drafts - the states of the project's open drafts; their assets are listed and flagged as drafts.
 * @returns the sections, filters, and draft flags.
 */
export function assetLibrary(main: WireState, drafts: readonly DraftState[] = []): AssetLibrary {
  const state = mergeDrafts(main, drafts)
  const onMain = new Set(main.assets.map(asset => asset.id))
  const byId = new Map(state.assets.map(asset => [asset.id, asset]))
  // The asset pool keeps the name and time of the first import of identical bytes in any project; show this project's
  // own import name and time, read from its `asset.import` records.
  for (const record of state.records) {
    if (record.status !== 'done' || record.operation !== 'asset.import') continue
    const name = record.params['name']
    for (const id of record.outputs) {
      const asset = byId.get(id)
      if (asset !== undefined) byId.set(id, { ...asset, created_at: record.created_at, ...(typeof name === 'string' && name.length > 0 ? { name } : {}) })
    }
  }
  const pick = (ids: Iterable<string>): Asset[] => {
    const seen = new Set<string>()
    const rows: Asset[] = []
    for (const id of ids) {
      const asset = byId.get(id)
      if (asset === undefined || seen.has(id)) continue
      seen.add(id)
      rows.push(asset)
    }
    return rows.sort((a, b) => b.created_at.localeCompare(a.created_at))
  }
  const characterIds = new Set<string>()
  const bibleReferenceIds = new Set<string>()
  for (const kind of ['characters', 'locations', 'styles'] as const) {
    for (const versions of Object.values(state.bible[kind])) {
      const latest = versions.at(-1)
      if (latest === undefined) continue
      for (const reference of latest.references) (kind === 'characters' ? characterIds : bibleReferenceIds).add(reference)
    }
  }
  const importedIds: string[] = []
  const renderedIds: string[] = []
  const exportIds: string[] = []
  for (const record of state.records) {
    if (record.status !== 'done' || record.operation === null) continue
    if (record.operation === 'asset.import') { importedIds.push(...record.outputs); continue }
    const videos = record.outputs.filter(id => byId.get(id)?.mime.startsWith('video/') === true)
    if (record.operation === 'shot.render') renderedIds.push(...videos)
    else if (record.operation === 'deliver.timeline_export') exportIds.push(...videos)
  }
  return {
    characters: pick(characterIds),
    references: pick([...importedIds, ...bibleReferenceIds].filter(id => !characterIds.has(id) && !renderedIds.includes(id))),
    rendered: pick(renderedIds),
    exports: pick(exportIds),
    imported: pick(importedIds),
    draft: new Set(state.assets.map(asset => asset.id).filter(id => !onMain.has(id))),
  }
}
