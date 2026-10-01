/** The generation client maps the streaming_v2 HTTP routes and the per-request event streams of a fake backend. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import DreamverseGeneration, {
  DreamverseValueError, GenerationSegmentError, type SegmentOutput, type SegmentRequest,
} from '../src/index.ts'

/** A port in the owned test range on which nothing listens. */
const UNREACHABLE_PORT = 18502

const CAPABILITIES_BODY = {
  model_id: 'h3-ref2va', name: 'H3 Ref2AV', min_segment_duration_sec: 5, max_segment_duration_sec: 15,
  max_reference_images: 3, max_reference_aspect_ratio: 4.0,
  frame_sizes: { '16:9': { '720p': [1344, 768], '480p': [896, 512] }, '9:16': { '720p': [768, 1344] } },
  num_frames_by_duration_sec: { 5: 124, 6: 158 },
}

interface Reply { status: number; body: unknown }
/** Answers one HTTP request; `request` is the parsed JSON body of a POST. */
type Route = (path: string, request: Record<string, unknown> | null, response: ServerResponse) => void

interface FakeBackend {
  /** The ephemeral port that the fake listens on, so no pooled connection of an earlier test can reach it. */
  port: number
  paths: string[]
  requests: Record<string, unknown>[]
  /** Settles when the client closes the connection of each POST, in arrival order. */
  closed: Promise<void>[]
}

const servers: Server[] = []
const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }))
})

/** Start a fake backend whose requests the route answers. */
async function startFakeBackend(route: Route): Promise<FakeBackend> {
  const fake: FakeBackend = { port: 0, paths: [], requests: [], closed: [] }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? ''
    fake.paths.push(path)
    if (request.method !== 'POST') {
      route(path, null, response)
      return
    }
    fake.closed.push(new Promise((resolve) => { response.once('close', () => { resolve() }) }))
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => { parts.push(part) })
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>
      fake.requests.push(body)
      route(path, body, response)
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  fake.port = (server.address() as AddressInfo).port
  return fake
}

/** Answer with one JSON body and close the connection. */
function sendJson(response: ServerResponse, reply: Reply): void {
  response.writeHead(reply.status, { 'content-type': 'application/json', connection: 'close' })
  response.end(JSON.stringify(reply.body))
}

/** Start an event-stream response and write the given events. */
function sendEvents(response: ServerResponse, events: Array<[string, object]>, end = true): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
  for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  if (end) response.end()
}

function client(port: number): DreamverseGeneration {
  const root = new Context()
  roots.push(root)
  return new DreamverseGeneration(root, { baseUrl: `http://127.0.0.1:${port}` })
}

async function collect(outputs: AsyncIterable<SegmentOutput>): Promise<SegmentOutput[]> {
  const received: SegmentOutput[] = []
  for await (const output of outputs) received.push(output)
  return received
}

function segmentRequest(fields: Partial<SegmentRequest> = {}): SegmentRequest {
  return { prompt: 'A lake', frameWidth: 1344, frameHeight: 768, numFrames: 124, referenceImages: [], returnLastFrame: false, ...fields }
}

describe('HTTP routes', () => {
  it('builds model facts from the capabilities and reuses the first successful response', async () => {
    const replies: Reply[] = [{ status: 503, body: { detail: 'warming' } }, { status: 200, body: CAPABILITIES_BODY }]
    const fake = await startFakeBackend((_path, _request, response) => { sendJson(response, replies.shift()!) })
    const generation = client(fake.port)
    await expect(generation.model()).rejects.toThrow(
      'DreamVerse generation backend GET /v1/streamv2/capabilities returned HTTP 503: {"detail":"warming"}')
    const facts = await generation.model()
    expect(facts).toEqual({
      modelId: 'h3-ref2va', name: 'H3 Ref2AV', generationModes: { ref2va: 'reference_images' },
      unsupportedGenerationModes: {}, aspectRatios: ['16:9', '9:16'], resolutions: ['720p', '480p'],
      minSegmentDurationSec: 5, maxSegmentDurationSec: 15, maxReferenceImages: 3, maxReferenceAspectRatio: 4,
      usesPreviousFrame: true,
      frameSizes: { '16:9': { '720p': [1344, 768], '480p': [896, 512] }, '9:16': { '720p': [768, 1344] } },
      numFramesByDurationSec: { 5: 124, 6: 158 },
      referenceLabels: ['Picture 1', 'Picture 2', 'Picture 3'],
    })
    expect(await generation.model()).toBe(facts)
    expect(fake.paths).toEqual(['/v1/streamv2/capabilities', '/v1/streamv2/capabilities'])
  })

  it('rejects model facts with a non-ValueError error when the backend is unreachable', async () => {
    const failure = await client(UNREACHABLE_PORT).model().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(DreamverseValueError)
  })

  it('reports readiness from the health route', async () => {
    const replies: Reply[] = [{ status: 200, body: { status: 'ready' } }, { status: 500, body: { detail: 'broken' } }]
    const fake = await startFakeBackend((_path, _request, response) => { sendJson(response, replies.shift()!) })
    const generation = client(fake.port)
    expect(await generation.ready()).toEqual({ ready: true, detail: null })
    await expect(generation.ready()).rejects.toThrow(
      'DreamVerse generation backend GET /v1/streamv2/health returned HTTP 500: {"detail":"broken"}')
    expect(fake.paths).toEqual(['/v1/streamv2/health', '/v1/streamv2/health'])
  })
})

describe('segment generation', () => {
  it('posts one request per segment and yields the event stream in arrival order', async () => {
    const fake = await startFakeBackend((_path, request, response) => {
      const lastFrame = request!['return_last_frame'] === true
        ? [['last_frame', { data: Buffer.from('frame').toString('base64') }] as [string, object]]
        : []
      sendEvents(response, [
        ...lastFrame,
        ['video_start', { mime: 'video/mp4; codecs="avc1.640028, mp4a.40.2"' }],
        ['video_chunk', { data: Buffer.from([1, 2]).toString('base64') }],
        ['video_chunk', { data: Buffer.from([3]).toString('base64') }],
        ['done', { timings: { generation_ms: 10, e2e_latency_ms: 12.5 } }],
      ])
    })
    const generation = client(fake.port)
    const images = [Buffer.from('side image'), Buffer.from([0, 255])]
    expect(await collect(generation.generateSegment(segmentRequest({ referenceImages: images, returnLastFrame: true, seed: 7 }))))
      .toEqual([
        { kind: 'last_frame', png: Buffer.from('frame') },
        { kind: 'video_start', mime: 'video/mp4; codecs="avc1.640028, mp4a.40.2"' },
        { kind: 'chunk', bytes: Buffer.from([1, 2]) },
        { kind: 'chunk', bytes: Buffer.from([3]) },
        { kind: 'done', timings: { generation_ms: 10, e2e_latency_ms: 12.5 } },
      ])
    expect((await collect(generation.generateSegment(segmentRequest()))).map(output => output.kind))
      .toEqual(['video_start', 'chunk', 'chunk', 'done'])
    expect(fake.paths).toEqual(['/v1/streamv2/generate', '/v1/streamv2/generate'])
    expect(fake.requests).toEqual([
      {
        prompt: 'A lake', reference_images: [Buffer.from('side image').toString('base64'), 'AP8='],
        width: 1344, height: 768, num_frames: 124, seed: 7, return_last_frame: true,
      },
      { prompt: 'A lake', reference_images: [], width: 1344, height: 768, num_frames: 124, return_last_frame: false },
    ])
  })

  it('parses events split across reads, carriage returns, comments, and multi-line data', async () => {
    const fake = await startFakeBackend((_path, _request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      response.write(': keep-alive\r\nevent: video_start\r\nda')
      response.write('ta: {"mime":\r\ndata: "video/mp4"}\r\n\r\nevent: done\ndata: {"timings": {}}\n\n')
      response.end()
    })
    expect(await collect(client(fake.port).generateSegment(segmentRequest()))).toEqual([
      { kind: 'video_start', mime: 'video/mp4' }, { kind: 'done', timings: {} },
    ])
  })

  it('rejects HTTP 400 and invalid_request errors as the ValueError kind and generation_failed as the other kind', async () => {
    const fake = await startFakeBackend((_path, request, response) => {
      if (request!['prompt'] === 'bad body') {
        sendJson(response, { status: 400, body: { code: 'invalid_request', message: 'num_frames is required' } })
      } else {
        const code = request!['prompt'] === 'bad reference' ? 'invalid_request' : 'generation_failed'
        sendEvents(response, [['video_start', { mime: 'video/mp4' }], ['error', { code, message: `${code} message` }]])
      }
    })
    const generation = client(fake.port)
    const results = await Promise.all(['bad body', 'bad reference', 'worker lost'].map(async prompt =>
      await collect(generation.generateSegment(segmentRequest({ prompt }))).catch((error: unknown) => error)))
    expect(results.map(result =>
      result instanceof GenerationSegmentError ? [result.message, result.errorType, result.isValueError] : result))
      .toEqual([
        ['num_frames is required', 'invalid_request', true],
        ['invalid_request message', 'invalid_request', true],
        ['generation_failed message', 'generation_failed', false],
      ])
  })

  it('rejects other statuses, unknown events, and streams that end before done with a plain error', async () => {
    const fake = await startFakeBackend((_path, request, response) => {
      if (request!['prompt'] === 'status') sendJson(response, { status: 500, body: { detail: 'boom' } })
      else if (request!['prompt'] === 'unknown') sendEvents(response, [['progress', { step: 1 }]])
      else sendEvents(response, [['video_start', { mime: 'video/mp4' }]])
    })
    const generation = client(fake.port)
    const results = await Promise.all(['status', 'unknown', 'truncated'].map(async prompt =>
      await collect(generation.generateSegment(segmentRequest({ prompt }))).catch((error: unknown) => error)))
    for (const result of results) expect(result).not.toBeInstanceOf(GenerationSegmentError)
    expect(results.map(result => (result as Error).message)).toEqual([
      'DreamVerse generation backend POST /v1/streamv2/generate returned HTTP 500: {"detail":"boom"}',
      'Unexpected DreamVerse generation event: progress',
      'DreamVerse generation stream ended before its done event.',
    ])
  })

  it('cancels the request and rejects with the abort reason without waiting for the backend', async () => {
    const fake = await startFakeBackend((_path, _request, response) => {
      sendEvents(response, [['video_start', { mime: 'video/mp4' }]], false)
    })
    const controller = new AbortController()
    const outputs: SegmentOutput[] = []
    const streaming = (async () => {
      for await (const output of client(fake.port).generateSegment(segmentRequest({ signal: controller.signal }))) {
        outputs.push(output)
        controller.abort(new Error('project closed'))
      }
    })()
    await expect(streaming).rejects.toThrow(/^project closed$/)
    expect(outputs).toEqual([{ kind: 'video_start', mime: 'video/mp4' }])
    await fake.closed[0]
  })

  it('cancels the request when the reader leaves the iteration early', async () => {
    const fake = await startFakeBackend((_path, _request, response) => {
      sendEvents(response, [['video_start', { mime: 'video/mp4' }]], false)
    })
    for await (const output of client(fake.port).generateSegment(segmentRequest())) {
      expect(output).toEqual({ kind: 'video_start', mime: 'video/mp4' })
      break
    }
    await fake.closed[0]
  })

  it('rejects an already aborted request without sending it', async () => {
    const fake = await startFakeBackend((_path, _request, response) => { sendJson(response, { status: 404, body: {} }) })
    const controller = new AbortController()
    controller.abort(new Error('project closed'))
    await expect(collect(client(fake.port).generateSegment(segmentRequest({ signal: controller.signal }))))
      .rejects.toThrow(/^project closed$/)
    expect(fake.paths).toEqual([])
  })
})
