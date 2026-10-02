import { Buffer } from 'node:buffer'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DreamverseValueError,
  GenerationSegmentError,
  ProjectClosedError,
  streamSegmentToBrowser,
  type DreamverseGeneration,
  type ModelFacts,
  type SegmentOutput,
  type SegmentRequest,
} from '../src/index.ts'
import { Deferred, ltxFacts, within } from './fakes.ts'

/** Serializes fake browser output and can hold or reject binary delivery. */
class MediaTarget {
  readonly emitted: (Record<string, unknown> | string)[] = []
  readonly receivedChunk = new Deferred()
  holdBinary: Deferred | null = null
  rejectMedia = false
  readonly socket = {
    sendJson: async (event: object): Promise<void> => { this.emitted.push(event as Record<string, unknown>) },
    sendBytes: async (chunk: Buffer): Promise<void> => {
      this.receivedChunk.resolve()
      if (this.holdBinary) await this.holdBinary.promise
      if (this.rejectMedia) throw new Error('output closed')
      this.emitted.push(chunk.toString('utf8'))
    },
  }

  /** @param generation - the generation client that streams the target's segments. */
  constructor(readonly generation: ScriptedGeneration) {}

  async sendBrowserEvent(event: Record<string, unknown>): Promise<void> {
    await this.socket.sendJson(event)
  }
}

/**
 * Yields scripted outputs and holds the terminal outcome (success or failure) until `finish`. An abort rejects at once
 * with `signal.reason`, as the generation client does after cancelling the segment's request.
 */
class ScriptedGeneration implements DreamverseGeneration {
  readonly requests: SegmentRequest[] = []
  /** Resolved unless `holdFinish()` holds the backend reply. */
  finish = new Deferred()
  readonly terminalWait = new Deferred()
  /** True after the iteration ended, when the client has cancelled the segment's request. */
  closed = false

  constructor(private readonly script?: (SegmentOutput | Error)[]) {
    this.finish.resolve()
  }

  holdFinish(): this {
    this.finish = new Deferred()
    return this
  }

  async model(): Promise<ModelFacts> {
    return ltxFacts()
  }

  generateSegment(request: SegmentRequest): AsyncIterable<SegmentOutput> {
    this.requests.push(request)
    return this.iterate(request)
  }

  private async *iterate(request: SegmentRequest): AsyncGenerator<SegmentOutput> {
    const script = this.script ?? [
      ...(request.returnLastFrame ? [{ kind: 'last_frame', png: Buffer.from(`frame of ${request.prompt}`) } as const] : []),
      { kind: 'video_start', mime: 'video/mp4' }, { kind: 'chunk', bytes: Buffer.from('video') },
      { kind: 'done', timings: { e2e_latency_ms: 12 } },
    ]
    try {
      for (const output of script) {
        if (output instanceof Error || output.kind === 'done') {
          this.terminalWait.resolve()
          const aborted = await Promise.race([this.finish.promise.then(() => false), aborts(request.signal)])
          if (aborted) throw request.signal?.reason
        }
        if (output instanceof Error) throw output
        yield output
      }
    } finally {
      this.closed = true
    }
  }
}

function aborts(signal: AbortSignal | undefined): Promise<true> {
  return new Promise((resolve) => {
    if (signal?.aborted) resolve(true)
    signal?.addEventListener('abort', () => { resolve(true) }, { once: true })
  })
}

function request(index: number, fields: { signal?: AbortSignal; returnLastFrame?: boolean } = {}): SegmentRequest {
  return {
    prompt: `scene-${index}`, frameWidth: 1280, frameHeight: 704, numFrames: 121, referenceImages: [],
    returnLastFrame: fields.returnLastFrame ?? false, ...(fields.signal ? { signal: fields.signal } : {}),
  }
}

/** The directory that receives the current test's segment videos. */
let videoDirectory = ''
beforeEach(() => { videoDirectory = mkdtempSync(join(tmpdir(), 'dreamverse-video-stream-')) })
afterEach(() => { rmSync(videoDirectory, { recursive: true, force: true }) })

/** The stored video path of the segment at a one-based display position. */
function videoPath(segmentIdx: number): string {
  return join(videoDirectory, `segment-${segmentIdx}.mp4`)
}

/** @returns the names of the files that the deliveries left in the video directory. */
function storedFiles(): string[] {
  return readdirSync(videoDirectory).sort()
}

/** The stream ID of the browser event at `index`. */
function streamIdAt(target: MediaTarget, index: number): unknown {
  return (target.emitted[index] as Record<string, unknown>)['stream_id']
}

describe('streamSegmentToBrowser', () => {
  it('preserves request identity, browser order, delivered counts, and last frames across segments', async () => {
    const generation = new ScriptedGeneration()
    const target = new MediaTarget(generation)
    const requests = [request(1, { returnLastFrame: true }), request(2)]
    expect(await streamSegmentToBrowser(target, 1, requests[0]!, videoPath(1))).toEqual({
      deliveryStats: { timings: { e2e_latency_ms: 12 }, chunkCount: 1, byteCount: 5 }, lastFrame: Buffer.from('frame of scene-1'),
      mime: 'video/mp4',
    })
    expect(await streamSegmentToBrowser(target, 2, requests[1]!, videoPath(2))).toEqual({
      deliveryStats: { timings: { e2e_latency_ms: 12 }, chunkCount: 1, byteCount: 5 }, lastFrame: null, mime: 'video/mp4',
    })
    expect(storedFiles()).toEqual(['segment-1.mp4', 'segment-2.mp4'])
    expect(readFileSync(videoPath(1), 'utf8')).toBe('video')
    expect(generation.requests).toEqual(requests)
    expect(generation.requests[0]).toBe(requests[0])
    const streamId: unknown = expect.stringMatching(/^seg00[12]-[0-9a-f]{8}$/)
    expect(target.emitted).toEqual([
      { type: 'media_init', segment_idx: 1, mime: 'video/mp4', stream_id: streamId },
      'video', { type: 'media_segment_complete', segment_idx: 1, stream_id: streamId },
      { type: 'media_init', segment_idx: 2, mime: 'video/mp4', stream_id: streamId },
      'video', { type: 'media_segment_complete', segment_idx: 2, stream_id: streamId },
    ])
    expect([streamIdAt(target, 0), streamIdAt(target, 3)]).toEqual([streamIdAt(target, 2), streamIdAt(target, 5)])
    expect(String(streamIdAt(target, 0)).startsWith('seg001-')).toBe(true)
    expect(String(streamIdAt(target, 3)).startsWith('seg002-')).toBe(true)
  })

  it.each([true, false])('announces media completion only after the backend reply (success=%s)', async (successful) => {
    const outcome: SegmentOutput | Error = successful
      ? { kind: 'done', timings: { generation_ms: 2 } }
      : new GenerationSegmentError('worker failed after media', 'generation_failed', false)
    const generation = new ScriptedGeneration([
      { kind: 'video_start', mime: 'video/mp4' }, { kind: 'chunk', bytes: Buffer.from('first') }, outcome,
    ]).holdFinish()
    const target = new MediaTarget(generation)
    const delivery = streamSegmentToBrowser(target, 1, request(1), videoPath(1))
    const settled = delivery.then(() => 'resolved', () => 'rejected')
    await within(generation.terminalWait.promise)
    expect(target.emitted.at(-1)).toBe('first')
    generation.finish.resolve()
    if (successful) {
      expect(await delivery).toEqual({
        deliveryStats: { timings: { generation_ms: 2 }, chunkCount: 1, byteCount: 5 }, lastFrame: null, mime: 'video/mp4',
      })
      expect(target.emitted.at(-1)).toEqual({ type: 'media_segment_complete', segment_idx: 1, stream_id: streamIdAt(target, 0) })
      expect(storedFiles()).toEqual(['segment-1.mp4'])
    } else {
      await expect(delivery).rejects.toThrow('worker failed after media')
      expect(target.emitted.at(-1)).toBe('first')
      expect(storedFiles()).toEqual([])
    }
    expect(await settled).toBe(successful ? 'resolved' : 'rejected')
  })

  it.each([
    ['video start', false, 'Segment 1 AV stream did not initialize (no media_init event)'],
    ['successful reply', false, 'Segment 1 stream ended without a successful backend reply'],
    ['requested last frame', true, 'Segment 1 finished without the requested last frame'],
  ])('rejects a stream without its %s', async (missing, returnLastFrame, message) => {
    const script: SegmentOutput[] = [
      { kind: 'video_start', mime: 'video/mp4' }, { kind: 'chunk', bytes: Buffer.from('video') }, { kind: 'done', timings: {} },
    ]
    if (missing === 'video start') script.splice(0, 1)
    if (missing === 'successful reply') script.splice(-1, 1)
    const generation = new ScriptedGeneration(script)
    const target = new MediaTarget(generation)
    await expect(streamSegmentToBrowser(target, 1, request(1, { returnLastFrame }), videoPath(1))).rejects.toThrow(new Error(message))
    expect(generation.closed).toBe(true)
    expect(storedFiles()).toEqual([])
    expect(target.emitted.some(event => typeof event === 'object' && event['type'] === 'media_segment_complete')).toBe(false)
  })

  it.each([
    [new GenerationSegmentError('The backend rejected this shot.', 'invalid_request', true), DreamverseValueError],
    [new GenerationSegmentError('fake GPU step failed', 'generation_failed', false), Error],
  ])('converts backend failure %s to the reference error kind', async (failure, kind) => {
    const generation = new ScriptedGeneration([{ kind: 'video_start', mime: 'video/mp4' }, failure])
    const error = await streamSegmentToBrowser(new MediaTarget(generation), 1, request(1), videoPath(1))
      .then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(kind)
    expect(error).not.toBeInstanceOf(GenerationSegmentError)
    expect(error instanceof DreamverseValueError).toBe(kind === DreamverseValueError)
    expect((error as Error).message).toBe(failure.message)
  })

  it.each(['abort', 'output failure'])('closes the segment stream after %s without waiting for the reply', async (ending) => {
    const generation = new ScriptedGeneration().holdFinish()
    const target = new MediaTarget(generation)
    const abort = new AbortController()
    if (ending === 'abort') target.holdBinary = new Deferred()
    else target.rejectMedia = true
    const deliverTwo = async (): Promise<void> => {
      await streamSegmentToBrowser(target, 1, request(1, { signal: abort.signal }), videoPath(1))
      await streamSegmentToBrowser(target, 2, request(2, { signal: abort.signal }), videoPath(2))
    }
    const settled = deliverTwo().then(() => null, (reason: unknown) => reason)
    await within(target.receivedChunk.promise)
    if (ending === 'abort') {
      // The held socket write finishes; the next read observes the abort.
      abort.abort()
      target.holdBinary!.resolve()
    }
    const error = await within(settled)
    expect(error).toBeInstanceOf(ending === 'abort' ? ProjectClosedError : Error)
    if (ending !== 'abort') expect((error as Error).message).toBe('output closed')
    expect([generation.closed, generation.finish.settled]).toEqual([true, false])
    expect(generation.requests).toHaveLength(1)
    expect(target.emitted.some(event => typeof event === 'object' && event['type'] === 'media_segment_complete')).toBe(false)
    expect(storedFiles()).toEqual([])
  })

  it('counts only non-empty chunks after their socket write finishes', async () => {
    const generation = new ScriptedGeneration([
      { kind: 'video_start', mime: 'video/mp4' }, { kind: 'chunk', bytes: Buffer.from('ab') },
      { kind: 'chunk', bytes: Buffer.alloc(0) }, { kind: 'chunk', bytes: Buffer.from('cde') }, { kind: 'done', timings: {} },
    ])
    const target = new MediaTarget(generation)
    target.holdBinary = new Deferred()
    const delivery = streamSegmentToBrowser(target, 1, request(1), videoPath(1))
    await within(target.receivedChunk.promise)
    expect(target.emitted).toEqual([{ type: 'media_init', segment_idx: 1, mime: 'video/mp4', stream_id: streamIdAt(target, 0) }])
    target.holdBinary.resolve()
    expect((await within(delivery)).deliveryStats).toEqual({ timings: {}, chunkCount: 2, byteCount: 5 })
    expect(target.emitted.filter(event => typeof event === 'string')).toEqual(['ab', 'cde'])
    expect(readFileSync(videoPath(1), 'utf8')).toBe('abcde')
  })
})
