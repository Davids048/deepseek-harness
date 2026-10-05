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

/** One operation record. */
export interface WireOp {
  id: string
  parents: string[]
  turn: string
  branch: string
  actor: 'user' | 'agent' | 'system'
  surface: 'chat' | 'timeline' | 'canvas' | 'api'
  intent: string
  kind: string
  tool?: { name: string; version: string }
  command?: { argv: string[] }
  inputs: WireInput[]
  params: Record<string, unknown>
  outputs: string[]
  status: 'pending' | 'running' | 'done' | 'failed'
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

/** What the fold knows about a turn. */
export interface WireTurn {
  ops: string[]
  actor: WireOp['actor']
  surface: WireOp['surface']
  intent: string
  accepted: boolean
  rejected: boolean
}

/** The folded state of one head. */
export interface WireState {
  project: { projectId: string; title: string; createdAt: string }
  head: string
  heads: Record<string, string>
  ops: WireOp[]
  assets: WireAsset[]
  entities: Record<string, WireEntityVersion[]>
  sequence: { items: WireSequenceItem[] } | null
  /** Every video of the project, in creation order; the first one equals `sequence`. */
  sequences?: Array<{ id: string; title: string; items: WireSequenceItem[] }>
  stale: Record<string, { because: string }>
  superseded: Record<string, string>
  turns: Record<string, WireTurn>
  takes: Record<string, string[]>
  plans: Array<{ op: string; approved: boolean; approvedBy: string | null }>
  producers: Record<string, string>
  /** The agent draft turns that are still open: neither accepted nor rejected. */
  openTurns: string[]
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
  inputs: Record<string, { type: string; description: string; required?: boolean; many?: boolean; entity?: boolean }>
  params: Record<string, WireParamSpec>
  outputs: Array<{ role: string; type: string }>
  deterministic: boolean
  cost: 'free' | 'cpu' | 'gpu'
  confirm: 'never' | 'cost' | 'always'
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

/** One change of the operation log, as the event stream sends it. */
export type WireLogEvent =
  | { kind: 'append'; op: WireOp }
  | { kind: 'patch'; op: WireOp }
  | { kind: 'head'; branch: string; to: string }
