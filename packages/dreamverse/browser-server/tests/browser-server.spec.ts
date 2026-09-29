/**
 * The browser server plugin, mounted through Cordis with fake generation, asset, project, and prompt enhancer
 * services, serves the reference project protocol and browser HTTP routes.
 */
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { AssetNotFoundError, MediaValidationError, UploadTooLargeError } from '@dreamverse/assets-manager'
import { ProjectValidationError } from '@dreamverse/project'
import { PromptRuntimeError, PromptValueError } from '@dreamverse/prompt-enhancer'
import WebSocket from 'ws'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as browserServer from '../src/index.ts'
import type {
  AssetRecord, CreationConfig, DreamverseAssetsManager, DreamverseGeneration, DreamverseProjects, DreamversePromptEnhancer,
  ModelFacts, Project, ProjectInit, ProjectSocket, PromptConfigUpdate,
} from '../src/dependencies.ts'

const PORT = 18322
const TEMP_PARENT = '/mnt/lustre/vlm-d1su/codes/fv-hub/fastvideo_ds8_dreamverse_dev/run/port-dreamverse-v1/browser-server'
mkdirSync(TEMP_PARENT, { recursive: true })
const tempRoot = mkdtempSync(join(TEMP_PARENT, 'spec-'))
afterAll(() => { rmSync(tempRoot, { recursive: true, force: true }) })

const CREATION_CONFIG: CreationConfig = {
  model_id: 'h3-ref2va', generation_mode: 'ref2va', aspect_ratio: '16:9', resolution: '480p',
  segment_count: 3, segment_duration_sec: 5,
}
const GPU_ASSIGNED = { type: 'gpu_assigned', creation_config: CREATION_CONFIG }
const MODEL_FACTS: ModelFacts = {
  modelId: 'h3-ref2va',
  generationModes: { ref2va: 'reference_images', a2v: 'text' },
  unsupportedGenerationModes: { fl2va: 'First/last frame mode (FL2VA) is not supported yet.' },
  aspectRatios: ['9:16', '16:9'],
  resolutions: ['720p', '480p'],
  minSegmentDurationSec: 5,
  maxSegmentDurationSec: 15,
  maxReferenceImages: 9,
  usesPreviousFrame: false,
}
const UPLOAD_POLICY = { image: { mime_types: ['image/png'], max_bytes: 15 } }
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?\+00:00$/

/** An ordered record of steps across the fake project and project log. */
let steps: string[] = []

/** A project that serves actions until closed, like the reference generation loop. */
class FakeProject implements Project {
  readonly videoGenerationSettings = CREATION_CONFIG
  readonly commands: Array<Record<string, unknown>> = []
  serve: (socket: ProjectSocket) => Promise<void> = () => this.closed
  private close!: () => void
  /** Settles when the connection closes the project, which ends a real project's generation loop. */
  readonly closed = new Promise<void>((resolve) => { this.close = resolve })

  constructor(readonly projectId: string, readonly socket: ProjectSocket) {}

  async processBrowserCommand(payload: Record<string, unknown>): Promise<void> {
    this.commands.push(payload)
  }

  async processQueuedGenerationActions(): Promise<void> {
    steps.push('generation started')
    await this.serve(this.socket)
  }

  async closeAndWaitForGeneration(): Promise<void> {
    steps.push('project closed')
    this.close()
  }
}

/** An asset library over files in the spec's temporary directory that records retention and additions. */
class FakeAssets implements DreamverseAssetsManager {
  readonly records = new Map<string, AssetRecord>()
  readonly added: Array<{ content: Buffer; name: string; mimeType: string }> = []
  readonly retentions: string[] = []
  readonly releases: string[] = []
  addFailure: Error | undefined

  /** Publish a file under the temporary directory as one asset. */
  put(assetId: string, name: string, content: Buffer, mimeType = 'video/mp4'): AssetRecord {
    const filePath = join(tempRoot, `asset-${assetId}`)
    writeFileSync(filePath, content)
    const record: AssetRecord = {
      assetId, name, mediaType: 'video', mimeType, filePath, sizeBytes: content.length, width: 1344, height: 768, durationSec: 5.5,
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
    return [...this.records.values()]
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

  uploadPolicy(): Record<string, unknown> {
    return UPLOAD_POLICY
  }

  private get(assetId: string): AssetRecord {
    const record = this.records.get(assetId)
    if (!record) throw new AssetNotFoundError(`Asset '${assetId}' is unavailable. Select an asset from the library.`)
    return record
  }
}

/** The fake services and their recorded calls. */
interface Fakes {
  generation: DreamverseGeneration & { readiness: () => Promise<{ ready: boolean; detail: string | null }> }
  assets: FakeAssets
  projects: DreamverseProjects & { created: FakeProject[]; logged: Array<[string, string, Record<string, unknown> | undefined]> }
  enhancer: DreamversePromptEnhancer & { saved: PromptConfigUpdate[] }
  createProject: ReturnType<typeof vi.fn<(init: ProjectInit) => Promise<FakeProject>>>
  saveFailure: Error | undefined
}

/** Build recording fakes: a ready generation backend, an empty asset library, and projects that serve until closed. */
function makeFakes(): Fakes {
  const created: FakeProject[] = []
  const logged: Fakes['projects']['logged'] = []
  const saved: PromptConfigUpdate[] = []
  const fakes: Fakes = {
    saveFailure: undefined,
    createProject: vi.fn(async (init: ProjectInit) => {
      const project = new FakeProject(init.projectId, init.socket)
      created.push(project)
      return project
    }),
    generation: {
      readiness: async () => ({ ready: true, detail: null }),
      model: async () => MODEL_FACTS,
      ready: () => fakes.generation.readiness(),
    },
    assets: new FakeAssets(),
    projects: {
      created,
      logged,
      createProject: init => fakes.createProject(init),
      logProjectEvent: async (projectId, event, payload) => {
        steps.push(`logged ${event}`)
        logged.push([projectId, event, payload])
      },
    },
    enhancer: {
      saved,
      getPromptConfig: () => ({ rewrite_model: 'gpt-oss-120b', rewrite_temperature: 0.7 }),
      savePromptConfig: (update) => {
        if (fakes.saveFailure) throw fakes.saveFailure
        saved.push(update)
        return { rewrite_model: update.rewrite_model ?? 'gpt-oss-120b', rewrite_temperature: 0.7 }
      },
    },
  }
  return fakes
}

const roots: Context[] = []
const clients: WebSocket[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate()
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  steps = []
})

/** Mount the plugin with fake services and wait until it listens. */
async function startBrowserServer(fakes: Fakes, config: Partial<browserServer.Config> = {}): Promise<Fiber> {
  const root = new Context()
  roots.push(root)
  root.provide('dreamverseGeneration', fakes.generation)
  root.provide('dreamverseAssetsManager', fakes.assets)
  root.provide('dreamverseProjects', fakes.projects)
  root.provide('dreamversePromptEnhancer', fakes.enhancer)
  const fiber = root.plugin(browserServer, {
    host: '127.0.0.1', port: PORT, devtoolsEnabled: false, curatedPresetsFilePath: join(tempRoot, 'unused.json'), ...config,
  })
  await fiber.await()
  return fiber
}

/** A browser-side socket that buffers received JSON messages and binary chunks in order. */
class BrowserClient {
  readonly closed: Promise<{ code: number; reason: string }>
  private readonly received: Array<unknown> = []
  private waiter: ((message: unknown) => void) | undefined

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data: Buffer, isBinary) => {
      const message = isBinary ? data : JSON.parse(data.toString('utf8'))
      const waiter = this.waiter
      this.waiter = undefined
      if (waiter) waiter(message)
      else this.received.push(message)
    })
    this.closed = new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  }

  static async open(): Promise<BrowserClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    clients.push(socket)
    await once(socket, 'open')
    return new BrowserClient(socket)
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message))
  }

  next(): Promise<unknown> {
    if (this.received.length > 0) return Promise.resolve(this.received.shift())
    return new Promise((resolve) => { this.waiter = resolve })
  }
}

/** Send one HTTP request on a fresh connection and read the complete response. */
async function call(method: string, path: string, options: { headers?: OutgoingHttpHeaders; chunks?: Buffer[] } = {}) {
  return await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: PORT, method, path, headers: options.headers ?? {}, agent: false }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }))
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
  return { status: response.status, headers: response.headers, json: JSON.parse(response.body.toString('utf8')) as unknown }
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

const PROJECT_INIT = { type: 'project_init_v1', generation_mode: 'ref2va', curated_prompts: ['a cat'] }

describe('/ws project protocol', () => {
  it('rejects a first message other than project_init_v1 with close code 1003 and the reference reason', async () => {
    const fakes = makeFakes()
    await startBrowserServer(fakes)
    const client = await BrowserClient.open()
    client.send({ type: 'append_prompt' })
    expect(await client.next()).toEqual({ type: 'error', message: 'The first message must be project_init_v1.' })
    expect(await client.closed).toEqual({ code: 1003, reason: 'Invalid project initialization' })
    expect(fakes.createProject).not.toHaveBeenCalled()
    expect(fakes.projects.logged.map(([, event]) => event)).toEqual(['websocket_connected'])
  })

  it('reports a createProject rejection and closes with code 1003 and its reason', async () => {
    const fakes = makeFakes()
    const error = new ProjectValidationError('segment_count must be from 1 to 6.', 'Invalid creation config')
    fakes.createProject.mockRejectedValueOnce(error)
    await startBrowserServer(fakes)
    const client = await BrowserClient.open()
    client.send(PROJECT_INIT)
    expect(await client.next()).toEqual({ type: 'error', message: error.message })
    expect(await client.closed).toEqual({ code: 1003, reason: error.reason })
    expect(steps).not.toContain('generation started')
  })

  it('sends gpu_assigned right after project creation, logs it without a payload, then generates while admitting commands', async () => {
    const fakes = makeFakes()
    await startBrowserServer(fakes)
    const client = await BrowserClient.open()
    client.send(PROJECT_INIT)
    expect(await client.next()).toEqual(GPU_ASSIGNED)

    const [project] = fakes.projects.created
    expect(fakes.createProject.mock.calls[0]![0].payload).toEqual(PROJECT_INIT)
    expect(project!.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    await vi.waitFor(() => expect(steps).toEqual(['logged websocket_connected', 'logged gpu_assigned', 'generation started']))
    expect(fakes.projects.logged).toEqual([
      [project!.projectId, 'websocket_connected', undefined],
      [project!.projectId, 'gpu_assigned', undefined],
    ])

    client.send({ type: 'append_prompt', prompt: 'a dog' })
    client.send({ type: 'leave' })
    expect(await client.closed).toEqual({ code: 1000, reason: '' })
    expect(project!.commands).toEqual([{ type: 'append_prompt', prompt: 'a dog' }])
    expect(steps.at(-1)).toBe('project closed')
  })

  it('answers a second project_init_v1 with the reference error and keeps serving the project', async () => {
    const fakes = makeFakes()
    await startBrowserServer(fakes)
    const client = await BrowserClient.open()
    client.send(PROJECT_INIT)
    await client.next()
    client.send(PROJECT_INIT)
    expect(await client.next()).toEqual({
      type: 'error',
      message: 'This connection already has a project. Open a separate connection for another project.',
    })
    client.send({ type: 'set_enhancement', enabled: false })
    client.send({ type: 'leave' })
    await client.closed
    expect(fakes.createProject).toHaveBeenCalledOnce()
    expect(fakes.projects.created[0]!.commands).toEqual([{ type: 'set_enhancement', enabled: false }])
  })

  it('reports an unexpected generation failure as AV streaming failed and closes the project', async () => {
    const fakes = makeFakes()
    await startBrowserServer(fakes)
    fakes.createProject.mockImplementationOnce(async (init) => {
      const project = new FakeProject(init.projectId, init.socket)
      project.serve = async () => { throw new Error('Segment 0 stream ended without a successful worker reply') }
      fakes.projects.created.push(project)
      return project
    })
    const client = await BrowserClient.open()
    client.send(PROJECT_INIT)
    await client.next()
    expect(await client.next()).toEqual({
      type: 'error',
      message: 'AV streaming failed: Segment 0 stream ended without a successful worker reply',
    })
    expect(await client.closed).toEqual({ code: 1000, reason: '' })
    expect(steps).toContain('project closed')
  })

  it('reports a malformed command with the reference exception text', async () => {
    await startBrowserServer(makeFakes())
    const client = await BrowserClient.open()
    client.send(PROJECT_INIT)
    await client.next()
    client.send([1, 2])
    expect(await client.next()).toEqual({ type: 'error', message: 'AV streaming failed: \'list\' object has no attribute \'get\'' })
    await client.closed
  })

  it('closes the project quietly when the browser disconnects during generation', async () => {
    const fakes = makeFakes()
    await startBrowserServer(fakes)
    const client = await BrowserClient.open()
    client.send(PROJECT_INIT)
    await client.next()
    await vi.waitFor(() => expect(steps).toContain('generation started'))
    client.socket.close()
    await client.closed
    await vi.waitFor(() => expect(steps.at(-1)).toBe('project closed'))
  })

  it('delivers the project socket JSON and binary sends to the browser in call order', async () => {
    const fakes = makeFakes()
    fakes.createProject.mockImplementationOnce(async (init) => {
      const project = new FakeProject(init.projectId, init.socket)
      project.serve = async (socket) => {
        await Promise.all([
          socket.sendJson({ type: 'media_init', segment_idx: 0 }),
          socket.sendBytes(Buffer.from([1, 2, 3])),
          socket.sendJson({ type: 'media_segment_complete', segment_idx: 0 }),
        ])
        await project.closed
      }
      return project
    })
    await startBrowserServer(fakes)
    const client = await BrowserClient.open()
    client.send(PROJECT_INIT)
    expect(await client.next()).toEqual(GPU_ASSIGNED)
    expect(await client.next()).toEqual({ type: 'media_init', segment_idx: 0 })
    expect(await client.next()).toEqual(Buffer.from([1, 2, 3]))
    expect(await client.next()).toEqual({ type: 'media_segment_complete', segment_idx: 0 })
  })

  it('closes WebSocket upgrades on paths other than /ws', async () => {
    await startBrowserServer(makeFakes())
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/v1/generation`)
    clients.push(socket)
    const [error] = await once(socket, 'error') as [Error]
    expect(error.message).toMatch(/socket hang up/)
  })
})

describe('routing', () => {
  it('answers FastAPI 404 for unknown paths and plain HTTP /ws, and 405 with Allow for other methods', async () => {
    await startBrowserServer(makeFakes())
    for (const path of ['/status', '/internal/monitor/capacity', '/lora/options', '/ws', '/assets/a%2Fb']) {
      expect(await callJson('GET', path)).toMatchObject({ status: 404, json: { detail: 'Not Found' } })
    }
    const head = await call('HEAD', '/healthz')
    expect([head.status, head.headers.allow]).toEqual([405, 'GET'])
    expect(await callJson('PUT', '/assets')).toMatchObject({ status: 405, headers: { allow: 'GET' }, json: { detail: 'Method Not Allowed' } })
    expect(await callJson('POST', '/assets/a1')).toMatchObject({ status: 405, headers: { allow: 'DELETE' } })
  })
})

describe('health and readiness', () => {
  it('reports the reference health payload on /health and /healthz', async () => {
    await startBrowserServer(makeFakes())
    for (const path of ['/health', '/healthz']) {
      const { status, json } = await callJson('GET', path)
      expect([status, json]).toEqual([200, { status: 'ok', service: 'ltx2-streaming-backend', ts: expect.stringMatching(TS) }])
    }
  })

  it('reports generation backend readiness, its warming detail, and an unreachable backend', async () => {
    const fakes = makeFakes()
    await startBrowserServer(fakes)
    expect(await callJson('GET', '/readyz')).toMatchObject({
      status: 200, json: { status: 'ready', service: 'ltx2-streaming-backend', ts: expect.stringMatching(TS) },
    })
    fakes.generation.readiness = async () => ({ ready: false, detail: 'Worker is initializing.' })
    const warming = await callJson('GET', '/readyz')
    expect([warming.status, warming.json]).toEqual([503, {
      status: 'warming', service: 'ltx2-streaming-backend', ts: expect.stringMatching(TS), detail: 'Worker is initializing.',
    }])
    fakes.generation.readiness = async () => { throw new TypeError('fetch failed') }
    expect(await callJson('GET', '/readyz')).toMatchObject({
      status: 503, json: { status: 'warming', detail: 'Generation backend is unreachable.' },
    })
  })
})

describe('/creation-capabilities', () => {
  it('reports the reference lobby capabilities from the model facts and the upload policy', async () => {
    const fakes = makeFakes()
    await startBrowserServer(fakes)
    const choices = {
      generation_modes: ['a2v', 'ref2va'],
      aspect_ratios: ['16:9', '9:16'],
      resolutions: ['480p', '720p'],
      min_segment_duration_sec: 5,
      max_segment_duration_sec: 15,
      unsupported_generation_modes: { fl2va: 'First/last frame mode (FL2VA) is not supported yet.' },
      reference_inputs: { media_types: ['image'], max_count: 9, conditioning: 'reference' },
    }
    const { status, json } = await callJson('GET', '/creation-capabilities')
    expect(status).toBe(200)
    expect(JSON.stringify(json)).toBe(JSON.stringify({
      model_ids: ['h3-ref2va'],
      segment_counts: [1, 2, 3, 4, 5, 6],
      asset_upload: UPLOAD_POLICY,
      models: { 'h3-ref2va': choices },
      ...choices,
    }))
    fakes.generation.model = async () => { throw new TypeError('fetch failed') }
    expect(await callJson('GET', '/creation-capabilities')).toMatchObject({ status: 503, json: { detail: 'Generation backend is unreachable.' } })
  })
})

describe('/assets', () => {
  it('lists assets with their content URLs', async () => {
    const fakes = makeFakes()
    fakes.assets.put('a1', 'clip.mp4', Buffer.from('0123456789'))
    await startBrowserServer(fakes)
    expect(await callJson('GET', '/assets')).toMatchObject({
      status: 200,
      json: { assets: [{
        asset_id: 'a1', name: 'clip.mp4', media_type: 'video', mime_type: 'video/mp4', size_bytes: 10, width: 1344,
        height: 768, duration_sec: 5.5, content_url: '/assets/a1/content',
      }] },
    })
  })

  it('adds a multipart upload with its name and type, and names an unnamed file Untitled asset', async () => {
    const fakes = makeFakes()
    await startBrowserServer(fakes)
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    const uploaded = await call('POST', '/assets', multipart([{ name: 'file', filename: 'a.png', type: 'image/png', content }]))
    expect([uploaded.status, JSON.parse(uploaded.body.toString())]).toEqual([201, {
      asset_id: 'new', name: 'a.png', media_type: 'image', mime_type: 'image/png', size_bytes: 6, width: 2, height: 1,
      duration_sec: null, content_url: '/assets/new/content',
    }])
    await call('POST', '/assets', multipart([{ name: 'file', filename: '', type: 'image/webp', content }]))
    expect(fakes.assets.added).toEqual([
      { content, name: 'a.png', mimeType: 'image/png' },
      { content, name: 'Untitled asset', mimeType: 'image/webp' },
    ])
  })

  it('maps upload rejections to 413 and 400 and invalid forms to FastAPI 422 and 400 responses', async () => {
    const fakes = makeFakes()
    await startBrowserServer(fakes)
    const upload = multipart([{ name: 'file', filename: 'a.mp4', type: 'video/mp4', content: Buffer.from('x') }])
    fakes.assets.addFailure = new UploadTooLargeError('The video exceeds the 104857600 byte upload limit.')
    const tooLarge = await call('POST', '/assets', upload)
    expect([tooLarge.status, JSON.parse(tooLarge.body.toString())]).toEqual([413, { detail: 'The video exceeds the 104857600 byte upload limit.' }])
    fakes.assets.addFailure = new MediaValidationError('The uploaded file is empty.')
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
    const fakes = makeFakes()
    const content = Buffer.from('0123456789')
    fakes.assets.put('a1', 'clip.mp4', content)
    await startBrowserServer(fakes)
    const full = await call('GET', '/assets/a1/content')
    expect(full.status).toBe(200)
    expect(full.body).toEqual(content)
    expect(full.headers).toMatchObject({
      'content-type': 'video/mp4', 'content-length': '10', 'accept-ranges': 'bytes', 'content-disposition': 'inline; filename="clip.mp4"',
      etag: expect.stringMatching(/^"[0-9a-f]{32}"$/), 'last-modified': expect.stringMatching(/^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/),
    })
    await vi.waitFor(() => expect(fakes.assets.releases).toEqual(['a1']))
    expect(fakes.assets.retentions).toEqual(['a1'])

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
    await vi.waitFor(() => expect(fakes.assets.releases).toHaveLength(fakes.assets.retentions.length))
  })

  it('names non-ASCII content with RFC 5987 filename*, answers 404 for an unknown asset, and releases after a disconnect', async () => {
    const fakes = makeFakes()
    fakes.assets.put('a2', 'café clip.mp4', Buffer.from('x'))
    fakes.assets.put('big', 'big.mp4', Buffer.alloc(32 * 1024 * 1024))
    await startBrowserServer(fakes)
    expect((await call('GET', '/assets/a2/content')).headers['content-disposition']).toBe('inline; filename*=utf-8\'\'caf%C3%A9%20clip.mp4')
    expect(await callJson('GET', '/assets/missing/content')).toMatchObject({
      status: 404, json: { detail: 'Asset \'missing\' is unavailable. Select an asset from the library.' },
    })

    const request = httpRequest({ host: '127.0.0.1', port: PORT, path: '/assets/big/content', agent: false })
    request.end()
    const [response] = await once(request, 'response') as [NodeJS.ReadableStream]
    await once(response, 'data')
    request.destroy()
    await vi.waitFor(() => expect(fakes.assets.releases).toEqual(['a2', 'big']))
  })

  it('deletes an asset with 204 and answers 404 for an unknown asset', async () => {
    const fakes = makeFakes()
    fakes.assets.put('a1', 'clip.mp4', Buffer.from('x'))
    await startBrowserServer(fakes)
    const deleted = await call('DELETE', '/assets/a1')
    expect([deleted.status, deleted.body.length, fakes.assets.records.has('a1')]).toEqual([204, 0, false])
    expect(await callJson('DELETE', '/assets/a1')).toMatchObject({
      status: 404, json: { detail: 'Asset \'a1\' is unavailable. Select an asset from the library.' },
    })
  })
})

describe('curated presets', () => {
  /** Write catalog files under a fresh directory and return their paths. */
  function catalogs(overlay: unknown, fallback: unknown): { overlayPath: string; fallbackPath: string } {
    const directory = mkdtempSync(join(tempRoot, 'catalog-'))
    const overlayPath = join(directory, 'prompts.local', 'presets.json')
    const fallbackPath = join(directory, 'prompts', 'presets.json')
    for (const [path, value] of [[overlayPath, overlay], [fallbackPath, fallback]] as const) {
      if (value === undefined) continue
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
    }
    return { overlayPath, fallbackPath }
  }

  /** The plugin config that serves the curated preset routes over the given catalogs. */
  function devtoolsConfig(overlayPath: string, fallbackPath: string | null): Partial<browserServer.Config> {
    return { devtoolsEnabled: true, curatedPresetsFilePath: overlayPath, curatedPresetsFallbackFilePath: fallbackPath }
  }

  it('serves no curated preset routes without developer tools', async () => {
    const { overlayPath } = catalogs([], undefined)
    await startBrowserServer(makeFakes(), { curatedPresetsFilePath: overlayPath })
    expect(await callJson('GET', '/curated-presets')).toMatchObject({ status: 404, json: { detail: 'Not Found' } })
    expect(await callJson('POST', '/curated-presets/append', {})).toMatchObject({ status: 404 })
  })

  it('merges the fallback catalog with the overlay catalog by case-insensitive ID', async () => {
    const { overlayPath, fallbackPath } = catalogs(
      [{ id: 'Story ', label: 'overlay' }, 'not an object', { id: '  ' }, { id: null, label: 'none' }],
      [{ id: 'story', label: 'fallback' }, { id: 'other', label: 'kept' }],
    )
    await startBrowserServer(makeFakes(), devtoolsConfig(overlayPath, fallbackPath))
    expect(await callJson('GET', '/curated-presets')).toEqual({
      status: 200,
      headers: expect.anything(),
      json: {
        presets: [{ id: 'Story ', label: 'overlay' }, { id: 'other', label: 'kept' }, { id: null, label: 'none' }],
        count: 3,
        file_path: overlayPath,
        fallback_file_path: fallbackPath,
      },
    })
  })

  it('reports catalog errors as 500 with the reference detail and absent catalogs as empty', async () => {
    const invalid = catalogs('{bad', undefined)
    await startBrowserServer(makeFakes(), devtoolsConfig(invalid.overlayPath, invalid.fallbackPath))
    expect(await callJson('GET', '/curated-presets')).toMatchObject({ status: 500, json: { detail: `Invalid JSON in curated presets file: ${invalid.overlayPath}` } })
    writeFileSync(invalid.overlayPath, '{"id": "x"}')
    expect(await callJson('GET', '/curated-presets')).toMatchObject({ status: 500, json: { detail: `Curated presets file must contain a JSON array: ${invalid.overlayPath}` } })
    rmSync(invalid.overlayPath)
    expect(await callJson('GET', '/curated-presets')).toMatchObject({ status: 200, json: { presets: [], count: 0 } })
  })

  it('appends a sanitized preset to the overlay catalog and rejects duplicate IDs with 409', async () => {
    const { overlayPath, fallbackPath } = catalogs(undefined, [{ id: 'city_story', label: 'fallback' }])
    await startBrowserServer(makeFakes(), devtoolsConfig(overlayPath, fallbackPath))
    const appended = await callJson('POST', '/curated-presets/append', { id: ' Café Story! ', label: ' Café ', segment_prompts: [' one ', '', 'two', '　'] })
    const preset = { id: 'caf_story', label: 'Café', segment_prompts: ['one', 'two'] }
    expect(appended).toMatchObject({
      status: 200,
      json: { type: 'curated_preset_appended', preset, count: 2, file_path: overlayPath, fallback_file_path: fallbackPath },
    })
    expect(readFileSync(overlayPath, 'utf8')).toBe(`${JSON.stringify([preset], null, 2)}\n`)
    for (const id of ['CAF STORY', 'City Story']) {
      const duplicate = await callJson('POST', '/curated-presets/append', { id, label: 'x', segment_prompts: ['a', 'b'] })
      expect(duplicate).toMatchObject({ status: 409, json: { detail: `Preset id already exists in curated presets file: ${id.toLowerCase().replace(' ', '_')}` } })
    }
  })

  it('validates the append body with FastAPI 422 details and the reference 400 checks', async () => {
    const { overlayPath } = catalogs(undefined, undefined)
    await startBrowserServer(makeFakes(), devtoolsConfig(overlayPath, null))
    const body = { label: 1, segment_prompts: ['a', 2] }
    expect(await callJson('POST', '/curated-presets/append', body)).toMatchObject({ status: 422, json: { detail: [
      { type: 'missing', loc: ['body', 'id'], msg: 'Field required', input: body },
      { type: 'string_type', loc: ['body', 'label'], msg: 'Input should be a valid string', input: 1 },
      { type: 'string_type', loc: ['body', 'segment_prompts', 1], msg: 'Input should be a valid string', input: 2 },
    ] } })
    expect((await callJson('POST', '/curated-presets/append', { id: 'x', label: 'y', segment_prompts: 'ab' })).json).toEqual({ detail: [
      { type: 'list_type', loc: ['body', 'segment_prompts'], msg: 'Input should be a valid list', input: 'ab' },
    ] })
    expect(await callJson('POST', '/curated-presets/append', { id: 'x', label: ' ', segment_prompts: ['a', 'b'] }))
      .toMatchObject({ status: 400, json: { detail: 'label must be non-empty.' } })
    expect(await callJson('POST', '/curated-presets/append', { id: 'x', label: 'y', segment_prompts: ['a', ' '] }))
      .toMatchObject({ status: 400, json: { detail: 'segment_prompts must contain at least 2 non-empty prompts.' } })
    expect(await callJson('POST', '/curated-presets/append', '{"id": "x", "label": "\\ud800", "segment_prompts": ["a", "b"]}'))
      .toMatchObject({ status: 400, json: { detail: 'label and segment_prompts must contain valid UTF-8 text.' } })
  })
})

describe('/prompt-system-config', () => {
  it('reads and saves the prompt configuration with null for absent fields', async () => {
    const fakes = makeFakes()
    await startBrowserServer(fakes)
    expect(await callJson('GET', '/prompt-system-config')).toMatchObject({
      status: 200, json: { rewrite_model: 'gpt-oss-120b', rewrite_temperature: 0.7 },
    })
    const saved = await callJson('POST', '/prompt-system-config', { rewrite_model: 'm2', rewrite_temperature: '0.5', extra: 1 })
    expect(saved).toMatchObject({ status: 200, json: { rewrite_model: 'm2', rewrite_temperature: 0.7 } })
    expect(fakes.enhancer.saved).toEqual([{
      next_segment_system_prompt: null, auto_extension_system_prompt: null, rewrite_window_system_prompt: null,
      rewrite_user_system_prompt: null, ref2va_system_prompt: null, rewrite_model: 'm2', rewrite_temperature: 0.5,
    }])
  })

  it('answers FastAPI request validation errors with 422 detail lists', async () => {
    await startBrowserServer(makeFakes())
    expect((await callJson('POST', '/prompt-system-config', { next_segment_system_prompt: true, rewrite_model: 3 })).json).toEqual({
      detail: [
        { type: 'string_type', loc: ['body', 'next_segment_system_prompt'], msg: 'Input should be a valid string', input: true },
        { type: 'string_type', loc: ['body', 'rewrite_model'], msg: 'Input should be a valid string', input: 3 },
      ],
    })
    expect(await callJson('POST', '/prompt-system-config', { rewrite_temperature: 'abc' })).toEqual({
      status: 422,
      headers: expect.anything(),
      json: { detail: [{ type: 'float_parsing', loc: ['body', 'rewrite_temperature'], msg: 'Input should be a valid number, unable to parse string as a number', input: 'abc' }] },
    })
    expect((await callJson('POST', '/prompt-system-config', { rewrite_temperature: [1] })).json).toEqual({
      detail: [{ type: 'float_type', loc: ['body', 'rewrite_temperature'], msg: 'Input should be a valid number', input: [1] }],
    })
    expect((await callJson('POST', '/prompt-system-config', [1, 2])).json).toEqual({
      detail: [{ type: 'model_attributes_type', loc: ['body'], msg: 'Input should be a valid dictionary or object to extract fields from', input: [1, 2] }],
    })
    expect((await callJson('POST', '/prompt-system-config', '{"rewrite_model": "m"}', 'text/plain')).json).toEqual({
      detail: [{ type: 'model_attributes_type', loc: ['body'], msg: 'Input should be a valid dictionary or object to extract fields from', input: '{"rewrite_model": "m"}' }],
    })
    expect((await callJson('POST', '/prompt-system-config')).json).toEqual({
      detail: [{ type: 'missing', loc: ['body'], msg: 'Field required', input: null }],
    })
    const invalidJson = await callJson('POST', '/prompt-system-config', '{bad json')
    expect(invalidJson.status).toBe(422)
    expect(invalidJson.json).toMatchObject({ detail: [{ type: 'json_invalid', loc: ['body', 1], msg: 'JSON decode error', input: {} }] })
  })

  it('maps save failures to 400, 500 with detail, and plain 500, and other methods to 405', async () => {
    const fakes = makeFakes()
    await startBrowserServer(fakes)
    fakes.saveFailure = new PromptValueError('rewrite_model cannot be empty.')
    expect(await callJson('POST', '/prompt-system-config', { rewrite_model: ' ' })).toMatchObject({ status: 400, json: { detail: 'rewrite_model cannot be empty.' } })
    fakes.saveFailure = new PromptRuntimeError('Failed to save next-segment system prompt: /x.md')
    expect(await callJson('POST', '/prompt-system-config', {})).toMatchObject({ status: 500, json: { detail: 'Failed to save next-segment system prompt: /x.md' } })
    fakes.saveFailure = new TypeError('unexpected')
    const plain = await call('POST', '/prompt-system-config', { headers: { 'content-type': 'application/json' }, chunks: [Buffer.from('{}')] })
    expect([plain.status, plain.headers['content-type'], plain.body.toString()]).toEqual([500, 'text/plain; charset=utf-8', 'Internal Server Error'])
    const put = await callJson('PUT', '/prompt-system-config')
    expect([put.status, put.headers.allow, put.json]).toEqual([405, 'GET', { detail: 'Method Not Allowed' }])
  })
})

it('closes the listener and every project socket when the plugin unloads', async () => {
  const fakes = makeFakes()
  const fiber = await startBrowserServer(fakes)
  const client = await BrowserClient.open()
  client.send(PROJECT_INIT)
  await client.next()
  await fiber.dispose()
  expect((await client.closed).code).toBe(1006)
  expect(steps).toContain('project closed')
  await expect(call('GET', '/healthz')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
})
