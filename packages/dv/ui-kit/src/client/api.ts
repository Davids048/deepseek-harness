/**
 * The browser client of the `/api/dv` routes and the `/dv/events` stream. Requests are same-origin, so the web
 * application's authentication cookie travels with them.
 *
 * @module @dv/ui-kit/api
 */
import type {
  ApprovalCard, Branch, CanvasLayout, ComposerMode, DraftCounts, DraftTarget, HistoryQuery, OperationRequest, ProjectEvent,
  ProjectInfo, ProjectRecord, ViewSelection, WireHistory, WireOperation, WireProject, WireRecordResult, WireSession, WireState,
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
const EVENT_KINDS: ReadonlyArray<ProjectEvent['kind']> = ['record', 'update', 'branch']

/** The surface a view sends with its writes: a subset of the record field `Surface`. */
export type ViewSurface = 'canvas' | 'timeline' | 'asset_pool' | 'history'

/** A route answered with an error status. */
export class DvApiError extends Error {
  /**
   * @param status - the HTTP status.
   * @param message - the server's explanation.
   * @param code - the Project error code, such as `draft_changed`, when the server sent one.
   * @param body - the whole error body, for fields such as a changed draft's `counts`.
   */
  constructor(readonly status: number, message: string, readonly code: string | null = null, readonly body: Record<string, unknown> = {}) {
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
    throw new DvApiError(response.status, reason, typeof fields['code'] === 'string' ? fields['code'] : null, fields)
  }
  return body as T
}

/** Every `/api/dv` call of the browser: project state, operations, drafts, branches, layout, workspaces, composer. */
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
   * @param branch - a branch name.
   * @param signal - cancels the request.
   * @returns the state of the branch.
   */
  getState(project: string, branch: string, signal?: AbortSignal): Promise<WireState> {
    return this.get('/api/dv/state', { project, branch }, signal)
  }

  /**
   * List a project's records with their marks, newest first, with the request record of each turn they belong to and
   * the assets they name.
   * The query travels as a JSON body because a `records` set can be long; the route writes no record.
   * @param query - the project and the filters.
   * @param signal - cancels the request.
   * @returns the entries, the turns' request records, and the assets.
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
   * @param session - the chat session the view sits beside; the record goes to that session's working branch.
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
   * Accept a draft into the branch it was forked from.
   * @param project - the project.
   * @param target - the chat session whose draft it is, or the draft branch.
   * @param surface - where the decision was made.
   * @returns the accept record and the branch heads afterwards.
   */
  acceptDraft(project: string, target: DraftTarget, surface: ViewSurface): Promise<WireRecordResult> {
    return this.post('/api/dv/drafts/accept', { project, ...target, surface })
  }

  /**
   * Discard a draft, including the human's edits on it. Without `counts` this is a dry read that returns the counts
   * to confirm; with the counts the human confirmed, the draft is discarded, or the call fails with code
   * `draft_changed` when the draft changed meanwhile.
   * @param project - the project.
   * @param target - the chat session whose draft it is, or the draft branch.
   * @param surface - where the decision was made.
   * @param counts - the counts the human confirmed; omitted for the dry read.
   * @returns the draft's name and its counts.
   */
  discardDraft(
    project: string, target: DraftTarget, surface: ViewSurface, counts?: DraftCounts,
  ): Promise<{ draft: string; counts: DraftCounts }> {
    return this.post('/api/dv/drafts/discard', { project, ...target, surface, ...counts === undefined ? {} : { counts } })
  }

  /**
   * Move `main` back by one accepted change.
   * @param project - the project.
   * @param surface - where the gesture came from.
   * @param session - the chat session the view sits beside, or null.
   * @returns the undo record and the heads afterwards.
   */
  undo(project: string, surface: ViewSurface, session: string | null = null): Promise<WireRecordResult> {
    return this.post('/api/dv/undo', { project, surface, ...session === null ? {} : { session } })
  }

  /**
   * Re-apply the change the latest undo removed.
   * @param project - the project.
   * @param surface - where the gesture came from.
   * @param session - the chat session the view sits beside, or null.
   * @returns the redo record and the heads afterwards.
   */
  redo(project: string, surface: ViewSurface, session: string | null = null): Promise<WireRecordResult> {
    return this.post('/api/dv/redo', { project, surface, ...session === null ? {} : { session } })
  }

  /**
   * Create an exploration branch `explore/<name>`.
   * @param project - the project.
   * @param name - the name after `explore/`.
   * @param at - a record ID or branch name.
   * @param surface - where the gesture came from.
   * @param session - the chat session the view sits beside, or null.
   * @returns the branch and the heads afterwards.
   */
  createBranch(
    project: string, name: string, at: string, surface: ViewSurface, session: string | null = null,
  ): Promise<{ branch: Branch; heads: Record<string, string> }> {
    return this.post('/api/dv/branches/create', { project, name, at, surface, ...session === null ? {} : { session } })
  }

  /**
   * Switch the working branch of a chat session to `main` or an exploration branch.
   * @param project - the project.
   * @param branch - the branch name.
   * @param surface - where the gesture came from.
   * @param session - the chat session.
   * @returns the branch and the heads afterwards.
   */
  switchBranch(
    project: string, branch: string, surface: ViewSurface, session: string,
  ): Promise<{ branch: Branch; heads: Record<string, string> }> {
    return this.post('/api/dv/branches/switch', { project, branch, surface, session })
  }

  /**
   * Keep a stale record as it is: runs `proj.stale_accept`.
   * @param project - the project.
   * @param record - the stale record.
   * @param surface - where the decision was made.
   * @param session - the chat session the view sits beside, or null.
   * @returns the accept record and the heads afterwards.
   */
  acceptStale(project: string, record: string, surface: ViewSurface, session: string | null = null): Promise<WireRecordResult> {
    return this.post('/api/dv/stale/accept', { project, record, surface, ...session === null ? {} : { session } })
  }

  /**
   * Tell the host what the view selected.
   * @param selection - the selection.
   * @returns nothing; failures are ignored because a selection is advisory.
   */
  async select(selection: Omit<ViewSelection, 'at'>): Promise<void> {
    try {
      await this.post('/api/dv/selection', selection)
    } catch {
      // A lost selection costs the agent one less hint; the view keeps working.
    }
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
   * @param session - a chat session.
   * @returns its composer choices.
   */
  getComposerMode(session: string): Promise<ComposerMode> {
    return this.get('/api/dv/composer/mode', { session })
  }

  /**
   * Change a chat session's composer choices.
   * @param session - a chat session.
   * @param patch - the choices to change.
   * @returns the choices afterwards.
   */
  updateComposerMode(session: string, patch: Partial<ComposerMode>): Promise<ComposerMode> {
    return this.post('/api/dv/composer/mode', { session, ...patch })
  }

  /**
   * @param session - a chat session.
   * @returns the renders of the session that wait for the user's approval.
   */
  listApprovals(session: string): Promise<ApprovalCard[]> {
    return this.get('/api/dv/composer/approvals', { session })
  }

  /**
   * Approve or skip one waiting render, or every waiting render of a session.
   * @param session - a chat session.
   * @param target - an approval ID, or `all`.
   * @param action - approve or skip.
   * @returns how many approvals were answered.
   */
  answerApprovals(session: string, target: string, action: 'approve' | 'skip'): Promise<{ answered: number }> {
    return this.post('/api/dv/composer/approvals', target === 'all' ? { session, all: true, action } : { session, id: target, action })
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
