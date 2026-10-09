/**
 * The JSON the browser receives: the project's current state (`ProjectState` with its component slices sent verbatim)
 * with the asset pool entries of the whole project, the history list, and the operation declarations the canvas turns
 * into parameter forms. Records travel as `ProjectRecord`, unchanged.
 *
 * @module @dv/api/wire
 */
import type { Asset } from '@dv/asset-pool'
import type {
  AssetId, ComponentStates, HistoryEntry, OperationSpec, ProjectId, ProjectInfo, ProjectRecord, ProjectState, RecordId,
} from '@dv/project'
import type {} from '@dv/shot-plan'
import type {} from '@dv/shot-render'
import type {} from '@dv/story-bible'
import type {} from '@dv/timeline'

/** The project's current state as the browser reads it. */
export interface WireState {
  project: ProjectInfo
  /** The project's last record. */
  head: RecordId
  /** One slice per registered reducer, as Project computed them. */
  components: ComponentStates
  /**
   * The asset pool entry of every asset a record of the project created or names, anywhere in the history, and every
   * asset the current state references; the asset pool keeps them all.
   */
  assets: Asset[]
}

/** The history list as the browser reads it (`POST /api/dv/history`). */
export interface WireHistory {
  /** The entries, newest first, as `dvProject.listHistory` returns them. */
  entries: HistoryEntry[]
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

/**
 * Collect every asset a project mentions: the outputs and resolved inputs of every record of its history, the created
 * assets of the state, and the character, location and style references and timeline clips of the state. Records that
 * failed before creating anything add nothing.
 * @param state - the project's current state.
 * @param records - every record of the project.
 * @returns the asset IDs, each once, in first-mention order.
 */
export function mentionedAssets(state: ProjectState, records: readonly ProjectRecord[]): AssetId[] {
  const seen = new Set<AssetId>(Object.keys(state.components.proj.created_by) as AssetId[])
  for (const record of records) {
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
 * Turn the project's current state into the wire form.
 * @param state - the current state.
 * @param records - every record of the project, for the assets of the whole history.
 * @param asset - looks an asset up; unknown IDs return null and are left out.
 * @returns the wire state.
 */
export function toWireState(state: ProjectState, records: readonly ProjectRecord[], asset: (id: AssetId) => Asset | null): WireState {
  const assets = mentionedAssets(state, records).flatMap((id) => {
    const found = asset(id)
    return found === null ? [] : [found]
  })
  return { project: state.project, head: state.head, components: state.components, assets }
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
