/**
 * Fakes and mounting for the multiverse specs: a generation backend whose segments the spec finishes or fails, a file
 * store backed by temporary files, a prompt enhancer, a harness LLM whose replies the spec queues, and the harness
 * default-model selection. `startMultiverse` mounts the real project store and segment generation service over them,
 * then the tree and the director, in a fresh Cordis root; passing an earlier fixture's files, project root, and log
 * root mounts a restarted harness over the same stored data.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  AssetNotFoundError, type AssetId, type AssetOwner, type AssetRecord, type AssetWriteOptions, type AssetWriter, type MediaType,
} from '@dreamverse/assets-manager'
import type { ModelFacts, SegmentOutput, SegmentRequest } from '@dreamverse/generation-client'
import DreamverseProjectStore from '@dreamverse/project-store'
import type { ContinueVideoRequest, ExpandClipRequest, PromptResult } from '@dreamverse/prompt-enhancer'
import DreamverseSegmentGeneration from '@dreamverse/segment-generation'
import { vi } from 'vitest'
import type { ProposalRoute } from '../src/branch-proposals.ts'
import MultiverseDirector from '../src/director.ts'
import MultiverseTree from '../src/tree.ts'

/** A promise with its settle functions exposed. */
export class Deferred<T = void> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void
  reject!: (reason: Error) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    // A spec may fail a segment before the fake stream awaits its reply; the stream still observes the rejection.
    this.promise.catch((_error: unknown) => undefined)
  }
}

/**
 * Wait for a promise the way a real backend request waits for its reply: aborting the request's signal rejects with
 * the signal's reason.
 * @param promise - the awaited reply.
 * @param signal - the request's abort signal.
 * @returns the reply.
 */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await promise
  signal.throwIfAborted()
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted.')) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
  })
}

/** H3 reference-image facts: nine request images, and each continued segment starts from its predecessor's last frame. */
export function ref2vaFacts(): ModelFacts {
  return {
    modelId: 'h3-ref2va', name: 'H3 Ref2AV', generationModes: { ref2va: 'reference_images' },
    unsupportedGenerationModes: {}, aspectRatios: ['16:9'], resolutions: ['720p'],
    minSegmentDurationSec: 5, maxSegmentDurationSec: 7, maxReferenceImages: 9, maxReferenceAspectRatio: 4,
    usesPreviousFrame: true, frameSizes: { '16:9': { '720p': [1344, 768] } },
    numFramesByDurationSec: { 5: 124, 6: 141, 7: 175 },
    referenceLabels: Array.from({ length: 9 }, (_value, index) => `Picture ${index + 1}`),
  }
}

/** The last frame that `FakeGeneration` returns for its nth segment request. */
export function lastFrameBytes(callNumber: number): Buffer {
  return Buffer.from(`last frame ${callNumber}`)
}

/** The video bytes that `FakeGeneration` streams for its nth segment request, in two chunks. */
export function clipBytes(callNumber: number): Buffer {
  return Buffer.from(`clip ${callNumber} bytes`)
}

/** One segment request, held until the spec finishes or fails it. */
export interface SegmentCall {
  readonly request: SegmentRequest
  readonly reply: Deferred
}

/**
 * Generation backend for one model. Each segment emits the last frame, the video start, and its clip in two chunks,
 * then waits for the spec to finish it (`done`) or fail it, or for the request's signal to abort it.
 */
export class FakeGeneration {
  readonly calls: SegmentCall[] = []
  private readonly taken = new Set<SegmentCall>()
  private waiters: Array<(call: SegmentCall) => void> = []

  constructor(readonly facts: ModelFacts = ref2vaFacts()) {}

  async model(): Promise<ModelFacts> {
    return this.facts
  }

  generateSegment(request: SegmentRequest): AsyncIterable<SegmentOutput> {
    return this.outputs(request)
  }

  /** @returns the oldest segment request that no spec has taken yet, waiting for one to arrive when there is none. */
  async nextCall(): Promise<SegmentCall> {
    const pending = this.calls.find(call => !this.taken.has(call))
    if (pending !== undefined) {
      this.taken.add(pending)
      return pending
    }
    return await new Promise((resolve) => {
      this.waiters.push((call) => {
        this.taken.add(call)
        resolve(call)
      })
    })
  }

  /** Emit one segment's outputs; see the class description. */
  private async *outputs(request: SegmentRequest): AsyncGenerator<SegmentOutput> {
    const call: SegmentCall = { request, reply: new Deferred() }
    this.calls.push(call)
    const callNumber = this.calls.length
    for (const waiter of this.waiters.splice(0)) waiter(call)
    yield { kind: 'last_frame', png: lastFrameBytes(callNumber) }
    yield { kind: 'video_start', mime: 'video/mp4' }
    const clip = clipBytes(callNumber)
    yield { kind: 'chunk', bytes: clip.subarray(0, 4) }
    yield { kind: 'chunk', bytes: clip.subarray(4) }
    await abortable(call.reply.promise, request.signal)
    yield { kind: 'done', timings: { e2e_latency_ms: 1 } }
  }
}

/** The media type that a MIME type names. */
function mediaTypeOf(mimeType: string): MediaType {
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return 'image'
}

/**
 * File store whose files are temporary files. Library images hold `image <assetId>`; written and copied files hold the
 * bytes written or copied.
 */
export class FakeAssets {
  readonly root = mkdtempSync(join(tmpdir(), 'dreamverse-multiverse-assets-'))
  readonly retained: string[][] = []
  readonly released: string[][] = []
  /** Every owner passed to `deleteOwnedBy`, in call order. */
  readonly deletedOwners: AssetOwner[] = []
  private readonly records = new Map<string, AssetRecord>()
  private nextId = 0

  /**
   * Add an image to the library.
   * @param assetId - the asset ID.
   * @returns the stored record.
   */
  addImage(assetId: string): AssetRecord {
    return this.store(brandString<AssetId>(assetId), { owner: 'library', name: assetId, mimeType: 'image/png' }, imageBytes(assetId))
  }

  get(assetId: string): AssetRecord {
    const record = this.records.get(assetId)
    if (record === undefined) throw new AssetNotFoundError(`Asset '${assetId}' is unavailable. Select an asset from the library.`)
    return record
  }

  list(owner: AssetOwner = 'library'): AssetRecord[] {
    return [...this.records.values()].filter(record => record.owner === owner)
  }

  async copy(assetId: string, owner: AssetOwner): Promise<AssetRecord> {
    const source = this.get(assetId)
    return this.store(this.newId(), { owner, name: source.name, mimeType: source.mimeType }, readFileSync(source.filePath))
  }

  retain(assetIds: readonly string[]): AssetRecord[] {
    const records = assetIds.map(assetId => this.get(assetId))
    this.retained.push([...assetIds])
    return records
  }

  release(assetIds: readonly string[]): void {
    this.released.push([...assetIds])
  }

  createWriter(options: AssetWriteOptions): AssetWriter {
    const assetId = this.newId()
    const chunks: Buffer[] = []
    return {
      assetId,
      write: async (chunk) => { chunks.push(Buffer.from(chunk)) },
      commit: async () => this.store(assetId, options, Buffer.concat(chunks)),
      abort: async () => { chunks.length = 0 },
    }
  }

  async addBytes(options: AssetWriteOptions, bytes: Uint8Array): Promise<AssetRecord> {
    return this.store(this.newId(), options, Buffer.from(bytes))
  }

  delete(assetId: string): void {
    const record = this.records.get(assetId)
    if (record === undefined) return
    rmSync(record.filePath, { force: true })
    this.records.delete(assetId)
  }

  deleteOwnedBy(owner: AssetOwner): void {
    this.deletedOwners.push(owner)
    for (const record of this.list(owner)) this.delete(record.assetId)
  }

  /** @returns {@link UPLOAD_POLICY}. */
  uploadPolicy(): Record<string, unknown> {
    return UPLOAD_POLICY
  }

  /**
   * @param assetId - a stored file.
   * @returns the file's bytes.
   */
  read(assetId: string): Buffer {
    return readFileSync(this.get(assetId).filePath)
  }

  /** Remove the store's directory. */
  dispose(): void {
    rmSync(this.root, { recursive: true, force: true })
  }

  /** Write one file and its record. */
  private store(assetId: AssetId, options: AssetWriteOptions, bytes: Buffer): AssetRecord {
    const filePath = join(this.root, assetId)
    writeFileSync(filePath, bytes)
    const record: AssetRecord = {
      assetId, owner: options.owner, name: options.name, mediaType: mediaTypeOf(options.mimeType), mimeType: options.mimeType,
      filePath, sizeBytes: bytes.length, width: null, height: null, durationSec: null, createdAt: new Date().toISOString(),
    }
    this.records.set(assetId, record)
    return record
  }

  /** A new file ID. */
  private newId(): AssetId {
    this.nextId += 1
    return brandString<AssetId>(`file-${this.nextId}`)
  }
}

/** The upload policy that `FakeAssets` reports. */
export const UPLOAD_POLICY = { image: { mime_types: ['image/png'], max_bytes: 1024 } }

/** The file content of an image that `FakeAssets` stores. */
export function imageBytes(assetId: string): Buffer {
  return Buffer.from(`image ${assetId}`)
}

/** Build a successful prompt enhancer result. */
export function promptResult(prompt: string): PromptResult {
  return { prompt, fallbackUsed: false, error: null, provider: 'test', model: 'model-a', latencyMs: 1 }
}

/**
 * Prompt enhancer that expands the root to `Expanded: <prompt>`, continues a branch as `Continued: <direction>`, and
 * reports `model-a` as its rewrite model.
 */
export class FakePromptEnhancer {
  readonly expandClip = vi.fn(async (prompt: string | null, _options: ExpandClipRequest) => promptResult(`Expanded: ${prompt ?? ''}`))
  readonly continueVideo = vi.fn(async (direction: string | null, _options: ContinueVideoRequest) =>
    promptResult(`Continued: ${direction ?? ''}`))

  /** @returns `model-a`. */
  rewriteModel(): string {
    return 'model-a'
  }
}

/** A JSON reply with two branches named `<prefix> A` and `<prefix> B`. */
export function branchReply(prefix: string): string {
  return JSON.stringify({
    branches: [
      { label: `${prefix} A`, direction: `${prefix} A happens.` },
      { label: `${prefix} B`, direction: `${prefix} B happens.` },
    ],
  })
}

/**
 * Harness LLM whose calls answer queued text replies in order; an empty queue answers `branchReply('Option <n>')`
 * for the nth call. A queued `Error` finishes that call with an `error` finish reason. A queued promise holds the call
 * until the promise resolves to the reply text or the call's signal aborts.
 */
export class FakeLlm {
  readonly requests: GenerateOptions[] = []
  readonly replies: Array<string | Error | Promise<string>> = []

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const queued = this.replies.shift() ?? branchReply(`Option ${this.requests.length}`)
    return (async function* (): AsyncGenerator<StreamChunk> {
      const reply = queued instanceof Promise ? await abortable(queued, options.signal) : queued
      if (reply instanceof Error) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: reply.message, code: 'TEST' } } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

/** The default model selection that the fake `agentDefaultModel` reports. */
export const DEFAULT_ROUTE: ProposalRoute = { provider: 'test-provider', model: 'test-model', reasoningEffort: ReasoningEffortId('low') }

/** The fake services and stored data behind one mounted tree and director. */
export interface MultiverseFixture {
  root: Context
  generation: FakeGeneration
  assets: FakeAssets
  promptEnhancer: FakePromptEnhancer
  llm: FakeLlm
  /** The project store's root directory. */
  projectRoot: string
  /** The director's multiverse log root. */
  logRoot: string
  store: DreamverseProjectStore
  tree: MultiverseTree
  director: MultiverseDirector
}

/**
 * Mount the project store, the segment generation service, the tree, and the director over fakes. Without `previous`,
 * the file store, project root, and log root are new and the library holds images `ref-1` through `ref-3`; with
 * `previous`, the mount reuses that fixture's file store, project root, and log root, as a restarted harness does.
 * @param previous - an earlier fixture whose stored data the new mount reads.
 * @returns the root context, the fakes, and the mounted services.
 */
export async function startMultiverse(
  previous?: Pick<MultiverseFixture, 'assets' | 'projectRoot' | 'logRoot'>,
): Promise<MultiverseFixture> {
  const root = new Context()
  const generation = new FakeGeneration()
  const assets = previous?.assets ?? new FakeAssets()
  if (previous === undefined) for (const assetId of ['ref-1', 'ref-2', 'ref-3']) assets.addImage(assetId)
  const projectRoot = previous?.projectRoot ?? mkdtempSync(join(tmpdir(), 'dreamverse-multiverse-projects-'))
  const logRoot = previous?.logRoot ?? mkdtempSync(join(tmpdir(), 'dreamverse-multiverse-logs-'))
  const promptEnhancer = new FakePromptEnhancer()
  const llm = new FakeLlm()
  root.provide('dreamverseGeneration', generation)
  root.provide('dreamverseAssetsManager', assets)
  root.provide('dreamversePromptEnhancer', promptEnhancer)
  root.provide('llm', llm)
  root.provide('agentDefaultModel', { currentSelection: () => DEFAULT_ROUTE })
  await root.plugin(DreamverseProjectStore, { root: projectRoot }).await()
  await root.plugin(DreamverseSegmentGeneration).await()
  await root.plugin(MultiverseTree).await()
  await root.plugin(MultiverseDirector, { logRoot, proposalMaxTokens: 640 }).await()
  return {
    root, generation, assets, promptEnhancer, llm, projectRoot, logRoot, store: root.dreamverseProjectStore,
    tree: root.dreamverseMultiverseTree, director: root.dreamverseMultiverseDirector,
  }
}

/**
 * Unmount a fixture and remove its stored data.
 * @param fixture - the fixture to dispose.
 */
export async function disposeMultiverse(fixture: MultiverseFixture): Promise<void> {
  await fixture.root.fiber.dispose()
  fixture.assets.dispose()
  rmSync(fixture.projectRoot, { recursive: true, force: true })
  rmSync(fixture.logRoot, { recursive: true, force: true })
}

/**
 * Read the multiverse log that a fixture's director writes.
 * @param fixture - a fixture mounted once on its log root.
 * @returns the log file's name and its entries in file order.
 */
export function readMultiverseLog(fixture: MultiverseFixture): { fileName: string; entries: Array<Record<string, unknown>> } {
  const directory = join(fixture.logRoot, hostname())
  const [fileName = ''] = readdirSync(directory)
  const entries = readFileSync(join(directory, fileName), 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
  return { fileName, entries }
}

/**
 * Wait until a condition on the tree holds, checking now and after every tree change.
 * @param tree - the tree to watch.
 * @param condition - the awaited condition.
 * @param label - names the condition in the timeout error.
 */
export async function waitForTree(tree: MultiverseTree, condition: () => boolean, label: string): Promise<void> {
  if (condition()) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`${label} did not happen within 3 seconds`))
    }, 3000)
    const stop = tree.onChange(() => {
      if (!condition()) return
      clearTimeout(timer)
      stop()
      resolve()
    })
  })
}
