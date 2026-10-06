/**
 * The pure helpers of `shot.render`: the frame size and frame count a shot asks the backend for, the GPU time the
 * backend reported, and the DreamVerse asset record of an asset-pool asset that the conditioning helpers read.
 *
 * @module @dv/shot-render/render
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetRecord, ModelFacts } from '@dreamverse/segment-generation'
import type DvAssetPool from '@dv/asset-pool'
import type { AssetId } from '@dv/project'

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
  mode: string
  aspectRatio: string
  resolution: string
  width: number
  height: number
  durationSec: number
  numFrames: number
}

/**
 * Resolve a shot's geometry from its params and the served model's facts. Omitted params take the model's first
 * mode, first aspect ratio, first resolution, and shortest duration.
 * @param facts - the served model.
 * @param params - the record params.
 * @returns the geometry.
 * @throws Error naming the allowed values when a param is outside the model's facts.
 */
export function shotGeometry(facts: ModelFacts, params: Record<string, unknown>): ShotGeometry {
  const mode = text(params['generation_mode'], Object.keys(facts.generationModes)[0] ?? '')
  if (facts.generationModes[mode] === undefined) {
    throw new Error(`generation_mode must be one of ${Object.keys(facts.generationModes).join(', ')}.`)
  }
  const aspectRatio = text(params['aspect_ratio'], facts.aspectRatios[0] ?? '')
  const resolution = text(params['resolution'], facts.resolutions[0] ?? '')
  const size = facts.frameSizes[aspectRatio]?.[resolution]
  if (size === undefined) {
    throw new Error(`aspect_ratio and resolution must be one of ${facts.aspectRatios.join(', ')} at ${facts.resolutions.join(', ')}.`)
  }
  const durationSec = number(params['duration_sec'], facts.minSegmentDurationSec)
  const numFrames = facts.numFramesByDurationSec[String(durationSec)]
  if (numFrames === undefined) {
    throw new Error(`duration_sec must be a whole number from ${facts.minSegmentDurationSec} to ${facts.maxSegmentDurationSec}.`)
  }
  return { mode, aspectRatio, resolution, width: size[0], height: size[1], durationSec, numFrames }
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

/**
 * A DreamVerse asset record over an asset-pool asset, so the DreamVerse conditioning helpers can read the file.
 * @param pool - the asset pool.
 * @param asset - the asset.
 * @returns the record; its owner is nominal because the asset pool has no owners.
 */
export function assetRecord(pool: Pick<DvAssetPool, 'get' | 'path'>, asset: AssetId): AssetRecord {
  const meta = pool.get(asset)
  return {
    assetId: brandString<AssetRecord['assetId']>(asset), owner: 'library', name: meta.name,
    mediaType: meta.mime.startsWith('video/') ? 'video' : 'image', mimeType: meta.mime, filePath: pool.path(asset),
    sizeBytes: meta.size_bytes, width: meta.width, height: meta.height, durationSec: meta.duration_sec, createdAt: meta.created_at,
  }
}

/** The MIME type without parameters, as the asset pool records it. */
export function baseMime(mime: string): string {
  return mime.replace(/;.*$/s, '').trim()
}
