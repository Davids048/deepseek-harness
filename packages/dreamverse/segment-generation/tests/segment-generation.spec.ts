/**
 * `dreamverseSegmentGeneration` on fake services: the request it sends, the files it stores, what the sink receives,
 * and the error kinds and file cleanup of failed, incomplete, and aborted segments.
 */
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { DreamverseValueError, GenerationSegmentError, type SegmentOutput } from '@dreamverse/generation-client'
import { afterEach, describe, expect, it } from 'vitest'
import DreamverseSegmentGeneration, { type SegmentGenerationRequest, type SegmentSink } from '../src/index.ts'
import { Deferred, FakeAssets, ScriptedGeneration, ltxFacts, within } from './fakes.ts'

const VIDEO_MIME = 'video/mp4; codecs="avc1.42C028, mp4a.40.2"'

/** The fake services of the current spec. */
let assets = new FakeAssets()
afterEach(() => { assets.dispose() })

/**
 * Mount the service on a generation backend and a fresh file store.
 * @param generation - the generation backend.
 * @returns the mounted service.
 */
async function mount(generation: ScriptedGeneration): Promise<DreamverseSegmentGeneration> {
  assets = new FakeAssets()
  const ctx = new Context()
  ctx.provide('dreamverseGeneration', generation)
  ctx.provide('dreamverseAssetsManager', assets)
  await ctx.plugin(DreamverseSegmentGeneration)
  return ctx.dreamverseSegmentGeneration
}

/** A ref2va segment of project `p1` named `segment-1`. */
function request(fields: Partial<SegmentGenerationRequest> = {}): SegmentGenerationRequest {
  return {
    prompt: 'scene-1', frameWidth: 1344, frameHeight: 768, numFrames: 124, generationMode: 'ref2va', referenceAssets: [],
    previousLastFrame: null, owner: 'project:p1', name: 'segment-1', ...fields,
  }
}

/** A sink that records what it receives and can hold or reject chunk delivery. */
class RecordingSink implements SegmentSink {
  readonly received: string[] = []
  readonly receivedChunk = new Deferred()
  holdChunk: Deferred | null = null
  rejectChunks = false

  async videoStart(mime: string): Promise<void> {
    this.received.push(`start ${mime}`)
    await Promise.resolve()
  }

  async chunk(bytes: Buffer): Promise<void> {
    this.receivedChunk.resolve()
    if (this.holdChunk) await this.holdChunk.promise
    if (this.rejectChunks) throw new Error('output closed')
    this.received.push(bytes.toString('utf8'))
  }
}

describe('dreamverseSegmentGeneration.generate', () => {
  it('sends the conditioning images, streams the video to the sink, and stores the video and last frame', async () => {
    const generation = new ScriptedGeneration()
    const service = await mount(generation)
    const side = assets.put('project:p1', 'side.png', Buffer.from('side'))
    const previous = assets.put('project:p1', 'segment-0.png', Buffer.from('previous frame'))
    const sink = new RecordingSink()
    const result = await service.generate(request({ referenceAssets: [side], previousLastFrame: previous, seed: 7 }), sink)

    expect(generation.requests).toHaveLength(1)
    expect(generation.requests[0]).toMatchObject({
      prompt: 'scene-1', frameWidth: 1344, frameHeight: 768, numFrames: 124, seed: 7, returnLastFrame: true,
    })
    expect(generation.requests[0]?.referenceImages.map(String)).toEqual(['side', 'previous frame'])
    expect(sink.received).toEqual([`start ${VIDEO_MIME}`, 'video'])
    expect(result).toMatchObject({ mime: VIDEO_MIME, timings: { e2e_latency_ms: 12 }, chunkCount: 1, byteCount: 5 })
    expect(result.video).toMatchObject({ owner: 'project:p1', name: 'segment-1.mp4', mimeType: VIDEO_MIME })
    expect(result.lastFrame).toMatchObject({ owner: 'project:p1', name: 'segment-1.png', mimeType: 'image/png' })
    expect(readFileSync(result.video.filePath, 'utf8')).toBe('video')
    expect(readFileSync(result.lastFrame.filePath, 'utf8')).toBe('frame of scene-1')
  })

  it('stores the segment without a sink', async () => {
    const service = await mount(new ScriptedGeneration())
    const result = await service.generate(request())
    expect([result.chunkCount, result.byteCount]).toEqual([1, 5])
    expect([assets.hasFile(result.video.assetId), assets.hasFile(result.lastFrame.assetId)]).toEqual([true, true])
  })

  it('counts only non-empty chunks after the sink accepts them', async () => {
    const generation = new ScriptedGeneration(ltxFacts(), [
      { kind: 'last_frame', png: Buffer.from('frame') }, { kind: 'video_start', mime: 'video/mp4' },
      { kind: 'chunk', bytes: Buffer.from('ab') }, { kind: 'chunk', bytes: Buffer.alloc(0) },
      { kind: 'chunk', bytes: Buffer.from('cde') }, { kind: 'done', timings: {} },
    ])
    const service = await mount(generation)
    const sink = new RecordingSink()
    sink.holdChunk = new Deferred()
    const delivery = service.generate(request({ generationMode: 't2va' }), sink)
    await within(sink.receivedChunk.promise)
    expect(sink.received).toEqual(['start video/mp4'])
    sink.holdChunk.resolve()
    const result = await within(delivery)
    expect([result.chunkCount, result.byteCount]).toEqual([2, 5])
    expect(sink.received).toEqual(['start video/mp4', 'ab', 'cde'])
    expect(readFileSync(result.video.filePath, 'utf8')).toBe('abcde')
  })

  it.each([
    [new GenerationSegmentError('The backend rejected this shot.', 'invalid_request', true), DreamverseValueError],
    [new GenerationSegmentError('fake GPU step failed', 'generation_failed', false), Error],
  ])('converts backend failure %s to its error kind and stores nothing', async (failure, kind) => {
    const service = await mount(new ScriptedGeneration(undefined, [
      { kind: 'video_start', mime: 'video/mp4' }, { kind: 'chunk', bytes: Buffer.from('video') }, failure,
    ]))
    const error = await service.generate(request()).then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(kind)
    expect(error).not.toBeInstanceOf(GenerationSegmentError)
    expect(error instanceof DreamverseValueError).toBe(kind === DreamverseValueError)
    expect((error as Error).message).toBe(failure.message)
    expect(assets.files()).toEqual([])
  })

  it.each([
    ['video start', 'Segment segment-1 AV stream did not initialize (no video start)'],
    ['successful reply', 'Segment segment-1 stream ended without a successful backend reply'],
    ['last frame', 'Segment segment-1 finished without the requested last frame'],
  ])('rejects a stream without its %s and stores nothing', async (missing, message) => {
    const script: SegmentOutput[] = [
      { kind: 'last_frame', png: Buffer.from('frame') }, { kind: 'video_start', mime: 'video/mp4' },
      { kind: 'chunk', bytes: Buffer.from('video') }, { kind: 'done', timings: {} },
    ]
    if (missing === 'video start') script.splice(1, 1)
    if (missing === 'successful reply') script.splice(-1, 1)
    if (missing === 'last frame') script.splice(0, 1)
    const generation = new ScriptedGeneration(undefined, script)
    const service = await mount(generation)
    await expect(service.generate(request())).rejects.toThrow(new Error(message))
    expect(generation.closed).toBe(true)
    expect(assets.files()).toEqual([])
  })

  it('removes the stored video when writing the last frame fails', async () => {
    const service = await mount(new ScriptedGeneration())
    assets.addBytesError = new Error('disk full')
    await expect(service.generate(request())).rejects.toThrow('disk full')
    expect(assets.files()).toEqual([])
    expect(assets.records.size).toBe(0)
  })

  it.each(['abort', 'sink failure'])('closes the backend stream after %s without waiting for the reply', async (ending) => {
    const generation = new ScriptedGeneration().holdFinish()
    const service = await mount(generation)
    const sink = new RecordingSink()
    const abort = new AbortController()
    const reason = new Error('Project disconnected.')
    if (ending === 'abort') sink.holdChunk = new Deferred()
    else sink.rejectChunks = true
    const settled = service.generate(request({ signal: abort.signal }), sink).then(() => null, (error: unknown) => error)
    await within(sink.receivedChunk.promise)
    if (ending === 'abort') {
      // The held sink write finishes; the next read observes the abort.
      abort.abort(reason)
      sink.holdChunk!.resolve()
    }
    const error = await within(settled)
    if (ending === 'abort') expect(error).toBe(reason)
    else expect((error as Error).message).toBe('output closed')
    expect([generation.closed, generation.finish.settled]).toEqual([true, false])
    expect(assets.files()).toEqual([])
  })

  it('rejects with the abort reason when the signal aborts before the request', async () => {
    const generation = new ScriptedGeneration()
    const service = await mount(generation)
    const abort = new AbortController()
    const reason = new Error('Project disconnected.')
    abort.abort(reason)
    await expect(service.generate(request({ signal: abort.signal }))).rejects.toBe(reason)
    expect(assets.files()).toEqual([])
  })

})
