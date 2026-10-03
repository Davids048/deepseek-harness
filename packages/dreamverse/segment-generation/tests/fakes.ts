/**
 * Fakes for the segment generation specs: served model facts, a file store in a temporary directory, and a generation
 * backend that streams a scripted segment.
 */
import { Buffer } from 'node:buffer'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { open, rename, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AssetOwner,
  AssetRecord,
  AssetWriteOptions,
  AssetWriter,
  DreamverseAssetsManager,
  DreamverseGeneration,
  ModelFacts,
  SegmentOutput,
  SegmentRequest,
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
 * Wait for a promise, failing the spec when it does not settle within 3 seconds.
 * @param promise - the awaited operation.
 * @returns the operation's result.
 */
export async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error('operation did not settle within 3 seconds')) }, 3000)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Frame counts for each whole-second duration from `min` to `max`. */
function framesByDuration(min: number, max: number, frames: (durationSec: number) => number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: max - min + 1 }, (_value, index) => [String(min + index), frames(min + index)]))
}

const FL2VA_MESSAGE = 'First/last frame mode (FL2VA) is not supported yet.'

/** FastLTX 2.3 with text and first-frame modes, continuing each segment's predecessor. */
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

/**
 * Reference-image model as `dreamverseGeneration` reports the streaming_v2 backend: up to nine request images, and each
 * continued shot starts from its predecessor's last frame.
 */
export function ref2vaFacts(): ModelFacts {
  return {
    modelId: 'h3-ref2va', name: 'H3 Ref2AV', generationModes: { ref2va: 'reference_images' },
    unsupportedGenerationModes: {}, aspectRatios: ['16:9'], resolutions: ['720p'],
    minSegmentDurationSec: 5, maxSegmentDurationSec: 15, maxReferenceImages: 9, maxReferenceAspectRatio: 4,
    usesPreviousFrame: true, frameSizes: { '16:9': { '720p': [1344, 768] } },
    // H3 aligns 24 fps durations up to 17 * n + 5 frames.
    numFramesByDurationSec: framesByDuration(5, 15, durationSec => Math.floor((durationSec * 24 - 5 + 16) / 17) * 17 + 5),
    referenceLabels: Array.from({ length: 9 }, (_value, index) => `Picture ${index + 1}`),
  }
}

/**
 * File store whose files live in one temporary directory: `<assetId>.partial` while a writer writes, `<assetId>` after
 * it commits. Records keep the owner, name, and MIME type that the caller gave.
 */
export class FakeAssets implements DreamverseAssetsManager {
  readonly root = mkdtempSync(join(tmpdir(), 'dreamverse-segment-generation-'))
  readonly records = new Map<string, AssetRecord>()
  /** When set, `addBytes` rejects with this error. */
  addBytesError: Error | null = null
  private nextId = 1

  /**
   * Store a file directly, as a library upload or an earlier segment's last frame.
   * @param owner - the file's owner.
   * @param name - the file name.
   * @param bytes - the file content.
   * @returns the record.
   */
  put(owner: AssetOwner, name: string, bytes: Buffer): AssetRecord {
    const assetId = `asset-${this.nextId++}`
    writeFileSync(join(this.root, assetId), bytes)
    return this.index(assetId, { owner, name, mimeType: name.endsWith('.png') ? 'image/png' : 'video/mp4' }, bytes.length)
  }

  createWriter(options: AssetWriteOptions): AssetWriter {
    const assetId = `asset-${this.nextId++}`
    const partialPath = join(this.root, `${assetId}.partial`)
    let file: FileHandle | null = null
    let size = 0
    let committed = false
    return {
      assetId,
      write: async (chunk) => {
        file ??= await open(partialPath, 'w')
        await file.write(chunk)
        size += chunk.length
      },
      commit: async () => {
        file ??= await open(partialPath, 'w')
        await file.close()
        await rename(partialPath, join(this.root, assetId))
        committed = true
        return this.index(assetId, options, size)
      },
      abort: async () => {
        if (committed) return
        await file?.close()
        file = null
        await rm(partialPath, { force: true })
      },
    }
  }

  async addBytes(options: AssetWriteOptions, bytes: Uint8Array): Promise<AssetRecord> {
    if (this.addBytesError) throw this.addBytesError
    const assetId = `asset-${this.nextId++}`
    writeFileSync(join(this.root, assetId), bytes)
    return await Promise.resolve(this.index(assetId, options, bytes.length))
  }

  delete(assetId: string): void {
    rmSync(join(this.root, assetId), { force: true })
    this.records.delete(assetId)
  }

  /** @returns the names of the files in the store directory, including unfinished ones. */
  files(): string[] {
    return readdirSync(this.root).sort()
  }

  /** @returns whether the asset's file exists. */
  hasFile(assetId: string): boolean {
    return existsSync(join(this.root, assetId))
  }

  /** Remove the store directory. */
  dispose(): void {
    rmSync(this.root, { recursive: true, force: true })
  }

  private index(assetId: string, options: AssetWriteOptions, sizeBytes: number): AssetRecord {
    const record: AssetRecord = {
      assetId, owner: options.owner, name: options.name, mediaType: options.mimeType.split('/')[0] ?? '',
      mimeType: options.mimeType, filePath: join(this.root, assetId), sizeBytes, width: null, height: null,
      durationSec: null, createdAt: '2026-10-02T00:00:00.000Z',
    }
    this.records.set(assetId, record)
    return record
  }
}

/**
 * Yields scripted outputs and holds the terminal outcome (success or failure) until `finish`. An abort rejects at once
 * with `signal.reason`, as the generation client does after cancelling the segment's request.
 */
export class ScriptedGeneration implements DreamverseGeneration {
  readonly requests: SegmentRequest[] = []
  /** Resolved unless `holdFinish()` holds the backend reply. */
  finish = new Deferred()
  readonly terminalWait = new Deferred()
  /** True after the iteration ended, when the client has cancelled the segment's request. */
  closed = false

  /**
   * @param facts - the served model's facts.
   * @param script - the outputs; the default streams a last frame, a video start, one chunk, and `done`.
   */
  constructor(private readonly facts: ModelFacts = ref2vaFacts(), private readonly script?: (SegmentOutput | Error)[]) {
    this.finish.resolve()
  }

  holdFinish(): this {
    this.finish = new Deferred()
    return this
  }

  async model(): Promise<ModelFacts> {
    return await Promise.resolve(this.facts)
  }

  generateSegment(request: SegmentRequest): AsyncIterable<SegmentOutput> {
    this.requests.push(request)
    return this.iterate(request)
  }

  private async *iterate(request: SegmentRequest): AsyncGenerator<SegmentOutput> {
    const script = this.script ?? [
      { kind: 'last_frame', png: Buffer.from(`frame of ${request.prompt}`) },
      { kind: 'video_start', mime: 'video/mp4; codecs="avc1.42C028, mp4a.40.2"' }, { kind: 'chunk', bytes: Buffer.from('video') },
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

/** Resolve once the signal aborts. */
function aborts(signal: AbortSignal | undefined): Promise<true> {
  return new Promise((resolve) => {
    if (signal?.aborted) resolve(true)
    signal?.addEventListener('abort', () => { resolve(true) }, { once: true })
  })
}
