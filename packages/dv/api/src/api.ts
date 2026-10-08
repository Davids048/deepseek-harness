/**
 * The handlers behind the browser routes, independent of transport: list and create projects, read a branch state,
 * list operations, run an operation as the human, create, switch and rename branches, undo and redo, accept a stale
 * record, and list the history. The Fetch routes and the tests call these methods directly.
 *
 * Every write goes through `dvProject` with actor `user`, the surface the request names, and the chat session the view
 * sits beside (`session`, when the request names one); it lands on the project's current branch.
 *
 * @module @dv/api/api
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type DvAssetPool from '@dv/asset-pool'
import { ProjectError } from '@dv/project'
import type DvProject from '@dv/project'
import type {
  AssetId, Branch, HistoryEntry, HistoryQuery, ProjectId, ProjectInfo, ProjectRecord, RecordId, RecordOrigin, RunRequest, SessionId,
  Surface,
} from '@dv/project'
import {
  projectIdOf, toWireOperation, toWireState, type WireHistory, type WireOperation, type WireState,
} from './wire.ts'

/**
 * A request a route could not serve, with the HTTP status that answers it and its error code: `invalid_params` for a
 * malformed request, `unknown_project` for an unknown project, `not_found` for another unknown resource, else the
 * `ProjectError` code.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409, message: string, readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

/** What a view sends to run an operation (`POST /api/dv/operation`). */
export interface OperationRequest {
  project: string
  operation: string
  /** The inputs by role; `ref` is reference text: `<asset>`, `<record>#<output>`, or `<id>@<version>`. */
  inputs?: Array<{ role: string; ref: string }>
  params?: Record<string, unknown>
  intent?: string
  surface: 'canvas' | 'timeline' | 'asset_pool'
  /** The chat session the view sits beside, recorded as the record's `session`. */
  session?: string
  based_on?: string
  supersedes?: string[]
}

/** One project as the project list returns it. */
export interface WireProject {
  id: ProjectId
  title: string
  created_at: string
  /** The head record of every branch, by branch name. */
  heads: Record<string, RecordId>
  /** Whether the chat session the view sits beside is bound to this project. */
  current: boolean
}

/**
 * The text of a thrown value.
 * @param error - what a call threw.
 * @returns the error's message, or the value as text.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A JSON response with no caching.
 * @param value - the body.
 * @param status - the HTTP status.
 * @returns the response.
 */
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

/**
 * Run a route body and answer with its JSON value, or with the error body `{error, code, ...details}` of every
 * `/api/dv` route and `/dv/events`: an {@link ApiRequestError} with its status and code, a `ProjectError` with the
 * status of its code, anything else with 500 and code `internal_error`.
 * @param run - the route body.
 * @returns the JSON response.
 */
export async function answer(run: () => unknown): Promise<Response> {
  try {
    return json(await run())
  } catch (error) {
    if (error instanceof ApiRequestError) return json({ ...error.details, error: error.message, code: error.code }, error.status)
    if (error instanceof ProjectError) return json({ error: error.message, code: error.code }, STATUS_OF[error.code] ?? 409)
    return json({ error: messageOf(error), code: 'internal_error' }, 500)
  }
}

/**
 * The project a request names, checked to exist.
 * @param project - the Project service.
 * @param value - the raw project ID.
 * @returns the project ID.
 * @throws ApiRequestError `invalid_params` when it is malformed, `unknown_project` when it names no project.
 */
export function requireProject(project: Pick<DvProject, 'openProject'>, value: unknown): ProjectId {
  const projectId = projectIdOf(value)
  if (projectId === null) throw new ApiRequestError(400, "'project' must name a project.", 'invalid_params')
  try {
    project.openProject(projectId)
  } catch {
    // Project throws for an unknown project; the request names no project.
    throw new ApiRequestError(404, `Unknown project '${projectId}'.`, 'unknown_project')
  }
  return projectId
}

/** The services the API reads and writes. */
export interface ApiServices {
  project: DvProject
  assets: DvAssetPool
}

/** The HTTP status of each refused Project call that a browser request can cause. */
const STATUS_OF: Partial<Record<ProjectError['code'], 400 | 404 | 409>> = {
  unknown_project: 404, unknown_branch: 404, unknown_record: 404, unknown_operation: 404, unknown_asset: 404,
  invalid_params: 400, invalid_inputs: 400, input_not_ready: 400,
}

/**
 * Run a Project call and turn its refusal into a request error with the matching status and code.
 * @param call - the call.
 * @returns the call's result.
 */
async function refused<T>(call: () => T | Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof ProjectError) throw new ApiRequestError(STATUS_OF[error.code] ?? 409, error.message, error.code)
    throw error
  }
}

/**
 * @param value - a raw JSON value.
 * @returns the value when it is a plain object, else an empty object.
 */
function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * @param value - a raw JSON value.
 * @param field - the field name for the error.
 * @returns the string.
 * @throws ApiRequestError (400, code `invalid_params`) when the value is not a non-empty string.
 */
function stringOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ApiRequestError(400, `'${field}' must be a non-empty string.`, 'invalid_params')
  return value
}

/**
 * @param value - the raw `surface` of a request.
 * @returns the surface; anything but `timeline`, `asset_pool` or `history` counts as the canvas.
 */
function surfaceOf(value: unknown): Surface & ('canvas' | 'timeline' | 'asset_pool' | 'history') {
  return value === 'timeline' || value === 'asset_pool' || value === 'history' ? value : 'canvas'
}

/** The values each enumerated history filter accepts. */
const HISTORY_ENUMS = {
  actor: ['user', 'agent', 'system'],
  kind: ['operation'],
  status: ['pending', 'running', 'done', 'failed', 'cancelled'],
  marks: ['current', 'redo', 'branch', 'undone'],
} as const

/** The history filters that take one free-form string, copied to the query as they are. */
const HISTORY_STRINGS = ['branch', 'component', 'operation', 'session', 'turn', 'tool_call', 'before'] as const

/** The number of entries a history request returns when it names no limit, and the most it may ask for. */
const HISTORY_LIMIT = { default: 50, max: 200 } as const

/**
 * The filters of a history request body, checked.
 * @param body - the request body.
 * @param project - the project, already checked.
 * @returns the history query.
 * @throws ApiRequestError (400, code `invalid_params`) when a filter has the wrong type or an unknown value.
 */
function historyQueryOf(body: Record<string, unknown>, project: ProjectId): HistoryQuery {
  const invalid = (message: string): ApiRequestError => new ApiRequestError(400, message, 'invalid_params')
  const query: Record<string, unknown> = { project }
  for (const field of HISTORY_STRINGS) {
    const value = body[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' || value.length === 0) throw invalid(`'${field}' must be a non-empty string.`)
    query[field] = value
  }
  for (const field of ['actor', 'kind', 'status'] as const) {
    const value = body[field]
    if (value === undefined || value === null) continue
    const allowed: readonly string[] = HISTORY_ENUMS[field]
    if (typeof value !== 'string' || !allowed.includes(value)) throw invalid(`'${field}' must be one of ${allowed.join(', ')}.`)
    query[field] = value
  }
  // `marks` and `records` are arrays of strings; `marks` takes only known marks.
  for (const field of ['marks', 'records'] as const) {
    const value = body[field]
    if (value === undefined || value === null) continue
    if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
      throw invalid(`'${field}' must be an array of strings.`)
    }
    const allowed: readonly string[] = HISTORY_ENUMS.marks
    if (field === 'marks' && !value.every(mark => allowed.includes(mark))) {
      throw invalid(`'marks' may hold only ${allowed.join(', ')}.`)
    }
    query[field] = value
  }
  const limit = body['limit'] ?? HISTORY_LIMIT.default
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMIT.max) {
    throw invalid(`'limit' must be an integer from 1 to ${String(HISTORY_LIMIT.max)}.`)
  }
  query['limit'] = limit
  return query as unknown as HistoryQuery
}

/**
 * @param value - the raw `session` of a request.
 * @returns the chat session, or null when the request names none.
 */
export function sessionOf(value: unknown): SessionId | null {
  return typeof value === 'string' && value.length > 0 ? brandString<SessionId>(value) : null
}

/**
 * The origin of a human action from a view.
 * @param body - the request body, for `surface` and `session`.
 * @param intent - what the action does, in words a creator can read.
 * @returns the origin.
 */
function humanOrigin(body: Record<string, unknown>, intent: string): RecordOrigin {
  return { actor: 'user', surface: surfaceOf(body['surface']), session: sessionOf(body['session']), turn: null, tool_call: null, intent }
}

/** A branch write's answer: the branch after the change and every branch head. */
export interface BranchChange {
  branch: Branch
  heads: Record<string, RecordId>
}

/** Reads and writes a project on behalf of the canvas, the timeline, and the asset pool panel. */
export class ApiHandlers {
  constructor(private readonly services: ApiServices) {}

  /**
   * Every project, newest first. When a chat session is named and the agent bound a project to it, that project is
   * flagged `current` and listed first, so a view opened beside the chat shows what the agent works on.
   * @param session - the agent session ID the view sits beside, when known.
   * @returns the project rows.
   */
  listProjects(session: string | null = null): WireProject[] {
    const bound = session === null || session.length === 0 ? null : this.services.project.sessionProject(brandString<SessionId>(session))
    return this.services.project.listProjects()
      .map(info => ({
        id: info.id, title: info.title, created_at: info.created_at, heads: this.heads(info.id), current: info.id === bound,
      }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.created_at.localeCompare(a.created_at))
  }

  /**
   * Start a project from a view. A title another listed project already has gets the next free number, so two clients
   * that pick the same name (two tabs, a double click) create two distinct titles.
   * @param raw - `{title, surface}`.
   * @returns the project, with the title it was created with.
   */
  async createProject(raw: unknown): Promise<ProjectInfo> {
    const body = objectOf(raw)
    const title = this.freeTitle(stringOf(body['title'], 'title'))
    return this.services.project.createProject(title, { ...humanOrigin(body, `create project ${title}`), session: null })
  }

  /**
   * @param wanted - the requested project title.
   * @returns the title itself when no listed project has it; else its base (without a trailing number) followed by the
   *   lowest free number from the requested one, or from 2, upwards.
   */
  private freeTitle(wanted: string): string {
    const taken = new Set(this.services.project.listProjects().map(info => info.title))
    if (!taken.has(wanted)) return wanted
    const numbered = /^(.*\S)\s+(\d+)$/.exec(wanted)
    const base = numbered?.[1] ?? wanted
    let n = numbered === null ? 2 : Number(numbered[2]) + 1
    while (taken.has(`${base} ${String(n)}`)) n += 1
    return `${base} ${String(n)}`
  }

  /**
   * The state of a branch at its head.
   * @param project - the raw project ID.
   * @param branch - a branch name; anything but a non-empty string reads the project's current branch.
   * @returns the wire state, with every branch and the current branch.
   * @throws ApiRequestError when the project or the branch is unknown.
   */
  getState(project: unknown, branch?: unknown): WireState {
    const projectId = this.requireProject(project)
    let state
    try {
      state = this.services.project.getState(projectId, typeof branch === 'string' && branch.length > 0 ? branch : undefined)
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      throw new ApiRequestError(404, error.message, error.code)
    }
    const { project: service } = this.services
    return toWireState(state, service.listBranches(projectId), service.currentBranch(projectId).name, id => this.assetOrNull(id))
  }

  /** @returns the declaration of every registered operation that a view can run: every operation that is not `readOnly`. */
  listOperations(): WireOperation[] {
    return this.services.project.listOperations().filter(spec => spec.readOnly !== true).map(toWireOperation)
  }

  /**
   * Run an operation as the human, from a view. The record goes to the project's current branch (forked first after an
   * undo). A call whose inputs name an unfinished record is scheduled to run once that record is done.
   * @param raw - the {@link OperationRequest}.
   * @returns the record, finished or pending.
   * @throws ApiRequestError when the body or the operation is unknown, or Project refuses the call.
   */
  async runOperation(raw: unknown): Promise<ProjectRecord> {
    const body = objectOf(raw)
    const projectId = this.requireProject(body['project'])
    const operation = stringOf(body['operation'], 'operation')
    if (!this.services.project.listOperations().some(spec => spec.name === operation)) {
      throw new ApiRequestError(404, `Unknown operation '${operation}'.`, 'unknown_operation')
    }
    const surface = surfaceOf(body['surface'])
    const intent = typeof body['intent'] === 'string' && body['intent'].length > 0 ? body['intent'] : `${surface}: ${operation}`
    const origin = humanOrigin(body, intent)
    const state = await refused(() => this.services.project.getState(projectId))
    const byRole = this.inputsByRole(body['inputs'])
    let inputs: RunRequest['inputs']
    try {
      inputs = this.services.project.parseInputs(operation, byRole, state, operation)
    } catch (error) {
      // Project's input parser explains an unknown role or a malformed reference; the request is at fault.
      throw new ApiRequestError(400, messageOf(error), error instanceof ProjectError ? error.code : 'invalid_inputs')
    }
    const request: RunRequest = {
      ...origin, project: projectId, operation, params: objectOf(body['params']), inputs,
      ...typeof body['based_on'] === 'string' ? { based_on: brandString<RecordId>(body['based_on']) } : {},
      ...Array.isArray(body['supersedes']) ? { supersedes: body['supersedes'].filter((id): id is RecordId => typeof id === 'string') } : {},
      ...await refused(() => this.waitsForProducer(projectId, inputs)) ? { after: [] } : {},
    }
    const result = await refused(() => this.services.project.run(request))
    if (result.record === null) throw new ApiRequestError(400, `'${operation}' is a read and writes no record.`, 'invalid_params')
    return result.record
  }

  /**
   * Fork a branch from the current branch at its head's position, or with `branch` and `to` at that step of that branch's
   * line, and make it current.
   * @param raw - `{project, title?, branch?, to?, session?, surface}`; an empty or missing title keeps the default label.
   * @returns the new branch and the heads afterwards.
   * @throws ApiRequestError (400 `invalid_params` when only one of `branch` and `to` is given or `to` is no step of the
   *   branch, 404 `unknown_branch` or `unknown_record`).
   */
  async createBranch(raw: unknown): Promise<BranchChange> {
    const body = objectOf(raw)
    const projectId = this.requireProject(body['project'])
    const title = typeof body['title'] === 'string' && body['title'].trim().length > 0 ? body['title'].trim() : null
    if ((body['branch'] === undefined) !== (body['to'] === undefined)) {
      throw new ApiRequestError(400, "'branch' and 'to' go together.", 'invalid_params')
    }
    const from = body['branch'] === undefined
      ? undefined
      : { branch: stringOf(body['branch'], 'branch'), record: brandString<RecordId>(stringOf(body['to'], 'to')) }
    const branch = await refused(() => this.services.project.createBranch(projectId, title, from))
    return { branch, heads: this.heads(projectId) }
  }

  /**
   * Make a branch the project's current branch and, with `to`, return it to that step of its line.
   * @param raw - `{project, branch, to?, session?, surface}`.
   * @returns the branch and the heads afterwards.
   * @throws ApiRequestError (404 `unknown_branch` or `unknown_record`, 400 `invalid_params` for a `to` off the line).
   */
  async switchBranch(raw: unknown): Promise<BranchChange> {
    const body = objectOf(raw)
    const projectId = this.requireProject(body['project'])
    const name = stringOf(body['branch'], 'branch')
    const to = body['to'] === undefined ? undefined : brandString<RecordId>(stringOf(body['to'], 'to'))
    const branch = await refused(() => this.services.project.switchBranch(projectId, name, humanOrigin(body, `switch to ${name}`), to))
    return { branch, heads: this.heads(projectId) }
  }

  /**
   * Give a branch the name the human chose; an empty title returns to the default label.
   * @param raw - `{project, branch, title}`.
   * @returns the branch and the heads afterwards.
   * @throws ApiRequestError (404 `unknown_branch`, 400 `invalid_params` without a string title).
   */
  async renameBranch(raw: unknown): Promise<BranchChange> {
    const body = objectOf(raw)
    const projectId = this.requireProject(body['project'])
    const name = stringOf(body['branch'], 'branch')
    if (typeof body['title'] !== 'string') throw new ApiRequestError(400, "'title' must be a string.", 'invalid_params')
    const title = body['title']
    const branch = await refused(() => this.services.project.renameBranch(projectId, name, title))
    return { branch, heads: this.heads(projectId) }
  }

  /**
   * Move the project's current branch back by one step, or jump it to the record `to` (a record on its effective
   * chain, or one of its redo steps).
   * @param raw - `{project, session?, surface, to?}`.
   * @returns the `proj.undo` record (`proj.redo` for a jump forward) and the heads afterwards.
   */
  async undo(raw: unknown): Promise<{ record: ProjectRecord; heads: Record<string, RecordId> }> {
    const body = objectOf(raw)
    const projectId = this.requireProject(body['project'])
    const to = body['to'] === undefined ? undefined : brandString<RecordId>(stringOf(body['to'], 'to'))
    const record = await refused(() => this.services.project.undo(projectId, humanOrigin(body, 'undo'), to))
    return { record, heads: this.heads(projectId) }
  }

  /**
   * Move the project's current branch forward by one redo step.
   * @param raw - `{project, session?, surface}`.
   * @returns the `proj.redo` record and the heads afterwards.
   */
  async redo(raw: unknown): Promise<{ record: ProjectRecord; heads: Record<string, RecordId> }> {
    const body = objectOf(raw)
    const projectId = this.requireProject(body['project'])
    const record = await refused(() => this.services.project.redo(projectId, humanOrigin(body, 'redo')))
    return { record, heads: this.heads(projectId) }
  }

  /**
   * Accept a stale record as it is: a `proj.stale_accept` record on the project's current branch removes its stale mark
   * and the marks of the records made from it.
   * @param raw - `{project, record, session?, surface}`.
   * @returns the `proj.stale_accept` record and the heads afterwards.
   * @throws ApiRequestError (404, code `unknown_record`) when the record does not exist.
   */
  async acceptStale(raw: unknown): Promise<{ record: ProjectRecord; heads: Record<string, RecordId> }> {
    const body = objectOf(raw)
    const projectId = this.requireProject(body['project'])
    const target = brandString<RecordId>(stringOf(body['record'], 'record'))
    const record = await refused(() => this.services.project.acceptStale(projectId, target, humanOrigin(body, `accept ${target}`)))
    return { record, heads: this.heads(projectId) }
  }

  /**
   * List a project's records with their marks, newest first, through `dvProject.listHistory` (the query behind
   * `dv_proj_history_list`). A read: it writes no record.
   * @param raw - the history query: `{project, branch?, marks?, actor?, component?, operation?, kind?, status?, session?,
   *   turn?, tool_call?, records?, before?, limit?}`; `limit` is 1 to 200, default 50.
   * @returns the entries and every asset they name.
   * @throws ApiRequestError (400 `invalid_params`, 404 `unknown_project`, 404 `unknown_record` for `before`).
   */
  async listHistory(raw: unknown): Promise<WireHistory> {
    const body = objectOf(raw)
    const projectId = this.requireProject(body['project'])
    const query = historyQueryOf(body, projectId)
    const entries: HistoryEntry[] = await refused(() => this.services.project.listHistory(query))
    const named = new Set<AssetId>()
    for (const { record } of entries) {
      for (const id of record.outputs) named.add(id)
      for (const input of record.inputs) if (input.resolved_asset !== null) named.add(input.resolved_asset)
    }
    const assets = [...named].flatMap((id) => {
      const asset = this.assetOrNull(id)
      return asset === null ? [] : [asset]
    })
    return { entries, assets }
  }

  /**
   * @param value - a raw project ID.
   * @returns the project ID.
   * @throws ApiRequestError `invalid_params` when it is malformed, `unknown_project` when it names no project.
   */
  private requireProject(value: unknown): ProjectId {
    return requireProject(this.services.project, value)
  }

  /**
   * @param projectId - the project.
   * @returns the head record of every branch, by branch name.
   */
  private heads(projectId: ProjectId): Record<string, RecordId> {
    return Object.fromEntries(this.services.project.listBranches(projectId).map(branch => [branch.name, branch.head]))
  }

  /**
   * The inputs of a request grouped by role, the form Project's input parser reads.
   * @param value - the raw `inputs`: an array of `{role, ref}`.
   * @returns the refs by role.
   * @throws ApiRequestError when an entry lacks a role or a ref.
   */
  private inputsByRole(value: unknown): Record<string, string[]> {
    if (value === undefined) return {}
    if (!Array.isArray(value)) throw new ApiRequestError(400, "'inputs' must be an array.", 'invalid_params')
    const byRole: Record<string, string[]> = {}
    for (const entry of value) {
      const input = objectOf(entry)
      const role = stringOf(input['role'], 'inputs[].role')
      ;(byRole[role] ??= []).push(stringOf(input['ref'], 'inputs[].ref'))
    }
    return byRole
  }

  private assetOrNull(id: AssetId) {
    return this.services.assets.has(id) ? this.services.assets.get(id) : null
  }

  /**
   * @param projectId - the project.
   * @param inputs - the request inputs.
   * @returns whether an input names the output of a record that has not finished.
   */
  private waitsForProducer(projectId: ProjectId, inputs: RunRequest['inputs']): boolean {
    return inputs.some(input => 'record' in input.ref && this.services.project.getRecord(projectId, input.ref.record).status !== 'done')
  }
}
