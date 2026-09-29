/** The generation client maps the HTTP routes and the per-request generation socket of a fake generation backend. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import DreamverseGeneration, {
  DreamverseValueError, GenerationSegmentError, type SegmentOutput, type SegmentRequest,
} from '../src/index.ts'

const PORT = 18501
/** A port in the owned test range on which nothing listens. */
const UNREACHABLE_PORT = 18502

const MODEL_BODY = {
  model_id: 'h3-ref2va', name: 'H3 Ref2AV', generation_modes: { ref2va: 'reference_images' },
  unsupported_generation_modes: { fl2va: 'First/last frame mode (FL2VA) is not supported yet.' },
  aspect_ratios: ['16:9'], resolutions: ['720p'], min_segment_duration_sec: 5, max_segment_duration_sec: 15,
  max_reference_images: 9, max_reference_aspect_ratio: 4.0, uses_previous_frame: false,
  frame_sizes: { '16:9': { '720p': [1344, 768] } }, num_frames_by_duration_sec: { 5: 124, 6: 158 },
  reference_labels: ['Picture 1', 'Picture 2'],
}

type HttpRoute = (path: string) => { status: number; body: unknown }
/** Serves one generation socket; `request` is the parsed `generate_segment` message. */
type SegmentScript = (socket: WebSocket, request: Record<string, unknown>) => void

interface FakeBackend {
  paths: string[]
  requests: Record<string, unknown>[]
  sockets: WebSocket[]
  /** Settles with the close code of each generation socket, in connection order. */
  closed: Promise<number>[]
}

const servers: Server[] = []
const socketServers: WebSocketServer[] = []
const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  for (const socketServer of socketServers.splice(0)) for (const socket of socketServer.clients) socket.terminate()
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }))
})

/** Start a fake backend whose HTTP routes and generation sockets follow the given scripts. */
async function startFakeBackend(http: HttpRoute, segment: SegmentScript = () => {}): Promise<FakeBackend> {
  const fake: FakeBackend = { paths: [], requests: [], sockets: [], closed: [] }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? ''
    fake.paths.push(path)
    const reply = http(path)
    // Each test restarts the fake on the same port, so pooled keep-alive sockets must not outlive a reply.
    response.writeHead(reply.status, { 'content-type': 'application/json', connection: 'close' })
    response.end(JSON.stringify(reply.body))
  })
  const socketServer = new WebSocketServer({ server, path: '/v1/generation' })
  socketServers.push(socketServer)
  socketServer.on('connection', (socket) => {
    fake.sockets.push(socket)
    fake.closed.push(new Promise((resolve) => { socket.once('close', (code) => { resolve(code) }) }))
    socket.once('message', (data) => {
      const request = JSON.parse((data as Buffer).toString('utf8')) as Record<string, unknown>
      fake.requests.push(request)
      segment(socket, request)
    })
  })
  servers.push(server)
  server.listen(PORT, '127.0.0.1')
  await once(server, 'listening')
  return fake
}

function client(port = PORT): DreamverseGeneration {
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
  return {
    prompt: 'A lake', frameWidth: 1344, frameHeight: 768, numFrames: 124, segmentIdx: 1, continueFrom: null,
    referenceImages: [], ...fields,
  }
}

/** Send JSON messages as text frames and buffers as binary frames. */
function sendFrames(socket: WebSocket, frames: Array<object | Buffer>): void {
  for (const frame of frames) socket.send(Buffer.isBuffer(frame) ? frame : JSON.stringify(frame), { binary: Buffer.isBuffer(frame) })
}

describe('HTTP routes', () => {
  it('maps model facts to camelCase fields and reuses the first successful response', async () => {
    const replies = [{ status: 503, body: { detail: 'warming' } }, { status: 200, body: MODEL_BODY }]
    const fake = await startFakeBackend(() => replies.shift()!)
    const generation = client()
    await expect(generation.model()).rejects.toThrow(
      'DreamVerse generation backend GET /v1/model returned HTTP 503: {"detail":"warming"}')
    const facts = await generation.model()
    expect(facts).toEqual({
      modelId: 'h3-ref2va', name: 'H3 Ref2AV', generationModes: { ref2va: 'reference_images' },
      unsupportedGenerationModes: { fl2va: 'First/last frame mode (FL2VA) is not supported yet.' },
      aspectRatios: ['16:9'], resolutions: ['720p'], minSegmentDurationSec: 5, maxSegmentDurationSec: 15,
      maxReferenceImages: 9, maxReferenceAspectRatio: 4, usesPreviousFrame: false,
      frameSizes: { '16:9': { '720p': [1344, 768] } }, numFramesByDurationSec: { 5: 124, 6: 158 },
      referenceLabels: ['Picture 1', 'Picture 2'],
    })
    expect(await generation.model()).toBe(facts)
    expect(fake.paths).toEqual(['/v1/model', '/v1/model'])
  })

  it('rejects model facts with a non-ValueError error when the backend is unreachable', async () => {
    const failure = await client(UNREACHABLE_PORT).model().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(DreamverseValueError)
  })

  it('reports readiness from /readyz', async () => {
    const replies = [
      { status: 200, body: { status: 'ready' } },
      { status: 503, body: { status: 'warming', detail: 'The generation worker is starting.' } },
      { status: 500, body: { detail: 'broken' } },
    ]
    const fake = await startFakeBackend(() => replies.shift()!)
    const generation = client()
    expect(await generation.ready()).toEqual({ ready: true, detail: null })
    expect(await generation.ready()).toEqual({ ready: false, detail: 'The generation worker is starting.' })
    await expect(generation.ready()).rejects.toThrow(
      'DreamVerse generation backend GET /readyz returned HTTP 500: {"detail":"broken"}')
    expect(fake.paths).toEqual(['/readyz', '/readyz', '/readyz'])
  })
})

describe('segment generation', () => {
  it('sends one generate_segment request per socket and yields outputs in arrival order', async () => {
    const fake = await startFakeBackend(() => ({ status: 404, body: {} }), (socket, request) => {
      const index = request['segment_idx'] as number
      sendFrames(socket, [
        { type: 'media_metadata', stream_id: `s${index}`, mime: 'video/mp4' },
        Buffer.from([1, 2]),
        Buffer.from([3]),
        { type: 'media_end', stream_id: `s${index}`, chunks: 2 },
        { type: 'segment_finished', timings: { e2e_latency_ms: 12.5 }, continuation_handle: `handle-${index}` },
      ])
    })
    const generation = client()
    const images = [{ name: 'side', data: Buffer.from('side image') }, { name: 'front', data: Buffer.from([0, 255]) }]
    expect(await collect(generation.generateSegment(segmentRequest({ referenceImages: images })))).toEqual([
      { kind: 'media_metadata', streamId: 's1', mime: 'video/mp4' },
      { kind: 'chunk', bytes: Buffer.from([1, 2]) },
      { kind: 'chunk', bytes: Buffer.from([3]) },
      { kind: 'media_end', streamId: 's1', chunks: 2 },
      { kind: 'segment_finished', timings: { e2e_latency_ms: 12.5 }, continuationHandle: 'handle-1' },
    ])
    const following = await collect(generation.generateSegment(segmentRequest({ segmentIdx: 2, continueFrom: 'handle-1' })))
    expect(following.at(-1)).toEqual({ kind: 'segment_finished', timings: { e2e_latency_ms: 12.5 }, continuationHandle: 'handle-2' })
    expect(fake.requests).toEqual([
      {
        type: 'generate_segment', prompt: 'A lake', frame_width: 1344, frame_height: 768, num_frames: 124,
        segment_idx: 1, continue_from: null,
        reference_images: [{ name: 'side', data: Buffer.from('side image').toString('base64') }, { name: 'front', data: 'AP8=' }],
      },
      {
        type: 'generate_segment', prompt: 'A lake', frame_width: 1344, frame_height: 768, num_frames: 124,
        segment_idx: 2, continue_from: 'handle-1', reference_images: [],
      },
    ])
    expect(fake.sockets).toHaveLength(2)
    expect(await Promise.all(fake.closed)).toEqual([1000, 1000])
  })

  it('rejects with GenerationSegmentError after segment_error and ends without finishing after segment_ended', async () => {
    await startFakeBackend(() => ({ status: 404, body: {} }), (socket, request) => {
      sendFrames(socket, request['segment_idx'] === 1
        ? [{ type: 'segment_error', error_type: 'ValueError', is_value_error: true, message: 'bad reference' }]
        : [{ type: 'media_metadata', stream_id: 's2', mime: 'video/mp4' }, { type: 'segment_ended' }])
    })
    const generation = client()
    const failure = await collect(generation.generateSegment(segmentRequest())).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GenerationSegmentError)
    expect(failure).toMatchObject({ message: 'bad reference', errorType: 'ValueError', isValueError: true })
    expect(await collect(generation.generateSegment(segmentRequest({ segmentIdx: 2 })))).toEqual([
      { kind: 'media_metadata', streamId: 's2', mime: 'video/mp4' },
    ])
  })

  it('rejects when the backend closes the socket before a terminal message', async () => {
    await startFakeBackend(() => ({ status: 404, body: {} }), (socket) => {
      sendFrames(socket, [{ type: 'media_metadata', stream_id: 's1', mime: 'video/mp4' }])
      socket.close(1011, 'worker lost')
    })
    const outputs: SegmentOutput[] = []
    const failure = await (async () => {
      for await (const output of client().generateSegment(segmentRequest())) outputs.push(output)
    })().catch((error: unknown) => error)
    expect(outputs).toEqual([{ kind: 'media_metadata', streamId: 's1', mime: 'video/mp4' }])
    expect((failure as Error).message).toBe('DreamVerse generation socket closed (code 1011: worker lost).')
    expect(failure).not.toBeInstanceOf(GenerationSegmentError)
  })

  it('closes the socket and rejects with the abort reason without waiting for the backend', async () => {
    const fake = await startFakeBackend(() => ({ status: 404, body: {} }), (socket) => {
      sendFrames(socket, [{ type: 'media_metadata', stream_id: 's1', mime: 'video/mp4' }])
    })
    const controller = new AbortController()
    const outputs: SegmentOutput[] = []
    const streaming = (async () => {
      for await (const output of client().generateSegment(segmentRequest({ signal: controller.signal }))) {
        outputs.push(output)
        controller.abort(new Error('project closed'))
      }
    })()
    await expect(streaming).rejects.toThrow(/^project closed$/)
    expect(outputs).toEqual([{ kind: 'media_metadata', streamId: 's1', mime: 'video/mp4' }])
    expect(await fake.closed[0]).toBe(1000)
  })

  it('rejects an already aborted request without opening a socket', async () => {
    const fake = await startFakeBackend(() => ({ status: 404, body: {} }))
    const controller = new AbortController()
    controller.abort(new Error('project closed'))
    await expect(collect(client().generateSegment(segmentRequest({ signal: controller.signal }))))
      .rejects.toThrow(/^project closed$/)
    expect(fake.sockets).toEqual([])
  })
})
