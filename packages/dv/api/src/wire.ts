/**
 * The JSON the browser receives: the state of one branch (`ProjectState` with its component slices sent verbatim) with
 * the asset pool entries it references, the branch heads and branches (with the counts of each open draft), the history
 * list, and the operation declarations the canvas turns into parameter forms. Records travel as `ProjectRecord`, unchanged.
 *
 * @module @dv/api/wire
 */
import type { Asset } from '@dv/asset-pool'
import type {
  AssetId, Branch, ComponentStates, HistoryEntry, OperationSpec, ProjectId, ProjectInfo, ProjectRecord, ProjectState, RecordId,
} from '@dv/project'
import type {} from '@dv/shot-plan'
import type {} from '@dv/shot-render'
import type {} from '@dv/story-bible'
import type {} from '@dv/timeline'

/** The state of one branch as the browser reads it. */
export interface WireState {
  project: ProjectInfo
  /** The branch the state is for. */
  branch: string
  /** The branch's head record. */
  head: RecordId
  /** The head record of every branch, by branch name. */
  heads: Record<string, RecordId>
  /** Every branch of the project; an open draft has `counts`. */
  branches: Branch[]
  /** One slice per registered reducer, as Project computed them. */
  components: ComponentStates
  /** The steps that redo brings back on the branch, oldest first (`ProjectState.redo_steps`). */
  redo_steps: RecordId[]
  /** The asset pool entry of every asset a record created, imported, or still references. */
  assets: Asset[]
}

/** The history list as the browser reads it (`POST /api/dv/history`). */
export interface WireHistory {
  /** The entries, newest first, as `dvProject.listHistory` returns them. */
  entries: HistoryEntry[]
  /** The `request` record of every turn that has a record in `entries`, by turn. */
  requests: Record<string, ProjectRecord>
  /** The asset pool entry of every asset the entries name as an output or a resolved input. */
  assets: Asset[]
}

/** An operation declaration without its executable parts. */
export interface WireOperation {
  name: string
  version: string
  description: string
  inputs: OperationSpec['inputs']
  params: OperationSpec['params']
  outputs: OperationSpec['outputs']
  deterministic: boolean
  /** The scheduler class: `none` for operations that wait in neither the CPU nor the GPU queue. */
  resource: OperationSpec['resource']
  confirm: OperationSpec['confirm']
}

/** What a view last selected in a project, so the agent integration can resolve "this one". */
export interface ViewSelection {
  kind: 'record' | 'clip' | 'asset' | 'character' | 'location' | 'style'
  /** The `RecordId`, `ClipId`, `AssetId`, or character, location or style ID. */
  id: string
  surface: 'canvas' | 'timeline' | 'asset_pool'
  /** ISO-8601 UTC of the selection. */
  at: string
}

/**
 * Collect every asset a state mentions: created assets, record outputs, resolved inputs, character, location and
 * style references, and timeline clips. Records that failed before creating anything add nothing.
 * @param state - a branch state.
 * @returns the asset IDs, each once, in first-mention order.
 */
export function mentionedAssets(state: ProjectState): AssetId[] {
  const seen = new Set<AssetId>(Object.keys(state.components.proj.created_by) as AssetId[])
  for (const record of state.components.proj.records) {
    for (const id of record.outputs) seen.add(id)
    for (const input of record.inputs) if (input.resolved_asset !== null) seen.add(input.resolved_asset)
  }
  const { characters, locations, styles } = state.components.bible
  for (const versions of [...Object.values(characters), ...Object.values(locations), ...Object.values(styles)]) {
    for (const version of versions) for (const id of version.references) seen.add(id)
  }
  // A placeholder clip has no asset until its render is done.
  for (const timeline of state.components.timeline.timelines) {
    for (const clip of timeline.clips) if (clip.asset !== null) seen.add(clip.asset)
  }
  return [...seen]
}

/**
 * Turn a branch state into the wire form.
 * @param state - the branch state.
 * @param branches - the project's branches.
 * @param asset - looks an asset up; unknown IDs return null and are left out.
 * @returns the wire state.
 */
export function toWireState(state: ProjectState, branches: Branch[], asset: (id: AssetId) => Asset | null): WireState {
  const assets = mentionedAssets(state).flatMap((id) => {
    const found = asset(id)
    return found === null ? [] : [found]
  })
  return {
    project: state.project,
    branch: state.branch,
    head: state.head,
    heads: Object.fromEntries(branches.map(branch => [branch.name, branch.head])),
    branches,
    components: state.components,
    redo_steps: state.redo_steps,
    assets,
  }
}

/**
 * Strip an operation spec to its declaration.
 * @param spec - a registered operation.
 * @returns the wire declaration.
 */
export function toWireOperation(spec: OperationSpec): WireOperation {
  return {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    inputs: spec.inputs,
    params: spec.params,
    outputs: spec.outputs,
    deterministic: spec.deterministic,
    resource: spec.resource,
    confirm: spec.confirm,
  }
}

/**
 * The project ID a request names, or null when it is missing or malformed.
 * @param value - the raw query or body value.
 * @returns the project ID.
 */
export function projectIdOf(value: unknown): ProjectId | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? (value as ProjectId) : null
}
