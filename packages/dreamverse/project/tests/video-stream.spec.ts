import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
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
 * with `signal.reason`, as the generation client does after closing the segment's socket.
 */
class ScriptedGeneration implements DreamverseGeneration {
  readonly requests: SegmentRequest[] = []
  /** Resolved unless `holdFinish()` holds the backend reply. */
  finish = new Deferred()
  readonly terminalWait = new Deferred()
  /** True after the iteration ended, when the client has closed the segment's socket. */
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
    const streamId = `stream-${request.segmentIdx}`
    const script = this.script ?? [
      { kind: 'media_metadata', streamId, mime: 'video/mp4' }, { kind: 'chunk', bytes: Buffer.from('video') },
      { kind: 'media_end', streamId, chunks: 1 },
      { kind: 'segment_finished', timings: { e2e_latency_ms: 12 }, continuationHandle: `handle-${request.segmentIdx}` },
    ]
    try {
      for (const output of script) {
        if (output instanceof Error || output.kind === 'segment_finished') {
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

function request(segmentIdx: number, signal?: AbortSignal): SegmentRequest {
  return {
    prompt: `scene-${segmentIdx}`, frameWidth: 1280, frameHeight: 704, numFrames: 121, segmentIdx,
    continueFrom: segmentIdx === 1 ? null : `handle-${segmentIdx - 1}`, referenceImages: [], ...(signal ? { signal } : {}),
  }
}

describe('streamSegmentToBrowser', () => {
  it('preserves request identity, browser order, delivered counts, and continuation handles across segments', async () => {
    const generation = new ScriptedGeneration()
    const target = new MediaTarget(generation)
    const requests = [request(1), request(2)]
    for (const segmentRequest of requests) {
      expect(await streamSegmentToBrowser(target, segmentRequest)).toEqual({
        deliveryStats: { timings: { e2e_latency_ms: 12 }, chunkCount: 1, byteCount: 5 },
        continuationHandle: `handle-${segmentRequest.segmentIdx}`,
      })
    }
    expect(generation.requests).toEqual(requests)
    expect(generation.requests[0]).toBe(requests[0])
    expect(target.emitted).toEqual([
      { type: 'media_init', segment_idx: 1, mime: 'video/mp4', stream_id: 'stream-1' },
      'video', { type: 'media_segment_complete', segment_idx: 1, stream_id: 'stream-1' },
      { type: 'media_init', segment_idx: 2, mime: 'video/mp4', stream_id: 'stream-2' },
      'video', { type: 'media_segment_complete', segment_idx: 2, stream_id: 'stream-2' },
    ])
  })

  it.each([true, false])('announces media completion only after the worker reply (success=%s)', async (successful) => {
    const outcome: SegmentOutput | Error = successful
      ? { kind: 'segment_finished', timings: { generation_ms: 2 }, continuationHandle: 'handle' }
      : new GenerationSegmentError('worker failed after media', 'RuntimeError', false)
    const generation = new ScriptedGeneration([
      { kind: 'media_metadata', streamId: 'stream', mime: 'video/mp4' }, { kind: 'chunk', bytes: Buffer.from('first') },
      { kind: 'media_end', streamId: 'stream', chunks: 1 }, outcome,
    ]).holdFinish()
    const target = new MediaTarget(generation)
    const delivery = streamSegmentToBrowser(target, request(1))
    const settled = delivery.then(() => 'resolved', () => 'rejected')
    await within(generation.terminalWait.promise)
    expect(target.emitted.at(-1)).toBe('first')
    generation.finish.resolve()
    if (successful) {
      expect(await delivery).toEqual({
        deliveryStats: { timings: { generation_ms: 2 }, chunkCount: 1, byteCount: 5 }, continuationHandle: 'handle',
      })
      expect(target.emitted.at(-1)).toEqual({ type: 'media_segment_complete', segment_idx: 1, stream_id: 'stream' })
    } else {
      await expect(delivery).rejects.toThrow('worker failed after media')
      expect(target.emitted.at(-1)).toBe('first')
    }
    expect(await settled).toBe(successful ? 'resolved' : 'rejected')
  })

  it.each([
    ['metadata', 'Segment 1 AV stream did not initialize (no media_init event)'],
    ['successful reply', 'Segment 1 stream ended without a successful worker reply'],
  ])('rejects a stream without its %s', async (missing, message) => {
    const script: SegmentOutput[] = [
      { kind: 'media_metadata', streamId: 'stream', mime: 'video/mp4' }, { kind: 'chunk', bytes: Buffer.from('video') },
      { kind: 'media_end', streamId: 'stream', chunks: 1 }, { kind: 'segment_finished', timings: {}, continuationHandle: 'handle' },
    ]
    script.splice(missing === 'metadata' ? 0 : -1, 1)
    const generation = new ScriptedGeneration(script)
    const target = new MediaTarget(generation)
    await expect(streamSegmentToBrowser(target, request(1))).rejects.toThrow(new Error(message))
    expect(generation.closed).toBe(true)
    expect(target.emitted.some(event => typeof event === 'object' && event['type'] === 'media_segment_complete')).toBe(false)
  })

  it.each([
    [new GenerationSegmentError('The worker rejected this shot.', 'ValueError', true), DreamverseValueError],
    [new GenerationSegmentError('fake GPU step failed', 'RuntimeError', false), Error],
  ])('converts worker failure %s to the reference error kind', async (failure, kind) => {
    const generation = new ScriptedGeneration([{ kind: 'media_metadata', streamId: 'stream', mime: 'video/mp4' }, failure])
    const error = await streamSegmentToBrowser(new MediaTarget(generation), request(1)).then(() => null, (reason: unknown) => reason)
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
      await streamSegmentToBrowser(target, request(1, abort.signal))
      await streamSegmentToBrowser(target, request(2, abort.signal))
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
  })

  it('counts only non-empty chunks after their socket write finishes', async () => {
    const generation = new ScriptedGeneration([
      { kind: 'media_metadata', streamId: 'stream', mime: 'video/mp4' }, { kind: 'chunk', bytes: Buffer.from('ab') },
      { kind: 'chunk', bytes: Buffer.alloc(0) }, { kind: 'chunk', bytes: Buffer.from('cde') },
      { kind: 'media_end', streamId: 'stream', chunks: 2 }, { kind: 'segment_finished', timings: {}, continuationHandle: 'handle' },
    ])
    const target = new MediaTarget(generation)
    target.holdBinary = new Deferred()
    const delivery = streamSegmentToBrowser(target, request(1))
    await within(target.receivedChunk.promise)
    expect(target.emitted).toEqual([{ type: 'media_init', segment_idx: 1, mime: 'video/mp4', stream_id: 'stream' }])
    target.holdBinary.resolve()
    expect((await within(delivery)).deliveryStats).toEqual({ timings: {}, chunkCount: 2, byteCount: 5 })
    expect(target.emitted.filter(event => typeof event === 'string')).toEqual(['ab', 'cde'])
  })
})
