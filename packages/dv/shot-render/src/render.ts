/**
 * The pure helpers of the Shot render operations: the frame size and frame count a shot asks the render mode for, the
 * prompt labels of a `ref2va` request's images, and the GPU time the backend reported.
 *
 * @module @dv/shot-render/render
 */
import type { RenderModelFacts } from '@dv/render-modes'

/** A params field as text, or the fallback when it is absent or not a string. */
export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** A params field as a finite number, or the fallback. */
export function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** The frame size and frame count a shot asks for, after the model facts validated the choices. */
export interface ShotGeometry {
  aspectRatio: string
  resolution: string
  width: number
  height: number
  durationSec: number
  numFrames: number
}

/**
 * Resolve a shot's geometry from its params and the served model's facts. Omitted params take the model's first
 * aspect ratio, first resolution, and shortest duration.
 * @param facts - the served model.
 * @param params - the record params.
 * @returns the geometry.
 * @throws Error naming the allowed values when a param is outside the model's facts.
 */
export function shotGeometry(facts: RenderModelFacts, params: Record<string, unknown>): ShotGeometry {
  const aspectRatio = text(params['aspect_ratio'], facts.aspectRatios[0] ?? '')
  const resolution = text(params['resolution'], facts.resolutions[0] ?? '')
  const size = facts.frameSizes[aspectRatio]?.[resolution]
  if (size === undefined) {
    throw new Error(`aspect_ratio and resolution must be one of ${facts.aspectRatios.join(', ')} at ${facts.resolutions.join(', ')}.`)
  }
  const durationSec = number(params['duration_sec'], facts.minDurationSec)
  const numFrames = facts.numFramesByDurationSec[String(durationSec)]
  if (numFrames === undefined) {
    throw new Error(`duration_sec must be a whole number from ${facts.minDurationSec} to ${facts.maxDurationSec}.`)
  }
  return { aspectRatio, resolution, width: size[0], height: size[1], durationSec, numFrames }
}

/** The prompt labels of a `ref2va` request's images, as the record report keeps them (`image_labels`). */
export interface ImageLabels {
  /** Labels of the reference images, in input order. */
  referenceLabels: string[]
  /** Label of the first frame; null when the request carries none. */
  firstFrameLabel: string | null
}

/**
 * Name the images of a `ref2va` request: the reference images take the first labels in input order, and the first
 * frame takes the next one.
 * @param facts - the served model.
 * @param referenceCount - the number of reference images.
 * @param firstFrame - whether the request carries a first frame.
 * @returns the labels; an image beyond the model's labels gets none.
 */
export function imageLabels(facts: RenderModelFacts, referenceCount: number, firstFrame: boolean): ImageLabels {
  return {
    referenceLabels: facts.imageLabels.slice(0, referenceCount),
    firstFrameLabel: firstFrame ? facts.imageLabels[referenceCount] ?? null : null,
  }
}

/**
 * The backend's end-to-end time of one request in seconds: the longest timing it reported, because the end-to-end
 * timing includes the others. Keys ending in `_ms` are milliseconds; other keys are seconds.
 * @param timings - the backend's `done` timings.
 * @returns seconds, rounded to milliseconds; 0 when the backend reported none.
 */
export function backendSeconds(timings: Record<string, number>): number {
  const seconds = Object.entries(timings).map(([key, value]) => key.endsWith('_ms') ? value / 1000 : value)
  return Math.round(Math.max(0, ...seconds) * 1000) / 1000
}

/** The MIME type without parameters, as the asset pool records it. */
export function baseMime(mime: string): string {
  return mime.replace(/;.*$/s, '').trim()
}
