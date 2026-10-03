/**
 * The `/assets` routes, registered as one prefix route on the DSH web server against a fake asset library, serve the
 * reference asset HTTP surface; the `dreamverseAssetsManager` service registers them while a web server is available.
 */
import { once } from 'node:events'
import { readdirSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import DreamverseAssetsManager, {
  AssetNotFoundError, MediaValidationError, UploadTooLargeError, projectOwner, type AssetOwner, type AssetRecord,
} from '../src/index.ts'
import { PROJECT_FILE_DELETE_DETAIL, assetsRouteHandler, type AssetRoutesLibrary } from '../src/asset-routes.ts'
import { shellFileResponder } from '../src/shell-files.ts'
import { temporaryDirectory, type TemporaryDirectory } from './support.ts'

/** The web server's OS-assigned port for the current test. */
let port = 0
let temporary: TemporaryDirectory
beforeAll(() => { temporary = temporaryDirectory() })
afterAll(() => { temporary.cleanup() })

/** An asset library over files in the spec's temporary directory that records retention and additions. */
class FakeAssets implements AssetRoutesLibrary {
  readonly records = new Map<string, AssetRecord>()
  readonly added: Array<{ content: Buffer; name: string; mimeType: string }> = []
  readonly retentions: string[] = []
  readonly releases: string[] = []
  addFailure: Error | undefined

  /** Publish a file under the temporary directory as one asset. */
  put(assetId: string, name: string, content: Buffer, mimeType = 'video/mp4', owner: AssetOwner = 'library'): AssetRecord {
    const filePath = join(temporary.directory, `asset-${assetId}`)
    writeFileSync(filePath, content)
    const record: AssetRecord = {
      assetId, owner, name, mediaType: 'video', mimeType, filePath, sizeBytes: content.length, width: 1344, height: 768,
      durationSec: 5.5, createdAt: '2026-10-02T00:00:00.000Z',
    }
    this.records.set(assetId, record)
    return record
  }

  async add(content: Uint8Array, name: string, mimeType: string): Promise<AssetRecord> {
    this.added.push({ content: Buffer.from(content), name, mimeType })
    if (this.addFailure) throw this.addFailure
    return { ...this.put('new', name, Buffer.from(content), mimeType), mediaType: 'image', width: 2, height: 1, durationSec: null }
  }

  list(): AssetRecord[] {
    return [...this.records.values()].filter(record => record.owner === 'library')
  }

  retain(assetIds: readonly string[]): AssetRecord[] {
    const records = assetIds.map(assetId => this.get(assetId))
    this.retentions.push(...assetIds)
    return records
  }

  release(assetIds: readonly string[]): void {
    this.releases.push(...assetIds)
  }

  delete(assetId: string): void {
    this.get(assetId)
    this.records.delete(assetId)
  }

  get(assetId: string): AssetRecord {
    const record = this.records.get(assetId)
    if (!record) throw new AssetNotFoundError(`Asset '${assetId}' is unavailable. Select an asset from the library.`)
    return record
  }
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
})

/** Mount the DSH web server on an OS-assigned port and return its root context. */
async function startWebServer(): Promise<Context> {
  const root = new Context()
  roots.push(root)
  await root.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' }).await()
  port = root.webServer.port
  return root
}

/** Mount the web server and register the `/assets` prefix route against the given library and shell file responder. */
async function startAssetRoutes(
  assets: AssetRoutesLibrary,
  serveShellFile?: Parameters<typeof assetsRouteHandler>[2],
): Promise<void> {
  const root = await startWebServer()
  root.webServer.register({ kind: 'prefix', path: '/assets', handler: assetsRouteHandler(assets, root.logger('test'), serveShellFile) })
}

/** Send one HTTP request on a fresh connection and read the complete response. */
async function call(method: string, path: string, options: { headers?: OutgoingHttpHeaders; chunks?: Buffer[] } = {}) {
  return await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers: options.headers ?? {}, agent: false }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }) })
    })
    request.on('error', reject)
    for (const chunk of options.chunks ?? []) request.write(chunk)
    request.end()
  })
}

async function callJson(method: string, path: string, body?: unknown, contentType = 'application/json') {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const headers = { 'content-type': contentType, 'content-length': chunks[0]?.length ?? 0 }
  const response = await call(method, path, { headers, chunks })
  const json: unknown = JSON.parse(response.body.toString('utf8'))
  return { status: response.status, headers: response.headers, json }
}

const BOUNDARY = '----dreamverse'

/** A multipart/form-data body with the given parts. */
function multipart(
  parts: Array<{ name: string; filename?: string; type?: string; content: Buffer }>,
): { headers: OutgoingHttpHeaders; chunks: Buffer[] } {
  const chunks = parts.flatMap(({ name, filename, type, content }) => [
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"${filename === undefined ? '' : `; filename="${filename}"`}\r\n`
      + `${type === undefined ? '' : `Content-Type: ${type}\r\n`}\r\n`),
    content,
    Buffer.from('\r\n'),
  ])
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return { headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }, chunks }
}

describe('/assets routing', () => {
  it('answers FastAPI 404 for decoded paths that match no asset route and 405 with Allow for other methods', async () => {
    await startAssetRoutes(new FakeAssets())
    expect(await callJson('GET', '/assets/a%2Fb')).toMatchObject({ status: 404, json: { detail: 'Not Found' } })
    expect(await callJson('PUT', '/assets')).toMatchObject({ status: 405, headers: { allow: 'GET' }, json: { detail: 'Method Not Allowed' } })
    expect(await callJson('POST', '/assets/a1')).toMatchObject({ status: 405, headers: { allow: 'DELETE' } })
  })

  it('answers Starlette\'s plain 500 when a route throws', async () => {
    const assets = new FakeAssets()
    assets.list = () => { throw new TypeError('unexpected') }
    await startAssetRoutes(assets)
    const failed = await call('GET', '/assets')
    expect([failed.status, failed.headers['content-type'], failed.body.toString()]).toEqual([500, 'text/plain; charset=utf-8', 'Internal Server Error'])
  })

  it('hands GET and HEAD requests that match no asset GET route to the shell file responder', async () => {
    const assets = new FakeAssets()
    assets.put('a1', 'clip.mp4', Buffer.from('x'))
    const shellPaths: string[] = []
    await startAssetRoutes(assets, async (request, response) => {
      shellPaths.push(`${request.method} ${request.url}`)
      response.writeHead(200, { 'content-type': 'text/javascript' })
      response.end('shell')
    })
    expect((await call('GET', '/assets/index-abc.js')).body.toString()).toBe('shell')
    expect((await call('HEAD', '/assets/fonts/a.woff2')).status).toBe(200)
    expect(shellPaths).toEqual(['GET /assets/index-abc.js', 'HEAD /assets/fonts/a.woff2'])
    expect(await callJson('GET', '/assets')).toMatchObject({ status: 200, json: { assets: [{ asset_id: 'a1' }] } })
    expect((await call('GET', '/assets/a1/content')).body.toString()).toBe('x')
    expect(await call('HEAD', '/assets')).toMatchObject({ status: 405, headers: { allow: 'GET' } })
    expect(await callJson('POST', '/assets/a1')).toMatchObject({ status: 405, headers: { allow: 'DELETE' } })
    expect(await callJson('DELETE', '/assets/index-abc.js')).toMatchObject({
      status: 404, json: { detail: 'Asset \'index-abc.js\' is unavailable. Select an asset from the library.' },
    })
  })

  it('serves a file of the built DSH page shell through the shell file responder', async () => {
    const serveShellFile = shellFileResponder()
    expect(serveShellFile).toBeDefined()
    const shellAssets = join(import.meta.dirname, '../../../../apps/web/dist/assets')
    const script = readdirSync(shellAssets).find(name => name.endsWith('.js'))
    expect(script).toBeDefined()
    await startAssetRoutes(new FakeAssets(), serveShellFile)
    const served = await call('GET', `/assets/${script!}`)
    expect([served.status, served.headers['content-type']]).toEqual([200, 'text/javascript; charset=utf-8'])
  })

  it('is registered by the service while the web server is available and removed when the service unloads', async () => {
    const root = await startWebServer()
    const fiber = root.plugin(DreamverseAssetsManager, { root: join(temporary.directory, 'library') })
    await fiber.await()
    await vi.waitFor(async () => { expect(await callJson('GET', '/assets')).toMatchObject({ status: 200, json: { assets: [] } }) })
    await fiber.dispose()
    const unrouted = await call('GET', '/assets')
    expect([unrouted.status, unrouted.body.length]).toEqual([404, 0])
  })
})

describe('/assets', () => {
  it('lists the library\'s files with their owner, creation time, and content URL', async () => {
    const assets = new FakeAssets()
    assets.put('a1', 'clip.mp4', Buffer.from('0123456789'))
    assets.put('p1', 'segment.mp4', Buffer.from('x'), 'video/mp4', projectOwner('project-a'))
    await startAssetRoutes(assets)
    expect(await callJson('GET', '/assets')).toEqual(expect.objectContaining({
      status: 200,
      json: { assets: [{
        asset_id: 'a1', owner: 'library', name: 'clip.mp4', media_type: 'video', mime_type: 'video/mp4', size_bytes: 10,
        width: 1344, height: 768, duration_sec: 5.5, created_at: '2026-10-02T00:00:00.000Z', content_url: '/assets/a1/content',
      }] },
    }))
  })

  it('adds a multipart upload with its name and type, and names an unnamed file Untitled asset', async () => {
    const assets = new FakeAssets()
    await startAssetRoutes(assets)
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    const uploaded = await call('POST', '/assets', multipart([{ name: 'file', filename: 'a.png', type: 'image/png', content }]))
    expect([uploaded.status, JSON.parse(uploaded.body.toString())]).toEqual([201, {
      asset_id: 'new', owner: 'library', name: 'a.png', media_type: 'image', mime_type: 'image/png', size_bytes: 6, width: 2,
      height: 1, duration_sec: null, created_at: '2026-10-02T00:00:00.000Z', content_url: '/assets/new/content',
    }])
    await call('POST', '/assets', multipart([{ name: 'file', filename: '', type: 'image/webp', content }]))
    expect(assets.added).toEqual([
      { content, name: 'a.png', mimeType: 'image/png' },
      { content, name: 'Untitled asset', mimeType: 'image/webp' },
    ])
  })

  it('maps upload rejections to 413 and 400 and invalid forms to FastAPI 422 and 400 responses', async () => {
    const assets = new FakeAssets()
    await startAssetRoutes(assets)
    const upload = multipart([{ name: 'file', filename: 'a.mp4', type: 'video/mp4', content: Buffer.from('x') }])
    assets.addFailure = new UploadTooLargeError('The video exceeds the 104857600 byte upload limit.')
    const tooLarge = await call('POST', '/assets', upload)
    expect([tooLarge.status, JSON.parse(tooLarge.body.toString())]).toEqual([413, { detail: 'The video exceeds the 104857600 byte upload limit.' }])
    assets.addFailure = new MediaValidationError('The uploaded file is empty.')
    const invalid = await call('POST', '/assets', upload)
    expect([invalid.status, JSON.parse(invalid.body.toString())]).toEqual([400, { detail: 'The uploaded file is empty.' }])

    const missing = { detail: [{ type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null }] }
    expect((await callJson('POST', '/assets', { file: 'x' })).json).toEqual(missing)
    expect(JSON.parse((await call('POST', '/assets', multipart([{ name: 'other', filename: 'a.png', content: Buffer.from('x') }]))).body.toString())).toEqual(missing)
    const text = await call('POST', '/assets', multipart([{ name: 'file', content: Buffer.from('text-value') }]))
    expect([text.status, JSON.parse(text.body.toString())]).toEqual([422, { detail: [{
      type: 'value_error', loc: ['body', 'file'], msg: 'Value error, Expected UploadFile, received: <class \'str\'>', input: 'text-value', ctx: { error: {} },
    }] }])
    expect(await callJson('POST', '/assets', 'x', 'multipart/form-data')).toMatchObject({ status: 400, json: { detail: 'Missing boundary in multipart.' } })
    expect(await callJson('POST', '/assets', 'not multipart', `multipart/form-data; boundary=${BOUNDARY}`))
      .toMatchObject({ status: 400, json: { detail: 'There was an error parsing the body' } })
  })

  it('serves content like Starlette FileResponse and releases the retained asset after the response', async () => {
    const assets = new FakeAssets()
    const content = Buffer.from('0123456789')
    assets.put('a1', 'clip.mp4', content)
    await startAssetRoutes(assets)
    const full = await call('GET', '/assets/a1/content')
    expect(full.status).toBe(200)
    expect(full.body).toEqual(content)
    expect(full.headers).toMatchObject({
      'content-type': 'video/mp4', 'content-length': '10', 'accept-ranges': 'bytes', 'content-disposition': 'inline; filename="clip.mp4"',
      etag: expect.stringMatching(/^"[0-9a-f]{32}"$/) as string,
      'last-modified': expect.stringMatching(/^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/) as string,
    })
    await vi.waitFor(() => { expect(assets.releases).toEqual(['a1']) })
    expect(assets.retentions).toEqual(['a1'])

    const ranged = await call('GET', '/assets/a1/content', { headers: { range: 'bytes=2-5' } })
    expect([ranged.status, ranged.headers['content-range'], ranged.headers['content-length'], ranged.body.toString()])
      .toEqual([206, 'bytes 2-5/10', '4', '2345'])
    const suffix = await call('GET', '/assets/a1/content', { headers: { range: 'bytes=-3' } })
    expect([suffix.status, suffix.headers['content-range'], suffix.body.toString()]).toEqual([206, 'bytes 7-9/10', '789'])
    const merged = await call('GET', '/assets/a1/content', { headers: { range: 'bytes=6-, 0-1, 1-3' } })
    expect([merged.status, merged.body.toString()]).toEqual([200, '0123456789'])
    const overlapping = await call('GET', '/assets/a1/content', { headers: { range: 'bytes=0-2, 1-4' } })
    expect([overlapping.status, overlapping.headers['content-range'], overlapping.body.toString()]).toEqual([206, 'bytes 0-4/10', '01234'])

    const unsatisfiable = await call('GET', '/assets/a1/content', { headers: { range: 'bytes=10-' } })
    expect([unsatisfiable.status, unsatisfiable.headers['content-range'], unsatisfiable.headers['content-type'], unsatisfiable.body.length])
      .toEqual([416, '*/10', 'text/plain; charset=utf-8', 0])
    for (const [range, message] of [['items=0-1', 'Only support bytes range'], ['bytes', 'Malformed range header.'], ['bytes=x-y', 'Range header: range must be requested'], ['bytes=5-2', 'Range header: start must be less than end']]) {
      const malformed = await call('GET', '/assets/a1/content', { headers: { range: range! } })
      expect([malformed.status, malformed.body.toString()]).toEqual([400, message])
    }

    const staleIfRange = await call('GET', '/assets/a1/content', { headers: { range: 'bytes=0-0', 'if-range': '"stale"' } })
    expect([staleIfRange.status, staleIfRange.body.toString()]).toEqual([200, '0123456789'])
    const currentIfRange = await call('GET', '/assets/a1/content', { headers: { range: 'bytes=0-0', 'if-range': full.headers.etag! } })
    expect([currentIfRange.status, currentIfRange.body.toString()]).toEqual([206, '0'])
    await vi.waitFor(() => { expect(assets.releases).toHaveLength(assets.retentions.length) })
  })

  it('names non-ASCII content with RFC 5987 filename*, answers 404 for an unknown asset, and releases after a disconnect', async () => {
    const assets = new FakeAssets()
    assets.put('a2', 'café clip.mp4', Buffer.from('x'))
    assets.put('big', 'big.mp4', Buffer.alloc(32 * 1024 * 1024))
    await startAssetRoutes(assets)
    expect((await call('GET', '/assets/a2/content')).headers['content-disposition']).toBe('inline; filename*=utf-8\'\'caf%C3%A9%20clip.mp4')
    expect(await callJson('GET', '/assets/missing/content')).toMatchObject({
      status: 404, json: { detail: 'Asset \'missing\' is unavailable. Select an asset from the library.' },
    })

    const request = httpRequest({ host: '127.0.0.1', port, path: '/assets/big/content', agent: false })
    request.end()
    const [response] = await once(request, 'response') as [NodeJS.ReadableStream]
    await once(response, 'data')
    request.destroy()
    await vi.waitFor(() => { expect(assets.releases).toEqual(['a2', 'big']) })
  })

  it('deletes an asset with 204 and answers 404 for an unknown asset', async () => {
    const assets = new FakeAssets()
    assets.put('a1', 'clip.mp4', Buffer.from('x'))
    await startAssetRoutes(assets)
    const deleted = await call('DELETE', '/assets/a1')
    expect([deleted.status, deleted.body.length, assets.records.has('a1')]).toEqual([204, 0, false])
    expect(await callJson('DELETE', '/assets/a1')).toMatchObject({
      status: 404, json: { detail: 'Asset \'a1\' is unavailable. Select an asset from the library.' },
    })
  })

  it('answers 409 for a project\'s file, which goes with its project, and serves that file\'s content', async () => {
    const assets = new FakeAssets()
    assets.put('p1', 'frame.png', Buffer.from('png bytes'), 'image/png', projectOwner('project-a'))
    await startAssetRoutes(assets)
    expect(await callJson('DELETE', '/assets/p1')).toMatchObject({ status: 409, json: { detail: PROJECT_FILE_DELETE_DETAIL } })
    expect(PROJECT_FILE_DELETE_DETAIL).toBe('This file belongs to a project. Delete the project to delete its files.')
    expect(assets.records.has('p1')).toBe(true)
    const content = await call('GET', '/assets/p1/content')
    expect([content.status, content.body.toString()]).toEqual([200, 'png bytes'])
  })
})
