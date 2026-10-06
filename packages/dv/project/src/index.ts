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
 * The internal modules (`record-store`, `runner`, `scheduler`, `drafts`, `history`, `reducers`, `subscriptions`) are
 * private; `CONTRACTS.md` in this package specifies each of them.
 *
 * @module @dv/project
 */
import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import z from '@deepseek-ai/schemastery'
import type { PutOptions } from '@video-harness/assets' // names:allow (the asset store service until stage 3)
import { Drafts } from './drafts.ts'
import { History } from './history.ts'
import { RecordStore } from './record-store.ts'
import { projReducer, ReducerRegistry } from './reducers.ts'
import { Runner } from './runner.ts'
import { Scheduler } from './scheduler.ts'
import { MAIN_BRANCH } from './shared.ts'
import { Subscriptions } from './subscriptions.ts'
import type {
  ApprovalChannel, Branch, ComponentStates, DraftCounts, HistoryEntry, HistoryQuery, OperationSpec, ProjectEvent, ProjectId,
  ProjectInfo, ProjectRecord, ProjectState, RecordId, RecordOrigin, Reducer, RunRequest, RunResult, SessionId,
} from './types.ts'

export * from './types.ts'
export { DraftConflictError, MAIN_BRANCH, ProjectError, draftBranch } from './shared.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Project component: records, branches and drafts, undo and redo, operations, state and history. */
    dvProject: DvProject
  }
}

/** `dvProject` plugin configuration. */
export interface Config {
  /** The directory holding one `<ProjectId>/` per project (`$VH_STATE_ROOT/projects`); created when missing. */
  root: string
  /** Scheduled records of `cpu` operations that may run at the same time. */
  cpuConcurrency: number
  /** Scheduled records of `gpu` operations that may run at the same time. */
  gpuConcurrency: number
}

/** Loader validation. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
  cpuConcurrency: z.number().default(4),
  gpuConcurrency: z.number().default(1),
})

/** The Project service. */
export default class DvProject extends Service {
  static inject = ['vhAssets'] // names:allow (the asset store service until stage 3)
  static Config = Config

  private readonly subscriptions = new Subscriptions()
  private readonly store: RecordStore
  private readonly reducers: ReducerRegistry
  private readonly drafts: Drafts
  private readonly history: History
  private readonly runner: Runner
  private readonly scheduler: Scheduler

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
    const assets = ctx.vhAssets // names:allow
    this.runner = new Runner({
      store: this.store, drafts: this.drafts, reducers: this.reducers, scheduler: this.scheduler,
      assets: {
        has: asset => assets.has(asset),
        importAsset: (source, meta, createdBy) => assets.put(source, {
          mime: meta.mime, name: meta.name,
          producedBy: createdBy === null ? null : brandString<NonNullable<PutOptions['producedBy']>>(createdBy),
          ...meta.durationSec === undefined ? {} : { durationSec: meta.durationSec },
          ...meta.width === undefined ? {} : { width: meta.width },
          ...meta.height === undefined ? {} : { height: meta.height },
        }),
      },
    })
    this.store.load()
    this.reducers.register('proj', projReducer)
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
   * Keep a stale record's result: write a `proj.stale_accept` record with `params {record}` on the origin's working
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
   * Register an operation; a component calls it from its plugin inside `ctx.effect` and returns the disposer.
   * @param spec - the operation.
   * @returns a function that removes it. Throws `operation_exists` or `invalid_params`.
   */
  registerOperation(spec: OperationSpec): () => void {
    return this.runner.registerOperation(spec)
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
   * Register the composer's approval channel; one at a time, a later registration replaces the earlier one.
   * @param channel - the channel.
   * @returns a function that removes it.
   */
  registerApprovalChannel(channel: ApprovalChannel): () => void {
    return this.runner.registerApprovalChannel(channel)
  }
}
