/**
 * Types of the Project component: IDs, the record format of `records.jsonl`, operations, reducers, project state,
 * history queries, and run requests.
 *
 * Field case: types that are written to disk or sent over the wire (records, update lines, `project.json`, run
 * requests, history queries) use snake_case fields, matching the record format. Types that only
 * code sees (operation specs, the execute context, reducers) use camelCase members.
 *
 * @module @dv/project/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ParameterSchemaSpec, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * The ID of an asset: the SHA-256 hex digest of its bytes. Project defines it because records name assets; the asset
 * pool depends on Project and re-exports it.
 */
export type AssetId = Branded<'DvAssetId'>

/** The ID of a character, chosen by the caller of `bible.character_create`, such as `c1`. The Story bible re-exports it. */
export type CharacterId = Branded<'DvCharacterId'>

/** The ID of a location, chosen by the caller of `bible.location_create`, such as `l1`. The Story bible re-exports it. */
export type LocationId = Branded<'DvLocationId'>

/** The ID of a style, chosen by the caller of `bible.style_create`, such as `s1`. The Story bible re-exports it. */
export type StyleId = Branded<'DvStyleId'>

/** The ID of a project; it names the project's directory under the store root. */
export type ProjectId = Branded<'DvProjectId'>

/** The ID of one record in a project's `records.jsonl`. */
export type RecordId = Branded<'DvRecordId'>

/**
 * The ID of one agent turn: one run of the agent from a request to its reply. It is the DSH turn number of the chat
 * session as a string (`"3"`), unique within the session; Project reads it when an agent tool runs.
 */
export type TurnId = Branded<'DvTurnId'>

/** The ID of one chat session; the DSH session ID of the agent that the human talks to. */
export type SessionId = Branded<'DvSessionId'>

/** What a record represents: one call of one operation. */
export type RecordKind = 'operation'

/** Who caused a record. `system` is used only for automatic actions, such as a scheduled render. */
export type Actor = 'user' | 'agent' | 'system'

/** Where the action that caused a record came from. */
export type Surface = 'chat' | 'canvas' | 'timeline' | 'asset_pool' | 'api' | 'history'

/**
 * The state of an operation call. It only moves forward: `pending` → `running` → `done` | `failed` | `cancelled`;
 * `pending` may also move straight to `done` (reused outputs), `failed` or `cancelled`.
 */
export type RecordStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/**
 * What one record input refers to: an asset, the n-th output of an earlier record, or one version of a character, a
 * location or a style.
 */
export type RecordInputRef =
  | { asset: AssetId }
  | { record: RecordId; output: number }
  | { character: CharacterId; version: number }
  | { location: LocationId; version: number }
  | { style: StyleId; version: number }

/** One input of a record: what the operation read. */
export interface RecordInput {
  /** The input's role, one of the operation's `inputRoles`, for example `reference`. */
  role: string
  ref: RecordInputRef
  /**
   * The asset the input stood for when the operation ran. Null on the record line for a `{record, output}` ref whose
   * producer had not finished when the record was written; the record store fills it in the current form of the
   * record once the producer is done.
   */
  resolved_asset: AssetId | null
}

/** The cost of one operation call, written by its final update line. */
export interface RecordCost {
  gpu_seconds: number
  wall_seconds: number
  /** Whether the outputs were reused from an earlier identical deterministic call instead of executed. */
  reused: boolean
}

/**
 * Why a call failed or was cancelled, in words a creator can read. `code` is one of `operation_failed` (the
 * operation's execute threw), `input_failed` (a record the scheduled call waited for failed), or `stopped` (the turn
 * was stopped: the run request's signal aborted). A stopped record ends with status `cancelled`.
 */
export interface RecordFailure {
  code: string
  message: string
}

/**
 * One record of a project, in its current form: the fields of the record line, plus the fields that its update lines
 * set. The record line on disk carries only the fields up to `created_at`; `started_at`, `finished_at`, `error`,
 * `cost` and `report` appear only after an update line sets them.
 */
export interface ProjectRecord {
  id: RecordId
  /** The record written just before this one; empty only for the first record of a project. */
  parents: RecordId[]
  kind: RecordKind
  /** The component key that owns the operation, for example `timeline`. */
  component: string
  /** The operation name, for example `timeline.clip_move`. */
  operation: string | null
  /** The version of the operation's parameter schema. */
  operation_version: string | null
  actor: Actor
  surface: Surface
  /** The agent turn that made the record; null for direct human actions. */
  turn: TurnId | null
  /** The chat session of the turn, or of the human's edit; null when the action has no chat session. */
  session: SessionId | null
  /** The agent's tool-call ID that made the record; null when the human acted directly. */
  tool_call: string | null
  /** Why: the agent's `reason` argument, or a short description of the human's gesture, such as "move clip 3 before clip 1". */
  intent: string
  /** The operation's parameters, valid against its schema. The owning component defines their meaning. */
  params: Record<string, unknown>
  inputs: RecordInput[]
  /** Assets the operation created; empty for operations that only change data. */
  outputs: AssetId[]
  /** The record this one repeats with changes, such as a new take with an edited prompt. */
  based_on: RecordId | null
  /** Records whose outputs this one replaces; their dependents become stale. */
  supersedes: RecordId[]
  /** Whether the same inputs and parameters always give the same outputs, which allows reuse. */
  deterministic: boolean
  status: RecordStatus
  /** When the record was written, ISO-8601 UTC. */
  created_at: string
  /** When the call started running, ISO-8601 UTC; set by an update line. */
  started_at?: string
  /** When the call ended, ISO-8601 UTC; set by an update line. */
  finished_at?: string
  /** Why the call failed or was cancelled; set by an update line. */
  error?: RecordFailure
  /** Set by the final update line of an executed call. */
  cost?: RecordCost
  /** Facts the operation found besides its outputs, such as the seed it drew; set by an update line. */
  report?: Record<string, unknown>
}

/**
 * One update line of `records.jsonl`: `{"update": "<RecordId>", …}` with the fields that changed. Only these fields
 * may change, only while the record is not finished, and `status` only moves forward.
 */
export interface RecordUpdate {
  update: RecordId
  status?: RecordStatus
  started_at?: string
  finished_at?: string
  outputs?: AssetId[]
  error?: RecordFailure
  cost?: RecordCost
  report?: Record<string, unknown>
}

/**
 * Who caused an action, from where, and why: the fields every record copies from the call that wrote it. Run requests
 * and the `proj.*` service methods take it.
 */
export interface RecordOrigin {
  actor: Actor
  surface: Surface
  /** The chat session the action belongs to; null for an action outside any chat session. */
  session: SessionId | null
  /** The agent turn; null for direct human actions. */
  turn: TurnId | null
  /** The agent's tool-call ID; null when the human acted directly. */
  tool_call: string | null
  intent: string
}

/** The contents of `project.json`. */
export interface ProjectInfo {
  id: ProjectId
  title: string
  /** When the project was created, ISO-8601 UTC. */
  created_at: string
}

/** The result of an operation's execute function. */
export interface OperationResult {
  /** The created assets, in the order the operation declares them. */
  outputs: AssetId[]
  /** Facts besides the outputs, such as the seed a renderer drew; a read returns its answer here. */
  report?: Record<string, unknown>
  /** GPU time the call used; the runner measures wall time itself. */
  cost?: { gpu_seconds: number }
}

/** What an operation's execute function receives. */
export interface OperationContext {
  project: ProjectId
  /** The running record; null for a read-only operation, which writes no record. */
  record: ProjectRecord | null
  params: Record<string, unknown>
  /** The record's inputs; every `resolved_asset` is set. */
  inputs: RecordInput[]
  /** The project state at the record's parent (for a read, the project's current state). */
  state: ProjectState
  /** A directory the call may write temporary files into; the runner removes it after the call. */
  scratchDir: string
  /** Aborted when the caller's run request aborts. */
  signal: AbortSignal
  /**
   * Import a file or bytes the operation produced into the asset pool, as an asset created by this record.
   * @param source - the bytes, or a file path to copy.
   * @param meta - the asset's media type, display name, duration for audio and video, and pixel width and height of
   *   images and video when the operation knows them.
   * @returns the asset's ID.
   */
  importAsset(
    source: Uint8Array | { path: string }, meta: { mime: string; name: string; durationSec?: number; width?: number; height?: number },
  ): AssetId
}

/** The kind of file or value an operation input or output carries. */
type OperationValueType = 'image' | 'video' | 'audio' | 'text' | 'json' | 'any'

/** One input role of an operation, as the agent tool and the canvas form declare it. */
export interface OperationInput {
  type: OperationValueType
  description: string
  required?: boolean
  /** Whether the role takes several references, such as every reference image of a shot. */
  many?: boolean
  /** Whether the role also accepts character, location or style versions (`<id>@<version>`) besides assets. */
  bible?: boolean
}

/** One output of an operation, in the order its `execute` returns them. */
export interface OperationOutput {
  role: string
  type: OperationValueType
}

/**
 * One agent tool call of an operation, after Project parsed it and before Project runs it. An operation's
 * `prepareToolCall` receives it.
 */
export interface OperationToolCall {
  /** The tool arguments as the model sent them, including the operation's `toolParams`. */
  args: Record<string, unknown>
  /** The run request Project will send; `prepareToolCall` may change its `params` and `inputs`. */
  request: RunRequest
  /** The project's current state, which the inputs were parsed against. */
  state: ProjectState
  /** The DSH tool call: the calling agent, the call ID and the stop signal. */
  exec: ToolRunContext
}

/**
 * An operation a component implements and registers with `dvProject.registerOperation`. Each operation is run only
 * through `dvProject.run`. The spec also declares the operation's agent tool and canvas form: `description`, `inputs`,
 * `outputs` and `summarize`.
 */
export interface OperationSpec {
  /** `<component key>.<verb>` or `<component key>.<object>_<verb>`, for example `timeline.clip_move`. */
  name: string
  /** The owning component's key; it equals the part of `name` before the dot. */
  component: string
  /** The version of the parameter schema, written to each record's `operation_version`. */
  version: string
  /** What the operation does, for the model (its tool description) and the canvas form. */
  description: string
  /** The parameter schema in the DSH tool parameter format; the runner validates `params` against it. */
  params: ParameterSchemaSpec
  /** The input roles the operation accepts; the runner refuses an input with any other role. */
  inputs: Record<string, OperationInput>
  /**
   * Input roles whose `{record, output}` reference may name a record that has not finished `done`. The runner and the
   * scheduler do not wait for those producers and do not fail the record on a null `resolved_asset` for those roles;
   * the record's current form fills `resolved_asset` when the producer is done, and a failed producer leaves it null.
   */
  pendingInputRoles?: string[]
  /** The outputs, in the order `execute` returns them. */
  outputs: OperationOutput[]
  /**
   * Whether an agent tool call needs the user's agreement, given in the conversation. `never`: no agreement.
   * `always`: the tool takes `user_approved`, and a call without `user_approved: true` is refused. `over_gpu_budget`:
   * the tool takes `user_requested`, and a call without `user_requested: true` is refused when the turn's GPU seconds
   * (the cost of the turn's finished records, the `estimate` of its unfinished records, and this call's
   * `confirmSummary` estimate) pass `dvProject`'s Config field `confirmGpuSecondsThreshold`. The refusal tells the agent
   * to ask the user in the conversation, the question in bold. Project adds the argument to the tool; the operation
   * declares nothing for it, and it never reaches the record's params. Calls by the human and by the system are never
   * refused.
   */
  confirm: 'never' | 'always' | 'over_gpu_budget'
  /**
   * What an agent call will do and cost, for the refusal text. `registerOperation` refuses a spec whose `confirm` is
   * not `never` and that has no `confirmSummary` (`invalid_params`).
   * @param call - the parsed call, after the operation's `prepareToolCall`.
   * @param state - the project's current state.
   * @returns `text`: what the agent shows the user before asking (for `plan.approve`: one line per shot it renders);
   *   `gpu_seconds`: the call's GPU estimate, which also counts against the turn's budget.
   */
  confirmSummary?(call: OperationToolCall, state: ProjectState): { text: string; gpu_seconds: number }
  /** Whether identical inputs and parameters always give identical outputs; the runner then reuses earlier outputs. */
  deterministic: boolean
  /** The scheduler's concurrency class: `gpu` and `cpu` calls share a configured limit each; `none` is unlimited. */
  resource: 'none' | 'cpu' | 'gpu'
  /**
   * The expected GPU time of a call; Project counts it for the turn's unfinished records (scheduled renders).
   * @param params - the call's parameters.
   * @returns the estimate; omit the function for operations that use no GPU.
   */
  estimate?(params: Record<string, unknown>): { gpu_seconds: number }
  /** A read: the runner writes no record and takes no lock. */
  readOnly?: boolean
  /**
   * The records a call of this operation replaces; the runner adds them to the record's `supersedes`.
   * @param params - the call's parameters.
   * @param state - the project's current state, which the call writes after.
   * @returns the replaced records; omit the function for operations that replace nothing by themselves.
   */
  supersedes?(params: Record<string, unknown>, state: ProjectState): RecordId[]
  /**
   * One line for a chat card or a canvas node.
   * @param record - a finished record of this operation.
   * @returns the line.
   */
  summarize(record: ProjectRecord): string
  /** Tool-only arguments besides `params`; Project removes them from the run request's params before `prepareToolCall`. */
  toolParams?: ParameterSchemaSpec
  /**
   * Check or change an agent tool call before Project runs it, for example to turn a tool-only argument into an input.
   * Project applies `confirm` after it.
   * @param call - the parsed call; throw to refuse it with the error's message.
   */
  prepareToolCall?(call: OperationToolCall): Promise<void>
  /**
   * Refuse a call of any caller before Project writes a record, for a rule the operation itself enforces (a render
   * needs a reference image). The runner calls it under the project lock, after the params and inputs are valid, so
   * it must stay fast and must never call `dvProject.run`.
   * @param request - the call.
   * @param state - the project's current state, which the call writes after (or reads, for a read-only operation).
   * @throws Error that rejects `run` unchanged; nothing is written.
   */
  precondition?(request: RunRequest, state: ProjectState): Promise<void>
  /**
   * Run the operation. A throw fails the record with code `operation_failed` and the error's message.
   * @param context - the record, resolved inputs, parameters, state, and asset storage.
   * @returns the outputs, the report, and the GPU time.
   */
  execute(context: OperationContext): Promise<OperationResult>
}

/**
 * The state slice of each component, keyed by component key. Each component adds its slice by declaration merging:
 *
 * ```ts
 * declare module '@dv/project' {
 *   interface ComponentStates { timeline: TimelineState }
 * }
 * ```
 *
 * Project declares its own slice, `proj`.
 */
export interface ComponentStates {
  proj: {
    /** The records of the history list up to the current position, oldest first. */
    records: ProjectRecord[]
    /** Stale records: record → the record whose change made it stale. */
    stale: Record<RecordId, RecordId>
    /** Superseded records: record → the record that superseded it. */
    superseded: Record<RecordId, RecordId>
    /** The record that created each output asset. */
    created_by: Record<AssetId, RecordId>
  }
}

/** A component key that has a declared state slice. */
type ComponentKey = keyof ComponentStates

/**
 * A component's reducer: it turns the records up to the current position into the component's state slice. Reducers are pure: they
 * read only their arguments and return a new slice or the same slice unchanged.
 */
export interface Reducer<K extends ComponentKey = ComponentKey> {
  /**
   * @returns the slice before any record.
   */
  initial(): ComponentStates[K]
  /**
   * Apply one record. The reducer receives every record of the chain, of every component, in order, and
   * ignores the records it does not interpret.
   * @param slice - the slice before the record.
   * @param record - the record in its current form.
   * @returns the slice after the record.
   */
  reduce(slice: ComponentStates[K], record: ProjectRecord): ComponentStates[K]
  /**
   * The assets a character, location or style reference stands for (Story bible's reducer defines it). The runner
   * calls it; at most one registered reducer defines it.
   * @param slice - the slice at the record's parent.
   * @param ref - a character, location or style reference.
   * @returns the assets, or null when the reference names an unknown version.
   */
  assetsOf?(slice: ComponentStates[K], ref: RecordInputRef): AssetId[] | null
  /**
   * The record that created the character, location or style version a reference names; Project's `proj` reducer
   * treats it as the producer of that input, so a record that read a superseded version is stale. Story bible's reducer
   * defines it; at most one registered reducer defines it.
   * @param slice - the slice before the record being reduced.
   * @param ref - a character, location or style reference.
   * @returns the record, or null for an unknown version.
   */
  createdBy?(slice: ComponentStates[K], ref: RecordInputRef): RecordId | null
  /**
   * The fields of this slice that the agent reads in the project summary that `dv_proj_state` and the other
   * `dv_proj_*` tools return. Project merges the fields of every reducer that defines it, in component key order,
   * after the record count and before the stale records; a field name that Project or another component already uses
   * throws `invalid_params`.
   * @param slice - the slice of the current state.
   * @param assets - the asset store, for the URLs of the assets the slice names.
   * @param state - the whole current state, for the records the slice refers to.
   * @returns the fields by name.
   */
  agentSummary?(slice: ComponentStates[K], assets: Pick<AssetStore, 'url'>, state: ProjectState): Record<string, JsonValue>
}

/** The state of a project at one record: the result of the chain that ends there. */
export interface ProjectState {
  project: ProjectInfo
  /** The record the state is computed at; for the current state, the current position. */
  head: RecordId
  /** One slice per registered reducer. */
  components: ComponentStates
}

/** What a history query selects. Every filter is optional; filters combine with AND. */
export interface HistoryQuery {
  project: ProjectId
  actor?: Actor
  component?: string
  operation?: string
  kind?: RecordKind
  status?: RecordStatus
  session?: SessionId
  turn?: TurnId
  /** Only records written by this tool call. */
  tool_call?: string
  /** Only these records. */
  records?: RecordId[]
  /** Only records written before this record, for paging. */
  before?: RecordId
  /** At most this many entries. */
  limit?: number
}

/** One entry of the history list: one step and where it stands relative to the current position. */
export interface HistoryEntry {
  record: ProjectRecord
  /** `current` for the current position, `before` for a step before it, `after` for a step redo brings back. */
  place: 'before' | 'current' | 'after'
}

/** One operation call through `dvProject.run`. */
export interface RunRequest extends RecordOrigin {
  project: ProjectId
  /** The operation name. */
  operation: string
  params: Record<string, unknown>
  inputs: Array<{ role: string; ref: RecordInputRef }>
  /**
   * Schedule the call instead of running it now: the runner writes the pending record at once and the scheduler runs
   * it after these records and the producers of its `{record, output}` inputs are done.
   */
  after?: RecordId[]
  based_on?: RecordId | null
  supersedes?: RecordId[]
  /** The turn's stop signal: aborting it aborts the execution (code `stopped`). */
  signal?: AbortSignal
}

/** What `dvProject.run` returns. */
export interface RunResult {
  /** The record in its final status; pending for a scheduled call; null for a read. */
  record: ProjectRecord | null
  outputs: AssetId[]
  report: Record<string, unknown> | null
}

/** The history list's last step and the current position, as `line.json` stores them. */
export interface ProjectLine {
  /** The last step of the history list; the list is its `parents[0]` ancestry. */
  tip: RecordId
  /** The current position: a record of the history list; the project state is the state at it. */
  at: RecordId
}

/** What a subscriber learns about a project change. */
export type ProjectEvent =
  | { kind: 'record'; record: ProjectRecord }
  | { kind: 'update'; record: ProjectRecord }
  /** The current position or the last step changed (an append, undo, redo, or a move to a step). */
  | ({ kind: 'line' } & ProjectLine)

/**
 * The asset pool as Project sees it: Project checks that input assets exist, imports the files operations produce,
 * and describes outputs to the agent. The asset pool registers itself with `dvProject.registerAssetStore`.
 */
export interface AssetStore {
  /**
   * @param asset - an asset ID.
   * @returns whether the asset pool holds it.
   */
  has(asset: AssetId): boolean
  /**
   * @param asset - an asset the pool holds.
   * @returns its media type and display name. Throws for an unknown asset.
   */
  get(asset: AssetId): { mime: string; name: string }
  /**
   * @param asset - an asset the pool holds.
   * @returns its bytes. Throws for an unknown asset.
   */
  read(asset: AssetId): Uint8Array
  /**
   * Import a file or bytes into the asset pool.
   * @param source - the bytes, or a file path to copy.
   * @param meta - the media type, the display name, the duration for audio and video, and the pixel size when known.
   * @param createdBy - the record that created the asset; null for a read-only operation.
   * @returns the asset's ID.
   */
  importAsset(
    source: Parameters<OperationContext['importAsset']>[0],
    meta: Parameters<OperationContext['importAsset']>[1],
    createdBy: RecordId | null,
  ): AssetId
  /**
   * @param asset - an asset ID.
   * @returns the URL that serves its bytes, as the agent and chat cards show it.
   */
  url(asset: AssetId): string
}
