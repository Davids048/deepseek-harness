/**
 * Types of the render mode seams: the facts of the model a provider serves, the request of each render mode, and the
 * events of a render stream. Every render mode has the same output: one video with audio, and its last frame.
 *
 * @module @dv/render-modes/types
 */

/**
 * The facts of the model that a render mode provider serves. Shot render reads them to choose the frame size and frame
 * count of a shot and to check the reference images of a `ref2va` call. Map keys keep the provider's values, such as
 * `16:9` or `720p`.
 */
export interface RenderModelFacts {
  /** The model ID the record report keeps (`model`); never shown to the user. */
  modelId: string
  /** The model's display name. */
  name: string
  /** The aspect ratios the model renders, the default first. */
  aspectRatios: string[]
  /** The resolutions the model renders, the default first. */
  resolutions: string[]
  /** `[width, height]` by aspect ratio and then by resolution, for every supported pair. */
  frameSizes: Record<string, Record<string, [number, number]>>
  /** The shortest shot in whole seconds. */
  minDurationSec: number
  /** The longest shot in whole seconds. */
  maxDurationSec: number
  /** The model's frame count by shot duration in whole seconds, for every duration from the minimum to the maximum. */
  numFramesByDurationSec: Record<string, number>
  /**
   * The most reference images one request carries besides its first frame; 0 for a render mode without reference
   * images (`t2va`).
   */
  maxReferenceImages: number
  /**
   * The prompt labels of the request images in request order (`Picture 1`, `Picture 2`, …): the reference images in
   * input order, then the first frame. Empty for a render mode without images.
   */
  imageLabels: string[]
  /** The provider's GPU seconds per rendered video second, for the GPU estimate of a render before it runs. */
  gpuSecondsPerVideoSecond: number
}

/**
 * One `ref2va` render: a prompt and at least one reference image, and optionally a first frame. The prompt names the
 * images by `imageLabels`: the reference images in order, then the first frame.
 */
export interface Ref2vaRequest {
  prompt: string
  /** Image bytes of the reference images in input order; 1 to `maxReferenceImages` of them. */
  references: Buffer[]
  /** Image bytes of the frame the video starts from, or null. */
  firstFrame: Buffer | null
  frameWidth: number
  frameHeight: number
  numFrames: number
  seed: number
}

/** One `t2va` render: a prompt only. */
export interface T2vaRequest {
  prompt: string
  frameWidth: number
  frameHeight: number
  numFrames: number
  seed: number
}

/**
 * One event of a render stream, in the order the provider sends them: the last frame (PNG bytes) before or after the
 * video, `video_start` with the video's media type, the video bytes in `chunk` events, then `done` with the backend's
 * timings (keys ending in `_ms` are milliseconds, other keys seconds). A failure rejects the iteration.
 */
export type RenderStreamEvent =
  | { kind: 'last_frame'; png: Buffer }
  | { kind: 'video_start'; mime: string }
  | { kind: 'chunk'; bytes: Buffer }
  | { kind: 'done'; timings: Record<string, number> }
