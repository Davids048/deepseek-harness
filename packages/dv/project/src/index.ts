/**
 * The Project component as the `dvProject` Cordis service. Project owns the records of every project, the history
 * list with its current position, the operation runner and scheduler, the reducer registry, history queries, and
 * change subscriptions. Every change to a project's content goes through this service and is written as a record:
 * - operations of every component go through {@link DvProject.run}, the single change path;
 * - Project's own actions (`proj.*`) go through the methods named after them, which write `proj.*` records.
 * Reads (`getState`, `getRecord`, `listHistory`, `openProject`, `listProjects`) write no record.
 *
 * History, as in the History panel of an image editor. Each record is a step of the project's history list; the
 * current position is one step of it, and the project state is the state at that step. `undo`, `redo` and `moveTo`
 * only move the current position and write no record. A write follows the current position, so the steps that were
 * after it are discarded; a discarded step that has not finished is cancelled.
 *
 * Concurrency: one lock per project. A run holds it while it checks and appends its record and while it writes each
 * update line, and releases it while the operation executes. Moves and project creation hold it for their whole
 * duration.
 *
 * Agent tools. While the DSH `tools` registry is mounted, every registered operation also has its agent tool
 * `dv_<operation name with _>`, built by the `agent-tools` module. A tool call runs the operation as the agent on the
 * project its chat session is bound to (`bindSession`), in the session's DSH turn; an operation whose `confirm` asks
 * for the user's agreement refuses a call without it (`OperationSpec.confirm`). Project also registers its own
 * `dv_proj_*` tools (the `proj-tools` module); they bind the session to its project and return the project summary,
 * to which each component's reducer adds its fields through `Reducer.agentSummary`. While the DSH `systemPrompt`
 * service is mounted, Project's rules and the summary of the project's current state reach the agent at every step
 * as the `dv:project` prompt section (the `agent-context` module).
 *
 * The asset pool registers itself with {@link DvProject.registerAssetStore}; until it does, a run that names an input
 * asset or imports an output fails.
 *
 * The internal modules (`record-store`, `runner`, `scheduler`, `history`, `reducers`, `subscriptions`,
 * `sessions`, `agent-tools`, `proj-tools`, `agent-context`) are private; `CONTRACTS.md` in this package specifies each of them.
 *
 * @module @dv/project
 */
import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { PROMPT_SECTION, projectContext } from './agent-context.ts'
import { AgentTools, parseInputs, turnOf } from './agent-tools.ts'
import { History } from './history.ts'
import { projTools, type ProjToolDeps } from './proj-tools.ts'
import { RecordStore } from './record-store.ts'
import { projReducer, ReducerRegistry } from './reducers.ts'
import { Runner } from './runner.ts'
import { Scheduler } from './scheduler.ts'
import { ProjectError } from './shared.ts'
import { Sessions } from './sessions.ts'
import { Subscriptions } from './subscriptions.ts'
import type {
  AssetId, AssetStore, ComponentStates, ProjectLine, HistoryEntry, HistoryQuery, OperationSpec,
  ProjectEvent, ProjectId, ProjectInfo, ProjectRecord, ProjectState, RecordId, RecordInputRef, RecordOrigin, Reducer,
  RunRequest, RunResult, SessionId,
} from './types.ts'

export * from './types.ts'
export { ProjectError } from './shared.ts'
export { formatInputRef, sessionOf, toolNameOf, type OperationToolValue } from './agent-tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Project component: records, undo, operations, state and history. */
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
  /** Estimated GPU seconds one agent turn may spend on `over_gpu_budget` operations before the user must agree. */
  confirmGpuSecondsThreshold: number
  /** Order of the `dv:project` section in the system prompt; before the tool SDK section at 5000. */
  promptSectionOrder: number
}

/** Loader validation. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
  cpuConcurrency: z.number().default(4),
  gpuConcurrency: z.number().default(1),
  sessionRoot: z.string().required(),
  confirmGpuSecondsThreshold: z.number().default(60),
  promptSectionOrder: z.number().default(4900),
})

/** The Project service. */
export default class DvProject extends Service {
  static Config = Config

  private readonly subscriptions = new Subscriptions()
  private readonly store: RecordStore
  private readonly reducers: ReducerRegistry
  private readonly history: History
  private readonly runner: Runner
  private readonly scheduler: Scheduler
  private readonly sessions: Sessions
  private readonly agentTools: AgentTools
  private assetStore: AssetStore | null = null
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
    this.history = new History(this.store)
    // The scheduler runs ready records through the runner, which is created next; the callback reads it at call time.
    this.scheduler = new Scheduler(this.store, (project, record) => this.runner.execute(project, record), {
      cpu: config.cpuConcurrency, gpu: config.gpuConcurrency,
    })
    // The runner reaches the asset pool through the registered store, read at call time.
    this.runner = new Runner({
      store: this.store, reducers: this.reducers, scheduler: this.scheduler,
      assets: {
        has: asset => this.requireAssetStore().has(asset),
        importAsset: (source, meta, createdBy) => this.requireAssetStore().importAsset(source, meta, createdBy),
      },
    })
    this.sessions = new Sessions(config.sessionRoot)
    this.agentTools = new AgentTools(ctx, {
      sessions: this.sessions,
      assets: () => this.requireAssetStore(),
      confirmGpuSecondsThreshold: config.confirmGpuSecondsThreshold,
      listOperations: () => this.listOperations(),
      currentState: project => this.getState(project),
      versionCreatedBy: (state, ref) => this.reducers.versionCreatedBy(state, ref),
      run: request => this.run(request),
      getRecord: (project, record) => this.getRecord(project, record),
      listHistory: query => this.listHistory(query),
    })
    this.store.load()
    this.reducers.register('proj', projReducer)
    // The project summary that the `dv_proj_*` tools return and the `dv:project` prompt section shows.
    const projToolDeps: ProjToolDeps = {
      assets: () => this.requireAssetStore(),
      agentSummaries: (state: ProjectState) => this.reducers.agentSummaries(state, this.requireAssetStore()),
      turnOf: exec => turnOf(ctx, exec),
    }
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
      for (const definition of projTools(this, projToolDeps)) child.effect(() => registry.register(definition), `dvProject ${definition.name}`)
    })
    ctx.inject(['systemPrompt'], (child) => {
      child.effect(() => child.systemPrompt.section({
        name: PROMPT_SECTION,
        order: config.promptSectionOrder,
        interpolate: false,
        text: context => projectContext(this, projToolDeps, context.agent?.id),
      }), 'dvProject prompt section')
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
      parents: [], kind: 'operation', component: 'proj', operation: 'proj.create', operation_version: '1',
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
   * Run one operation call: the single change path for every component's operations. The record goes after the
   * project's current position (see the module comment). With `after`,
   * the call is scheduled and the result holds the `pending` record. A read-only operation writes no record and
   * returns its answer in `report`.
   * @param request - the call.
   * @returns the record in its final status (or `pending` when scheduled), its outputs and report. Rejects with
   *   `ProjectError` only when the call is refused before a record is written.
   */
  run(request: RunRequest): Promise<RunResult> {
    return this.runner.run(request)
  }

  /**
   * Move the current position one step back. Writes no record. Rules in the history module.
   * @param project - the project.
   * @returns the last step and the current position afterwards. Throws `nothing_to_undo` at the first record.
   */
  undo(project: ProjectId): Promise<ProjectLine> {
    return this.store.lock(project, () => this.history.undo(project))
  }

  /**
   * Move the current position to a step of the history list, before or after it. Writes no record. Rules in the history
   * module.
   * @param project - the project.
   * @param to - a step of the history list.
   * @returns the last step and the current position afterwards. Throws `unknown_record`, or `invalid_params` for a
   *   discarded record.
   */
  moveTo(project: ProjectId, to: RecordId): Promise<ProjectLine> {
    return this.store.lock(project, () => this.history.moveTo(project, to))
  }

  /**
   * Move the current position one step forward, toward the last step. Writes no record.
   * @param project - the project.
   * @returns the last step and the current position afterwards. Throws `nothing_to_redo`.
   */
  redo(project: ProjectId): Promise<ProjectLine> {
    return this.store.lock(project, () => this.history.redo(project))
  }

  /**
   * @param project - the project.
   * @returns the last step of the history list and the current position. Throws `unknown_project`, or `invalid_params`
   *   before the first record.
   */
  line(project: ProjectId): ProjectLine {
    return this.store.requireLine(project)
  }

  /**
   * Accept a stale record's result: write a `proj.stale_accept` record with `params {record}` after the current position,
   * which removes the record's stale mark from then on.
   * @param project - the project.
   * @param record - a stale record.
   * @param origin - who accepts it.
   * @returns the `proj.stale_accept` record.
   */
  acceptStale(project: ProjectId, record: RecordId, origin: RecordOrigin): Promise<ProjectRecord> {
    return this.runner.acceptStale(project, record, origin)
  }

  /**
   * The project's current state: one slice per registered reducer, computed at the current position.
   * @param project - the project.
   * @returns the state. Throws `unknown_project`.
   */
  getState(project: ProjectId): ProjectState {
    return this.reducers.getState(project)
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
   * Every record of a project in write order, discarded records included (a discarded import keeps its asset in the
   * asset pool). A read: it writes no record.
   * @param project - the project.
   * @returns the records in their current form.
   */
  listRecords(project: ProjectId): ProjectRecord[] {
    return this.store.listRecords(project)
  }

  /**
   * List the steps of a project's history list, newest first, each with its place relative to the current position;
   * discarded records are not listed.
   * @param query - the project and the filters.
   * @returns the entries.
   */
  listHistory(query: HistoryQuery): HistoryEntry[] {
    return this.history.list(query)
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
   * Receive a project's record appends and record updates, after each is on disk.
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
   *   an unknown component key, a name that does not start with `<component>.`, or a `confirm` other than `never`
   *   without `confirmSummary`.
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
   * @param state - the state to read the version in, normally the project's current state.
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
   * @param state - the state the references are read against, normally the project's current state.
   * @param callerName - the name the error messages give the call: the tool name for an agent tool call, the operation
   *   name (the default) for a view request or a call made by another operation.
   * @returns the inputs. Throws `unknown_operation`, or an `Error` naming the role and `callerName` for an unknown role,
   *   a list on a single role, or a missing required role, or an `Error` for an unknown version.
   */
  parseInputs(operation: string, raw: unknown, state: ProjectState, callerName: string = operation): RunRequest['inputs'] {
    const spec = this.listOperations().find(candidate => candidate.name === operation)
    if (spec === undefined) throw new ProjectError('unknown_operation', `Operation ${operation} is not registered.`)
    return parseInputs(spec, raw, state, (at, ref) => this.reducers.versionCreatedBy(at, ref), callerName)
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

  /** @returns the registered asset store; throws while the asset pool has not registered one. */
  private requireAssetStore(): AssetStore {
    if (this.assetStore === null) throw new Error('No asset store is registered with dvProject; mount the asset pool.')
    return this.assetStore
  }

  /** Register the agent tool of an operation while the DSH tool registry is mounted. */
  private addTool(spec: OperationSpec): void {
    if (this.registerOperationTool === null) return
    this.toolDisposers.set(spec.name, this.registerOperationTool(spec))
  }
}
