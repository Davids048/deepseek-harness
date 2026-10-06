/**
 * The JSON the browser views receive: the state of one branch with the asset records it references, the branch heads
 * and branches (with the counts of each open draft), and the tool declarations the canvas turns into parameter forms.
 * Records keep the field names the views read (`tool`, `base_op`, `resolved`, `cost.gpu_s`), converted from the
 * Project record format into the field names that the views read.
 *
 * @module @video-harness/views/wire
 */
import type { AssetMeta } from '@video-harness/assets'
import type { AssetId, Branch, ProjectId, ProjectInfo, ProjectRecord, ProjectState, RecordInputRef } from '@dv/project'
import type { ToolSpec } from '@video-harness/tools'

/** One input of a record as the views read it: the reference as text and the asset it stood for. */
export interface WireInput {
  role: string
  /** An asset ID, `<record>#<output>`, or `<character|location|style>@<version>`. */
  ref: string
  resolved: AssetId | null
}

/** One record as the views read it. */
export interface WireOp {
  id: string
  parents: string[]
  /** The agent turn; null for direct human actions. */
  turn: string | null
  /** The chat session of the action; null outside any chat session. */
  session: string | null
  branch: string
  actor: ProjectRecord['actor']
  surface: ProjectRecord['surface']
  intent: string
  kind: ProjectRecord['kind']
  /** The operation; absent on a request record. */
  tool?: { name: string; version: string }
  inputs: WireInput[]
  params: Record<string, unknown>
  outputs: AssetId[]
  status: ProjectRecord['status']
  base_op?: string
  supersedes: string[]
  cost?: { gpu_s: number; wall_s: number; cached: boolean }
  report?: Record<string, unknown>
  deterministic: boolean
  created_at: string
  finished_at?: string
  /** Why the call failed or was cancelled, in words a creator can read. */
  error?: string
}

/** The state of one branch as the views read it. */
export interface WireState {
  project: { projectId: ProjectId; title: string; createdAt: string }
  head: string
  /** The head record of every branch, by branch name. */
  heads: Record<string, string>
  /** Every branch of the project; an open draft has `counts`. */
  branches: Branch[]
  ops: WireOp[]
  /** The records of every asset a record created, imported, or still references. */
  assets: AssetMeta[]
  entities: ProjectState['components']['bible']['entities']
  sequence: ProjectState['components']['timeline']['sequence']
  sequences: ProjectState['components']['timeline']['sequences']
  /** Stale records: record → the record whose change made it stale. */
  stale: Record<string, { because: string }>
  superseded: Record<string, string>
  takes: ProjectState['components']['shot']['takes']
  plans: ProjectState['components']['plan']['plans']
  /** The record that created each asset, by asset. */
  producers: Record<string, string>
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
  /** The scheduler class: `free` for operations that use no CPU or GPU slot. */
  cost: 'free' | 'cpu' | 'gpu'
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
 * A record input reference as the text the views and the agent read.
 * @param ref - the reference.
 * @returns an asset ID, `<record>#<output>`, or `<id>@<version>`.
 */
export function refText(ref: RecordInputRef): string {
  if ('asset' in ref) return ref.asset
  if ('record' in ref) return `${ref.record}#${String(ref.output)}`
  const id = 'character' in ref ? ref.character : 'location' in ref ? ref.location : ref.style
  return `${id}@${String(ref.version)}`
}

/**
 * Convert one record into the form the views read.
 * @param record - a record in its current form.
 * @returns the wire record.
 */
export function toWireOp(record: ProjectRecord): WireOp {
  return {
    id: record.id, parents: record.parents, turn: record.turn, session: record.session, branch: record.branch,
    actor: record.actor, surface: record.surface, intent: record.intent, kind: record.kind,
    ...record.operation === null ? {} : { tool: { name: record.operation, version: record.operation_version ?? '' } },
    inputs: record.inputs.map(input => ({ role: input.role, ref: refText(input.ref), resolved: input.resolved_asset })),
    params: record.params, outputs: record.outputs, status: record.status,
    ...record.based_on === null ? {} : { base_op: record.based_on },
    supersedes: record.supersedes,
    ...record.cost === undefined
      ? {}
      : { cost: { gpu_s: record.cost.gpu_seconds, wall_s: record.cost.wall_seconds, cached: record.cost.reused } },
    ...record.report === undefined ? {} : { report: record.report },
    deterministic: record.deterministic, created_at: record.created_at,
    ...record.finished_at === undefined ? {} : { finished_at: record.finished_at },
    ...record.error === undefined ? {} : { error: record.error.message },
  }
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
  for (const versions of Object.values(state.components.bible.entities)) {
    for (const version of versions) for (const id of version.refs) seen.add(id)
  }
  for (const timeline of state.components.timeline.sequences) for (const item of timeline.items) seen.add(item.assetId)
  return [...seen]
}

/**
 * Turn a branch state into the wire form.
 * @param project - the project's metadata.
 * @param state - the branch state.
 * @param branches - the project's branches.
 * @param asset - looks an asset record up; unknown IDs return null and are left out.
 * @returns the wire state.
 */
export function toWireState(
  project: ProjectInfo,
  state: ProjectState,
  branches: Branch[],
  asset: (id: AssetId) => AssetMeta | null,
): WireState {
  const assets: AssetMeta[] = []
  for (const id of mentionedAssets(state)) {
    const meta = asset(id)
    if (meta !== null) assets.push(meta)
  }
  const { proj, bible, timeline, shot, plan } = state.components
  const stale: WireState['stale'] = {}
  for (const [record, because] of Object.entries(proj.stale)) stale[record] = { because }
  return {
    project: { projectId: project.id, title: project.title, createdAt: project.created_at },
    head: state.head,
    heads: Object.fromEntries(branches.map(branch => [branch.name, branch.head])),
    branches,
    ops: proj.records.map(toWireOp),
    assets,
    entities: bible.entities,
    sequence: timeline.sequence,
    sequences: timeline.sequences,
    stale,
    superseded: proj.superseded,
    takes: shot.takes,
    plans: plan.plans,
    producers: proj.created_by,
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
    cost: spec.resource === 'none' ? 'free' : spec.resource,
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
