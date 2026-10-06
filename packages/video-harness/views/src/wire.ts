/**
 * The JSON the browser views receive: the state of one branch with the asset records it references, the branch heads
 * and branches (with the counts of each open draft), and the tool declarations the canvas turns into parameter forms.
 * Records keep the field names the views read (`tool`, `base_op`, `resolved`, `cost.gpu_s`), converted from the
 * Project record format into the field names that the views read.
 *
 * @module @video-harness/views/wire
 */
import type { Asset } from '@dv/asset-pool'
import {
  formatInputRef, type AssetId, type Branch, type OperationSpec, type ProjectId, type ProjectInfo, type ProjectRecord,
  type ProjectState, type RecordId,
} from '@dv/project'
import type {} from '@dv/shot-plan'
import type {} from '@dv/shot-render'
import type { Character, Location, StoryBibleState, Style } from '@dv/story-bible'
import type { Timeline } from '@dv/timeline'

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
  assets: WireAsset[]
  /**
   * Every version of each character, location and style by ID, in the wire names the views read until stage 4
   * (`kind`, `refs`, `updatedBy`). names:allow
   */
  entities: Record<string, WireBibleVersion[]> // names:allow
  /**
   * The first timeline's clips, in the wire names the views read until stage 4: each clip's 1-based position, asset,
   * and in and out points. names:allow
   */
  sequence: { items: Array<{ slot: number; assetId: AssetId; inSec: number | null; outSec: number | null }> } | null // names:allow
  /** Every timeline, in creation order, with its clips in the same wire names. names:allow */
  sequences: Array<{ id: string; title: string; items: NonNullable<WireState['sequence']>['items'] }> // names:allow
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
  inputs: OperationSpec['inputs']
  params: OperationSpec['params']
  outputs: OperationSpec['outputs']
  deterministic: boolean
  /** The scheduler class: `free` for operations that use no CPU or GPU slot. */
  cost: 'free' | 'cpu' | 'gpu'
  confirm: OperationSpec['confirm']
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
 * Convert one record into the form the views read.
 * @param record - a record in its current form.
 * @returns the wire record.
 */
export function toWireOp(record: ProjectRecord): WireOp {
  return {
    id: record.id, parents: record.parents, turn: record.turn, session: record.session, branch: record.branch,
    actor: record.actor, surface: record.surface, intent: record.intent, kind: record.kind,
    ...record.operation === null ? {} : { tool: { name: record.operation, version: record.operation_version ?? '' } },
    inputs: record.inputs.map(input => ({ role: input.role, ref: formatInputRef(input.ref), resolved: input.resolved_asset })),
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
 * Convert one timeline of the `timeline` slice into the wire names the views read.
 * @param timeline - a timeline.
 * @returns its ID, its name (wire field `title`) and its clips with their positions.
 */
function toWireTimeline(timeline: Timeline): WireState['sequences'][number] { // names:allow
  const items = timeline.clips.map((clip, index) => ({
    slot: index + 1, assetId: clip.asset, inSec: clip.in_sec, outSec: clip.out_sec, // names:allow
  }))
  return { id: timeline.id, title: timeline.name, items }
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
  for (const timeline of state.components.timeline.timelines) for (const clip of timeline.clips) seen.add(clip.asset)
  return [...seen]
}

/** One version of a character, location or style in the field names the views read (renamed in stage 4). */
interface WireBibleVersion {
  kind: 'character' | 'location' | 'style'
  version: number
  name: string
  description: string
  refs: AssetId[]
  updatedBy: RecordId
}

/**
 * Convert the `bible` slice into the wire form: one map of every character, location and style by ID.
 * @param bible - the slice.
 * @returns the versions by ID, each with its kind.
 */
function toWireBible(bible: StoryBibleState): WireState['entities'] { // names:allow
  const wire: WireState['entities'] = {} // names:allow
  const kinds = [['character', bible.characters], ['location', bible.locations], ['style', bible.styles]] as const
  for (const [kind, byId] of kinds) {
    for (const [id, versions] of Object.entries(byId) as Array<[string, Array<Character | Location | Style>]>) {
      wire[id] = versions.map(version => ({
        kind, version: version.version, name: version.name, description: version.description, refs: version.references,
        updatedBy: version.created_by,
      }))
    }
  }
  return wire
}

/** One asset of the asset pool in the field names the views read (renamed with the other wire names in stage 4). */
interface WireAsset {
  id: AssetId
  mime: string
  name: string
  sizeBytes: number
  producedBy: string | null
  createdAt: string
  width: number | null
  height: number | null
  durationSec: number | null
}

/**
 * Turn an asset of the asset pool into the wire form.
 * @param asset - the asset.
 * @returns the wire asset.
 */
function toWireAsset(asset: Asset): WireAsset {
  return {
    id: asset.id, mime: asset.mime, name: asset.name, sizeBytes: asset.size_bytes, producedBy: asset.created_by,
    createdAt: asset.created_at, width: asset.width, height: asset.height, durationSec: asset.duration_sec,
  }
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
  asset: (id: AssetId) => Asset | null,
): WireState {
  const assets: WireAsset[] = []
  for (const id of mentionedAssets(state)) {
    const found = asset(id)
    if (found !== null) assets.push(toWireAsset(found))
  }
  const { proj, bible, timeline, shot, plan } = state.components
  const stale: WireState['stale'] = {}
  for (const [record, because] of Object.entries(proj.stale)) stale[record] = { because }
  const wireTimelines = timeline.timelines.map(toWireTimeline)
  const first = wireTimelines[0]
  return {
    project: { projectId: project.id, title: project.title, createdAt: project.created_at },
    head: state.head,
    heads: Object.fromEntries(branches.map(branch => [branch.name, branch.head])),
    branches,
    ops: proj.records.map(toWireOp),
    assets,
    entities: toWireBible(bible), // names:allow
    sequence: first === undefined ? null : { items: first.items }, // names:allow
    sequences: wireTimelines, // names:allow
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
export function toWireToolSpec(spec: OperationSpec): WireToolSpec {
  return {
    name: spec.name,
    version: spec.version,
    summary: spec.description,
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
