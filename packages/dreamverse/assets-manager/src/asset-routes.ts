/**
 * Port of the reference `dreamverse/routes/assets.py`: `GET /assets`, multipart `POST /assets`, seekable
 * `GET /assets/{asset_id}/content`, and `DELETE /assets/{asset_id}` against the asset library, with FastAPI's status
 * codes and `{"detail": ...}` bodies. The service registers them as one `/assets` prefix route on the DSH web server.
 *
 * @module @dreamverse/assets-manager/asset-routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Logger } from '@deepseek-ai/cordis'
import { requestPath, sendInternalServerError, sendJson, serveRoutes, type Route, type ValidationIssue } from '@dreamverse/http-routes'
import { sendFile } from './file-response.ts'
import { AssetNotFoundError, type AssetRecord } from './library.ts'
import { MediaValidationError, UploadTooLargeError } from './media.ts'

/** The asset library members that the asset routes call; the `dreamverseAssetsManager` service implements them. */
export interface AssetRoutesLibrary {
  /** Rejects with `UploadTooLargeError` or another `MediaValidationError` for a rejected upload. */
  add(content: Uint8Array, name: string, mimeType: string): Promise<AssetRecord>
  /** Every published asset, most recently added first. */
  list(): AssetRecord[]
  /** Throws `AssetNotFoundError` for the first unavailable ID without retaining any file. */
  retain(assetIds: readonly string[]): AssetRecord[]
  release(assetIds: readonly string[]): void
  /** Throws `AssetNotFoundError` when the asset is absent or already deleted. */
  delete(assetId: string): void
}

/** The reference `_asset_as_dict`: the record's fields without `file_path`, plus its content URL. */
function assetAsDict(asset: AssetRecord): Record<string, unknown> {
  return {
    asset_id: asset.assetId,
    name: asset.name,
    media_type: asset.mediaType,
    mime_type: asset.mimeType,
    size_bytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    duration_sec: asset.durationSec,
    content_url: `/assets/${asset.assetId}/content`,
  }
}

/** A request form that Starlette's parser rejects; FastAPI answers 400 with this detail. */
class FormParseError extends Error {}

/**
 * Read the request form like Starlette's `Request.form()`: multipart and URL-encoded bodies are parsed, and any
 * other content type yields an empty form.
 * @throws FormParseError with Starlette's missing-boundary message or FastAPI's body parsing message.
 */
async function readForm(request: IncomingMessage): Promise<FormData> {
  const contentType = request.headers['content-type'] ?? ''
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (mediaType !== 'multipart/form-data' && mediaType !== 'application/x-www-form-urlencoded') {
    request.resume()
    return new FormData()
  }
  if (mediaType === 'multipart/form-data' && !/;\s*boundary=/i.test(contentType)) {
    request.resume()
    throw new FormParseError('Missing boundary in multipart.')
  }
  // Undici requires `duplex: 'half'` for a streamed request body; the DOM `RequestInit` type does not declare it.
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
    duplex: 'half',
  }
  try {
    return await new Request('http://localhost/assets', init).formData()
  } catch {
    throw new FormParseError('There was an error parsing the body')
  }
}

/**
 * Serve `GET /assets`.
 * @param response - the browser response.
 * @param assets - the asset library.
 */
function listAssets(response: ServerResponse, assets: AssetRoutesLibrary): void {
  sendJson(response, 200, { assets: assets.list().map(assetAsDict) })
}

/**
 * Serve `POST /assets`: validate the multipart `file` field like FastAPI's `UploadFile` parameter, then add the
 * upload; `UploadTooLargeError` answers 413 and any other `MediaValidationError` answers 400.
 * @param request - the browser request.
 * @param response - the browser response.
 * @param assets - the asset library.
 */
async function uploadAsset(request: IncomingMessage, response: ServerResponse, assets: AssetRoutesLibrary): Promise<void> {
  let form: FormData
  try {
    form = await readForm(request)
  } catch (error) {
    if (!(error instanceof FormParseError)) throw error
    sendJson(response, 400, { detail: error.message })
    return
  }
  // Starlette's form keeps the last value of a repeated field, and FastAPI treats an empty string as absent.
  const file = form.getAll('file').at(-1)
  if (file === undefined || file === '') {
    const issue: ValidationIssue = { type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null }
    sendJson(response, 422, { detail: [issue] })
    return
  }
  if (typeof file === 'string') {
    const msg = 'Value error, Expected UploadFile, received: <class \'str\'>'
    const issue: ValidationIssue = { type: 'value_error', loc: ['body', 'file'], msg, input: file, ctx: { error: {} } }
    sendJson(response, 422, { detail: [issue] })
    return
  }
  try {
    const asset = await assets.add(new Uint8Array(await file.arrayBuffer()), file.name || 'Untitled asset', file.type)
    sendJson(response, 201, assetAsDict(asset))
  } catch (error) {
    if (error instanceof UploadTooLargeError) sendJson(response, 413, { detail: error.message })
    else if (error instanceof MediaValidationError) sendJson(response, 400, { detail: error.message })
    else throw error
  }
}

/**
 * Serve `GET /assets/{asset_id}/content`: retain the asset for the delivery and release it once the response
 * finishes or the browser disconnects, so a concurrent delete keeps the file until then.
 * @param request - the browser request, whose `Range` header selects the bytes.
 * @param response - the browser response.
 * @param assets - the asset library.
 * @param assetId - the decoded path parameter.
 * @param logger - receives a release failure.
 */
async function readAssetContent(
  request: IncomingMessage,
  response: ServerResponse,
  assets: AssetRoutesLibrary,
  assetId: string,
  logger: Logger,
): Promise<void> {
  let retained: AssetRecord[]
  try {
    retained = assets.retain([assetId])
  } catch (error) {
    if (!(error instanceof AssetNotFoundError)) throw error
    sendJson(response, 404, { detail: error.message })
    return
  }
  // `retain` returns one record per requested ID or throws, so a missing record breaks that contract.
  const [asset] = retained
  if (asset === undefined) throw new Error(`Retaining asset ${assetId} returned no record.`)
  response.once('close', () => {
    try {
      assets.release([assetId])
    } catch (error) {
      logger.error(error)
    }
  })
  await sendFile(request, response, { path: asset.filePath, mediaType: asset.mimeType, filename: asset.name })
}

/**
 * Serve `DELETE /assets/{asset_id}` with 204, or 404 for an absent or deleted asset.
 * @param response - the browser response.
 * @param assets - the asset library.
 * @param assetId - the decoded path parameter.
 */
function deleteAsset(response: ServerResponse, assets: AssetRoutesLibrary, assetId: string): void {
  try {
    assets.delete(assetId)
  } catch (error) {
    if (!(error instanceof AssetNotFoundError)) throw error
    sendJson(response, 404, { detail: error.message })
    return
  }
  response.writeHead(204)
  response.end()
}

/**
 * Build the `/assets` prefix route handler: the four reference asset routes dispatched like Starlette's router, so a
 * decoded path under `/assets` that matches no route answers FastAPI's 404 and a known path with another method 405.
 * When `serveShellFile` is given, a GET or HEAD request whose path matches no asset GET route goes to it instead: the
 * DSH page shell loads its own files from `/assets/`.
 * @param assets - the asset library.
 * @param logger - receives route failures and release failures.
 * @param serveShellFile - serves the DSH page shell's files, when the composition has the shell.
 * @returns the web server route handler.
 */
export function assetsRouteHandler(
  assets: AssetRoutesLibrary,
  logger: Logger,
  serveShellFile?: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): (request: IncomingMessage, response: ServerResponse) => void {
  const routes: Route[] = [
    { method: 'GET', path: /^\/assets$/, handle: (_request, response) => { listAssets(response, assets) } },
    { method: 'POST', path: /^\/assets$/, handle: (request, response) => uploadAsset(request, response, assets) },
    {
      method: 'GET',
      path: /^\/assets\/([^/]+)\/content$/,
      handle: (request, response, [assetId = '']) => readAssetContent(request, response, assets, assetId, logger),
    },
    { method: 'DELETE', path: /^\/assets\/([^/]+)$/, handle: (_request, response, [assetId = '']) => { deleteAsset(response, assets, assetId) } },
  ]
  const getPaths = routes.filter(route => route.method === 'GET').map(route => route.path)
  return (request, response) => {
    const shellRequest = request.method === 'GET' || request.method === 'HEAD'
    if (serveShellFile !== undefined && shellRequest && !getPaths.some(path => path.test(requestPath(request)))) {
      serveShellFile(request, response).catch((error: unknown) => {
        logger.error(error)
        if (response.headersSent) response.destroy()
        else sendInternalServerError(response)
      })
      return
    }
    serveRoutes(routes, request, response, logger)
  }
}
