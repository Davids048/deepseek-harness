/**
 * Geometry of one timeline in the timeline editor: which timelines a state holds, how long each clip plays after its in
 * and out points, where it starts on the track, and which clip plays at a given time.
 */
import { FALLBACK_CLIP_SECONDS } from '@dv/ui-kit/timeline.ts'
import type { Clip, Timeline, WireState } from '@dv/ui-kit/types.ts'

/**
 * Whether a clip can play: `ready` when it has its asset, `rendering` while the render it waits for is pending or
 * running, `failed` when that render ended without the asset. Derived from the clip's source record, never stored.
 */
export type ClipStatus = 'ready' | 'rendering' | 'failed'

/** One clip placed on the track, with its in and out points resolved to numbers. */
export interface TrackClip {
  /** The 1-based position of the clip on its timeline. */
  position: number
  /** The clip ID, which the clip operations take in their `clip` param. */
  clip: string
  /** The asset the clip plays; null for a placeholder clip, whose render is not done. */
  assetId: string | null
  status: ClipStatus
  /** The recorded in point, or null when the clip starts at the asset's start. */
  rawIn: number | null
  /** The recorded out point, or null when the clip ends at the asset's end. */
  rawOut: number | null
  /** Asset time where the clip starts playing. */
  inSec: number
  /** Asset time where the clip stops playing. */
  outSec: number
  /** Length of the whole asset; for a placeholder clip, the `duration_sec` param of the render it waits for. */
  assetSeconds: number
  /** Seconds the clip plays: `outSec - inSec`. */
  seconds: number
  /** Timeline time where the clip starts. */
  startSec: number
  /** The image the producing record left beside the clip, used as the track thumbnail. */
  thumbnail: string | null
  stale: boolean
  draft: boolean
}

/**
 * The timelines of a state.
 * @param state - the branch state.
 * @returns the timelines in creation order.
 */
export function timelinesOf(state: WireState): Timeline[] {
  return state.components.timeline.timelines
}

/**
 * The first free timeline ID of the form `t<n>`, starting after the current count.
 * @param timelines - the existing timelines.
 * @returns the ID for a new timeline.
 */
export function nextTimelineId(timelines: Timeline[]): string {
  const taken = new Set(timelines.map(timeline => timeline.id))
  let n = timelines.length + 1
  while (taken.has(`t${String(n)}`)) n += 1
  return `t${String(n)}`
}

/**
 * Place the clips of one timeline on the track in playback order. A clip is a draft when the shown branch is a draft
 * branch and the clip is new there: the draft produced its asset, or the same timeline on `main` has no matching clip
 * (same asset, in point, and out point). Records of an accepted draft keep their `draft/` branch name but are on
 * `main`, so nothing on `main` is a draft. A placeholder clip (no asset yet) takes its length and its status from the
 * render record it waits for.
 * @param state - the branch state, for asset durations, thumbnails, and stale marks.
 * @param timeline - the timeline, or null when the project has none.
 * @param branch - the shown branch: `main` or a `draft/<session>` branch.
 * @param baseClips - the clips of the same timeline on `main`, when a draft is shown.
 * @returns the clips and the total length in seconds.
 */
export function placeTimeline(state: WireState, timeline: Timeline | null, branch = 'main', baseClips: Clip[] = []): { clips: TrackClip[]; total: number } {
  const assets = new Map(state.assets.map(asset => [asset.id, asset]))
  const proj = state.components.proj
  const records = new Map(proj.records.map(record => [record.id, record]))
  const clips: TrackClip[] = []
  let cursor = 0
  // Each clip on `main` matches at most one clip of the draft.
  const unmatched = new Map<string, number>()
  const keyOf = (clip: Clip): string => `${clip.asset ?? clip.source?.record ?? ''}|${String(clip.in_sec)}|${String(clip.out_sec)}`
  for (const clip of baseClips) unmatched.set(keyOf(clip), (unmatched.get(keyOf(clip)) ?? 0) + 1)
  for (const [index, clip] of (timeline?.clips ?? []).entries()) {
    const source = clip.source === null ? undefined : records.get(clip.source.record)
    const renderSeconds = source?.params['duration_sec']
    const assetSeconds = clip.asset === null
      ? typeof renderSeconds === 'number' ? renderSeconds : FALLBACK_CLIP_SECONDS
      : assets.get(clip.asset)?.duration_sec ?? FALLBACK_CLIP_SECONDS
    const inSec = clip.in_sec ?? 0
    const outSec = clip.out_sec ?? assetSeconds
    const seconds = Math.max(0.1, outSec - inSec)
    const rendering = source === undefined || source.status === 'pending' || source.status === 'running'
    const status: ClipStatus = clip.asset !== null ? 'ready' : rendering ? 'rendering' : 'failed'
    const producerId = (clip.asset === null ? clip.source?.record : proj.created_by[clip.asset]) ?? null
    const producer = producerId === null ? undefined : records.get(producerId)
    const thumbnail = producer?.outputs.find(id => assets.get(id)?.mime.startsWith('image/')) ?? null
    const left = unmatched.get(keyOf(clip)) ?? 0
    if (left > 0) unmatched.set(keyOf(clip), left - 1)
    clips.push({
      position: index + 1, clip: clip.id, assetId: clip.asset, status, rawIn: clip.in_sec, rawOut: clip.out_sec, inSec, outSec,
      assetSeconds, seconds, startSec: cursor, thumbnail, stale: producerId !== null && producerId in proj.stale,
      draft: branch.startsWith('draft/') && (producer?.branch === branch || left === 0),
    })
    cursor += seconds
  }
  return { clips, total: cursor }
}

/**
 * The clip that plays at a timeline time. A time at or past the end resolves to the last clip.
 * @param clips - the placed clips.
 * @param position - timeline time in seconds.
 * @returns the clip's index, or -1 when there are no clips.
 */
export function clipIndexAt(clips: TrackClip[], position: number): number {
  const index = clips.findIndex(clip => position < clip.startSec + clip.seconds)
  return index === -1 ? clips.length - 1 : index
}

/**
 * The first clip at or after an index that can play.
 * @param clips - the placed clips.
 * @param from - the index to start at.
 * @returns the clip's index, or -1 when no later clip is ready.
 */
export function readyIndexFrom(clips: TrackClip[], from: number): number {
  return clips.findIndex((clip, at) => at >= from && clip.status === 'ready')
}

/**
 * Where a clip lands when it is dropped with its center at `centerSec`: one plus the number of other clips whose
 * centers lie before it.
 * @param clips - the placed clips.
 * @param centerSec - timeline time of the dropped clip's center.
 * @param exclude - the position of the dragged clip, or null for an inserted asset.
 * @returns the 1-based position.
 */
export function dropPosition(clips: TrackClip[], centerSec: number, exclude: number | null): number {
  return 1 + clips.filter(clip => clip.position !== exclude && clip.startSec + clip.seconds / 2 < centerSec).length
}

/**
 * Format a time as `m:ss.s`.
 * @param seconds - a position or duration.
 * @returns the text.
 */
export function timecode(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${String(minutes)}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`
}
