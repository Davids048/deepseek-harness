/**
 * The operations behind the browser routes, independent of transport: list projects, fold a head, list tools, invoke a
 * tool as a user turn, accept or reject a draft, undo, branch, and remember a view's selection. The Fetch routes and the
 * tests call these methods directly.
 *
 * @module @video-harness/views/api
 */
import type VhAssets from '@video-harness/assets'
import type { AssetId } from '@video-harness/assets'
import { MAIN_BRANCH, type Op, type OpId, type ProjectId, type TurnId } from '@video-harness/oplog'
import type VhOpLog from '@video-harness/oplog'
import type VhProject from '@video-harness/runtime'
import type { InvokeRequest } from '@video-harness/runtime'
import type VhTools from '@video-harness/tools'
import { deletedProjectIds } from './workspaces.ts'
import { projectIdOf, toWireState, toWireToolSpec, type ViewSelection, type WireState, type WireToolSpec } from './wire.ts'

/** A request a route could not serve, with the HTTP status that answers it. */
export class ViewsRequestError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message)
    this.name = 'ViewsRequestError'
  }
}

/** What a view sends to run a tool. */
export interface ViewInvokeBody {
  project: string
  tool: string
  inputs?: Array<{ role: string; ref: string }>
  params?: Record<string, unknown>
  intent?: string
  surface: 'canvas' | 'timeline'
  /** The exploration branch to write to; omitted writes to `main`. */
  branch?: string
  base_op?: string
  supersedes?: string[]
}

/**
 * The text of a thrown value.
 * @param error - what a runtime call threw.
 * @returns the error's message, or the value as text.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The services the API reads and writes. */
export interface ViewsServices {
  project: VhProject
  log: VhOpLog
  assets: VhAssets
  tools: VhTools
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
 * @throws ViewsRequestError when the value is not a non-empty string.
 */
function stringOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ViewsRequestError(400, `'${field}' must be a non-empty string.`)
  return value
}

/**
 * The input list of an invoke body.
 * @param value - the raw `inputs`.
 * @returns the typed inputs.
 * @throws ViewsRequestError when an entry lacks a role or a ref.
 */
function inputsOf(value: unknown): InvokeRequest['inputs'] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ViewsRequestError(400, "'inputs' must be an array.")
  return value.map((entry) => {
    const record = objectOf(entry)
    return { role: stringOf(record['role'], 'inputs[].role'), ref: stringOf(record['ref'], 'inputs[].ref') as InvokeRequest['inputs'][number]['ref'] }
  })
}

/** Reads and writes a project on behalf of the canvas and the timeline. */
export class ViewsApi {
  private readonly selections = new Map<ProjectId, ViewSelection>()

  constructor(private readonly services: ViewsServices) {}

  /**
   * Every project, newest first. When a chat session is named and the agent bound a project to it, that project is
   * flagged `current` and listed first, so a view opened beside the chat shows what the agent works on.
   * @param session - the agent session ID the view sits beside, when known.
   * @returns the project rows.
   */
  projects(session: string | null = null): Array<{
    projectId: ProjectId
    title: string
    createdAt: string
    heads: Record<string, OpId>
    current: boolean
  }> {
    const bound = session === null || session.length === 0 ? null : this.services.tools.sessionProject(session)
    return this.services.log.listProjects()
      .map(info => ({ ...info, heads: this.services.log.heads(info.projectId), current: info.projectId === bound }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * Start a project from a view. A title another listed project already has gets the next free number, so two clients
   * that pick the same name (two tabs, a double click) create two distinct titles.
   * @param raw - `{title, surface}`.
   * @returns the project row with the title it was created with.
   */
  create(raw: unknown): { projectId: ProjectId; title: string } {
    const body = objectOf(raw)
    const title = this.freeTitle(stringOf(body['title'], 'title'))
    const surface = body['surface'] === 'timeline' ? 'timeline' : 'canvas'
    const projectId = this.services.project.createProject({ title, actor: 'user', surface })
    return { projectId, title }
  }

  /**
   * @param wanted - the requested project title.
   * @returns the title itself when no listed project has it; else its base (without a trailing number) followed by the
   *   lowest free number from the requested one, or from 2, upwards.
   */
  private freeTitle(wanted: string): string {
    const deleted = deletedProjectIds()
    const taken = new Set(this.services.log.listProjects().filter(info => !deleted.has(info.projectId)).map(info => info.title))
    if (!taken.has(wanted)) return wanted
    const numbered = /^(.*\S)\s+(\d+)$/.exec(wanted)
    const base = numbered?.[1] ?? wanted
    let n = numbered === null ? 2 : Number(numbered[2]) + 1
    while (taken.has(`${base} ${String(n)}`)) n += 1
    return `${base} ${String(n)}`
  }

  /**
   * The folded state at a head.
   * @param project - the raw project ID.
   * @param head - a branch name or record ID; defaults to `main`.
   * @returns the wire state, plus the agent draft turns that are still open (neither accepted nor rejected), which a
   *   fold of `main` cannot tell apart from closed ones because their accept or reject records sit on the draft branch.
   * @throws ViewsRequestError when the project is unknown.
   */
  state(project: unknown, head: unknown = MAIN_BRANCH): WireState & { openTurns: TurnId[] } {
    const projectId = this.requireProject(project)
    const headName = typeof head === 'string' && head.length > 0 ? head : MAIN_BRANCH
    let state
    try {
      state = this.services.project.fold(projectId, headName)
    } catch (error) {
      throw new ViewsRequestError(404, messageOf(error))
    }
    const info = this.services.log.project(projectId)
    const heads = this.services.log.heads(projectId)
    const openTurns = Object.keys(heads)
      .filter(branch => branch.startsWith('draft/'))
      .map(branch => branch.slice('draft/'.length) as TurnId)
      .filter(turn => this.services.project.openTurn(turn) !== undefined)
    return { ...toWireState(info, state, heads, id => this.assetOrNull(id)), openTurns }
  }

  /** @returns every registered tool's declaration. */
  tools(): WireToolSpec[] {
    return this.services.tools.list().map(toWireToolSpec)
  }

  /**
   * Run a tool as one user turn from a view. The turn writes to `main`, or to the named exploration branch, and closes
   * when the record exists; a record whose inputs name an unfinished record is scheduled instead of run.
   * @param raw - the request body.
   * @returns the record, finished or pending.
   * @throws ViewsRequestError when the body or the tool is unknown.
   */
  async invoke(raw: unknown): Promise<Op> {
    const body = objectOf(raw)
    const projectId = this.requireProject(body['project'])
    const tool = stringOf(body['tool'], 'tool')
    if (this.services.project.tool(tool) === undefined) throw new ViewsRequestError(404, `Unknown tool '${tool}'.`)
    const surface = body['surface'] === 'timeline' ? 'timeline' : 'canvas'
    const intent = typeof body['intent'] === 'string' && body['intent'].length > 0 ? body['intent'] : `${surface}: ${tool}`
    const branch = typeof body['branch'] === 'string' && body['branch'].length > 0 && body['branch'] !== MAIN_BRANCH ? body['branch'] : undefined
    const inputs = inputsOf(body['inputs'])
    const open = this.services.project.beginTurn(projectId, { actor: 'user', surface, intent, ...(branch === undefined ? {} : { branch }) })
    const request: InvokeRequest = {
      tool, inputs, params: objectOf(body['params']), actor: 'user', surface, intent, turn: open.turn,
      ...(typeof body['base_op'] === 'string' ? { base_op: body['base_op'] as OpId } : {}),
      ...(Array.isArray(body['supersedes']) ? { supersedes: body['supersedes'].filter((id): id is string => typeof id === 'string') as OpId[] } : {}),
    }
    try {
      return this.waitsForProducer(projectId, inputs)
        ? this.services.project.schedule(projectId, request)
        : await this.services.project.invoke(projectId, request)
    } finally {
      this.services.project.acceptTurn(projectId, open.turn, { actor: 'user', surface })
    }
  }

  /**
   * Accept or reject an agent's draft turn.
   * @param raw - `{project, turn, action}`.
   * @returns the branch heads after the change.
   * @throws ViewsRequestError when the turn is not open or `main` moved.
   */
  turn(raw: unknown): Record<string, OpId> {
    const body = objectOf(raw)
    const projectId = this.requireProject(body['project'])
    const turn = stringOf(body['turn'], 'turn') as TurnId
    const action = body['action']
    if (action !== 'accept' && action !== 'reject') throw new ViewsRequestError(400, "'action' must be accept or reject.")
    const surface = body['surface'] === 'timeline' ? 'timeline' : 'canvas'
    try {
      if (action === 'accept') this.services.project.acceptTurn(projectId, turn, { actor: 'user', surface })
      else this.services.project.rejectTurn(projectId, turn)
    } catch (error) {
      throw new ViewsRequestError(409, messageOf(error))
    }
    return this.services.log.heads(projectId)
  }

  /**
   * Move `main` back one turn.
   * @param raw - `{project}`.
   * @returns the undone turn and the heads after the move.
   */
  undo(raw: unknown): { turn: TurnId; heads: Record<string, OpId> } {
    const projectId = this.requireProject(objectOf(raw)['project'])
    try {
      const turn = this.services.project.undoLatestTurn(projectId)
      return { turn, heads: this.services.log.heads(projectId) }
    } catch (error) {
      throw new ViewsRequestError(409, messageOf(error))
    }
  }

  /**
   * Start an exploration branch.
   * @param raw - `{project, name, at}` where `at` is a record ID or a branch name.
   * @returns the branch record and the heads after creation.
   */
  branch(raw: unknown): { op: Op; heads: Record<string, OpId> } {
    const body = objectOf(raw)
    const projectId = this.requireProject(body['project'])
    const name = stringOf(body['name'], 'name')
    const at = typeof body['at'] === 'string' && body['at'].length > 0 ? body['at'] : MAIN_BRANCH
    try {
      const op = this.services.project.createBranch(projectId, name, at)
      return { op, heads: this.services.log.heads(projectId) }
    } catch (error) {
      throw new ViewsRequestError(409, messageOf(error))
    }
  }

  /**
   * Remember what a view selected, for the agent's resolver.
   * @param raw - `{project, kind, id, slot?, surface}`.
   * @returns the stored selection.
   */
  select(raw: unknown): ViewSelection {
    const body = objectOf(raw)
    const projectId = this.requireProject(body['project'])
    const kind = body['kind']
    if (kind !== 'op' && kind !== 'clip' && kind !== 'asset' && kind !== 'entity') throw new ViewsRequestError(400, "'kind' must be op, clip, asset, or entity.")
    const selection: ViewSelection = {
      kind, id: stringOf(body['id'], 'id'),
      ...(typeof body['slot'] === 'number' ? { slot: body['slot'] } : {}),
      surface: body['surface'] === 'timeline' ? 'timeline' : 'canvas',
      at: new Date().toISOString(),
    }
    this.selections.set(projectId, selection)
    return selection
  }

  /**
   * @param project - the raw project ID.
   * @returns the last selection in the project, or null.
   */
  selection(project: unknown): ViewSelection | null {
    return this.selections.get(this.requireProject(project)) ?? null
  }

  /**
   * @param value - a raw project ID.
   * @returns the project ID.
   * @throws ViewsRequestError when it is malformed or names no project.
   */
  private requireProject(value: unknown): ProjectId {
    const projectId = projectIdOf(value)
    if (projectId === null) throw new ViewsRequestError(400, "'project' must name a project.")
    try {
      this.services.log.project(projectId)
    } catch {
      throw new ViewsRequestError(404, `Unknown project '${projectId}'.`)
    }
    return projectId
  }

  private assetOrNull(id: AssetId) {
    return this.services.assets.has(id) ? this.services.assets.get(id) : null
  }

  /**
   * @param projectId - the project.
   * @param inputs - the request inputs.
   * @returns whether an input names the output of a record that has not finished.
   */
  private waitsForProducer(projectId: ProjectId, inputs: InvokeRequest['inputs']): boolean {
    return inputs.some((input) => {
      const match = /^(.+)#(\d+)$/.exec(input.ref)
      if (match === null) return false
      try {
        return this.services.log.get(projectId, match[1] as OpId).status !== 'done'
      } catch {
        return false
      }
    })
  }
}
