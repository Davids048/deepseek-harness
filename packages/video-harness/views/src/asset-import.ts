/**
 * The asset import route of the assets panel and the canvas.
 *
 * `POST /api/vh/assets/upload?project=<id>&name=<name>&mime=<type>[&session=<id>]` takes the raw file bytes as the
 * body, stores them, and runs `asset.upload` as the human with surface `canvas`; the record goes to the working branch
 * of the named chat session, else to `main`. It answers `{assetId, op}`; a malformed request answers `400`, an unknown
 * project `404`, and every error body is `{error}`.
 *
 * @module @video-harness/views/asset-import
 */
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type VhAssets from '@video-harness/assets'
import type DvProject from '@dv/project'
import type { ProjectId } from '@dv/project'
import { sessionOf } from './api.ts'
import { projectIdOf, toWireOp } from './wire.ts'

/** The Fetch route path of the asset import. */
export const ASSET_IMPORT_ROUTE = '/api/vh/assets/upload'

/** The services the route reads and writes. */
export interface AssetImportServices {
  project: DvProject
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
 * Store the request body as an asset and record it with one `asset.upload` run as the human.
 * @param services - the Project service and the asset store.
 * @param request - the import request.
 * @returns the asset ID and the `asset.upload` record.
 * @throws AssetImportRequestError when the project, the MIME type, or the body is missing or unknown.
 */
async function importAsset(services: AssetImportServices, request: Request): Promise<unknown> {
  const url = new URL(request.url)
  const projectId: ProjectId | null = projectIdOf(url.searchParams.get('project'))
  if (projectId === null) throw new AssetImportRequestError(400, "'project' must name a project.")
  try {
    services.project.openProject(projectId)
  } catch {
    // Project throws for an unknown project; the route reports it as 404.
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
  const { record } = await services.project.run({
    project: projectId, operation: 'asset.upload', inputs: [], params: { path: services.assets.path(stored), mime, name },
    actor: 'user', surface: 'canvas', session: sessionOf(url.searchParams.get('session')), turn: null, tool_call: null, intent,
  })
  if (record === null) throw new Error('asset.upload wrote no record.')
  return { assetId: record.outputs[0] ?? stored, op: toWireOp(record) }
}

/**
 * The asset import Fetch route.
 * @param services - the Project service and the asset store.
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
