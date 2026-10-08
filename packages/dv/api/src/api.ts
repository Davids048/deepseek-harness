/**
 * The handlers behind the browser routes, independent of transport: list and create projects, summarize projects for
 * the project cards, read a branch state, list operations, run an operation as the human, accept or discard a chat
 * session's draft, undo and redo, accept a stale record, and list the history. The Fetch routes and the tests call these methods directly.
 *
 * Every write goes through `dvProject` with actor `user`, the surface the request names, and the chat session the view
 * sits beside (`session`, when the request names one), so a human edit lands on that session's working branch: its open
 * draft, else `main`.
 *
 * @module @dv/api/api
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type DvAssetPool from '@dv/asset-pool'
import { draftBranch, MAIN_BRANCH, ProjectError } from '@dv/project'
import type DvProject from '@dv/project'
import type {
  AssetId, Branch, DraftCounts, HistoryEntry, HistoryQuery, ProjectId, ProjectInfo, ProjectRecord, RecordId, RecordOrigin, RunRequest,
  SessionId, Surface,
} from '@dv/project'
import { summarizeProject, type WireProjectSummary } from './summaries.ts'
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
  /** The chat session the view sits beside; the record goes to that session's working branch. */
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
  marks: ['main', 'draft', 'undone', 'discarded', 'replayed'],
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

/**
 * The draft counts of a discard request.
 * @param value - the raw `counts`.
 * @returns the counts, or null when the request sends none (a dry read).
 * @throws ApiRequestError when `counts` is present but malformed.
 */
function countsOf(value: unknown): DraftCounts | null {
  if (value === undefined || value === null) return null
  const counts = objectOf(value)
  const agent = counts['agent_changes']
  const human = counts['human_edits']
  if (typeof agent !== 'number' || typeof human !== 'number') {
    throw new ApiRequestError(400, "'counts' must hold numbers 'agent_changes' and 'human_edits'.", 'invalid_params')
  }
  return { agent_changes: agent, human_edits: human }
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
   * The card summary of every project, in the order of `dvProject.listProjects()`, or of the one project the request
   * names: the cover, shot count, total duration, and last edit time, read from `main`, or from the first open draft
   * when `main` has no rendered take. In the list of every project, a project whose state cannot be read or summarized
   * gets an empty entry (`cover` null, `shots` and `duration_sec` 0, `edited_at` null) and a console warning, so the
   * other projects still arrive.
   * @param project - the raw `project` query value; null summarizes every project.
   * @returns one summary per project.
   * @throws ApiRequestError `invalid_params` when `project` is malformed, `unknown_project` when it names no project;
   *   with `project`, also whatever its state read throws.
   */
  listProjectSummaries(project: string | null = null): WireProjectSummary[] {
    const mimeOf = (id: AssetId): string | null => this.assetOrNull(id)?.mime ?? null
    const summarize = (projectId: ProjectId): WireProjectSummary => {
      const draft = this.services.project.listBranches(projectId).find(branch => branch.counts !== null)
      return summarizeProject(projectId, branch => this.services.project.getState(projectId, branch), draft?.name ?? null, mimeOf)
    }
    if (project !== null) return [summarize(this.requireProject(project))]
    return this.services.project.listProjects().map((info) => {
      try {
        return summarize(info.id)
      } catch (error) {
        // One unreadable project must not hide the cards of the others.
        console.warn(`dvApi: project ${info.id} summary failed: ${messageOf(error)}`)
        return { project: info.id, cover: null, shots: 0, duration_sec: 0, edited_at: null }
      }
    })
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
   * @param branch - a branch name; anything but a non-empty string reads `main`.
   * @returns the wire state, with every branch and the counts of each open draft.
   * @throws ApiRequestError when the project or the branch is unknown.
   */
  getState(project: unknown, branch: unknown = MAIN_BRANCH): WireState {
    const projectId = this.requireProject(project)
    const name = typeof branch === 'string' && branch.length > 0 ? branch : MAIN_BRANCH
    let state
    try {
      state = this.services.project.getState(projectId, name)
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      throw new ApiRequestError(404, error.message, error.code)
    }
    return toWireState(state, this.services.project.listBranches(projectId), id => this.assetOrNull(id))
  }

  /** @returns the declaration of every registered operation that a view can run: every operation that is not `readOnly`. */
  listOperations(): WireOperation[] {
    return this.services.project.listOperations().filter(spec => spec.readOnly !== true).map(toWireOperation)
  }

  /**
   * Run an operation as the human, from a view. The record goes to the working branch of the request's chat session
   * (`main` without one). A call whose inputs name an unfinished record is scheduled to run once that record is done.
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
    const working = this.services.project.workingBranch(projectId, origin.session).name
    const state = await refused(() => this.services.project.getState(projectId, working))
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
   * Accept a chat session's draft into the branch it was forked from.
   * @param raw - `{project, session | branch, surface}`; `branch` names the draft when the request has no session.
   * @returns the `proj.draft_accept` record and the heads afterwards.
   * @throws ApiRequestError when no draft is open, a draft record still runs, or a record conflicts with `main`.
   */
  async acceptDraft(raw: unknown): Promise<{ record: ProjectRecord; heads: Record<string, RecordId> }> {
    const body = objectOf(raw)
    const projectId = this.requireProject(body['project'])
    const draft = this.draftOf(projectId, body)
    const record = await refused(() => this.services.project.acceptDraft(projectId, { ...humanOrigin(body, `accept ${draft.name}`), session: draft.session }))
    return { record, heads: this.heads(projectId) }
  }

  /**
   * Discard a chat session's draft, including the human's edits on it. Without `counts` the call is a dry read that
   * returns the counts a confirmation shows; with the counts the human confirmed, it discards the draft, unless the
   * draft changed meanwhile.
   * @param raw - `{project, session | branch, surface, counts?}`.
   * @returns the draft and its counts (dry read), or the discarded counts and the heads afterwards.
   * @throws ApiRequestError (409, code `draft_changed`, with the current `counts`) when the counts differ.
   */
  async discardDraft(raw: unknown): Promise<{ draft: string; counts: DraftCounts; heads?: Record<string, RecordId> }> {
    const body = objectOf(raw)
    const projectId = this.requireProject(body['project'])
    const draft = this.draftOf(projectId, body)
    const current = draft.counts ?? { agent_changes: 0, human_edits: 0 }
    const confirmed = countsOf(body['counts'])
    if (confirmed === null) return { draft: draft.name, counts: current }
    try {
      const counts = await this.services.project.discardDraft(projectId, { ...humanOrigin(body, `discard ${draft.name}`), session: draft.session }, confirmed)
      return { draft: draft.name, counts, heads: this.heads(projectId) }
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      // A changed draft answers with its current counts, so the confirmation can show them again.
      const counts = this.services.project.listBranches(projectId).find(branch => branch.name === draft.name)?.counts ?? current
      throw new ApiRequestError(STATUS_OF[error.code] ?? 409, error.message, error.code, error.code === 'draft_changed' ? { counts } : {})
    }
  }

  /**
   * Move the session's working branch back by one step, or jump it to the record `to` (a record on its effective
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
   * Move the session's working branch forward by one redo step, while nothing else was written on it after the undo.
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
   * Accept a stale record as it is: a `proj.stale_accept` record on the working branch of the request's chat session
   * (`main` without one) removes its stale mark and the marks of the records made from it.
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
   * The open draft a request names: the draft of its `session`, else the draft branch `branch`.
   * @param projectId - the project.
   * @param body - the request body.
   * @returns the draft branch, with its session and counts.
   * @throws ApiRequestError (409, code `no_open_draft`) when that draft is not open.
   */
  private draftOf(projectId: ProjectId, body: Record<string, unknown>): Branch & { session: SessionId } {
    const session = sessionOf(body['session'])
    const name = session === null ? stringOf(body['branch'], 'branch') : draftBranch(session)
    const draft = this.services.project.listBranches(projectId).find(branch => branch.name === name)
    if (draft === undefined || draft.session === null || draft.counts === null) {
      throw new ApiRequestError(409, `No draft ${name} is open in project ${projectId}.`, 'no_open_draft')
    }
    return { ...draft, session: draft.session }
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
