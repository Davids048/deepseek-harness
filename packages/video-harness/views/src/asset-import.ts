/**
 * The asset import route of the assets panel and the canvas.
 *
 * `POST /api/vh/assets/upload?project=<id>&name=<name>&mime=<type>` takes the raw file bytes as the body, stores them,
 * and records an `asset.upload` user turn with surface `canvas`. It answers `{assetId, op}`; a malformed request answers
 * `400`, an unknown project `404`, and every error body is `{error}`.
 *
 * @module @video-harness/views/asset-import
 */
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type VhAssets from '@video-harness/assets'
import type VhOpLog from '@video-harness/oplog'
import type { ProjectId } from '@video-harness/oplog'
import type VhProject from '@video-harness/runtime'
import { projectIdOf } from './wire.ts'

/** The Fetch route path of the asset import. */
export const ASSET_IMPORT_ROUTE = '/api/vh/assets/upload'

/** The services the route reads and writes. */
export interface AssetImportServices {
  project: VhProject
  log: VhOpLog
  assets: VhAssets
}

/** A request the route refuses, with its status. */
class AssetImportRequestError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message)
    this.name = 'AssetImportRequestError'
  }
}

/**
 * A JSON response with no caching.
 * @param value - the body.
 * @param status - the HTTP status.
 * @returns the response.
 */
function json(value: unknown, status = 200): Response {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  return new Response(JSON.stringify(value), { status, headers })
}

/**
 * Store the request body as an asset and record it in one accepted user turn on `main`.
 * @param services - the runtime, the log, and the asset store.
 * @param request - the import request.
 * @returns the asset ID and the `asset.upload` record.
 * @throws AssetImportRequestError when the project, the MIME type, or the body is missing or unknown.
 */
async function importAsset(services: AssetImportServices, request: Request): Promise<unknown> {
  const url = new URL(request.url)
  const projectId: ProjectId | null = projectIdOf(url.searchParams.get('project'))
  if (projectId === null) throw new AssetImportRequestError(400, "'project' must name a project.")
  try {
    services.log.project(projectId)
  } catch {
    // The log throws for an unknown project; the route reports it as 404.
    throw new AssetImportRequestError(404, `Unknown project '${projectId}'.`)
  }
  const mime = url.searchParams.get('mime')?.trim() ?? ''
  if (mime.length === 0) throw new AssetImportRequestError(400, "'mime' must be a non-empty string.")
  const name = url.searchParams.get('name') ?? 'upload'
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length === 0) throw new AssetImportRequestError(400, 'The upload body is empty.')
  // Store the bytes first so the record names the stored file by path instead of carrying base64 in its params.
  const stored = services.assets.put(bytes, { mime, name })
  const intent = `upload ${name}`
  const open = services.project.beginTurn(projectId, { actor: 'user', surface: 'canvas', intent })
  try {
    const op = await services.project.invoke(projectId, {
      tool: 'asset.upload', inputs: [], params: { path: services.assets.path(stored), mime, name },
      actor: 'user', surface: 'canvas', intent, turn: open.turn,
    })
    return { assetId: op.outputs[0] ?? stored, op }
  } finally {
    services.project.acceptTurn(projectId, open.turn, { actor: 'user', surface: 'canvas' })
  }
}

/**
 * The asset import Fetch route.
 * @param services - the runtime, the log, and the asset store.
 * @returns the route.
 */
export function assetImportRoutes(services: AssetImportServices): ConnectionFetchRoute[] {
  return [{
    path: ASSET_IMPORT_ROUTE, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return json(await importAsset(services, request))
      } catch (error) {
        if (error instanceof AssetImportRequestError) return json({ error: error.message }, error.status)
        return json({ error: error instanceof Error ? error.message : String(error) }, 500)
      }
    },
  }]
}
