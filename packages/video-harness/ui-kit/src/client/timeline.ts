/**
 * Geometry of the single video track: how long each clip plays, where it starts, and how wide it is drawn.
 *
 * @module @video-harness/ui-kit/timeline
 */
import type { WireAsset, WireSequenceItem, WireState } from './types.ts'

/** The length assumed for a clip whose asset reports no duration. */
export const FALLBACK_CLIP_SECONDS = 5

/** One clip placed on the track. */
export interface PlacedClip {
  slot: number
  assetId: string
  inSec: number | null
  outSec: number | null
  /** Seconds the clip plays: `out - in`, else the asset duration, else the fallback. */
  seconds: number
  startSec: number
  x: number
  width: number
  /** The last-frame image of the record that produced the clip, when it has one. */
  thumbnail: string | null
  stale: boolean
  /** Whether the producing record sits on a draft branch. */
  draft: boolean
  producer: string | null
}

/**
 * How long a clip plays.
 * @param item - the clip.
 * @param asset - its asset record, when known.
 * @returns seconds.
 */
export function clipSeconds(item: WireSequenceItem, asset: WireAsset | undefined): number {
  const whole = asset?.durationSec ?? FALLBACK_CLIP_SECONDS
  const start = item.inSec ?? 0
  const end = item.outSec ?? whole
  return Math.max(0.1, end - start)
}

/**
 * Place the clips of a state.
 * @param state - the folded state.
 * @param pxPerSec - pixels per second.
 * @returns the clips in slot order and the track width.
 */
export function placeClips(state: WireState, pxPerSec: number): { clips: PlacedClip[]; width: number } {
  const assets = new Map(state.assets.map(asset => [asset.id, asset]))
  const ops = new Map(state.ops.map(op => [op.id, op]))
  let cursor = 0
  const clips: PlacedClip[] = []
  for (const item of [...(state.sequence?.items ?? [])].sort((a, b) => a.slot - b.slot)) {
    const seconds = clipSeconds(item, assets.get(item.assetId))
    const producerId = state.producers[item.assetId] ?? null
    const producer = producerId === null ? undefined : ops.get(producerId)
    const lastFrame = producer?.outputs.find(id => assets.get(id)?.mime.startsWith('image/')) ?? null
    clips.push({
      slot: item.slot, assetId: item.assetId, inSec: item.inSec, outSec: item.outSec, seconds, startSec: cursor,
      x: cursor * pxPerSec, width: seconds * pxPerSec,
      thumbnail: lastFrame, stale: producerId !== null && producerId in state.stale,
      draft: producer?.branch.startsWith('draft/') ?? false, producer: producerId,
    })
    cursor += seconds
  }
  return { clips, width: cursor * pxPerSec }
}

/**
 * Format seconds as `m:ss.s`.
 * @param seconds - a duration or position.
 * @returns the text.
 */
export function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${String(minutes)}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`
}
