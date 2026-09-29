/**
 * Controlled browser socket, generation backend, asset library, and prompt enhancer for project and user-action
 * specs. Each fake records what the project sent or requested so specs can assert exact order and payloads.
 */

import { Buffer } from 'node:buffer'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import {
  GenerationSegmentError,
  type AssetRecord,
  type ContinueVideoOptions,
  type DreamverseAssetsManager,
  type DreamverseGeneration,
  type DreamversePromptEnhancer,
  type ExpandClipOptions,
  type ModelFacts,
  type ProjectSocket,
  type PromptResult,
  type RewriteRolloutOptions,
  type RolloutResult,
  type SegmentOutput,
  type SegmentRequest,
} from '../src/index.ts'

/** A promise with its settle functions exposed. */
export class Deferred<T = void> {
  readonly promise: Promise<T>
  settled = false
  resolve!: (value: T) => void
  reject!: (reason: Error) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = (value) => { this.settled = true; resolve(value) }
      this.reject = (reason) => { this.settled = true; reject(reason) }
    })
  }
}

/**
 * Wait for a promise, failing the spec after a bounded delay instead of at the spec timeout.
 * @param promise - the awaited operation.
 * @param label - names the operation in the timeout error.
 * @returns the operation's result.
 */
export async function within<T>(promise: Promise<T>, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`${label} did not settle within 3 seconds`)) }, 3000)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Let every queued promise continuation run. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise<void>((resolve) => { setImmediate(resolve) })
}

/** One JSON event the project sent to the browser. */
export type BrowserEvent = Record<string, unknown>

/** Records JSON events and binary chunks in one ordered list; single events can be held or failed. */
export class FakeSocket implements ProjectSocket {
  readonly entries: (BrowserEvent | Buffer)[] = []
  private readonly holds = new Map<string, { held: Deferred; resume: Deferred }>()
  private readonly resumes: Deferred[] = []
  private readonly failures = new Map<string, Error>()
  private changed = new Deferred()

  /** Record a copy of the event after any hold or one-shot failure registered for its type. */
  async sendJson(event: object): Promise<void> {
    const type = String((event as BrowserEvent)['type'])
    const hold = this.holds.get(type)
    if (hold) {
      this.holds.delete(type)
      hold.held.resolve()
      await hold.resume.promise
    }
    const failure = this.failures.get(type)
    if (failure) {
      this.failures.delete(type)
      throw failure
    }
    this.record(structuredClone(event as BrowserEvent))
  }

  async sendBytes(chunk: Buffer): Promise<void> {
    this.record(chunk)
  }

  /**
   * Hold the next event of a type before it is recorded.
   * @param type - the browser event type.
   * @returns `held` resolves when the project reaches the send; `resume` lets it finish.
   */
  hold(type: string): { held: Deferred; resume: Deferred } {
    const hold = { held: new Deferred(), resume: new Deferred() }
    this.holds.set(type, hold)
    this.resumes.push(hold.resume)
    return hold
  }

  /** Let every held send finish. */
  resumeAll(): void {
    this.holds.clear()
    for (const resume of this.resumes) resume.resolve()
  }

  /**
   * Fail the next send of an event type without recording it.
   * @param type - the browser event type.
   * @param error - the send failure.
   */
  failNext(type: string, error: Error): void {
    this.failures.set(type, error)
  }

  /**
   * @param after - an index into `entries`.
   * @returns the JSON events recorded at or after the index.
   */
  events(after = 0): BrowserEvent[] {
    return this.entries.slice(after).filter((entry): entry is BrowserEvent => !Buffer.isBuffer(entry))
  }

  /**
   * @param type - the browser event type.
   * @param after - an index into `entries`.
   * @returns the recorded events of that type.
   */
  eventsOfType(type: string, after = 0): BrowserEvent[] {
    return this.events(after).filter(event => event['type'] === type)
  }

  /**
   * Wait for the first event of a type recorded at or after an index.
   * @param type - the browser event type.
   * @param after - an index into `entries`.
   * @returns the event.
   */
  async waitFor(type: string, after = 0): Promise<BrowserEvent> {
    return await within((async () => {
      for (;;) {
        const event = this.eventsOfType(type, after)[0]
        if (event) return event
        await this.changed.promise
      }
    })(), `browser event ${type}`)
  }

  /**
   * Wait for a `generation_round_status` event with a status, returning the latest match.
   * @param status - the round status.
   * @param after - an index into `entries`.
   * @returns the event.
   */
  async waitForStatus(status: string, after = 0): Promise<BrowserEvent> {
    return await within((async () => {
      for (;;) {
        const matches = this.eventsOfType('generation_round_status', after).filter(event => event['status'] === status)
        if (matches.length > 0) return matches.at(-1)!
        await this.changed.promise
      }
    })(), `generation_round_status ${status}`)
  }

  private record(entry: BrowserEvent | Buffer): void {
    this.entries.push(entry)
    const changed = this.changed
    this.changed = new Deferred()
    changed.resolve()
  }
}

/** One admitted segment request, held until the spec lets the backend reply. */
export interface SegmentCall {
  readonly request: SegmentRequest
  /** Resolve to let the backend reply. */
  readonly finish: Deferred
  /** Resolves when the request's abort signal closes the segment before the backend replied. */
  readonly cancelled: Deferred
  /** Replaces the backend's successful reply with this failure. */
  failWith: Error | null
}

/** A promise that resolves when the signal aborts, immediately when it has already aborted. */
function whenAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) return
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

/** The browser-visible message the generation backend sends for a continuation handle it no longer holds. */
export const STALE_CONTINUATION_MESSAGE = 'The video service can continue only its last completed segment.'

/**
 * Generation backend that serves one model's facts and emits media metadata and one chunk per segment, then holds
 * the reply until `finish`. Like the backend, it keeps continuation state only for its latest finished segment,
 * names finished segments `continuation-1`, `continuation-2`, and so on, and rejects any other `continueFrom`
 * handle with a `ValueError`. An abort rejects at once with `signal.reason`.
 */
export class FakeGeneration implements DreamverseGeneration {
  /** Every segment request in arrival order, including rejected requests. */
  readonly requests: SegmentRequest[] = []
  /** The admitted segment requests. */
  readonly calls: SegmentCall[] = []
  /** When set, each segment fails before any output, without admitting a call. */
  rejectSegments: Error | null = null
  /** When set, `model()` rejects with this error, as it does for an unreachable backend. */
  modelError: Error | null = null
  private latestContinuationHandle: string | null = null
  private finishedCount = 0
  private started: SegmentCall[] = []
  private startedChanged = new Deferred()

  /** @param facts - the served model's facts; specs may replace them before creating a project. */
  constructor(public facts: ModelFacts = ltxFacts()) {}

  async model(): Promise<ModelFacts> {
    if (this.modelError) throw this.modelError
    return this.facts
  }

  generateSegment(request: SegmentRequest): AsyncIterable<SegmentOutput> {
    return this.outputs(request)
  }

  /**
   * Wait for the next admitted segment request.
   * @returns the call, in admission order.
   */
  async nextCall(): Promise<SegmentCall> {
    return await within((async () => {
      for (;;) {
        const call = this.started.shift()
        if (call) return call
        await this.startedChanged.promise
      }
    })(), 'segment request')
  }

  /** Emit one segment's outputs; see the class description. */
  private async *outputs(request: SegmentRequest): AsyncGenerator<SegmentOutput> {
    this.requests.push(request)
    request.signal?.throwIfAborted()
    const continuable = request.continueFrom === null || request.continueFrom === this.latestContinuationHandle
    // A started segment replaces the continuation state; a failed or abandoned segment leaves none.
    this.latestContinuationHandle = null
    if (!continuable) throw new GenerationSegmentError(STALE_CONTINUATION_MESSAGE, 'ValueError', true)
    if (this.rejectSegments) throw this.rejectSegments
    const call: SegmentCall = { request, finish: new Deferred(), cancelled: new Deferred(), failWith: null }
    this.calls.push(call)
    this.started.push(call)
    const startedChanged = this.startedChanged
    this.startedChanged = new Deferred()
    startedChanged.resolve()
    const streamId = `stream-${request.segmentIdx}`
    yield { kind: 'media_metadata', streamId, mime: 'video/mp4' }
    yield { kind: 'chunk', bytes: Buffer.from('segment!') }
    const aborted = await Promise.race([call.finish.promise.then(() => false), whenAborted(request.signal).then(() => true)])
    if (aborted) {
      call.cancelled.resolve()
      throw request.signal?.reason
    }
    if (call.failWith) throw call.failWith
    yield { kind: 'media_end', streamId, chunks: 1 }
    this.finishedCount += 1
    this.latestContinuationHandle = `continuation-${this.finishedCount}`
    yield { kind: 'segment_finished', timings: { e2e_latency_ms: 1 }, continuationHandle: this.latestContinuationHandle }
  }
}

/**
 * The durations from `min` to `max` mapped to frame counts.
 * @param min - the shortest duration in seconds.
 * @param max - the longest duration in seconds.
 * @param frames - the frame count of one duration.
 * @returns the `numFramesByDurationSec` map.
 */
function framesByDuration(min: number, max: number, frames: (durationSec: number) => number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: max - min + 1 }, (_value, index) => [String(min + index), frames(min + index)]))
}

const FL2VA_MESSAGE = 'First/last frame mode (FL2VA) is not supported yet.'

/** Default served model: FastLTX 2.3 with text and first-frame modes, continuing each segment's predecessor. */
export function ltxFacts(): ModelFacts {
  return {
    modelId: 'fast-ltx23', name: 'FastLTX23', generationModes: { t2va: 'text', i2v: 'initial_image' },
    unsupportedGenerationModes: { fl2va: FL2VA_MESSAGE }, aspectRatios: ['16:9', '9:16'],
    resolutions: ['480p', '720p', '1080p'], minSegmentDurationSec: 1, maxSegmentDurationSec: 20,
    maxReferenceImages: 1, maxReferenceAspectRatio: null, usesPreviousFrame: true,
    frameSizes: {
      '16:9': { '480p': [896, 512], '720p': [1280, 704], '1080p': [1920, 1088] },
      '9:16': { '480p': [512, 896], '720p': [704, 1280], '1080p': [1088, 1920] },
    },
    // LTX rounds 24 fps durations up to its eight-frame grid.
    numFramesByDurationSec: framesByDuration(1, 20, durationSec => Math.ceil(durationSec * 24 / 8) * 8 + 1),
    referenceLabels: [],
  }
}

/** Reference-image model: independent H3 shots with up to nine images. */
export function ref2vaFacts(): ModelFacts {
  return {
    modelId: 'h3-ref2va', name: 'H3 Ref2AV', generationModes: { ref2va: 'reference_images' },
    unsupportedGenerationModes: { fl2va: FL2VA_MESSAGE }, aspectRatios: ['16:9'], resolutions: ['720p'],
    minSegmentDurationSec: 5, maxSegmentDurationSec: 15, maxReferenceImages: 9, maxReferenceAspectRatio: 4,
    usesPreviousFrame: false, frameSizes: { '16:9': { '720p': [1344, 768] } },
    // H3 aligns 24 fps durations up to 17 * n + 5 frames.
    numFramesByDurationSec: framesByDuration(5, 15, durationSec => Math.floor((durationSec * 24 - 5 + 16) / 17) * 17 + 5),
    referenceLabels: Array.from({ length: 9 }, (_value, index) => `Picture ${index + 1}`),
  }
}

/** The error that the asset library raises for an absent or deleted asset. */
class AssetNotFoundError extends Error {
  override name = 'AssetNotFoundError'
}

/**
 * The bytes that `FakeAssets` stores for an image.
 * @param assetId - the asset ID.
 * @returns the image file content.
 */
export function imageBytes(assetId: string): Buffer {
  return Buffer.from(`image ${assetId}`)
}

/**
 * The `referenceImages` entry that a segment request carries for a library image.
 * @param assetId - the asset ID.
 * @returns the image's name and bytes.
 */
export function referenceImage(assetId: string): { name: string; data: Buffer } {
  return { name: assetId, data: imageBytes(assetId) }
}

/**
 * Asset library with files in a temporary directory. A deleted asset keeps its file until its last retention is
 * released, as the reference `AssetLibrary` does.
 */
export class FakeAssets implements DreamverseAssetsManager {
  readonly root = mkdtempSync(join(tmpdir(), 'dreamverse-assets-manager-'))
  readonly retainRequests: string[][] = []
  readonly releaseRequests: string[][] = []
  /** Fails the next release request. */
  releaseError: Error | null = null
  private readonly records = new Map<string, AssetRecord>()
  private readonly retentions = new Map<string, number>()
  private readonly deleted = new Set<string>()

  /** Resolve every ID before retaining any, like the reference `AssetLibrary.retain`. */
  retain(assetIds: readonly string[]): AssetRecord[] {
    this.retainRequests.push([...assetIds])
    const records = assetIds.map((assetId) => {
      const record = this.records.get(assetId)
      if (record === undefined || this.deleted.has(assetId)) {
        throw new AssetNotFoundError(`Asset '${assetId}' is unavailable. Select an asset from the library.`)
      }
      return record
    })
    for (const assetId of assetIds) this.retentions.set(assetId, this.retainedCount(assetId) + 1)
    return records
  }

  /** Release one retention and remove deleted files that no retention protects any more. */
  release(assetIds: readonly string[]): void {
    this.releaseRequests.push([...assetIds])
    if (this.releaseError) {
      const error = this.releaseError
      this.releaseError = null
      throw error
    }
    for (const assetId of assetIds) {
      this.retentions.set(assetId, this.retainedCount(assetId) - 1)
      if (this.retainedCount(assetId) === 0 && this.deleted.has(assetId)) rmSync(this.filePath(assetId))
    }
  }

  /**
   * Add an image to the library; its file holds `imageBytes(assetId)`.
   * @param assetId - the asset ID.
   * @param size - the image width and height.
   * @returns the stored record.
   */
  addImage(assetId: string, size: [number, number] = [16, 16]): AssetRecord {
    return this.add(assetId, { mediaType: 'image', mimeType: 'image/png', width: size[0], height: size[1], durationSec: null })
  }

  /**
   * Add a video to the library.
   * @param assetId - the asset ID.
   * @returns the stored record.
   */
  addVideo(assetId: string): AssetRecord {
    return this.add(assetId, { mediaType: 'video', mimeType: 'video/mp4', width: 16, height: 16, durationSec: 1 })
  }

  /** Delete an asset from the library; its file remains while any action retains it. */
  deleteAsset(assetId: string): void {
    this.deleted.add(assetId)
    if (this.retainedCount(assetId) === 0) rmSync(this.filePath(assetId))
  }

  /** @returns whether the asset's file exists. */
  fileExists(assetId: string): boolean {
    return existsSync(this.filePath(assetId))
  }

  /** @returns the asset's outstanding retentions. */
  retainedCount(assetId: string): number {
    return this.retentions.get(assetId) ?? 0
  }

  /** @returns outstanding retentions across every asset. */
  totalRetained(): number {
    return [...this.retentions.values()].reduce((total, count) => total + count, 0)
  }

  /** Remove the library directory. */
  dispose(): void {
    rmSync(this.root, { recursive: true, force: true })
  }

  private filePath(assetId: string): string {
    return join(this.root, assetId)
  }

  private add(assetId: string, fields: Pick<AssetRecord, 'mediaType' | 'mimeType' | 'width' | 'height' | 'durationSec'>): AssetRecord {
    const content = imageBytes(assetId)
    writeFileSync(this.filePath(assetId), content)
    const record = { assetId, name: assetId, filePath: this.filePath(assetId), sizeBytes: content.length, ...fields }
    this.records.set(assetId, record)
    return record
  }
}

/** Python `_normalize_prompts_to_rewrite`. */
function normalizePrompts(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values.filter((value): value is string => typeof value === 'string' && value.trim() !== '').map(value => value.trim())
}

/**
 * Build a prompt enhancer result.
 * @param prompt - the returned prompt.
 * @param fields - result fields that replace the successful defaults.
 * @returns the result.
 */
export function promptResult(prompt: string, fields: Partial<PromptResult> = {}): PromptResult {
  return { prompt, fallbackUsed: false, error: null, provider: 'test', model: 'model-a', latencyMs: 2.345, ...fields }
}

/**
 * Prompt enhancer whose rollout returns `Scene 1..N`, where N is the normalized source length or the selected
 * segment count, like the reference test provider race.
 */
export class FakePromptEnhancer implements DreamversePromptEnhancer {
  readonly modelOptions = ['model-a', 'model-b']
  readonly expandClip = vi.fn(async (_prompt: string, _options: ExpandClipOptions): Promise<PromptResult> =>
    promptResult('Expanded clip'))

  readonly continueVideo = vi.fn(async (_prompt: string | null, _options: ContinueVideoOptions): Promise<PromptResult> =>
    promptResult('Following scene', { latencyMs: 3.456 }))

  readonly rewriteRollout = vi.fn(async (prompts: string[], options: RewriteRolloutOptions): Promise<RolloutResult> => {
    const normalized = normalizePrompts(options.promptsToRewrite)
    const sourcePrompts = normalized.length > 0 ? normalized : normalizePrompts(prompts)
    const count = sourcePrompts.length > 0 ? sourcePrompts.length : options.segmentCount
    const scenes = Array.from({ length: count }, (_value, index) => `Scene ${index + 1}`)
    return {
      prompts: scenes, sourcePrompts, fallbackUsed: false, error: null, provider: 'test', model: options.rewriteModel,
      latencyMs: 12.345, rolloutId: 'test-scenes', rolloutLabel: 'Test scenes',
      rawResponseText: JSON.stringify({ id: 'test-scenes', label: 'Test scenes', segment_prompts: scenes }),
    }
  })

  resolveRewriteModel(requestedModel: unknown): string {
    const candidate = typeof requestedModel === 'string' ? requestedModel.trim() : ''
    return this.modelOptions.includes(candidate) ? candidate : 'model-a'
  }

  resolveRewriteTemperature(requestedTemperature: unknown): number {
    return typeof requestedTemperature === 'number' ? Math.min(2, Math.max(0, requestedTemperature)) : 1
  }
}

/** A prompt-enhancer call held by `holdPromptCall`. */
export interface HeldPromptCall {
  /** Resolves when the enhancer receives its first call. */
  entered: Deferred
  /** Resolve to return the prepared result. */
  release: Deferred
  /** Resolves when the held call returned its result. */
  finished: Deferred
}

/**
 * Hold every call of an enhancer mock until `release` resolves, then return the prepared result.
 * @param mock - the enhancer method.
 * @param result - the result each held call returns.
 * @returns the gates of the held calls.
 */
export function holdPromptCall<R>(
  mock: { mockImplementation(implementation: (...args: never[]) => Promise<R>): unknown },
  result: () => R,
): HeldPromptCall {
  const held: HeldPromptCall = { entered: new Deferred(), release: new Deferred(), finished: new Deferred() }
  mock.mockImplementation(async () => {
    held.entered.resolve()
    await held.release.promise
    held.finished.resolve()
    return result()
  })
  return held
}
