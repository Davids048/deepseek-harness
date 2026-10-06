/**
 * The Project component as the `dvProject` Cordis service. Project owns the records of every project, its branches
 * and drafts, undo and redo, the operation runner and scheduler, the reducer registry, history queries, and change
 * subscriptions. Every change to a project goes through this service and is written as a record:
 * - operations of every component go through {@link DvProject.run}, the single change path;
 * - Project's own actions (`proj.*`) go through the methods named after them, which write `proj.*` records.
 * Reads (`getState`, `getRecord`, `listHistory`, `listBranches`, `workingBranch`, `openProject`, `listProjects`)
 * write no record.
 *
 * Working branch. Each chat session has at most one open draft, `draft/<session>`, which spans turns. The working
 * branch of a session is its open draft, else the exploration branch it switched to, else `main`; an action without a
 * session works on `main`. The first `agent` write of a session without an open draft opens the draft, forked from
 * the session's working branch. A human edit with a session goes to that session's draft when one is open, else to
 * the session's working branch; human and `system` writes never open a draft. Project never accepts or discards a
 * draft by itself.
 *
 * Accept merges the draft into the branch it was forked from (normally `main`). When that branch moved after the draft
 * was opened, accept replays the draft's records on it and stops with `DraftConflictError`, writing nothing, at the
 * first record that conflicts. Discard drops the draft, including the human's edits on it, after the caller confirms
 * the counts it showed.
 *
 * Concurrency: one lock per project. A run holds it while it checks and appends its record and while it writes each
 * update line, and releases it while an approval card waits and while the operation executes. Accept, discard, undo,
 * redo, branch creation, branch switching and project creation hold it for their whole duration.
 *
 * Agent tools. While the DSH `tools` registry is mounted, every registered operation also has its agent tool
 * `dv_<operation name with _>`, built by the `agent-tools` module. A tool call runs the operation as the agent on the
 * project its chat session is bound to (`bindSession`), in the session's current turn (`noteTurn`). Project also
 * registers its own `dv_proj_*` tools (the `proj-tools` module); they bind the session to its project and return the
 * project summary, to which each component's reducer adds its fields through `Reducer.agentSummary`.
 *
 * The asset pool registers itself with {@link DvProject.registerAssetStore}; until it does, a run that names an input
 * asset or imports an output fails.
 *
 * The internal modules (`record-store`, `runner`, `scheduler`, `drafts`, `history`, `reducers`, `subscriptions`,
 * `sessions`, `agent-tools`, `proj-tools`) are private; `CONTRACTS.md` in this package specifies each of them.
 *
 * @module @dv/project
 */
import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { AgentTools, parseInputs } from './agent-tools.ts'
import { Drafts } from './drafts.ts'
import { History } from './history.ts'
import { projTools } from './proj-tools.ts'
import { RecordStore } from './record-store.ts'
import { projReducer, ReducerRegistry } from './reducers.ts'
import { Runner } from './runner.ts'
import { Scheduler } from './scheduler.ts'
import { MAIN_BRANCH, ProjectError } from './shared.ts'
import { Sessions } from './sessions.ts'
import { Subscriptions } from './subscriptions.ts'
import type {
  ApprovalChannel, AssetId, AssetStore, Branch, ComponentStates, DraftCounts, HistoryEntry, HistoryQuery, OperationSpec,
  ProjectEvent, ProjectId, ProjectInfo, ProjectRecord, ProjectState, RecordId, RecordInputRef, RecordOrigin, Reducer,
  RunRequest, RunResult, SessionId, ToolCallCheck, TurnId,
} from './types.ts'

export * from './types.ts'
export { DraftConflictError, MAIN_BRANCH, ProjectError, draftBranch } from './shared.ts'
export { formatInputRef, sessionOf, toolNameOf, type OperationToolValue } from './agent-tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Project component: records, branches and drafts, undo and redo, operations, state and history. */
    dvProject: DvProject
  }
}

/** `dvProject` plugin configuration. */
export interface Config {
  /** The directory holding one `<ProjectId>/` per project (`$DV_STATE_ROOT/projects`); created when missing. */
  root: string
  /** Scheduled records of `cpu` operations that may run at the same time. */
  cpuConcurrency: number
  /** Scheduled records of `gpu` operations that may run at the same time. */
  gpuConcurrency: number
  /** The directory holding one file per chat session with the project it is bound to (`$DV_STATE_ROOT/sessions`). */
  sessionRoot: string
}

/** Loader validation. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
  cpuConcurrency: z.number().default(4),
  gpuConcurrency: z.number().default(1),
  sessionRoot: z.string().required(),
})

/** The Project service. */
export default class DvProject extends Service {
  static Config = Config

  private readonly subscriptions = new Subscriptions()
  private readonly store: RecordStore
  private readonly reducers: ReducerRegistry
  private readonly drafts: Drafts
  private readonly history: History
  private readonly runner: Runner
  private readonly scheduler: Scheduler
  private readonly sessions: Sessions
  private readonly agentTools: AgentTools
  private assetStore: AssetStore | null = null
  private toolCallCheck: ToolCallCheck | null = null
  /**
   * Registers one operation's agent tool while the DSH tool registry is mounted, else null; and the disposer of each
   * operation's tool by operation name.
   */
  private registerOperationTool: ((spec: OperationSpec) => () => void) | null = null
  private readonly toolDisposers = new Map<string, () => void>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'dvProject')
    this.subscriptions.onListenerError = (error) => {
      ctx.logger('dvProject').warn('a project subscriber threw: %s', error instanceof Error ? error.message : String(error))
    }
    // Every change on disk reaches the subscribers; a finished record also lets the scheduler start its dependents.
    this.store = new RecordStore(config.root, (project, event) => {
      this.subscriptions.emit(project, event)
      if (event.kind === 'update' && ['done', 'failed', 'cancelled'].includes(event.record.status)) this.scheduler.recordFinished(project)
    })
    this.reducers = new ReducerRegistry(this.store)
    this.drafts = new Drafts(this.store, this.reducers)
    this.history = new History(this.store)
    // The scheduler runs ready records through the runner, which is created next; the callback reads it at call time.
    this.scheduler = new Scheduler(this.store, (project, record) => this.runner.execute(project, record), {
      cpu: config.cpuConcurrency, gpu: config.gpuConcurrency,
    })
    // The runner reaches the asset pool through the registered store, read at call time.
    this.runner = new Runner({
      store: this.store, drafts: this.drafts, reducers: this.reducers, scheduler: this.scheduler,
      assets: {
        has: asset => this.requireAssetStore().has(asset),
        importAsset: (source, meta, createdBy) => this.requireAssetStore().importAsset(source, meta, createdBy),
      },
    })
    this.sessions = new Sessions(config.sessionRoot)
    this.agentTools = new AgentTools(ctx, {
      sessions: this.sessions,
      assets: () => this.requireAssetStore(),
      toolCallCheck: () => this.toolCallCheck,
      workingState: (project, session) => this.getState(project, this.workingBranch(project, session).name),
      versionCreatedBy: (state, ref) => this.reducers.versionCreatedBy(state, ref),
      run: request => this.run(request),
      getRecord: (project, record) => this.getRecord(project, record),
      listHistory: query => this.listHistory(query),
    })
    this.store.load()
    this.reducers.register('proj', projReducer)
    // Every registered operation has its agent tool while the DSH tool registry is mounted.
    ctx.inject(['tools'], (child) => {
      // The registry stays in this closure: read through the service from another plugin, it would bind each tool to
      // that plugin's fiber, which may be unloading (a tool call check removed while its plugin unloads).
      const registry = child.tools
      child.effect(() => {
        this.registerOperationTool = spec => registry.register(this.agentTools.define(spec))
        for (const spec of this.listOperations()) this.addTool(spec)
        return () => {
          for (const dispose of this.toolDisposers.values()) dispose()
          this.toolDisposers.clear()
          this.registerOperationTool = null
        }
      }, 'dvProject operation tools')
      const projToolDeps = {
        assets: () => this.requireAssetStore(),
        agentSummaries: (state: ProjectState) => this.reducers.agentSummaries(state, this.requireAssetStore()),
      }
      for (const definition of projTools(this, projToolDeps)) child.effect(() => registry.register(definition), `dvProject ${definition.name}`)
    })
    ctx.effect(() => () => { this.scheduler.dispose() }, 'dvProject stop scheduling')
    this.runner.recover().catch((error: unknown) => {
      ctx.logger('dvProject').warn('could not end unfinished records: %s', error instanceof Error ? error.message : String(error))
    })
  }

  /**
   * Create a project: write `project.json`, then the project's first record, `proj.create` with `params {title}`, on
   * `main` with status `done`. Holds the new project's lock.
   * @param title - the project title.
   * @param origin - who creates it, from where.
   * @returns the project's metadata.
   */
  async createProject(title: string, origin: RecordOrigin): Promise<ProjectInfo> {
    const info: ProjectInfo = { id: brandString<ProjectId>(randomUUID()), title, created_at: new Date().toISOString() }
    this.store.createProject(info)
    await this.store.lock(info.id, () => this.store.append(info.id, {
      parents: [], branch: MAIN_BRANCH, kind: 'operation', component: 'proj', operation: 'proj.create', operation_version: '1',
      ...origin, params: { title }, inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: true, status: 'done',
    }))
    return info
  }

  /**
   * Open a project: check that it exists and return its metadata. Writes no record; the caller remembers which project
   * a session works on.
   * @param project - the project.
   * @returns its metadata; throws `unknown_project`.
   */
  openProject(project: ProjectId): ProjectInfo {
    return this.store.getProject(project)
  }

  /** @returns every project's metadata, oldest first. */
  listProjects(): ProjectInfo[] {
    return this.store.listProjects()
  }

  /**
   * Change a project's title in `project.json`. Writes no record.
   * @param project - the project.
   * @param title - the new title.
   * @returns the metadata after the change.
   */
  renameProject(project: ProjectId, title: string): Promise<ProjectInfo> {
    return this.store.lock(project, () => this.store.renameProject(project, title))
  }

  /**
   * Delete a project: move its directory to the store's trash and forget it. Writes no record.
   * @param project - the project.
   */
  deleteProject(project: ProjectId): Promise<void> {
    return this.store.lock(project, () => { this.store.deleteProject(project) })
  }

  /**
   * Run one operation call: the single change path for every component's operations. The record goes to the working
   * branch of `request.session` (an `agent` call opens the session's draft first when none is open). When the
   * operation's `confirm` is `agent_ask_first`, the actor is `agent`, and the session's composer asks first, the
   * runner waits for the approval card before executing; a skipped card ends the record `cancelled` with code
   * `skipped`. With `after`, the call is scheduled and the result holds the `pending` record. A read-only operation
   * writes no record and returns its answer in `report`.
   * @param request - the call.
   * @returns the record in its final status (or `pending` when scheduled), its outputs and report. Rejects with
   *   `ProjectError` only when the call is refused before a record is written.
   */
  run(request: RunRequest): Promise<RunResult> {
    return this.runner.run(request)
  }

  /**
   * Accept the draft of `origin.session` into the branch it was forked from, replaying it when that branch moved.
   * Writes a `proj.draft_accept` record.
   * @param project - the project.
   * @param origin - who accepts; `session` names the draft.
   * @returns the `proj.draft_accept` record. Throws `no_open_draft`, `draft_busy`, or `DraftConflictError`.
   */
  acceptDraft(project: ProjectId, origin: RecordOrigin): Promise<ProjectRecord> {
    return this.store.lock(project, () => this.drafts.accept(project, origin))
  }

  /**
   * Discard the draft of `origin.session`, including the human's edits on it. Writes a `proj.draft_discard` record.
   * The caller first shows the draft's `counts` (from {@link DvProject.workingBranch}) in a confirmation dialog and
   * passes them here; when the draft changed meanwhile the call throws `draft_changed` and discards nothing.
   * @param project - the project.
   * @param origin - who discards; `session` names the draft.
   * @param counts - the counts the dialog showed.
   * @returns the counts of the discarded records. Throws `no_open_draft`, `draft_busy`, or `draft_changed`.
   */
  discardDraft(project: ProjectId, origin: RecordOrigin, counts: DraftCounts): Promise<DraftCounts> {
    return this.store.lock(project, () => this.drafts.discard(project, origin, counts))
  }

  /**
   * Move `main` back by one accepted change: one accepted draft, or one other change on `main`. Writes a `proj.undo`
   * record on `main` whose `params.to` names the record whose state `main` returns to.
   * @param project - the project.
   * @param origin - who undoes, from where.
   * @returns the `proj.undo` record. Throws `nothing_to_undo`.
   */
  undo(project: ProjectId, origin: RecordOrigin): Promise<ProjectRecord> {
    return this.store.lock(project, () => this.history.undo(project, origin))
  }

  /**
   * Re-apply the change the latest undo removed, while no other change followed it on `main`. Writes a `proj.redo`
   * record on `main` with `params.to`.
   * @param project - the project.
   * @param origin - who redoes, from where.
   * @returns the `proj.redo` record. Throws `nothing_to_redo`.
   */
  redo(project: ProjectId, origin: RecordOrigin): Promise<ProjectRecord> {
    return this.store.lock(project, () => this.history.redo(project, origin))
  }

  /**
   * Create an exploration branch `explore/<name>` at a record or at a branch head. Writes a `proj.branch_create`
   * record on the new branch.
   * @param project - the project.
   * @param name - the full branch name, starting with `explore/`.
   * @param at - a record ID or a branch name.
   * @param origin - who creates it.
   * @returns the branch. Throws `branch_exists`, `unknown_branch`, `unknown_record`, or `invalid_params`.
   */
  createBranch(project: ProjectId, name: string, at: RecordId | string, origin: RecordOrigin): Promise<Branch> {
    return this.store.lock(project, () => this.drafts.createBranch(project, name, at, origin))
  }

  /**
   * Switch the working branch of `origin.session` to `main` or an exploration branch. Writes a `proj.branch_switch`
   * record on the target branch. While the session has an open draft, the draft stays its working branch.
   * @param project - the project.
   * @param branch - `main` or an exploration branch name.
   * @param origin - who switches; `session` is required.
   * @returns the target branch. Throws `unknown_branch` or `invalid_params`.
   */
  switchBranch(project: ProjectId, branch: string, origin: RecordOrigin): Promise<Branch> {
    return this.store.lock(project, () => this.drafts.switchBranch(project, branch, origin))
  }

  /**
   * Accept a stale record's result: write a `proj.stale_accept` record with `params {record}` on the origin's working
   * branch, which removes the record's stale mark from then on.
   * @param project - the project.
   * @param record - a stale record.
   * @param origin - who accepts it.
   * @returns the `proj.stale_accept` record.
   */
  acceptStale(project: ProjectId, record: RecordId, origin: RecordOrigin): Promise<ProjectRecord> {
    return this.runner.acceptStale(project, record, origin)
  }

  /**
   * The state of a branch at its head: one slice per registered reducer.
   * @param project - the project.
   * @param branch - a branch name; defaults to `main`. Use `workingBranch(project, session).name` for a session.
   * @returns the state. Throws `unknown_project` or `unknown_branch`.
   */
  getState(project: ProjectId, branch: string = MAIN_BRANCH): ProjectState {
    return this.reducers.getState(project, branch)
  }

  /**
   * @param project - the project.
   * @param record - a record ID.
   * @returns the record in its current form. Throws `unknown_record`.
   */
  getRecord(project: ProjectId, record: RecordId): ProjectRecord {
    return this.store.getRecord(project, record)
  }

  /**
   * List a project's records, newest first, with their marks (`main`, `draft`, `undone`, `discarded`, `replayed`,
   * `branch`).
   * @param query - the project and the filters.
   * @returns the entries.
   */
  listHistory(query: HistoryQuery): HistoryEntry[] {
    return this.history.list(query)
  }

  /**
   * @param project - the project.
   * @returns every branch with draft counts; `main` first.
   */
  listBranches(project: ProjectId): Branch[] {
    return this.drafts.listBranches(project)
  }

  /**
   * The branch a session reads and writes: its open draft, else the exploration branch it switched to, else `main`.
   * @param project - the project.
   * @param session - a chat session, or null for an action outside any chat session (always `main`).
   * @returns the branch, with `counts` when it is a draft.
   */
  workingBranch(project: ProjectId, session: SessionId | null): Branch {
    return this.drafts.workingBranch(project, session)
  }

  /**
   * Wait until records finish.
   * @param project - the project.
   * @param records - the records to wait for; omitted means every scheduled record of the project.
   * @returns a promise that settles when they are `done`, `failed` or `cancelled`.
   */
  wait(project: ProjectId, records?: RecordId[]): Promise<void> {
    return this.scheduler.wait(project, records)
  }

  /**
   * Receive a project's record appends, record updates and branch changes, after each is on disk.
   * @param project - the project.
   * @param listener - called synchronously for each change.
   * @returns a function that removes the listener.
   */
  subscribe(project: ProjectId, listener: (event: ProjectEvent) => void): () => void {
    return this.subscriptions.subscribe(project, listener)
  }

  /**
   * Register an operation and, while the DSH `tools` registry is mounted, its agent tool `dv_<name with _>`; a
   * component calls it from its plugin inside `ctx.effect` and returns the disposer.
   * @param spec - the operation.
   * @returns a function that removes the operation and its tool. Throws `operation_exists`, or `invalid_params` for
   *   an unknown component key or a name that does not start with `<component>.`.
   */
  registerOperation(spec: OperationSpec): () => void {
    const remove = this.runner.registerOperation(spec)
    this.addTool(spec)
    return () => {
      remove()
      this.toolDisposers.get(spec.name)?.()
      this.toolDisposers.delete(spec.name)
    }
  }

  /** @returns every registered operation, in registration order. */
  listOperations(): OperationSpec[] {
    return this.runner.listOperations()
  }

  /**
   * Register a component's reducer for its state slice; a component calls it inside `ctx.effect`.
   * @param key - the component key, declared in `ComponentStates`.
   * @param reducer - the reducer.
   * @returns a function that removes it. Throws `reducer_exists`.
   */
  registerReducer<K extends keyof ComponentStates>(key: K, reducer: Reducer<K>): () => void {
    return this.reducers.register(key, reducer)
  }

  /**
   * The assets a character, location or style version stands for, read through `assetsOf` of the reducer that defines it.
   * @param state - the state to read the version in, normally the caller's working branch.
   * @param ref - a versioned input reference.
   * @returns the version's assets, or null for an unknown version or when no reducer answers.
   */
  assetsOf(state: ProjectState, ref: RecordInputRef): AssetId[] | null {
    return this.reducers.assetsOf(state, ref)
  }

  /**
   * Turn the `inputs` argument of a tool call or a view request into run inputs: `<record>#<n>` names output n of a
   * record, `<id>@<n>` a character, location or style version, anything else an asset.
   * @param operation - a registered operation name.
   * @param raw - role → reference text or a list of them; undefined for none.
   * @param state - the state the references are read against, normally the caller's working branch.
   * @returns the inputs. Throws `unknown_operation`, or an `Error` naming the role for an unknown role, a list on a
   *   single role, a missing required role, or an unknown version.
   */
  parseInputs(operation: string, raw: unknown, state: ProjectState): RunRequest['inputs'] {
    const spec = this.listOperations().find(candidate => candidate.name === operation)
    if (spec === undefined) throw new ProjectError('unknown_operation', `Operation ${operation} is not registered.`)
    return parseInputs(spec, raw, state, (at, ref) => this.reducers.versionCreatedBy(at, ref))
  }

  /**
   * Bind a chat session to a project, so its agent tools and the views beside its chat work on that project. The
   * binding is saved under `sessionRoot` and survives a restart.
   * @param session - the chat session.
   * @param project - the project.
   */
  bindSession(session: SessionId, project: ProjectId): void {
    this.sessions.bind(session, project)
  }

  /**
   * @param session - a chat session.
   * @returns the project it is bound to, or null while it has none.
   */
  sessionProject(session: SessionId): ProjectId | null {
    return this.sessions.project(session)
  }

  /**
   * Note the agent turn a chat session is in and the human's words that started it, so the records of the turn's tool
   * calls carry the turn and the first one writes the turn's `request` record. A new turn number starts a new turn ID;
   * the same number with words sets the words.
   * @param session - the chat session.
   * @param turn - the agent loop's turn number.
   * @param requestText - the human's words; empty while they are not known.
   */
  noteTurn(session: SessionId, turn: number, requestText: string): void {
    this.sessions.noteTurn(session, turn, requestText)
  }

  /**
   * @param session - a chat session.
   * @returns the ID of the turn it is in, or null before its first noted turn.
   */
  sessionTurn(session: SessionId): TurnId | null {
    return this.sessions.turn(session)?.turn ?? null
  }

  /**
   * Make the session's next agent tool calls wait until `work` settles, for example while the images of the human's
   * message are imported. A failure of `work` does not fail the calls.
   * @param session - the chat session.
   * @param work - the work.
   */
  holdToolCalls(session: SessionId, work: Promise<unknown>): void {
    this.sessions.hold(session, work)
  }

  /**
   * Register the asset pool's store; one at a time, a later registration replaces the earlier one.
   * @param store - the store.
   * @returns a function that removes it.
   */
  registerAssetStore(store: AssetStore): () => void {
    this.assetStore = store
    return () => {
      if (this.assetStore === store) this.assetStore = null
    }
  }

  /**
   * Register the agent integration's check of every agent tool call; one at a time, a later registration replaces the
   * earlier one. The tools are registered again so that their schemas carry the check's tool-only arguments.
   * @param check - the check.
   * @returns a function that removes it.
   */
  registerToolCallCheck(check: ToolCallCheck): () => void {
    this.toolCallCheck = check
    this.refreshTools()
    return () => {
      if (this.toolCallCheck !== check) return
      this.toolCallCheck = null
      this.refreshTools()
    }
  }

  /**
   * Register the composer's approval channel; one at a time, a later registration replaces the earlier one.
   * @param channel - the channel.
   * @returns a function that removes it.
   */
  registerApprovalChannel(channel: ApprovalChannel): () => void {
    return this.runner.registerApprovalChannel(channel)
  }

  /** @returns the registered asset store; throws while the asset pool has not registered one. */
  private requireAssetStore(): AssetStore {
    if (this.assetStore === null) throw new Error('No asset store is registered with dvProject; mount the asset pool.')
    return this.assetStore
  }

  /** Register every operation's agent tool again, after the tool call check changed. */
  private refreshTools(): void {
    if (this.registerOperationTool === null) return
    for (const dispose of this.toolDisposers.values()) dispose()
    this.toolDisposers.clear()
    for (const spec of this.listOperations()) this.addTool(spec)
  }

  /** Register the agent tool of an operation while the DSH tool registry is mounted. */
  private addTool(spec: OperationSpec): void {
    if (this.registerOperationTool === null) return
    this.toolDisposers.set(spec.name, this.registerOperationTool(spec))
  }
}
