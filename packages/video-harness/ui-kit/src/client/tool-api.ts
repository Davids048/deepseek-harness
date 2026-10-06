/**
 * Browser client of the asset import route of `@video-harness/views` (`/api/vh/assets/upload`).
 *
 * @module @video-harness/ui-kit/tool-api
 */
import { VhApiError } from './api.ts'

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

/** Calls the asset import route. */
export class ToolApi {
  constructor(private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

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
}
