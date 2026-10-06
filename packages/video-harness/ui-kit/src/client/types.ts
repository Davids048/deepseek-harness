/**
 * The JSON the browser receives from `@video-harness/views`, as plain structural types: the host package cannot be
 * imported into a browser bundle, so the views keep their own copy of the field names.
 *
 * @module @video-harness/ui-kit/types
 */

/** One input of a record. */
export interface WireInput {
  role: string
  ref: string
  resolved: string | null
}

/** One record: a request that started an agent turn, or one operation call. */
export interface WireOp {
  id: string
  parents: string[]
  /** The agent turn; null for direct human actions. */
  turn: string | null
  /** The chat session of the action; null outside any chat session. */
  session: string | null
  branch: string
  actor: 'user' | 'agent' | 'system'
  surface: 'chat' | 'timeline' | 'canvas' | 'asset_pool' | 'api'
  intent: string
  kind: 'request' | 'operation'
  tool?: { name: string; version: string }
  inputs: WireInput[]
  params: Record<string, unknown>
  outputs: string[]
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
  base_op?: string
  supersedes?: string[]
  cost?: { gpu_s?: number; wall_s?: number; cached?: boolean }
  report?: Record<string, unknown>
  deterministic: boolean
  created_at: string
  finished_at?: string
  error?: string
}

/** One stored asset. */
export interface WireAsset {
  id: string
  mime: string
  name: string
  sizeBytes: number
  producedBy: string | null
  createdAt: string
  width: number | null
  height: number | null
  durationSec: number | null
}

/** One version of a character, style, or location. */
export interface WireEntityVersion {
  kind: string
  version: number
  name: string
  description: string
  refs: string[]
  updatedBy: string
}

/** One clip on the timeline. */
export interface WireSequenceItem {
  slot: number
  assetId: string
  inSec: number | null
  outSec: number | null
}

/** How many records a draft holds, as a discard confirmation shows them. */
export interface WireDraftCounts {
  agent_changes: number
  human_edits: number
}

/** One branch of a project. */
export interface WireBranch {
  /** `main`, `draft/<session>`, or `explore/<name>`. */
  name: string
  head: string
  /** The branch an accept merges into; null for `main` and exploration branches. */
  base: string | null
  forked_at: string | null
  /** The chat session that owns the draft; null for `main` and exploration branches. */
  session: string | null
  /** The draft's counts; null for branches that are not open drafts. */
  counts: WireDraftCounts | null
}

/** The state of one branch at its head. */
export interface WireState {
  project: { projectId: string; title: string; createdAt: string }
  head: string
  heads: Record<string, string>
  /** Every branch of the project; an open draft has `counts`. */
  branches: WireBranch[]
  ops: WireOp[]
  assets: WireAsset[]
  entities: Record<string, WireEntityVersion[]>
  sequence: { items: WireSequenceItem[] } | null
  /** Every video of the project, in creation order; the first one equals `sequence`. */
  sequences?: Array<{ id: string; title: string; items: WireSequenceItem[] }>
  stale: Record<string, { because: string }>
  superseded: Record<string, string>
  takes: Record<string, string[]>
  plans: Array<{ record: string; approved: boolean; approved_by: string | null }>
  producers: Record<string, string>
}

/** One property of a tool's parameter schema, in the DSH tool format. */
export interface WireParamSpec {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json'
  required?: boolean
  description?: string
  title?: string
  default?: unknown
  enum?: readonly unknown[]
  items?: WireParamSpec
  properties?: Record<string, WireParamSpec>
  oneOf?: readonly WireParamSpec[]
}

/** A tool declaration. */
export interface WireToolSpec {
  name: string
  version: string
  summary: string
  inputs: Record<string, { type: string; description: string; required?: boolean; many?: boolean; bible?: boolean }>
  params: Record<string, WireParamSpec>
  outputs: Array<{ role: string; type: string }>
  deterministic: boolean
  cost: 'free' | 'cpu' | 'gpu'
  confirm: 'never' | 'agent_ask_first'
}

/** A project row. */
export interface WireProject {
  projectId: string
  title: string
  createdAt: string
  heads: Record<string, string>
  /** Whether the chat session the view sits beside is bound to this project. */
  current?: boolean
}

/**
 * One project change, as the event stream sends it: an appended record, a record update, or a branch that was created,
 * moved (`branch` set), or removed (`branch` null). Records arrive in the Project record format, not as {@link WireOp}.
 */
export type WireProjectEvent =
  | { kind: 'record'; record: { id: string; branch: string; status: string } }
  | { kind: 'update'; record: { id: string; branch: string; status: string } }
  | { kind: 'branch'; name: string; branch: WireBranch | null }
