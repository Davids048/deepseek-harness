/**
 * The asset import route of the asset pool panel and the canvas.
 *
 * `POST /api/dv/assets/import?project=<id>&name=<name>&mime=<type>&surface=<surface>[&session=<id>]` takes the raw file
 * bytes as the body, stores them in the asset pool, and runs `asset.import` as the human with the request's surface
 * (`canvas` or `asset_pool`); the record goes to the project's current branch, and an import from the canvas also puts
 * the asset on the canvas (`place`). It
 * answers `{asset, record}` (the `AssetId` and the `asset.import` record). Errors use the body `{error, code}` of every
 * `/api/dv` route: a malformed request (no project, a surface other than `canvas` or `asset_pool`, no MIME type, an empty
 * body) answers 400 `invalid_params`, an unknown project 404 `unknown_project`.
 *
 * @module @dv/api/asset-import
 */
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type DvAssetPool from '@dv/asset-pool'
import type DvProject from '@dv/project'
import { answer, ApiRequestError, requireProject, sessionOf } from './api.ts'

/** The Fetch route path of the asset import. */
export const ASSET_IMPORT_ROUTE = '/api/dv/assets/import'

/** The services the route reads and writes. */
export interface AssetImportServices {
  project: DvProject
  assets: DvAssetPool
}

/**
 * Store the request body as an asset and record it with one `asset.import` run as the human.
 * @param services - the Project service and the asset pool.
 * @param request - the import request.
 * @returns the asset ID and the `asset.import` record.
 * @throws ApiRequestError when the project, the surface, the MIME type, or the body is missing or unknown.
 */
async function importAsset(services: AssetImportServices, request: Request): Promise<unknown> {
  const url = new URL(request.url)
  const projectId = requireProject(services.project, url.searchParams.get('project'))
  // The asset pool panel and a file dropped on the canvas both import here; the caller names which one it is.
  const surface = url.searchParams.get('surface')
  if (surface !== 'canvas' && surface !== 'asset_pool') {
    throw new ApiRequestError(400, "'surface' must be 'canvas' or 'asset_pool'.", 'invalid_params')
  }
  const mime = url.searchParams.get('mime')?.trim() ?? ''
  if (mime.length === 0) throw new ApiRequestError(400, "'mime' must be a non-empty string.", 'invalid_params')
  const name = url.searchParams.get('name') ?? 'imported'
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length === 0) throw new ApiRequestError(400, 'The import body is empty.', 'invalid_params')
  // Store the bytes first so the record names the stored file by path instead of carrying base64 in its params.
  const stored = services.assets.importAsset(bytes, { mime, name }, null)
  const intent = `import ${name}`
  const { record } = await services.project.run({
    project: projectId, operation: 'asset.import', inputs: [], params: { path: services.assets.path(stored), mime, name, place: surface === 'canvas' },
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
    fetch: request => answer(() => importAsset(services, request)),
  }]
}
