/**
 * The browser client of the `/api/vh` routes and the `/vh/events` stream. Requests are same-origin, so the web
 * application's authentication cookie travels with them.
 *
 * @module @video-harness/ui-kit/api
 */
import type { WireLogEvent, WireOp, WireProject, WireState, WireToolSpec } from './types.ts'

/** One `/vh/events` stream shared by every subscriber of a project in this page. */
interface SharedEventSource {
  source: EventSource
  subscribers: number
  /** True once the server's `ready` event arrived, proving that events reach this page unbuffered. */
  live: boolean
}

/**
 * The page's `/vh/events` streams, keyed by project. Every DreamVerse bundle carries its own copy of this module, so
 * the registry lives on the page's global object (`window`): one page holds at most one stream per project. Browsers
 * allow 6 concurrent HTTP/1.1 connections per host across all tabs, and a stream per panel exhausts them with two tabs
 * open.
 */
type StreamGlobal = typeof globalThis & { __vhEventSources?: Map<string, SharedEventSource>; __vhStreams?: number }

/** @returns the page's stream registry, created on first use. */
function eventSources(): Map<string, SharedEventSource> {
  const page = globalThis as StreamGlobal
  page.__vhEventSources ??= new Map()
  return page.__vhEventSources
}

/** Publish the number of open streams on `window.__vhStreams` for tests and debugging. */
function countStreams(): void {
  ;(globalThis as StreamGlobal).__vhStreams = eventSources().size
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
    const opened: SharedEventSource = { source: new EventSource(`/vh/events?project=${encodeURIComponent(project)}`), subscribers: 0, live: false }
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

/** What a view sends to run a tool. */
export interface InvokeBody {
  project: string
  tool: string
  inputs?: Array<{ role: string; ref: string }>
  params?: Record<string, unknown>
  intent?: string
  surface: 'canvas' | 'timeline'
  branch?: string
  base_op?: string
  supersedes?: string[]
}

/** A route answered with an error status. */
export class VhApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'VhApiError'
  }
}

/** The media URL of an asset, served by `@video-harness/assets`. */
export function assetUrl(id: string): string {
  return `/vh/assets/${encodeURIComponent(id)}/content`
}

/**
 * Read a JSON response, turning error statuses into {@link VhApiError}.
 * @param response - the response.
 * @returns the parsed body.
 */
async function decode<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const reason = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${String(response.status)}`
    throw new VhApiError(response.status, reason)
  }
  return body as T
}

/** Reads project state and writes records through the views API. */
export class VhClient {
  constructor(private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  /**
   * @param signal - cancels the request.
   * @param session - the chat session the view sits beside; its bound project comes first, flagged `current`.
   * @returns every project, newest first.
   */
  projects(signal?: AbortSignal, session: string | null = null): Promise<WireProject[]> {
    return this.get('/api/vh/projects', session === null ? {} : { session }, signal)
  }

  /**
   * Start a project.
   * @param title - the project title.
   * @param surface - where the gesture came from.
   * @returns the project row.
   */
  createProject(title: string, surface: 'canvas' | 'timeline'): Promise<{ projectId: string; title: string }> {
    return this.post('/api/vh/projects', { title, surface })
  }

  /**
   * @param project - the project.
   * @param head - a branch name or record ID.
   * @param signal - cancels the request.
   * @returns the folded state.
   */
  state(project: string, head: string, signal?: AbortSignal): Promise<WireState> {
    return this.get('/api/vh/state', { project, head }, signal)
  }

  /** @returns every registered tool's declaration. */
  tools(signal?: AbortSignal): Promise<WireToolSpec[]> {
    return this.get('/api/vh/tools', {}, signal)
  }

  /**
   * Run a tool as a user turn.
   * @param body - the tool, inputs, params, and where the gesture came from.
   * @returns the record.
   */
  invoke(body: InvokeBody): Promise<WireOp> {
    return this.post('/api/vh/invoke', body)
  }

  /**
   * Accept or reject an agent draft.
   * @param project - the project.
   * @param turn - the draft's turn.
   * @param action - accept or reject.
   * @param surface - where the decision was made.
   * @returns the branch heads afterwards.
   */
  turn(project: string, turn: string, action: 'accept' | 'reject', surface: 'canvas' | 'timeline'): Promise<Record<string, string>> {
    return this.post('/api/vh/turn', { project, turn, action, surface })
  }

  /**
   * Move `main` back one turn.
   * @param project - the project.
   * @returns the undone turn and the heads afterwards.
   */
  undo(project: string): Promise<{ turn: string; heads: Record<string, string> }> {
    return this.post('/api/vh/undo', { project })
  }

  /**
   * Start an exploration branch.
   * @param project - the project.
   * @param name - the branch name.
   * @param at - a record ID or branch name.
   * @returns the branch record and the heads afterwards.
   */
  branch(project: string, name: string, at: string): Promise<{ op: WireOp; heads: Record<string, string> }> {
    return this.post('/api/vh/branch', { project, name, at })
  }

  /**
   * Tell the host what the view selected.
   * @param selection - the selection.
   * @returns nothing; failures are ignored because a selection is advisory.
   */
  async select(selection: { project: string; kind: 'op' | 'clip' | 'asset' | 'entity'; id: string; slot?: number; surface: 'canvas' | 'timeline' }): Promise<void> {
    try {
      await this.post('/api/vh/selection', selection)
    } catch {
      // A lost selection costs the agent one less hint; the view keeps working.
    }
  }

  /**
   * Follow a project's log. Uses the page's shared `EventSource` of the project when the browser has it, else polls
   * `onChange` every `pollMs`.
   * @param project - the project.
   * @param onChange - called on every change, with the event when the stream delivered one.
   * @param pollMs - the polling interval of the fallback.
   * @returns a function that stops following.
   */
  subscribe(project: string, onChange: (event: WireLogEvent | null) => void, pollMs = 3000): () => void {
    if (typeof EventSource === 'function') {
      const handler = (message: MessageEvent<string>): void => {
        try {
          onChange(JSON.parse(message.data) as WireLogEvent)
        } catch {
          // A frame the view cannot parse still means the log changed.
          onChange(null)
        }
      }
      const shared = acquireEventSource(project)
      shared.source.addEventListener('op', handler as EventListener)
      shared.source.addEventListener('head', handler as EventListener)
      // A proxy that buffers event streams (a Cloudflare quick tunnel does) delivers nothing, not even `ready`; poll
      // until the stream proves live so views still follow the log.
      const fallback = setInterval(() => { if (!shared.live) onChange(null) }, pollMs)
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        clearInterval(fallback)
        shared.source.removeEventListener('op', handler as EventListener)
        shared.source.removeEventListener('head', handler as EventListener)
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
