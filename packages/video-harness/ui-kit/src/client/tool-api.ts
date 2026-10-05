/**
 * Browser client of the Tool session and asset-upload routes of `@video-harness/views` (`/api/vh/tool-sessions*`,
 * `/api/vh/assets/upload`).
 *
 * @module @video-harness/ui-kit/tool-api
 */
import { VhApiError } from './api.ts'
import { pickText } from './locale.ts'
import type { WireOp } from './types.ts'

/** One Tool session of a project. */
export interface WireToolSession {
  id: string
  title: string
  createdAt: string
}

/** The `window` event a view dispatches after it creates, renames, or deletes a Tool session; `detail` is the project ID. */
export const VH_TOOL_SESSIONS_CHANGED_EVENT = 'vh:tool-sessions-changed'

/**
 * Tell every view that shows Tool session titles to refetch them.
 * @param project - the project whose sessions changed.
 */
export function notifyToolSessionsChanged(project: string): void {
  window.dispatchEvent(new CustomEvent<string>(VH_TOOL_SESSIONS_CHANGED_EVENT, { detail: project }))
}

/**
 * A Tool session title in the interface language: the host's default title "Tool 会话 N" reads "Tool session N" in
 * English; a title the user typed is shown as typed.
 * @param title - the stored title.
 * @returns the display title.
 */
export function toolSessionTitle(title: string): string {
  const match = /^Tool (?:会话|session) (\d+)$/.exec(title)
  return match === null ? title : pickText(`Tool 会话 ${match[1] ?? ''}`, `Tool session ${match[1] ?? ''}`)
}

/** The served model's limits for Tool generations. */
export interface WireToolCapabilities {
  /** Whether a generation backend is mounted; false means the other fields are placeholders. */
  available: boolean
  modelName: string
  minDurationSec: number
  maxDurationSec: number
  maxReferences: number
}

/** What one Tool generation sends. */
export interface ToolGenerateBody {
  project: string
  session: string
  prompt: string
  /** Asset IDs of the reference images. */
  references: string[]
  duration_sec?: number
  seed?: number
}

/**
 * Read a JSON response, turning error statuses into {@link VhApiError}.
 * @param response - the response.
 * @returns the parsed body.
 */
async function decode<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
    throw new VhApiError(response.status, typeof error === 'string' ? error : `HTTP ${String(response.status)}`)
  }
  return body as T
}

/** Calls the Tool session and upload routes. */
export class ToolApi {
  constructor(private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  /**
   * @param project - a project.
   * @returns its Tool sessions, newest first.
   */
  sessions(project: string): Promise<WireToolSession[]> {
    return this.get('/api/vh/tool-sessions', { project })
  }

  /**
   * @param project - a project.
   * @param title - the title of a created session; empty lets the host number the session.
   * @returns the project's newest empty session, else a created one.
   */
  createSession(project: string, title = ''): Promise<WireToolSession> {
    return this.post('/api/vh/tool-sessions', { project, title })
  }

  /**
   * @param project - a project.
   * @param session - the session ID.
   * @param title - the title.
   * @returns the renamed session.
   */
  renameSession(project: string, session: string, title: string): Promise<WireToolSession> {
    return this.post('/api/vh/tool-sessions/rename', { project, session, title })
  }

  /**
   * Remove a session from the project's list; its generation records stay in the log.
   * @param project - a project.
   * @param session - the session ID.
   */
  async deleteSession(project: string, session: string): Promise<void> {
    await this.post('/api/vh/tool-sessions/delete', { project, session })
  }

  /**
   * @param project - a project.
   * @param session - the session ID.
   * @returns the session's generation records, newest first.
   */
  results(project: string, session: string): Promise<WireOp[]> {
    return this.get('/api/vh/tool-sessions/results', { project, session })
  }

  /**
   * @param body - the generation request.
   * @returns the pending record.
   */
  generate(body: ToolGenerateBody): Promise<WireOp> {
    return this.post('/api/vh/tool-sessions/generate', body)
  }

  /** @returns the served model's limits. */
  capabilities(): Promise<WireToolCapabilities> {
    return this.get('/api/vh/tool-sessions/capabilities', {})
  }

  /**
   * Store a file as a project asset through an `asset.upload` record.
   * @param project - a project.
   * @param file - the file.
   * @returns the asset ID.
   */
  async upload(project: string, file: File): Promise<string> {
    const query = new URLSearchParams({ project, name: file.name, mime: file.type.length > 0 ? file.type : 'application/octet-stream' })
    const response = await this.fetchImpl(`/api/vh/assets/upload?${query.toString()}`, { method: 'POST', body: file })
    return (await decode<{ assetId: string }>(response)).assetId
  }

  private async get<T>(path: string, query: Record<string, string>): Promise<T> {
    const search = new URLSearchParams(query).toString()
    return decode<T>(await this.fetchImpl(search.length === 0 ? path : `${path}?${search}`))
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return decode<T>(await this.fetchImpl(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  }
}
