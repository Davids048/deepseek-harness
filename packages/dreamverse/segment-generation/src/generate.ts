/**
 * Generate one segment: request it from the generation backend with its conditioning images, hand the video to the
 * caller while it streams, and store the video and its last frame in the file store.
 *
 * @module @dreamverse/segment-generation/generate
 */

import { DreamverseValueError, GenerationSegmentError } from '@dreamverse/generation-client'
import { segmentRequestImages } from './conditioning.ts'
import type { AssetOwner, AssetRecord, AssetWriter, DreamverseAssetsManager, DreamverseGeneration } from './dependencies.ts'

/** One segment to generate. */
export interface SegmentGenerationRequest {
  prompt: string
  frameWidth: number
  frameHeight: number
  numFrames: number
  /** The generation mode; it decides which images the request carries in which order. */
  generationMode: string
  /** Selected reference images in selection order; the caller's project owns them. */
  referenceAssets: readonly AssetRecord[]
  /** The predecessor's last frame when the segment continues one, else null. */
  previousLastFrame: AssetRecord | null
  /** Owner of the video and last-frame files. */
  owner: AssetOwner
  /** Base name of the written files, such as the segment or node ID: `<name>.mp4` and `<name>.png`. */
  name: string
  seed?: number
  /** Aborting it cancels the backend request; `generate` then rejects with `signal.reason`. */
  signal?: AbortSignal
}

/** Where the caller receives the video while it streams, for example to forward it to a browser. */
export interface SegmentSink {
  /** The backend started the video with this MIME type. */
  videoStart?(mime: string): Promise<void>
  /** One non-empty piece of the fragmented MP4, in stream order. */
  chunk?(bytes: Buffer): Promise<void>
}

/** One generated segment and its stored files. */
export interface GeneratedSegment {
  /** The fragmented MP4: the bytes that the sink received. */
  video: AssetRecord
  /** The PNG of the segment's last decoded frame. */
  lastFrame: AssetRecord
  /** The video's MIME type with codecs, from the backend's video start. */
  mime: string
  /** The backend's timings from its `done` event. */
  timings: Record<string, number>
  /** The non-empty chunks that the sink accepted. */
  chunkCount: number
  /** The bytes of those chunks. */
  byteCount: number
}

/** The services that one segment generation calls. */
export interface SegmentGenerationServices {
  generation: DreamverseGeneration
  assets: DreamverseAssetsManager
}

/**
 * The error for a stream that sends video bytes or `done` before its video start.
 * @param name - the segment's base file name.
 * @returns the error.
 */
function notStarted(name: string): Error {
  return new Error(`Segment ${name} AV stream did not initialize (no video start)`)
}

/**
 * The rejection reason of an aborted generation: the abort reason itself when it is an `Error`.
 * @param signal - the aborted signal.
 * @returns the error that `generateSegment` rejects with.
 */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error(String(reason))
}

/**
 * Generate one segment and store its video and last frame with the requested owner.
 *
 * The request carries the conditioning images in the order of `segmentRequestImages` and always asks the backend for
 * the last frame. Each non-empty chunk goes to a file store writer and then to `sink.chunk`; the counts include only
 * chunks that the sink accepted. On `done` the writer commits the video, then the last frame is written. Any failure
 * removes the files of this segment, so both files exist only for a completely delivered segment. Leaving the stream
 * early cancels the backend request.
 * @param services - the generation backend and the file store.
 * @param request - the segment to generate.
 * @param sink - where the video goes while it streams.
 * @returns the stored video and last frame with the delivery statistics.
 * @throws {DreamverseValueError} for a backend `invalid_request` failure.
 * @throws Error with the backend message for any other backend failure, and for a stream that has no video start,
 *   no last frame, or no `done`.
 * @throws the abort reason of `request.signal` once it aborts.
 */
export async function generateSegment(
  services: SegmentGenerationServices,
  request: SegmentGenerationRequest,
  sink: SegmentSink = {},
): Promise<GeneratedSegment> {
  const { generation, assets } = services
  const { name, owner } = request
  let writer: AssetWriter | null = null
  let video: AssetRecord | null = null
  let mime: string | null = null
  let lastFrame: Buffer | null = null
  let chunkCount = 0
  let byteCount = 0
  try {
    const modelFacts = await generation.model()
    const referenceImages = await segmentRequestImages(
      modelFacts, request.generationMode, request.referenceAssets, request.previousLastFrame)
    const outputs = generation.generateSegment({
      prompt: request.prompt,
      frameWidth: request.frameWidth,
      frameHeight: request.frameHeight,
      numFrames: request.numFrames,
      referenceImages,
      returnLastFrame: true,
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    for await (const output of outputs) {
      switch (output.kind) {
        case 'last_frame':
          lastFrame = output.png
          break
        case 'video_start':
          mime = output.mime
          writer ??= assets.createWriter({ owner, name: `${name}.mp4`, mimeType: output.mime })
          await sink.videoStart?.(output.mime)
          break
        case 'chunk':
          if (output.bytes.length > 0) {
            if (writer === null) throw notStarted(name)
            await writer.write(output.bytes)
            await sink.chunk?.(output.bytes)
            chunkCount += 1
            byteCount += output.bytes.length
          }
          break
        case 'done': {
          if (writer === null || mime === null) throw notStarted(name)
          if (lastFrame === null) throw new Error(`Segment ${name} finished without the requested last frame`)
          video = await writer.commit()
          const frame = await assets.addBytes({ owner, name: `${name}.png`, mimeType: 'image/png' }, lastFrame)
          return { video, lastFrame: frame, mime, timings: output.timings, chunkCount, byteCount }
        }
        default: {
          const unexpected: never = output
          throw new Error(`Unexpected segment output: ${JSON.stringify(unexpected)}`)
        }
      }
    }
    throw new Error(`Segment ${name} stream ended without a successful backend reply`)
  } catch (error) {
    await writer?.abort()
    if (video !== null) assets.delete(video.assetId)
    if (request.signal?.aborted) throw abortReason(request.signal)
    if (error instanceof GenerationSegmentError) {
      throw error.isValueError ? new DreamverseValueError(error.message) : new Error(error.message)
    }
    throw error
  }
}
