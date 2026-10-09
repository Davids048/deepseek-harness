/**
 * The browser client of the `/api/dv` routes and the `/dv/events` stream. Requests are same-origin, so the web
 * application's authentication cookie travels with them.
 *
 * @module @dv/ui-kit/api
 */
import type {
  CanvasLayout, HistoryQuery, OperationRequest, ProjectEvent,
  ProjectInfo, ProjectRecord, WireHistory, WireLine, WireOperation, WireProject, WireRecordResult, WireSession, WireState,
  WireWorkspaces,
} from './types.ts'

/** One `/dv/events` stream shared by every subscriber of a project in this page. */
interface SharedEventSource {
  source: EventSource
  subscribers: number
  /** True once the server's `ready` event arrived, proving that events reach this page unbuffered. */
  live: boolean
}

/**
 * The page's `/dv/events` streams, keyed by project. Every DreamVerse bundle carries its own copy of this module, so
 * the registry lives on the page's global object (`window`): one page holds at most one stream per project. Browsers
 * allow 6 concurrent HTTP/1.1 connections per host across all tabs, and a stream per panel exhausts them with two tabs
 * open.
 */
type StreamGlobal = typeof globalThis & { __dvEventSources?: Map<string, SharedEventSource>; __dvStreams?: number }

/** @returns the page's stream registry, created on first use. */
function eventSources(): Map<string, SharedEventSource> {
  const page = globalThis as StreamGlobal
  page.__dvEventSources ??= new Map()
  return page.__dvEventSources
}

/** Publish the number of open streams on `window.__dvStreams` for tests and debugging. */
function countStreams(): void {
  ;(globalThis as StreamGlobal).__dvStreams = eventSources().size
}

/**
 * Join the project's shared stream, opening it for the first subscriber.
 * @param project - the project.
 * @returns the shared stream.
 */
function acquireEventSource(project: string): SharedEventSource {
  const sources = eventSources()
  let shared = sources.get(project)
  if (shared === undefined) {
    const opened: SharedEventSource = { source: new EventSource(`/dv/events?project=${encodeURIComponent(project)}`), subscribers: 0, live: false }
    opened.source.addEventListener('ready', () => { opened.live = true })
    shared = opened
    sources.set(project, shared)
  }
  shared.subscribers += 1
  countStreams()
  return shared
}

/**
 * Leave the project's shared stream, closing it after the last subscriber.
 * @param project - the project.
 * @param shared - the stream the subscriber joined.
 */
function releaseEventSource(project: string, shared: SharedEventSource): void {
  shared.subscribers -= 1
  if (shared.subscribers > 0) return
  shared.source.close()
  const sources = eventSources()
  if (sources.get(project) === shared) sources.delete(project)
  countStreams()
}

/** The SSE event names of `/dv/events`: the kinds of a project change. */
const EVENT_KINDS: ReadonlyArray<ProjectEvent['kind']> = ['record', 'update', 'line']

/** The surface a view sends with its writes: a subset of the record field `Surface`. */
export type ViewSurface = 'canvas' | 'timeline' | 'asset_pool' | 'history'

/** A route answered with an error status. */
export class DvApiError extends Error {
  /**
   * @param status - the HTTP status.
   * @param message - the server's explanation.
   * @param code - the Project error code, such as `unknown_record`, when the server sent one.
   */
  constructor(readonly status: number, message: string, readonly code: string | null = null) {
    super(message)
    this.name = 'DvApiError'
  }
}

/** The URL of an asset's file, served by `@dv/asset-pool`. */
export function assetUrl(id: string): string {
  return `/dv/assets/${encodeURIComponent(id)}`
}

/**
 * Read a JSON response, turning error statuses into {@link DvApiError}.
 * @param response - the response.
 * @returns the parsed body.
 */
async function decode<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const fields = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    const reason = typeof fields['error'] === 'string' ? fields['error'] : `HTTP ${String(response.status)}`
    throw new DvApiError(response.status, reason, typeof fields['code'] === 'string' ? fields['code'] : null)
  }
  return body as T
}

/** Every `/api/dv` call of the browser: project state, operations, history, undo and redo, layout, workspaces. */
export class DvClient {
  constructor(private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  /**
   * @param signal - cancels the request.
   * @param session - the chat session the view sits beside; its bound project comes first, flagged `current`.
   * @returns every project, newest first.
   */
  listProjects(signal?: AbortSignal, session: string | null = null): Promise<WireProject[]> {
    return this.get('/api/dv/projects', session === null ? {} : { session }, signal)
  }

  /**
   * Create a project.
   * @param title - the project title.
   * @param surface - where the gesture came from.
   * @returns the project's identity.
   */
  createProject(title: string, surface: ViewSurface): Promise<ProjectInfo> {
    return this.post('/api/dv/projects', { title, surface })
  }

  /**
   * Rename a project.
   * @param project - the project.
   * @param title - the title.
   * @returns the stored title.
   */
  renameProject(project: string, title: string): Promise<{ title: string }> {
    return this.post('/api/dv/projects/rename', { project, title })
  }

  /**
   * Delete a project.
   * @param project - the project.
   * @returns the Workspace the project was linked to, for the caller to remove; null when none.
   */
  deleteProject(project: string): Promise<{ ok: boolean; workspace_id: string | null }> {
    return this.post('/api/dv/projects/delete', { project })
  }

  /**
   * @param project - the project.
   * @param signal - cancels the request.
   * @returns the project's current state.
   */
  getState(project: string, signal?: AbortSignal): Promise<WireState> {
    return this.get('/api/dv/state', { project }, signal)
  }

  /**
   * List a project's records, newest first, and the assets they name.
   * The query travels as a JSON body because a `records` set can be long; the route writes no record.
   * @param query - the project and the filters.
   * @param signal - cancels the request.
   * @returns the entries and the assets.
   */
  async listHistory(query: HistoryQuery, signal?: AbortSignal): Promise<WireHistory> {
    const response = await this.fetchImpl('/api/dv/history', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query), signal: signal ?? null,
    })
    return decode<WireHistory>(response)
  }

  /** @returns the declaration of every operation that changes a project. */
  listOperations(signal?: AbortSignal): Promise<WireOperation[]> {
    return this.get('/api/dv/operations', {}, signal)
  }

  /**
   * Run an operation as the human.
   * @param request - the operation, inputs, params, where the gesture came from, and the chat session beside the view.
   * @returns the record: finished, or pending when the call was scheduled.
   */
  runOperation(request: OperationRequest): Promise<ProjectRecord> {
    return this.post('/api/dv/operation', request)
  }

  /**
   * Import a file into the asset pool through an `asset.import` record.
   * @param project - the project.
   * @param file - the file.
   * @param surface - where the file was imported: the canvas or the asset pool panel.
   * @param session - the chat session the view sits beside, recorded as the record's `session`.
   * @returns the asset ID and the record.
   */
  async importAsset(
    project: string, file: File, surface: 'canvas' | 'asset_pool', session: string | null = null,
  ): Promise<{ asset: string; record: ProjectRecord }> {
    const mime = file.type.length > 0 ? file.type : 'application/octet-stream'
    const query = new URLSearchParams({ project, name: file.name, mime, surface })
    if (session !== null) query.set('session', session)
    return decode(await this.fetchImpl(`/api/dv/assets/import?${query.toString()}`, { method: 'POST', body: file }))
  }

  /**
   * Move the current position one step back, or with `to` to that step of the history list (before or after the
   * current position). Writes no record.
   * @param project - the project.
   * @param to - a step of the history list; omit for one step back.
   * @returns the last step and the current position afterwards.
   */
  undo(project: string, to?: string): Promise<WireLine> {
    return this.post('/api/dv/undo', { project, ...to === undefined ? {} : { to } })
  }

  /**
   * Move the current position one step forward. Writes no record.
   * @param project - the project.
   * @returns the last step and the current position afterwards.
   */
  redo(project: string): Promise<WireLine> {
    return this.post('/api/dv/redo', { project })
  }

  /**
   * Keep a stale record as it is: runs `proj.stale_accept`.
   * @param project - the project.
   * @param record - the stale record.
   * @param surface - where the decision was made.
   * @param session - the chat session the view sits beside, or null.
   * @returns the accept record.
   */
  acceptStale(project: string, record: string, surface: ViewSurface, session: string | null = null): Promise<WireRecordResult> {
    return this.post('/api/dv/stale/accept', { project, record, surface, ...session === null ? {} : { session } })
  }

  /**
   * @param project - the project.
   * @returns the project's stored canvas layout.
   */
  async getLayout(project: string): Promise<CanvasLayout> {
    const layout = await this.get<Partial<CanvasLayout>>('/api/dv/layout', { project })
    return { positions: layout.positions ?? {}, viewport: layout.viewport ?? null }
  }

  /**
   * Merge node positions into the project's canvas layout and store the viewport.
   * @param project - the project.
   * @param patch - the positions moved since the last save, and the viewport.
   * @returns the stored layout.
   */
  updateLayout(project: string, patch: Partial<CanvasLayout>): Promise<CanvasLayout> {
    return this.post('/api/dv/layout', { project, ...patch })
  }

  /**
   * Put assets on the project's canvas (`asset.place`), or take them off it (`asset.unplace`);
   * the assets stay in the asset pool either way.
   * @param project - the project.
   * @param assetIds - the assets.
   * @param on - true to put them on the canvas, false to take them off.
   * @param session - the chat session the view sits beside, recorded as the record's `session`.
   * @returns the record.
   */
  placeOnCanvas(project: string, assetIds: string[], on: boolean, session: string | null = null): Promise<ProjectRecord> {
    return this.runOperation({
      project, operation: on ? 'asset.place' : 'asset.unplace', surface: 'canvas', inputs: assetIds.map(ref => ({ role: 'asset', ref })),
      ...session === null ? {} : { session },
    })
  }

  /** @returns every project with its directory and Workspace, and the saved chat session bindings. */
  listWorkspaces(): Promise<WireWorkspaces> {
    return this.get('/api/dv/workspaces', {})
  }

  /**
   * Record the Workspace created for a project.
   * @param project - the project.
   * @param workspaceId - the Workspace.
   * @returns the acknowledgement.
   */
  linkWorkspace(project: string, workspaceId: string): Promise<{ ok: boolean }> {
    return this.post('/api/dv/workspaces', { project, workspace_id: workspaceId })
  }

  /**
   * Bind a chat session to a project.
   * @param session - the chat session.
   * @param project - the project.
   * @returns the acknowledgement.
   */
  bindSession(session: string, project: string): Promise<{ ok: boolean }> {
    return this.post('/api/dv/workspaces/bind', { session, project })
  }

  /**
   * @param project - the project.
   * @returns the project's saved chat sessions.
   */
  listSessions(project: string): Promise<WireSession[]> {
    return this.get('/api/dv/workspaces/sessions', { project })
  }

  /**
   * Follow a project's changes. Uses the page's shared `EventSource` of the project when the browser has it, else polls
   * `onChange` every `pollMs`.
   * @param project - the project.
   * @param onChange - called on every change, with the event when the stream delivered one.
   * @param pollMs - the polling interval of the fallback.
   * @returns a function that stops following.
   */
  subscribe(project: string, onChange: (event: ProjectEvent | null) => void, pollMs = 3000): () => void {
    if (typeof EventSource === 'function') {
      const handler = (message: MessageEvent<string>): void => {
        try {
          onChange(JSON.parse(message.data) as ProjectEvent)
        } catch {
          // A frame the view cannot parse still means the project changed.
          onChange(null)
        }
      }
      const shared = acquireEventSource(project)
      for (const kind of EVENT_KINDS) shared.source.addEventListener(kind, handler as EventListener)
      // A proxy that buffers event streams (a Cloudflare quick tunnel does) delivers nothing, not even `ready`; poll
      // until the stream proves live so views still follow the project.
      const fallback = setInterval(() => { if (!shared.live) onChange(null) }, pollMs)
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        clearInterval(fallback)
        for (const kind of EVENT_KINDS) shared.source.removeEventListener(kind, handler as EventListener)
        releaseEventSource(project, shared)
      }
    }
    const timer = setInterval(() => { onChange(null) }, pollMs)
    return () => { clearInterval(timer) }
  }

  private async get<T>(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const search = new URLSearchParams(query).toString()
    const response = await this.fetchImpl(search.length === 0 ? path : `${path}?${search}`, { signal: signal ?? null })
    return decode<T>(response)
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return decode<T>(response)
  }
}
