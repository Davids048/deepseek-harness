/**
 * The project controller plugin, mounted through Cordis on the DSH web server with fake generation, asset, and project
 * services, serves the reference project protocol and the health, readiness, and creation capability routes. The fake
 * projects take their leases from a real `dreamverseProjectStore`, so a takeover runs through the store.
 */
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { ProjectValidationError } from '@dreamverse/project'
import DreamverseProjectStore, { ProjectInUseError } from '@dreamverse/project-store'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as projectController from '../src/index.ts'
import type {
  CreationConfig, DreamverseAssetsManager, DreamverseGeneration, DreamverseProjects, ModelFacts, Project, ProjectId, ProjectInit,
  ProjectOpenInit, ProjectSocket,
} from '../src/dependencies.ts'

/** The web server's OS-assigned port for the current test. */
let port = 0

const CREATION_CONFIG: CreationConfig = {
  model_id: 'h3-ref2va', generation_mode: 'ref2va', aspect_ratio: '16:9', resolution: '480p',
  segment_count: 3, segment_duration_sec: 5,
}
const GPU_ASSIGNED = { type: 'gpu_assigned', project_id: expect.any(String) as string, creation_config: CREATION_CONFIG }
const MODEL_FACTS: ModelFacts = {
  modelId: 'h3-ref2va',
  name: 'Ref2VA',
  generationModes: { ref2va: 'reference_images', a2v: 'text' },
  unsupportedGenerationModes: { fl2va: 'First/last frame mode (FL2VA) is not supported yet.' },
  aspectRatios: ['9:16', '16:9'],
  resolutions: ['720p', '480p'],
  minSegmentDurationSec: 5,
  maxSegmentDurationSec: 15,
  maxReferenceImages: 9,
  maxReferenceAspectRatio: null,
  usesPreviousFrame: false,
  frameSizes: {},
  numFramesByDurationSec: {},
  referenceLabels: [],
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

  /**
   * @param projectId - the stored project's ID.
   * @param socket - the browser socket.
   * @param release - gives up the project's lease in the store.
   */
  constructor(readonly projectId: ProjectId, readonly socket: ProjectSocket, private readonly release: () => void) {}

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

  releaseLease(): void {
    steps.push(`released ${this.projectId}`)
    this.release()
  }
}

/** The fake services and their recorded calls. */
interface Fakes {
  generation: DreamverseGeneration & { readiness: () => Promise<{ ready: boolean; detail: string | null }> }
  /** The upload policy, plus the member that the project store calls when it deletes a project. */
  assets: DreamverseAssetsManager & { deleteOwnedBy(owner: string): void }
  projects: DreamverseProjects & {
    created: FakeProject[]
    logged: Array<[string, string, Record<string, unknown> | undefined]>
  }
  /** The project store that `startProjectController` mounts. */
  store(): DreamverseProjectStore
  createProject: ReturnType<typeof vi.fn<(init: ProjectInit) => Promise<FakeProject>>>
  openProject: ReturnType<typeof vi.fn<(init: ProjectOpenInit) => Promise<FakeProject>>>
}

/**
 * Build recording fakes: a ready generation backend, a fixed upload policy, and projects that take their leases from
 * the mounted project store and serve until closed.
 */
function makeFakes(): Fakes {
  const created: FakeProject[] = []
  const logged: Fakes['projects']['logged'] = []
  const fakes: Fakes = {
    store: () => {
      const store = roots.at(-1)?.get('dreamverseProjectStore')
      if (store === undefined) throw new Error('The project store is not mounted.')
      return store
    },
    createProject: vi.fn(async (init: ProjectInit) => {
      const store = fakes.store()
      const record = store.create({ kind: 'dreamverse', title: 'a cat', workload: { schemaVersion: 1, data: {} } })
      const lease = await store.acquire(record.projectId, init.holder)
      const project = new FakeProject(record.projectId, init.socket, () => { store.release(lease) })
      created.push(project)
      return project
    }),
    openProject: vi.fn(async (init: ProjectOpenInit) => {
      const store = fakes.store()
      const lease = await store.acquire(init.projectId, init.holder)
      steps.push(`opened ${init.projectId}`)
      const project = new FakeProject(init.projectId, init.socket, () => { store.release(lease) })
      created.push(project)
      return project
    }),
    generation: {
      readiness: async () => ({ ready: true, detail: null }),
      model: async () => MODEL_FACTS,
      ready: () => fakes.generation.readiness(),
    },
    assets: { uploadPolicy: () => UPLOAD_POLICY, deleteOwnedBy: () => {} },
    projects: {
      created,
      logged,
      createProject: init => fakes.createProject(init),
      openProject: init => fakes.openProject(init),
      logProjectEvent: async (projectId, event, payload) => {
        steps.push(`logged ${event}`)
        logged.push([projectId, event, payload])
      },
    },
  }
  return fakes
}

const roots: Context[] = []
const clients: WebSocket[] = []
/** Temporary project store roots. */
const storeRoots: string[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate()
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  for (const root of storeRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  steps = []
})

/** Mount the DSH web server on an OS-assigned port and a project store in a temporary root, then the plugin. */
async function startProjectController(fakes: Fakes): Promise<Fiber> {
  const root = new Context()
  roots.push(root)
  root.provide('dreamverseGeneration', fakes.generation)
  root.provide('dreamverseAssetsManager', fakes.assets)
  root.provide('dreamverseProjects', fakes.projects)
  const storeRoot = mkdtempSync(join(tmpdir(), 'dreamverse-controller-projects-'))
  storeRoots.push(storeRoot)
  await root.plugin(DreamverseProjectStore, { root: storeRoot }).await()
  await root.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' }).await()
  port = root.webServer.port
  const fiber = root.plugin(projectController)
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
      const message: unknown = isBinary ? data : JSON.parse(data.toString('utf8'))
      const waiter = this.waiter
      this.waiter = undefined
      if (waiter) waiter(message)
      else this.received.push(message)
    })
    this.closed = new Promise(resolve => socket.once('close', (code, reason) => { resolve({ code, reason: reason.toString() }) }))
  }

  static async open(): Promise<BrowserClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
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

const PROJECT_INIT = { type: 'project_init_v1', generation_mode: 'ref2va', curated_prompts: ['a cat'] }

describe('/ws project protocol', () => {
  it('rejects a first message other than project_init_v1 or project_open_v1 with close code 1003', async () => {
    const fakes = makeFakes()
    await startProjectController(fakes)
    const client = await BrowserClient.open()
    client.send({ type: 'append_prompt' })
    expect(await client.next()).toEqual({ type: 'error', message: 'The first message must be project_init_v1 or project_open_v1.' })
    expect(await client.closed).toEqual({ code: 1003, reason: 'Invalid project initialization' })
    expect(fakes.createProject).not.toHaveBeenCalled()
    expect(fakes.projects.logged.map(([, event]) => event)).toEqual(['websocket_connected'])
  })

  it('reports a createProject rejection and closes with code 1003 and its reason', async () => {
    const fakes = makeFakes()
    const error = new ProjectValidationError('segment_count must be from 1 to 6.', 'Invalid creation config')
    fakes.createProject.mockRejectedValueOnce(error)
    await startProjectController(fakes)
    const client = await BrowserClient.open()
    client.send(PROJECT_INIT)
    expect(await client.next()).toEqual({ type: 'error', message: error.message })
    expect(await client.closed).toEqual({ code: 1003, reason: error.reason })
    expect(steps).not.toContain('generation started')
  })

  it('sends gpu_assigned right after project creation, logs it without a payload, then generates while admitting commands', async () => {
    const fakes = makeFakes()
    await startProjectController(fakes)
    const client = await BrowserClient.open()
    client.send(PROJECT_INIT)
    expect(await client.next()).toEqual(GPU_ASSIGNED)

    const [project] = fakes.projects.created
    expect(fakes.createProject.mock.calls[0]![0].payload).toEqual(PROJECT_INIT)
    expect(fakes.store().get(project!.projectId)?.kind).toBe('dreamverse')
    await vi.waitFor(() => { expect(steps).toEqual(['logged websocket_connected', 'logged gpu_assigned', 'generation started']) })
    // Before the store assigns the project ID, the connection logs under its own UUID.
    expect(fakes.projects.logged).toEqual([
      [expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), 'websocket_connected', undefined],
      [project!.projectId, 'gpu_assigned', undefined],
    ])

    client.send({ type: 'append_prompt', prompt: 'a dog' })
    client.send({ type: 'leave' })
    expect(await client.closed).toEqual({ code: 1000, reason: '' })
    expect(project!.commands).toEqual([{ type: 'append_prompt', prompt: 'a dog' }])
    expect(steps.slice(-2)).toEqual(['project closed', `released ${project!.projectId}`])
  })

  it('answers a second project_init_v1 with the reference error and keeps serving the project', async () => {
    const fakes = makeFakes()
    await startProjectController(fakes)
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
    await startProjectController(fakes)
    fakes.createProject.mockImplementationOnce(async (init) => {
      const project = new FakeProject(brandString<ProjectId>('failing-project'), init.socket, () => {})
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
    await startProjectController(makeFakes())
    const client = await BrowserClient.open()
    client.send(PROJECT_INIT)
    await client.next()
    client.send([1, 2])
    expect(await client.next()).toEqual({ type: 'error', message: 'AV streaming failed: \'list\' object has no attribute \'get\'' })
    await client.closed
  })

  it('closes the project quietly when the browser disconnects during generation', async () => {
    const fakes = makeFakes()
    await startProjectController(fakes)
    const client = await BrowserClient.open()
    client.send(PROJECT_INIT)
    await client.next()
    await vi.waitFor(() => { expect(steps).toContain('generation started') })
    client.socket.close()
    await client.closed
    const projectId = fakes.projects.created[0]!.projectId
    await vi.waitFor(() => { expect(steps.slice(-2)).toEqual(['project closed', `released ${projectId}`]) })
  })

  it('delivers the project socket JSON and binary sends to the browser in call order', async () => {
    const fakes = makeFakes()
    fakes.createProject.mockImplementationOnce(async (init) => {
      const project = new FakeProject(brandString<ProjectId>('streaming-project'), init.socket, () => {})
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
    await startProjectController(fakes)
    const client = await BrowserClient.open()
    client.send(PROJECT_INIT)
    expect(await client.next()).toEqual(GPU_ASSIGNED)
    expect(await client.next()).toEqual({ type: 'media_init', segment_idx: 0 })
    expect(await client.next()).toEqual(Buffer.from([1, 2, 3]))
    expect(await client.next()).toEqual({ type: 'media_segment_complete', segment_idx: 0 })
  })

  it('opens the stored project that project_open_v1 names, reports its ID in gpu_assigned, and releases its lease on leave', async () => {
    const fakes = makeFakes()
    await startProjectController(fakes)
    const projectId = fakes.store().create({ kind: 'dreamverse', title: 'stored', workload: { schemaVersion: 1, data: {} } }).projectId
    const client = await BrowserClient.open()
    client.send({ type: 'project_open_v1', project_id: projectId })
    expect(await client.next()).toEqual({ ...GPU_ASSIGNED, project_id: projectId })
    expect(fakes.openProject.mock.calls[0]![0].projectId).toBe(projectId)
    expect(fakes.createProject).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(steps).toContain('generation started') })
    expect(fakes.projects.logged.at(-1)?.slice(0, 2)).toEqual([projectId, 'gpu_assigned'])
    expect(fakes.store().isHeld(projectId)).toBe(true)
    client.send({ type: 'leave' })
    await client.closed
    await vi.waitFor(() => { expect(fakes.store().isHeld(projectId)).toBe(false) })
    expect(steps.slice(-2)).toEqual(['project closed', `released ${projectId}`])
  })

  it.each([
    ['without a project ID', { type: 'project_open_v1' }, 'project_open_v1 requires a project_id.', 'Invalid project initialization'],
    ['for a project that cannot open', { type: 'project_open_v1', project_id: 'stored' }, 'Project not found.', 'Project not found'],
  ])('reports a project_open_v1 %s and closes with code 1003', async (_case, message, text, reason) => {
    const fakes = makeFakes()
    fakes.openProject.mockRejectedValueOnce(new ProjectValidationError(text, reason))
    await startProjectController(fakes)
    const client = await BrowserClient.open()
    client.send(message)
    expect(await client.next()).toEqual({ type: 'error', message: text })
    expect(await client.closed).toEqual({ code: 1003, reason })
    expect(steps).not.toContain('generation started')
  })

  it('hands an open project to a later connection through the store lease, after the earlier connection stored it', async () => {
    const fakes = makeFakes()
    await startProjectController(fakes)
    const first = await BrowserClient.open()
    first.send(PROJECT_INIT)
    const { project_id: projectId } = await first.next() as { project_id: ProjectId }
    expect(projectId).toBe(fakes.projects.created[0]!.projectId)
    await vi.waitFor(() => { expect(steps).toContain('generation started') })
    const second = await BrowserClient.open()
    second.send({ type: 'project_open_v1', project_id: projectId })
    expect(await first.next()).toEqual({ type: 'error', message: 'This project was opened in another window.' })
    expect(await first.closed).toEqual({ code: 1000, reason: 'Project opened in another window' })
    expect(await second.next()).toEqual({ ...GPU_ASSIGNED, project_id: projectId })
    const closed = steps.lastIndexOf('project closed')
    expect(closed).toBeGreaterThan(-1)
    expect(steps.slice(closed)).toEqual(['project closed', `released ${projectId}`, `opened ${projectId}`, 'logged gpu_assigned',
      'generation started'])
    expect(() => { fakes.store().delete(projectId) }).toThrow(ProjectInUseError)
  })

  it('closes WebSocket upgrades on paths other than /ws', async () => {
    await startProjectController(makeFakes())
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/generation`)
    clients.push(socket)
    const [error] = await once(socket, 'error') as [Error]
    expect(error.message).toMatch(/socket hang up/)
  })
})

describe('routing', () => {
  it('answers 405 with Allow for other methods on its routes', async () => {
    await startProjectController(makeFakes())
    const head = await call('HEAD', '/healthz')
    expect([head.status, head.headers.allow]).toEqual([405, 'GET'])
    expect(await callJson('PUT', '/readyz')).toMatchObject({ status: 405, headers: { allow: 'GET' }, json: { detail: 'Method Not Allowed' } })
  })

  it('answers Starlette\'s plain 500 when a route throws', async () => {
    const fakes = makeFakes()
    fakes.assets.uploadPolicy = () => { throw new TypeError('unexpected') }
    await startProjectController(fakes)
    const failed = await call('GET', '/creation-capabilities')
    expect([failed.status, failed.headers['content-type'], failed.body.toString()]).toEqual([500, 'text/plain; charset=utf-8', 'Internal Server Error'])
  })
})

describe('health and readiness', () => {
  it('reports the reference health payload on /health and /healthz', async () => {
    await startProjectController(makeFakes())
    for (const path of ['/health', '/healthz']) {
      const { status, json } = await callJson('GET', path)
      expect([status, json]).toEqual([200, { status: 'ok', service: 'ltx2-streaming-backend', ts: expect.stringMatching(TS) as string }])
    }
  })

  it('reports generation backend readiness, its warming detail, and an unreachable backend', async () => {
    const fakes = makeFakes()
    await startProjectController(fakes)
    expect(await callJson('GET', '/readyz')).toMatchObject({
      status: 200, json: { status: 'ready', service: 'ltx2-streaming-backend', ts: expect.stringMatching(TS) as string },
    })
    fakes.generation.readiness = async () => ({ ready: false, detail: 'Worker is initializing.' })
    const warming = await callJson('GET', '/readyz')
    expect([warming.status, warming.json]).toEqual([503, {
      status: 'warming', service: 'ltx2-streaming-backend', ts: expect.stringMatching(TS) as string, detail: 'Worker is initializing.',
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
    await startProjectController(fakes)
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

it('removes its routes and closes every project socket when the plugin unloads', async () => {
  const fakes = makeFakes()
  const fiber = await startProjectController(fakes)
  const client = await BrowserClient.open()
  client.send(PROJECT_INIT)
  await client.next()
  await fiber.dispose()
  expect((await client.closed).code).toBe(1006)
  expect(steps).toContain('project closed')
  const unrouted = await call('GET', '/healthz')
  expect([unrouted.status, unrouted.body.length]).toEqual([404, 0])
})
