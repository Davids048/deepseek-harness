/**
 * The JSON the browser receives from `@dv/api`, as plain structural types: host packages cannot be imported into a
 * browser bundle, so the browser keeps its own copy of the field names. A type that copies a registry type of
 * `@dv/project` or a component has the registry name; a shape that only the wire has carries the prefix `Wire`.
 *
 * @module @dv/ui-kit/types
 */

/** Who caused a record. */
export type Actor = 'user' | 'agent' | 'system'

/** Where the action that caused a record came from. */
export type Surface = 'chat' | 'canvas' | 'timeline' | 'asset_pool' | 'api' | 'history'

/** The state of an operation call. */
export type RecordStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/**
 * What one record input refers to: an asset, the n-th output of an earlier record, or one version of a character, a
 * location or a style.
 */
export type RecordInputRef =
  | { asset: string }
  | { record: string; output: number }
  | { character: string; version: number }
  | { location: string; version: number }
  | { style: string; version: number }

/** One input of a record: what the operation read. */
export interface RecordInput {
  role: string
  ref: RecordInputRef
  /** The asset the input stood for when the operation ran; null while its producer has not finished. */
  resolved_asset: string | null
}

/** The cost of one operation call. */
export interface RecordCost {
  gpu_seconds: number
  wall_seconds: number
  /** Whether the outputs were reused from an earlier identical deterministic call. */
  reused: boolean
}

/** Why a call failed or was cancelled. */
export interface RecordFailure {
  code: string
  message: string
}

/** One record of a project in its current form: one operation call. */
export interface ProjectRecord {
  id: string
  parents: string[]
  kind: 'operation'
  /** The component key that owns the operation, for example `timeline`. */
  component: string
  /** The operation name, for example `shot.render_ref2va`. */
  operation: string | null
  operation_version: string | null
  actor: Actor
  surface: Surface
  /** The agent turn; null for direct human actions. */
  turn: string | null
  /** The chat session of the action; null outside any chat session. */
  session: string | null
  tool_call: string | null
  intent: string
  params: Record<string, unknown>
  inputs: RecordInput[]
  outputs: string[]
  /** The record this one repeats with changes, such as a take with an edited prompt; null when none. */
  based_on: string | null
  supersedes: string[]
  deterministic: boolean
  status: RecordStatus
  created_at: string
  started_at?: string
  finished_at?: string
  error?: RecordFailure
  cost?: RecordCost
  report?: Record<string, unknown>
}

/** A project's identity, as `project.json` stores it. */
export interface ProjectInfo {
  id: string
  title: string
  created_at: string
}

/** One stored asset of the asset pool. */
export interface Asset {
  id: string
  mime: string
  name: string
  size_bytes: number
  /** The record that created the asset; null for an imported file. */
  created_by: string | null
  created_at: string
  width: number | null
  height: number | null
  duration_sec: number | null
}

/**
 * An asset as one project sees it: `name` and `created_at` are the project's own import name and time, and `made_by`
 * is the operation of the current-state record that created it, else `asset.import` for an asset the project imported
 * anywhere in its history, else null.
 */
export interface ProjectAsset extends Asset {
  made_by: string | null
}

/** One version of a character in the story bible. */
export interface Character {
  id: string
  version: number
  name: string
  description: string
  /** The reference images of the version. */
  references: string[]
  /** The record that wrote the version. */
  created_by: string
}

/** One version of a location; the same shape as a character version. */
export type Location = Character

/** One version of a style; the same shape as a character version. */
export type Style = Character

/** One clip of a timeline. */
export interface Clip {
  /** The clip ID, such as `cl3`, unique in the project; the clip operations name the clip by it. */
  id: string
  /** The asset the clip plays; null while the render the clip waits for is not done (a placeholder clip). */
  asset: string | null
  /** The render output the clip waits for, `{record, output}`; null for a clip of an existing asset. */
  source: { record: string; output: number } | null
  in_sec: number | null
  out_sec: number | null
}

/** One edited video of a project: its clips in playback order. */
export interface Timeline {
  /** The timeline ID, such as `t1`. */
  id: string
  /** The stored name; empty until the timeline is renamed, and the interface then shows 时间线 {n}. */
  name: string
  clips: Clip[]
}

/** One shot of a plan version; its number is its 1-based position in the version. */
export interface Shot {
  prompt: string
  duration_sec?: number
  /** Character, location or style versions (`c1@1`) or asset IDs this shot uses instead of the plan's references. */
  references?: string[]
  seed?: number
  /** The render mode (`ref2va` from references, `t2va` from text), which picks `shot.render_ref2va` or `shot.render_t2va`. */
  mode: 'ref2va' | 't2va'
  /** Whether the shot starts from the last still of the previous shot's take. */
  continue_previous?: boolean
}

/** One version of a plan: what a `plan.create` (version 1) or `plan.update` record stored. */
export interface PlanVersion {
  /** The 1-based version number; reference text `p1@2` names version 2 of plan `p1`. */
  version: number
  title?: string
  references?: string[]
  aspect_ratio?: string
  resolution?: string
  seed?: number
  shots: Shot[]
  /** The `plan.create` or `plan.update` record that wrote the version. */
  created_by: string
  /** The latest finished `plan.approve` record of the version; null while the version is not approved. */
  approved_by: string | null
}

/** The `bible` slice: every version of every character, location and style, oldest first. */
export interface StoryBibleState {
  characters: Record<string, Character[]>
  locations: Record<string, Location[]>
  styles: Record<string, Style[]>
}

/** The `plan` slice: every version of every plan, by `PlanId` (`p1`), oldest first. */
export interface PlanState {
  plans: Record<string, PlanVersion[]>
}

/** The `shot` slice: the takes of each shot. */
export interface ShotState {
  /** The root record of each shot → the root and every take based on it. */
  takes: Record<string, string[]>
  /** Each take with a `based_on` → its root record. */
  roots: Record<string, string>
}

/** The `timeline` slice. */
export interface TimelineState {
  /** Every timeline of the project, in creation order. */
  timelines: Timeline[]
}

/** The state slices of the components the browser reads, sent verbatim by the server. */
export interface ComponentStates {
  proj: {
    /** The records of the effective chain, oldest first. */
    records: ProjectRecord[]
    /** Stale records: record → the record whose change made it stale. */
    stale: Record<string, string>
    /** Superseded records: record → the record that superseded it. */
    superseded: Record<string, string>
    /** The record that created each output asset. */
    created_by: Record<string, string>
  }
  bible: StoryBibleState
  plan: PlanState
  shot: ShotState
  timeline: TimelineState
  /** The assets on the canvas, in the order they were placed. */
  asset: { placed: string[] }
}

/** The project's current state, with the assets the views need beside it. */
export interface WireState {
  project: ProjectInfo
  /** The current position: the step whose state this is. */
  head: string
  /** The last step of the history list; redo can move the current position up to it. */
  tip: string
  components: ComponentStates
  /** Every asset of the current state, and every asset the project imported anywhere in its history. */
  assets: ProjectAsset[]
}

/** One property of an operation's parameter schema, in the DSH parameter format. */
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

/** An operation declaration, as `GET /api/dv/operations` lists it. */
export interface WireOperation {
  name: string
  version: string
  description: string
  inputs: Record<string, { type: string; description: string; required?: boolean; many?: boolean; bible?: boolean }>
  params: Record<string, WireParamSpec>
  outputs: Array<{ role: string; type: string }>
  deterministic: boolean
  resource: 'none' | 'cpu' | 'gpu'
  confirm: 'never' | 'always' | 'over_gpu_budget'
}

/** A project row. */
export interface WireProject {
  id: string
  title: string
  created_at: string
  /** Whether the chat session the view sits beside is bound to this project. */
  current?: boolean
}

/** The last step of the history list and the current position, as undo and redo answer them. */
export interface WireLine {
  tip: string
  at: string
}

/** One project change, as the event stream sends it: an appended record, a record update, or a move of the position. */
export type ProjectEvent =
  | { kind: 'record'; record: ProjectRecord }
  | { kind: 'update'; record: ProjectRecord }
  | ({ kind: 'line' } & WireLine)

/** One entry of the history list: one step and where it stands relative to the current position. */
export interface HistoryEntry {
  record: ProjectRecord
  /** `current` for the current position, `before` for a step before it, `after` for a step redo brings back. */
  place: 'before' | 'current' | 'after'
}

/** What `POST /api/dv/history` selects (the JSON body). Every filter is optional; filters combine with AND. */
export interface HistoryQuery {
  project: string
  actor?: Actor
  /** A component key, such as `timeline`. */
  component?: string
  operation?: string
  kind?: ProjectRecord['kind']
  status?: RecordStatus
  session?: string
  turn?: string
  /** Only records written by this tool call. */
  tool_call?: string
  /** Only these records. */
  records?: string[]
  /** Only records written before this record, for paging. */
  before?: string
  /** At most this many entries: 1 to 200; the server's default is 50. */
  limit?: number
}

/** The `POST /api/dv/history` answer. */
export interface WireHistory {
  /** The entries, newest first. */
  entries: HistoryEntry[]
  /** Every asset that the entries name as an output or a resolved input. */
  assets: Asset[]
}

/** What a view sends to run an operation as the human. */
export interface OperationRequest {
  project: string
  operation: string
  /** Inputs with `ref` as reference text: `<asset>`, `<record>#<output>`, or `<id>@<version>`. */
  inputs?: Array<{ role: string; ref: string }>
  params?: Record<string, unknown>
  intent?: string
  surface: 'canvas' | 'timeline' | 'asset_pool'
  /** The chat session the view sits beside, recorded as the record's `session`. */
  session?: string
  based_on?: string
  supersedes?: string[]
}

/** Where a canvas node sits, in canvas units. */
export interface NodePosition {
  x: number
  y: number
}

/** The canvas pan offset, in screen pixels, and zoom. */
export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

/** A project's stored canvas layout: node positions keyed by canvas node ID, and the viewport. */
export interface CanvasLayout {
  positions: Record<string, NodePosition>
  viewport: CanvasViewport | null
}

/** One project as `GET /api/dv/workspaces` lists it. */
export interface WireProjectLink {
  id: string
  title: string
  created_at: string
  /** The project's directory, which is its Workspace's directory. */
  path: string
  /** The recorded Workspace, or null before one was created. */
  workspace_id: string | null
}

/** The `GET /api/dv/workspaces` answer. */
export interface WireWorkspaces {
  entry_path: string
  projects: WireProjectLink[]
  /** Saved chat session → project bindings. */
  bindings: Record<string, string>
}

/** One saved chat session of a project, as `GET /api/dv/workspaces/sessions` lists it. */
export interface WireSession {
  session: string
  /** When the session log last changed, ISO-8601 UTC. */
  updated_at: string
  bytes: number
}
