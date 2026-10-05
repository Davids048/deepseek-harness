/**
 * The JSON the browser views receive: the folded project state with the asset records it references, the branch
 * heads, and the tool declarations the canvas turns into parameter forms. Sets become arrays and nothing else changes,
 * so a view can reason about the state the way the runtime does.
 *
 * @module @video-harness/views/wire
 */
import type { AssetId, AssetMeta } from '@video-harness/assets'
import type { Op, OpId, ProjectId, ProjectInfo } from '@video-harness/oplog'
import type { ProjectState } from '@video-harness/runtime'
import type { ToolSpec } from '@video-harness/tools'

/** The folded state of one branch or record as the views read it. */
export interface WireState {
  project: ProjectInfo
  head: OpId
  /** The branch heads of the project; a `draft/<turn>` head belongs to an open or abandoned agent turn. */
  heads: Record<string, OpId>
  ops: Op[]
  /** The records of every asset a record produced, uploaded, or still references. */
  assets: AssetMeta[]
  entities: ProjectState['entities']
  sequence: ProjectState['sequence']
  sequences: ProjectState['sequences']
  stale: ProjectState['stale']
  superseded: ProjectState['superseded']
  turns: ProjectState['turns']
  takes: ProjectState['takes']
  plans: ProjectState['plans']
  /** The asset each record produced, by asset. */
  producers: ProjectState['producers']
}

/** A tool declaration without its executable parts. */
export interface WireToolSpec {
  name: string
  version: string
  summary: string
  inputs: ToolSpec['inputs']
  params: ToolSpec['params']
  outputs: ToolSpec['outputs']
  deterministic: boolean
  cost: ToolSpec['cost']
  confirm: ToolSpec['confirm']
}

/** What a view last selected in a project, so the agent's resolver can read "this one". */
export interface ViewSelection {
  kind: 'op' | 'clip' | 'asset' | 'entity'
  id: string
  /** The timeline slot when a clip was selected. */
  slot?: number
  surface: 'canvas' | 'timeline'
  /** ISO-8601 UTC of the selection. */
  at: string
}

/**
 * Collect every asset a state mentions: produced or uploaded assets, record outputs, resolved inputs, entity references,
 * and sequence clips. Records that failed before producing anything add nothing.
 * @param state - a folded state.
 * @returns the asset IDs, each once, in first-mention order.
 */
export function mentionedAssets(state: ProjectState): AssetId[] {
  const seen = new Set<AssetId>(state.assets)
  for (const op of state.ops) {
    for (const id of op.outputs) seen.add(id)
    for (const input of op.inputs) if (input.resolved !== null) seen.add(input.resolved)
  }
  for (const versions of Object.values(state.entities)) {
    for (const version of versions) for (const id of version.refs) seen.add(id)
  }
  for (const sequence of state.sequences) for (const item of sequence.items) seen.add(item.assetId)
  return [...seen]
}

/**
 * Turn a folded state into the wire form.
 * @param project - the project's record.
 * @param state - the folded state.
 * @param heads - the project's branch heads.
 * @param asset - looks an asset record up; unknown IDs return null and are left out.
 * @returns the wire state.
 */
export function toWireState(
  project: ProjectInfo,
  state: ProjectState,
  heads: Record<string, OpId>,
  asset: (id: AssetId) => AssetMeta | null,
): WireState {
  const assets: AssetMeta[] = []
  for (const id of mentionedAssets(state)) {
    const meta = asset(id)
    if (meta !== null) assets.push(meta)
  }
  return {
    project,
    head: state.head,
    heads,
    ops: state.ops,
    assets,
    entities: state.entities,
    sequence: state.sequence,
    sequences: state.sequences,
    stale: state.stale,
    superseded: state.superseded,
    turns: state.turns,
    takes: state.takes,
    plans: state.plans,
    producers: state.producers,
  }
}

/**
 * Strip a tool spec to its declaration.
 * @param spec - a registered tool.
 * @returns the wire spec.
 */
export function toWireToolSpec(spec: ToolSpec): WireToolSpec {
  return {
    name: spec.name,
    version: spec.version,
    summary: spec.summary,
    inputs: spec.inputs,
    params: spec.params,
    outputs: spec.outputs,
    deterministic: spec.deterministic,
    cost: spec.cost,
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
