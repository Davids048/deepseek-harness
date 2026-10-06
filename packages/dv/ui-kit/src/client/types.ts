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

/** One record of a project in its current form: a request that started an agent turn, or one operation call. */
export interface ProjectRecord {
  id: string
  parents: string[]
  branch: string
  kind: 'request' | 'operation'
  /** The component key that owns the operation, for example `timeline`; `proj` for request records. */
  component: string
  /** The operation name, for example `shot.render`; null on a request record. */
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

/** How many records a draft holds, as a discard confirmation shows them. */
export interface DraftCounts {
  agent_changes: number
  human_edits: number
}

/** One branch of a project. */
export interface Branch {
  /** `main`, `draft/<session>`, or `explore/<name>`. */
  name: string
  head: string
  /** The branch an accept merges into; null for `main` and exploration branches. */
  base: string | null
  forked_at: string | null
  /** The chat session that owns the draft; null for `main` and exploration branches. */
  session: string | null
  /** The draft's counts; null for branches that are not open drafts. */
  counts: DraftCounts | null
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
  asset: string
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

/** One plan of the shot plan slice. */
export interface PlanSummary {
  /** The `plan.create` or `plan.update` record that holds the plan. */
  record: string
  approved: boolean
  /** The `plan.approve` record; null while the plan is not approved. */
  approved_by: string | null
}

/** The `bible` slice: every version of every character, location and style, oldest first. */
export interface StoryBibleState {
  characters: Record<string, Character[]>
  locations: Record<string, Location[]>
  styles: Record<string, Style[]>
}

/** The `plan` slice. */
export interface PlanState {
  plans: PlanSummary[]
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
    /** The records of the branch's effective chain, oldest first. */
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
}

/** The state of one branch at its head, with the branches and assets the views need beside it. */
export interface WireState {
  project: ProjectInfo
  /** The branch the state is for. */
  branch: string
  head: string
  heads: Record<string, string>
  /** Every branch of the project; an open draft has `counts`. */
  branches: Branch[]
  components: ComponentStates
  assets: Asset[]
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
  confirm: 'never' | 'agent_ask_first'
}

/** A project row. */
export interface WireProject {
  id: string
  title: string
  created_at: string
  heads: Record<string, string>
  /** Whether the chat session the view sits beside is bound to this project. */
  current?: boolean
}

/**
 * One project change, as the event stream sends it: an appended record, a record update, or a branch that was created,
 * moved (`branch` set), or removed (`branch` null).
 */
export type ProjectEvent =
  | { kind: 'record'; record: ProjectRecord }
  | { kind: 'update'; record: ProjectRecord }
  | { kind: 'branch'; name: string; branch: Branch | null }

/** One entry of the history list: a record in its current form and where it stands. */
export interface HistoryEntry {
  record: ProjectRecord
  /**
   * `main` (on the effective chain of `main`), `draft` (on an open draft), `undone` (left behind by an undo),
   * `discarded` (on a discarded draft), `replayed` (a draft record that accept copied onto `main`), or `branch` (only
   * on an exploration branch).
   */
  mark: 'main' | 'draft' | 'undone' | 'discarded' | 'replayed' | 'branch'
}

/** What `POST /api/dv/history` selects (the JSON body). Every filter is optional; filters combine with AND. */
export interface HistoryQuery {
  project: string
  /** Only records appended to this branch name. */
  branch?: string
  /** Only entries with one of these marks. */
  marks?: Array<HistoryEntry['mark']>
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
  /** The `request` record of every turn that has a record in `entries`, by turn. */
  requests: Record<string, ProjectRecord>
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
  /** The chat session the view sits beside; the record goes to that session's working branch (its open draft). */
  session?: string
  based_on?: string
  supersedes?: string[]
}

/** The record a project-level route wrote (accept, undo, redo, stale accept), with the branch heads afterwards. */
export interface WireRecordResult {
  record: ProjectRecord
  heads: Record<string, string>
}

/** Which draft an accept or discard addresses: the draft of a chat session, or a draft branch by name. */
export type DraftTarget = { session: string } | { branch: string }

/** What a view last selected, as the agent is told about it. */
export interface ViewSelection {
  project: string
  kind: 'record' | 'clip' | 'asset' | 'character' | 'location' | 'style'
  /** The `RecordId`, `ClipId`, `AssetId`, or story bible ID. */
  id: string
  surface: 'canvas' | 'timeline' | 'asset_pool'
  /** ISO-8601 UTC of the selection; set by the server. */
  at?: string
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

/** A project's stored canvas layout, keyed by canvas node ID. */
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

/** The two composer choices of a chat session. */
export interface ComposerMode {
  confirm: 'ask' | 'direct'
  speed: 'quality' | 'speed'
}

/** One reference image of a render waiting for the user. */
export interface ApprovalReference {
  role: string
  ref: string
  asset: string | null
  url: string | null
}

/** One render waiting for the user's approval. */
export interface ApprovalCard {
  id: string
  session: string
  tool_call: string
  /** The operation name. */
  operation: string
  summary: string
  prompt: string
  duration_sec: number | null
  gpu_seconds: number
  references: ApprovalReference[]
  created_at: string
}
