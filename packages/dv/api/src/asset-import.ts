/**
 * The asset import route of the asset pool panel and the canvas.
 *
 * `POST /api/dv/assets/import?project=<id>&name=<name>&mime=<type>&surface=<surface>[&session=<id>]` takes the raw file
 * bytes as the body, stores them in the asset pool, and runs `asset.import` as the human with the request's surface
 * (`canvas` or `asset_pool`); the record goes to the working branch of the named chat session, else to `main`. It
 * answers `{asset, record}` (the `AssetId` and the `asset.import` record); a malformed request answers `400` (a surface
 * other than `canvas` or `asset_pool` with code `invalid_params`), an unknown project `404`, and every error body is
 * `{error, code?}`.
 *
 * @module @dv/api/asset-import
 */
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type DvAssetPool from '@dv/asset-pool'
import type DvProject from '@dv/project'
import type { ProjectId } from '@dv/project'
import { sessionOf } from './api.ts'
import { projectIdOf } from './wire.ts'

/** The Fetch route path of the asset import. */
export const ASSET_IMPORT_ROUTE = '/api/dv/assets/import'

/** The services the route reads and writes. */
export interface AssetImportServices {
  project: DvProject
  assets: DvAssetPool
}

/** A request the route refuses, with its status. */
class AssetImportRequestError extends Error {
  constructor(readonly status: 400 | 404, message: string, readonly code?: 'invalid_params') {
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
 * Store the request body as an asset and record it with one `asset.import` run as the human.
 * @param services - the Project service and the asset pool.
 * @param request - the import request.
 * @returns the asset ID and the `asset.import` record.
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
  // The asset pool panel and a file dropped on the canvas both import here; the caller names which one it is.
  const surface = url.searchParams.get('surface')
  if (surface !== 'canvas' && surface !== 'asset_pool') {
    throw new AssetImportRequestError(400, "'surface' must be 'canvas' or 'asset_pool'.", 'invalid_params')
  }
  const mime = url.searchParams.get('mime')?.trim() ?? ''
  if (mime.length === 0) throw new AssetImportRequestError(400, "'mime' must be a non-empty string.")
  const name = url.searchParams.get('name') ?? 'imported'
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length === 0) throw new AssetImportRequestError(400, 'The import body is empty.')
  // Store the bytes first so the record names the stored file by path instead of carrying base64 in its params.
  const stored = services.assets.importAsset(bytes, { mime, name }, null)
  const intent = `import ${name}`
  const { record } = await services.project.run({
    project: projectId, operation: 'asset.import', inputs: [], params: { path: services.assets.path(stored), mime, name },
    actor: 'user', surface, session: sessionOf(url.searchParams.get('session')), turn: null, tool_call: null, intent,
  })
  if (record === null) throw new Error('asset.import wrote no record.')
  return { asset: record.outputs[0] ?? stored, record }
}

/**
 * The asset import Fetch route.
 * @param services - the Project service and the asset pool.
 * @returns the route.
 */
export function assetImportRoutes(services: AssetImportServices): ConnectionFetchRoute[] {
  return [{
    path: ASSET_IMPORT_ROUTE, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return json(await importAsset(services, request))
      } catch (error) {
        if (error instanceof AssetImportRequestError) {
          return json({ error: error.message, ...error.code === undefined ? {} : { code: error.code } }, error.status)
        }
        return json({ error: error instanceof Error ? error.message : String(error) }, 500)
      }
    },
  }]
}
