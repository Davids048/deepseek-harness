/**
 * Values that the DreamVerse generation backend API returns and accepts. TypeScript fields use camelCase; keys of
 * nested maps keep the backend's values, such as `16:9` or `720p`.
 *
 * @module @dreamverse/generation-client/types
 */

/** The served model's facts from `GET /v1/model`, computed from the reference `ModelCapabilities`. */
export interface ModelFacts {
  modelId: string
  name: string
  /** Wire generation-mode IDs mapped to their input kind: `text`, `initial_image`, or `reference_images`. */
  generationModes: Record<string, string>
  /** Wire generation-mode IDs that the model rejects, mapped to the rejection message. */
  unsupportedGenerationModes: Record<string, string>
  aspectRatios: string[]
  resolutions: string[]
  minSegmentDurationSec: number
  maxSegmentDurationSec: number
  maxReferenceImages: number
  maxReferenceAspectRatio: number | null
  /** Whether a segment continues from the preceding segment's generated video. */
  usesPreviousFrame: boolean
  /** `[width, height]` by aspect ratio and then by resolution, for every supported pair. */
  frameSizes: Record<string, Record<string, [number, number]>>
  /** Native frame count by segment duration in seconds, for every duration from the minimum to the maximum. */
  numFramesByDurationSec: Record<string, number>
  /** Prompt labels of the reference images; the labels for N images are the first N entries. */
  referenceLabels: string[]
}

/** Backend readiness from `GET /readyz`. */
export interface GenerationReadiness {
  ready: boolean
  /** The backend's `detail` while it is not ready; null when it is ready. */
  detail: string | null
}

/** The inputs of one `generate_segment` request. */
export interface SegmentRequest {
  prompt: string
  frameWidth: number
  frameHeight: number
  numFrames: number
  /** The segment's one-based position in its display sequence. */
  segmentIdx: number
  /** The continuation handle of the segment that this segment continues, or null to start fresh video. */
  continueFrom: string | null
  /** Image bytes in selection order; the backend writes each image under its `name`. */
  referenceImages: { name: string; data: Buffer }[]
  /** Aborting closes the request's socket and rejects the iteration with `signal.reason`. */
  signal?: AbortSignal
}

/** One output of a segment request, in the order the backend sent it. */
export type SegmentOutput =
  | { kind: 'media_metadata'; streamId: string; mime: string }
  | { kind: 'chunk'; bytes: Buffer }
  | { kind: 'media_end'; streamId: string; chunks: number }
  | { kind: 'segment_finished'; timings: Record<string, number>; continuationHandle: string }
