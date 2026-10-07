/**
 * The operation runner: the operation registry and the single change path of operations. `run` checks a request,
 * writes its pending record on the right branch, then executes the operation now or hands the record to the
 * scheduler. The agent's confirmation (`OperationSpec.confirm`) is checked earlier, in the agent tool call.
 *
 * Lock scope: the runner holds the project lock (from the record store) while it checks and appends a record and
 * while it writes each update line. It releases the lock while `execute` runs, so a long render does not block other
 * edits, and an operation's `execute` may itself call `dvProject.run`.
 *
 * Calls: the record store (lock, append, update, records), drafts (`branchForWrite`, `workingBranch`), the reducer
 * registry (state at a record's parent, character, location and style assets), the scheduler (`enqueue`), and the
 * asset store. Called by the service and by the scheduler (`execute`).
 *
 * @module @dv/project/runner
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateArgs } from '@deepseek-ai/dsh-tools'
import type { Drafts } from './drafts.ts'
import type { ReducerRegistry } from './reducers.ts'
import type { RecordStore } from './record-store.ts'
import type { Scheduler } from './scheduler.ts'
import { COMPONENT_KEYS, ProjectError } from './shared.ts'
import type {
  AssetId, OperationContext, OperationSpec, ProjectId, ProjectRecord, ProjectState, RecordFailure, RecordId,
  RecordInput, RecordOrigin, RecordUpdate, RunRequest, RunResult,
} from './types.ts'

/** What the runner needs from the asset store. */
export interface RunnerAssets {
  /**
   * @param asset - an asset ID.
   * @returns whether the asset store holds it.
   */
  has(asset: AssetId): boolean
  /**
   * Import a file or bytes into the asset store.
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
}

/** The modules and services the runner calls. */
export interface RunnerDeps {
  store: RecordStore
  drafts: Drafts
  reducers: ReducerRegistry
  assets: RunnerAssets
  scheduler: Scheduler
}

/**
 * JSON with object keys sorted at every level, so that two equal params objects give the same text.
 * @param value - a JSON value.
 * @returns its canonical text.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * The sorted `resolved_asset` values of a record's inputs, as one text, for comparing two calls.
 * @param inputs - the record's inputs.
 * @returns the joined list.
 */
function resolvedAssetsKey(inputs: RecordInput[]): string {
  return inputs.map(input => String(input.resolved_asset)).sort().join(',')
}

/**
 * @param error - what a call threw.
 * @returns its message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The six origin fields a record copies from a run request.
 * @param request - the run request.
 * @returns the origin.
 */
function originOf(request: RunRequest): RecordOrigin {
  return {
    actor: request.actor, surface: request.surface, session: request.session, turn: request.turn, tool_call: request.tool_call,
    intent: request.intent,
  }
}

/** The operation registry and the change path. */
export class Runner {
  private readonly operations = new Map<string, OperationSpec>()

  /**
   * @param deps - the modules and services the runner calls.
   */
  constructor(private readonly deps: RunnerDeps) {}

  /**
   * Register an operation. Refused with `operation_exists` when the name is registered, and with `invalid_params`
   * when `component` is not one of the component keys `proj asset bible plan shot timeline deliver inspect`, when `name`
   * does not start with `<component>.`, or when `confirm` is not `never` and the spec has no `confirmSummary`.
   * @param spec - the operation.
   * @returns a function that removes the registration (only if it is still this spec).
   */
  registerOperation(spec: OperationSpec): () => void {
    if (this.operations.has(spec.name)) throw new ProjectError('operation_exists', `Operation ${spec.name} is already registered.`)
    if (!COMPONENT_KEYS.has(spec.component)) {
      throw new ProjectError('invalid_params', `Operation ${spec.name} names an unknown component '${spec.component}'.`)
    }
    if (!spec.name.startsWith(`${spec.component}.`)) {
      throw new ProjectError('invalid_params', `Operation ${spec.name} does not start with its component key '${spec.component}.'.`)
    }
    if (spec.confirm !== 'never' && spec.confirmSummary === undefined) {
      throw new ProjectError('invalid_params', `Operation ${spec.name} asks for confirmation (${spec.confirm}) but has no confirmSummary.`)
    }
    this.operations.set(spec.name, spec)
    return () => {
      if (this.operations.get(spec.name) === spec) this.operations.delete(spec.name)
    }
  }

  /** @returns every registered operation, in registration order. */
  listOperations(): OperationSpec[] {
    return [...this.operations.values()]
  }

  /**
   * Run one operation call. The steps are listed in `CONTRACTS.md` ("Runner: run"). Rejects with `ProjectError` only
   * before a record exists (unknown operation, invalid params or inputs, input not ready, unknown project), or with the
   * error of the operation's `precondition`. Once the record is written, resolves with it in its final status (`done`,
   * `failed`, `cancelled`), or `pending` for a scheduled run.
   * @param request - the call.
   * @returns the record, its outputs and report.
   */
  async run(request: RunRequest): Promise<RunResult> {
    const { store, drafts, reducers, scheduler } = this.deps
    const spec = this.operations.get(request.operation)
    if (spec === undefined) throw new ProjectError('unknown_operation', `Operation ${request.operation} is not registered.`)
    store.getProject(request.project)
    this.checkRequest(spec, request)

    if (spec.readOnly === true) return await this.runRead(spec, request)

    const pending = await store.lock(request.project, async () => {
      // Inputs resolve before `branchForWrite`, which may open a draft, so that a refused call writes nothing. A newly
      // opened draft starts at the head of the session's working branch, so the state there is the state at the parent.
      for (const record of request.after ?? []) store.getRecord(request.project, record)
      const working = drafts.workingBranch(request.project, request.session)
      const state = reducers.getState(request.project, working.name)
      const inputs = this.resolveInputs(spec, request, state, request.after !== undefined)
      // The operation's own rule refuses the call before anything is written; the lock keeps the state it read current.
      await spec.precondition?.(request, state)
      // The operation names the records it replaces itself; the caller may name more.
      const supersedes = [...new Set([...request.supersedes ?? [], ...spec.supersedes?.(request.params, state) ?? []])]
      const branch = drafts.branchForWrite(request.project, request)
      const origin = originOf(request)
      return store.append(request.project, {
        parents: [this.headOf(request.project, branch)], branch, kind: 'operation', component: spec.component, operation: spec.name,
        operation_version: spec.version, ...origin, params: request.params, inputs, outputs: [], based_on: request.based_on ?? null,
        supersedes, deterministic: spec.deterministic, status: 'pending',
      })
    })

    if (request.after !== undefined) {
      scheduler.enqueue(request.project, pending.id, spec.resource, request.after, spec.pendingInputRoles ?? [])
      return { record: pending, outputs: [], report: null }
    }
    const final = await this.execute(request.project, pending.id, request.signal)
    return { record: final, outputs: final.outputs, report: final.report ?? null }
  }

  /**
   * Execute a pending record: reuse the outputs of an identical deterministic record, or update it to `running`, call
   * the operation's `execute`, and write the final update. Used by `run` and by the scheduler. Never rejects for the
   * operation's own failure.
   * @param project - the project.
   * @param record - a `pending` record.
   * @param signal - the run request's signal; scheduled records run without one.
   * @returns the record in its final status.
   */
  async execute(project: ProjectId, record: RecordId, signal?: AbortSignal): Promise<ProjectRecord> {
    const { store, reducers, assets } = this.deps
    const pending = store.getRecord(project, record)
    const spec = pending.operation === null ? undefined : this.operations.get(pending.operation)
    if (spec === undefined) {
      return await this.finish(project, record, 'failed', {
        code: 'operation_failed', message: `Operation ${String(pending.operation)} is not registered.`,
      })
    }
    // A pending input role may name a render that is still running or failed: the operation handles the null asset.
    const pendingRoles = new Set(spec.pendingInputRoles ?? [])
    const unresolved = pending.inputs.find(input => input.resolved_asset === null && !pendingRoles.has(input.role))
    if (unresolved !== undefined) {
      return await this.finish(project, record, 'failed', {
        code: 'input_failed', message: `Input '${unresolved.role}' has no asset: the record it names did not finish done.`,
      })
    }
    const reused = spec.deterministic ? this.reusableOutputs(project, pending) : null
    if (reused !== null) {
      return await this.update(project, {
        update: record, status: 'done', finished_at: new Date().toISOString(), outputs: reused,
        cost: { gpu_seconds: 0, wall_seconds: 0, reused: true },
      })
    }

    const running = await this.update(project, { update: record, status: 'running', started_at: new Date().toISOString() })
    let scratchDir: string | null = null
    try {
      // `parents[0]` always exists: an operation record follows at least the project's `proj.create` record.
      const state = reducers.stateAt(project, running.branch, running.parents[0] ?? running.id)
      scratchDir = await mkdtemp(join(tmpdir(), 'dv-operation-'))
      const started = performance.now()
      const result = await spec.execute({
        project, record: running, params: running.params, inputs: running.inputs, state, scratchDir,
        signal: signal ?? new AbortController().signal,
        importAsset: (source, meta) => assets.importAsset(source, meta, record),
      })
      const wallSeconds = Math.round(performance.now() - started) / 1000
      return await this.update(project, {
        update: record, status: 'done', finished_at: new Date().toISOString(), outputs: result.outputs,
        cost: { gpu_seconds: result.cost?.gpu_seconds ?? 0, wall_seconds: wallSeconds, reused: false },
        ...result.report === undefined ? {} : { report: result.report },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true) {
        return await this.finish(project, record, 'cancelled', {
          code: 'stopped', message: `The turn was stopped while ${spec.name} ran: ${messageOf(error)}`,
        })
      }
      return await this.finish(project, record, 'failed', { code: 'operation_failed', message: messageOf(error) })
    } finally {
      if (scratchDir !== null) await rm(scratchDir, { recursive: true, force: true })
    }
  }

  /**
   * Accept a stale record's result: append `proj.stale_accept` with `params {record}` on the branch for the origin's
   * write (`drafts.branchForWrite`). Takes the project lock.
   * @param project - the project.
   * @param record - a record that is stale on that branch.
   * @param origin - who accepts it.
   * @returns the `proj.stale_accept` record.
   */
  acceptStale(project: ProjectId, record: RecordId, origin: RecordOrigin): Promise<ProjectRecord> {
    const { store, drafts } = this.deps
    return store.lock(project, () => {
      store.getRecord(project, record)
      const branch = drafts.branchForWrite(project, origin)
      return store.append(project, {
        parents: [this.headOf(project, branch)], branch, kind: 'operation', component: 'proj', operation: 'proj.stale_accept',
        operation_version: '1', ...origin, params: { record }, inputs: [], outputs: [], based_on: null, supersedes: [],
        deterministic: true, status: 'done',
      })
    })
  }

  /**
   * At service start, end the records an earlier process left unfinished: every `pending` or `running` operation
   * record is updated to `cancelled` with `error {code: 'stopped', message}`, so no draft stays busy forever.
   */
  async recover(): Promise<void> {
    const { store } = this.deps
    await Promise.all(store.listProjects().map(info => store.lock(info.id, () => {
      for (const record of store.listRecords(info.id)) {
        if (record.status !== 'pending' && record.status !== 'running') continue
        store.update(info.id, {
          update: record.id, status: 'cancelled', finished_at: new Date().toISOString(),
          error: { code: 'stopped', message: 'The server stopped before the call finished.' },
        })
      }
    })))
  }

  /**
   * Check a request's params against the operation's schema and its input roles against the operation's roles.
   * @param spec - the operation.
   * @param request - the call.
   */
  private checkRequest(spec: OperationSpec, request: RunRequest): void {
    const messages = validateArgs(spec.params, request.params)
    if (messages.length > 0) {
      throw new ProjectError('invalid_params', `Invalid parameters for ${spec.name}: ${messages.join('; ')}`)
    }
    const role = request.inputs.find(input => !Object.hasOwn(spec.inputs, input.role))
    if (role !== undefined) {
      throw new ProjectError('invalid_inputs', `Operation ${spec.name} takes no input with role '${role.role}'.`)
    }
  }

  /**
   * Run a read-only operation on the head of the session's working branch: no lock, no record, no confirmation.
   * @param spec - a read-only operation.
   * @param request - the call.
   * @returns the outputs and the report; the record is null.
   */
  private async runRead(spec: OperationSpec, request: RunRequest): Promise<RunResult> {
    const { drafts, reducers, assets } = this.deps
    const branch = drafts.workingBranch(request.project, request.session).name
    const state = reducers.getState(request.project, branch)
    const inputs = this.resolveInputs(spec, request, state, false)
    await spec.precondition?.(request, state)
    const scratchDir = await mkdtemp(join(tmpdir(), 'dv-operation-'))
    try {
      const result = await spec.execute({
        project: request.project, record: null, params: request.params, inputs, state, scratchDir,
        signal: request.signal ?? new AbortController().signal,
        importAsset: (source, meta) => assets.importAsset(source, meta, null),
      })
      return { record: null, outputs: result.outputs, report: result.report ?? null }
    } finally {
      await rm(scratchDir, { recursive: true, force: true })
    }
  }

  /**
   * Turn the request's input refs into record inputs against a state. An asset ref must name a stored asset; a record
   * output ref resolves to the producer's output once the producer is done; a character, location or style ref becomes
   * one input per asset of that version. A record output ref of one of the operation's `pendingInputRoles` may name a
   * producer in any status: it resolves to null until the producer is done.
   * @param spec - the operation.
   * @param request - the call.
   * @param state - the state the record's inputs resolve against.
   * @param allowUnfinished - whether a pending or running producer is allowed (a scheduled run).
   * @returns the record inputs.
   */
  private resolveInputs(spec: OperationSpec, request: RunRequest, state: ProjectState, allowUnfinished: boolean): RecordInput[] {
    const { store, reducers, assets } = this.deps
    return request.inputs.flatMap(({ role, ref }): RecordInput[] => {
      if ('asset' in ref) {
        if (!assets.has(ref.asset)) throw new ProjectError('unknown_asset', `Input '${role}' names an unknown asset ${ref.asset}.`)
        return [{ role, ref, resolved_asset: ref.asset }]
      }
      if ('record' in ref) {
        if (!Number.isInteger(ref.output) || ref.output < 0) {
          throw new ProjectError('invalid_inputs', `Input '${role}' names output ${String(ref.output)}, which is not an output index.`)
        }
        const producer = store.getRecord(request.project, ref.record)
        if (producer.status === 'done') {
          const asset = producer.outputs[ref.output]
          if (asset === undefined) {
            throw new ProjectError('invalid_inputs', `Input '${role}': record ${ref.record} has no output ${String(ref.output)}.`)
          }
          return [{ role, ref, resolved_asset: asset }]
        }
        if (spec.pendingInputRoles?.includes(role) === true) return [{ role, ref, resolved_asset: null }]
        if (producer.status === 'failed' || producer.status === 'cancelled') {
          throw new ProjectError('invalid_inputs', `Input '${role}': record ${ref.record} ended ${producer.status}.`)
        }
        if (!allowUnfinished) {
          throw new ProjectError('input_not_ready', `Input '${role}': record ${ref.record} has not finished; schedule the call with after.`)
        }
        return [{ role, ref, resolved_asset: null }]
      }
      const resolved = reducers.assetsOf(state, ref)
      if (resolved === null) throw new ProjectError('invalid_inputs', `Input '${role}' names an unknown version: ${JSON.stringify(ref)}.`)
      return resolved.map(asset => ({ role, ref, resolved_asset: asset }))
    })
  }

  /**
   * The outputs of an earlier executed record with the same operation, version, params and resolved assets.
   * @param project - the project.
   * @param record - the pending record.
   * @returns the earlier record's outputs, or null when there is none.
   */
  private reusableOutputs(project: ProjectId, record: ProjectRecord): ProjectRecord['outputs'] | null {
    const params = canonicalJson(record.params)
    const assetsKey = resolvedAssetsKey(record.inputs)
    for (const earlier of this.deps.store.listRecords(project)) {
      if (earlier.id === record.id) break
      if (earlier.operation !== record.operation || earlier.operation_version !== record.operation_version) continue
      if (earlier.status !== 'done' || earlier.cost?.reused === true) continue
      if (canonicalJson(earlier.params) === params && resolvedAssetsKey(earlier.inputs) === assetsKey) return earlier.outputs
    }
    return null
  }

  /**
   * @param project - the project.
   * @param branch - an existing branch name.
   * @returns the branch's head record.
   */
  private headOf(project: ProjectId, branch: string): RecordId {
    const stored = this.deps.store.getBranch(project, branch)
    if (stored === undefined) throw new ProjectError('unknown_branch', `Branch ${branch} does not exist in project ${project}.`)
    return stored.head
  }

  /**
   * Write an update line under the project lock.
   * @param project - the project.
   * @param update - the update line.
   * @returns the record after the update.
   */
  private update(project: ProjectId, update: RecordUpdate): Promise<ProjectRecord> {
    return this.deps.store.lock(project, () => this.deps.store.update(project, update))
  }

  /**
   * Write a final update that ends a record without outputs.
   * @param project - the project.
   * @param record - the record.
   * @param status - `failed` or `cancelled`.
   * @param error - why.
   * @returns the record after the update.
   */
  private finish(project: ProjectId, record: RecordId, status: 'failed' | 'cancelled', error: RecordFailure): Promise<ProjectRecord> {
    return this.update(project, { update: record, status, finished_at: new Date().toISOString(), error })
  }
}
