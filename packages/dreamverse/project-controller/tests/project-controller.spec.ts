/**
 * The project controller plugin, mounted through Cordis on the DSH web server with fake generation, asset, and project
 * services, serves the reference project protocol and the health, readiness, and creation capability routes.
 */
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { ProjectValidationError } from '@dreamverse/project'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as projectController from '../src/index.ts'
import type {
  CreationConfig, DreamverseAssetsManager, DreamverseGeneration, DreamverseProjects, ModelFacts, PersistedProject, Project,
  ProjectInit, ProjectOpenInit, ProjectSocket,
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

/** The fake services and their recorded calls. */
interface Fakes {
  generation: DreamverseGeneration & { readiness: () => Promise<{ ready: boolean; detail: string | null }> }
  assets: DreamverseAssetsManager
  projects: DreamverseProjects & {
    created: FakeProject[]
    logged: Array<[string, string, Record<string, unknown> | undefined]>
    /** Stored projects by ID. */
    records: Map<string, PersistedProject>
    /** Stored segment files by `<project_id>/<segment_id>/<kind>`. */
    files: Map<string, string>
    deleted: string[]
  }
  createProject: ReturnType<typeof vi.fn<(init: ProjectInit) => Promise<FakeProject>>>
  openProject: ReturnType<typeof vi.fn<(init: ProjectOpenInit) => Promise<FakeProject>>>
}

/**
 * Build recording fakes: a ready generation backend, a fixed upload policy, projects that serve until closed, and an
 * initially empty project store.
 */
function makeFakes(): Fakes {
  const created: FakeProject[] = []
  const logged: Fakes['projects']['logged'] = []
  const records = new Map<string, PersistedProject>()
  const files = new Map<string, string>()
  const deleted: string[] = []
  const fakes: Fakes = {
    createProject: vi.fn(async (init: ProjectInit) => {
      const project = new FakeProject(init.projectId, init.socket)
      created.push(project)
      return project
    }),
    openProject: vi.fn(async (init: ProjectOpenInit) => {
      steps.push(`opened ${init.projectId}`)
      const project = new FakeProject(init.projectId, init.socket)
      created.push(project)
      return project
    }),
    generation: {
      readiness: async () => ({ ready: true, detail: null }),
      model: async () => MODEL_FACTS,
      ready: () => fakes.generation.readiness(),
    },
    assets: { uploadPolicy: () => UPLOAD_POLICY },
    projects: {
      created,
      logged,
      records,
      files,
      deleted,
      createProject: init => fakes.createProject(init),
      openProject: init => fakes.openProject(init),
      listProjects: () => [...records.values()],
      readProject: projectId => records.get(projectId),
      segmentFile: (projectId, segmentId, kind) => files.get(`${projectId}/${segmentId}/${kind}`),
      deleteProject: (projectId) => {
        if (!records.delete(projectId)) return false
        deleted.push(projectId)
        return true
      },
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
/** Temporary directories holding stored segment files. */
const fileRoots: string[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate()
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  for (const root of fileRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  steps = []
})

/** Mount the DSH web server on an OS-assigned port, then the plugin with fake services. */
async function startProjectController(fakes: Fakes): Promise<Fiber> {
  const root = new Context()
  roots.push(root)
  root.provide('dreamverseGeneration', fakes.generation)
  root.provide('dreamverseAssetsManager', fakes.assets)
  root.provide('dreamverseProjects', fakes.projects)
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
    expect(project!.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    await vi.waitFor(() => { expect(steps).toEqual(['logged websocket_connected', 'logged gpu_assigned', 'generation started']) })
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
    await vi.waitFor(() => { expect(steps.at(-1)).toBe('project closed') })
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
    await startProjectController(fakes)
    const client = await BrowserClient.open()
    client.send(PROJECT_INIT)
    expect(await client.next()).toEqual(GPU_ASSIGNED)
    expect(await client.next()).toEqual({ type: 'media_init', segment_idx: 0 })
    expect(await client.next()).toEqual(Buffer.from([1, 2, 3]))
    expect(await client.next()).toEqual({ type: 'media_segment_complete', segment_idx: 0 })
  })

  it('opens the stored project that project_open_v1 names and reports its ID in gpu_assigned', async () => {
    const fakes = makeFakes()
    await startProjectController(fakes)
    const client = await BrowserClient.open()
    client.send({ type: 'project_open_v1', project_id: 'stored-project' })
    expect(await client.next()).toEqual({ ...GPU_ASSIGNED, project_id: 'stored-project' })
    expect(fakes.openProject.mock.calls[0]![0].projectId).toBe('stored-project')
    expect(fakes.createProject).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(steps).toContain('generation started') })
    expect(fakes.projects.logged.at(-1)?.slice(0, 2)).toEqual(['stored-project', 'gpu_assigned'])
  })

  it.each([
    ['without a project ID', { type: 'project_open_v1' }, 'project_open_v1 requires a project_id.', 'Invalid project initialization'],
    ['for a project that cannot open', { type: 'project_open_v1', project_id: 'stored' }, 'Project not found.', 'Project not found'],
  ])('reports a project_open_v1 %s, closes with code 1003, and releases the project', async (_case, message, text, reason) => {
    const fakes = makeFakes()
    fakes.projects.records.set('stored', storedProject('stored', '2026-10-02T00:00:00.000Z'))
    fakes.openProject.mockRejectedValueOnce(new ProjectValidationError(text, reason))
    await startProjectController(fakes)
    const client = await BrowserClient.open()
    client.send(message)
    expect(await client.next()).toEqual({ type: 'error', message: text })
    expect(await client.closed).toEqual({ code: 1003, reason })
    expect((await call('DELETE', '/projects/stored')).status).toBe(204)
  })

  it('hands an open project to a later connection, which opens it after the earlier connection closed it', async () => {
    const fakes = makeFakes()
    await startProjectController(fakes)
    const first = await BrowserClient.open()
    first.send(PROJECT_INIT)
    const { project_id: projectId } = await first.next() as { project_id: string }
    await vi.waitFor(() => { expect(steps).toContain('generation started') })
    const second = await BrowserClient.open()
    second.send({ type: 'project_open_v1', project_id: projectId })
    expect(await first.next()).toEqual({ type: 'error', message: 'This project was opened in another window.' })
    expect(await first.closed).toEqual({ code: 1000, reason: 'Project opened in another window' })
    expect(await second.next()).toEqual({ ...GPU_ASSIGNED, project_id: projectId })
    expect(steps.indexOf('project closed')).toBeGreaterThan(-1)
    expect(steps.indexOf('project closed')).toBeLessThan(steps.indexOf(`opened ${projectId}`))
    fakes.projects.records.set(projectId, storedProject(projectId, '2026-10-02T00:00:00.000Z'))
    expect((await call('DELETE', `/projects/${projectId}`)).status).toBe(409)
  })

  it('closes WebSocket upgrades on paths other than /ws', async () => {
    await startProjectController(makeFakes())
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/generation`)
    clients.push(socket)
    const [error] = await once(socket, 'error') as [Error]
    expect(error.message).toMatch(/socket hang up/)
  })
})

/**
 * A stored project with two completed rounds, the second continuing the first, and one failed segment.
 * @param projectId - the project ID.
 * @param updatedAt - the latest write time.
 * @returns the stored record.
 */
function storedProject(projectId: string, updatedAt: string): PersistedProject {
  const mime = 'video/mp4; codecs="avc1.42C028, mp4a.40.2"'
  const instruction = { request_id: 'request-1', text: 'a cat' }
  return {
    project_id: projectId, title: `Title ${projectId}`, created_at: '2026-10-01T00:00:00.000Z', updated_at: updatedAt,
    creation_config: CREATION_CONFIG,
    segments: [
      { segment_id: 's1', prompt: 'first shot', status: 'completed', mime, instruction },
      { segment_id: 's2', prompt: 'second shot', status: 'completed', mime, instruction: { request_id: 'request-2', text: 'it jumps' } },
      { segment_id: 's3', prompt: 'failed shot', status: 'failed', mime: null, instruction: null },
    ],
    completed_sequences: [['s1'], ['s1', 's2', 's3']],
  }
}

/**
 * Store one segment file for the fake project service.
 * @param fakes - the fakes whose store receives the file.
 * @param key - `<project_id>/<segment_id>/<kind>`.
 * @param content - the file content.
 */
function storeFile(fakes: Fakes, key: string, content: string): void {
  const root = fileRoots[0] ?? mkdtempSync(join(tmpdir(), 'dreamverse-project-files-'))
  if (fileRoots.length === 0) fileRoots.push(root)
  const path = join(root, key.replaceAll('/', '-'))
  writeFileSync(path, content)
  fakes.projects.files.set(key, path)
}

describe('/projects', () => {
  it('lists stored projects and describes one with its completed rounds and segment file URLs', async () => {
    const fakes = makeFakes()
    fakes.projects.records.set('p1', storedProject('p1', '2026-10-02T00:00:01.000Z'))
    fakes.projects.records.set('p2', { ...storedProject('p2', '2026-10-02T00:00:00.000Z'), segments: [], completed_sequences: [] })
    storeFile(fakes, 'p1/s1/video', 'video one')
    storeFile(fakes, 'p1/s2/video', 'video two')
    storeFile(fakes, 'p1/s2/frame', 'frame two')
    await startProjectController(fakes)

    expect(await callJson('GET', '/projects')).toMatchObject({ status: 200, json: { projects: [
      { project_id: 'p1', title: 'Title p1', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:01.000Z',
        thumbnail_url: '/projects/p1/segments/s2/frame', round_count: 2 },
      { project_id: 'p2', title: 'Title p2', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z',
        thumbnail_url: null, round_count: 0 },
    ] } })
    const mime = 'video/mp4; codecs="avc1.42C028, mp4a.40.2"'
    const first = { segment_id: 's1', prompt: 'first shot', mime, video_url: '/projects/p1/segments/s1/video', frame_url: null }
    const detail = await callJson('GET', '/projects/p1')
    expect([detail.status, detail.json]).toEqual([200, {
      project_id: 'p1', title: 'Title p1', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:01.000Z',
      open: false, creation_config: CREATION_CONFIG,
      rounds: [
        { round_index: 0, instruction: 'a cat', segments: [first] },
        { round_index: 1, instruction: 'it jumps', segments: [first, {
          segment_id: 's2', prompt: 'second shot', mime, video_url: '/projects/p1/segments/s2/video',
          frame_url: '/projects/p1/segments/s2/frame',
        }] },
      ],
    }])
    expect(await callJson('GET', '/projects/missing')).toMatchObject({ status: 404, json: { detail: 'Project not found.' } })

    const video = await call('GET', '/projects/p1/segments/s2/video')
    expect([video.status, video.headers['content-type'], video.body.toString()]).toEqual([200, 'video/mp4', 'video two'])
    const frame = await call('GET', '/projects/p1/segments/s2/frame')
    expect([frame.status, frame.headers['content-type'], frame.body.toString()]).toEqual([200, 'image/png', 'frame two'])
    expect(await callJson('GET', '/projects/p1/segments/s1/frame')).toMatchObject({ status: 404, json: { detail: 'Segment file not found.' } })
  })

  it('refuses to delete an open project and deletes it after its socket closes', async () => {
    const fakes = makeFakes()
    fakes.projects.records.set('p1', storedProject('p1', '2026-10-02T00:00:00.000Z'))
    await startProjectController(fakes)
    const client = await BrowserClient.open()
    client.send({ type: 'project_open_v1', project_id: 'p1' })
    await client.next()
    expect(await callJson('GET', '/projects/p1')).toMatchObject({ status: 200, json: { open: true } })
    expect(await callJson('DELETE', '/projects/p1')).toMatchObject({
      status: 409, json: { detail: 'This project is open. Close it before deleting.' },
    })
    client.send({ type: 'leave' })
    await client.closed
    await vi.waitFor(async () => { expect((await callJson('GET', '/projects/p1')).json).toMatchObject({ open: false }) })
    const deleted = await call('DELETE', '/projects/p1')
    expect([deleted.status, deleted.body.length, fakes.projects.deleted]).toEqual([204, 0, ['p1']])
    expect(await callJson('DELETE', '/projects/p1')).toMatchObject({ status: 404, json: { detail: 'Project not found.' } })
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
