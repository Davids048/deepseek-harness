/**
 * Geometry of one video in the cuts editor: which videos a state holds, how long each clip plays after its in and out
 * points, where it starts on the track, and which clip plays at a given time.
 */
import { FALLBACK_CLIP_SECONDS } from '@video-harness/ui-kit/timeline.ts'
import type { WireSequenceItem, WireState } from '@video-harness/ui-kit/types.ts'

/** One video of a project as the editor shows it: an ID, a title, and its clips. */
export interface CutsVideo {
  id: string
  title: string
  items: WireSequenceItem[]
}

/** One clip placed on the track, with its in and out points resolved to numbers. */
export interface CutClip {
  slot: number
  assetId: string
  /** The recorded in point, or null when the clip starts at the asset's start. */
  rawIn: number | null
  /** The recorded out point, or null when the clip ends at the asset's end. */
  rawOut: number | null
  /** Asset time where the clip starts playing. */
  inSec: number
  /** Asset time where the clip stops playing. */
  outSec: number
  /** Length of the whole asset. */
  assetSeconds: number
  /** Seconds the clip plays: `outSec - inSec`. */
  seconds: number
  /** Sequence time where the clip starts. */
  startSec: number
  /** The image the producing record left beside the clip, used as the track thumbnail. */
  thumbnail: string | null
  stale: boolean
  draft: boolean
}

/**
 * The videos of a state. A host that predates `sequences` sends only `sequence`, which is the first video.
 * @param state - the folded state.
 * @returns the videos in creation order.
 */
export function videosOf(state: WireState): CutsVideo[] {
  if (state.sequences !== undefined) return state.sequences
  return state.sequence === null ? [] : [{ id: 'v1', title: '', items: state.sequence.items }]
}

/**
 * The first free video ID of the form `v<n>`, starting after the current count.
 * @param videos - the existing videos.
 * @returns the ID for a new video.
 */
export function nextVideoId(videos: CutsVideo[]): string {
  const taken = new Set(videos.map(video => video.id))
  let n = videos.length + 1
  while (taken.has(`v${String(n)}`)) n += 1
  return `v${String(n)}`
}

/**
 * Place the clips of one video on the track in slot order. A clip is a draft when the shown head is an agent draft
 * branch and the clip is new there: the draft produced its asset, or the same video on `main` has no matching clip
 * (same asset, in point, and out point). Records of an accepted draft keep their `draft/` branch name but are on
 * `main`, so nothing on `main` is a draft.
 * @param state - the folded state, for asset durations, thumbnails, and stale marks.
 * @param video - the video, or null when the project has none.
 * @param head - the shown head: `main`, a branch, or a `draft/<turn>` branch.
 * @param baseItems - the clips of the same video on `main`, when a draft is shown.
 * @returns the clips and the total length in seconds.
 */
export function placeVideo(state: WireState, video: CutsVideo | null, head = 'main', baseItems: WireSequenceItem[] = []): { clips: CutClip[]; total: number } {
  const assets = new Map(state.assets.map(asset => [asset.id, asset]))
  const ops = new Map(state.ops.map(op => [op.id, op]))
  const clips: CutClip[] = []
  let cursor = 0
  // Each clip on `main` matches at most one clip of the draft.
  const unmatched = new Map<string, number>()
  const keyOf = (item: WireSequenceItem): string => `${item.assetId}|${String(item.inSec)}|${String(item.outSec)}`
  for (const item of baseItems) unmatched.set(keyOf(item), (unmatched.get(keyOf(item)) ?? 0) + 1)
  for (const item of [...video?.items ?? []].sort((a, b) => a.slot - b.slot)) {
    const assetSeconds = assets.get(item.assetId)?.durationSec ?? FALLBACK_CLIP_SECONDS
    const inSec = item.inSec ?? 0
    const outSec = item.outSec ?? assetSeconds
    const seconds = Math.max(0.1, outSec - inSec)
    const producerId = state.producers[item.assetId] ?? null
    const producer = producerId === null ? undefined : ops.get(producerId)
    const thumbnail = producer?.outputs.find(id => assets.get(id)?.mime.startsWith('image/')) ?? null
    clips.push({
      slot: item.slot, assetId: item.assetId, rawIn: item.inSec, rawOut: item.outSec, inSec, outSec, assetSeconds, seconds,
      startSec: cursor, thumbnail, stale: producerId !== null && producerId in state.stale,
      draft: head.startsWith('draft/') && producer?.branch === head,
    })
    cursor += seconds
    const left = unmatched.get(keyOf(item)) ?? 0
    if (left > 0) unmatched.set(keyOf(item), left - 1)
    const clip = clips[clips.length - 1]
    if (clip !== undefined && head.startsWith('draft/') && left === 0) clip.draft = true
  }
  return { clips, total: cursor }
}

/**
 * The clip that plays at a sequence time. A time at or past the end resolves to the last clip.
 * @param clips - the placed clips.
 * @param position - sequence time in seconds.
 * @returns the clip's index, or -1 when there are no clips.
 */
export function clipIndexAt(clips: CutClip[], position: number): number {
  const index = clips.findIndex(clip => position < clip.startSec + clip.seconds)
  return index === -1 ? clips.length - 1 : index
}

/**
 * Where a clip lands when it is dropped with its center at `centerSec`: one plus the number of other clips whose
 * centers lie before it.
 * @param clips - the placed clips.
 * @param centerSec - sequence time of the dropped clip's center.
 * @param exclude - the slot of the dragged clip, or null for an inserted asset.
 * @returns the 1-based slot.
 */
export function dropSlot(clips: CutClip[], centerSec: number, exclude: number | null): number {
  return 1 + clips.filter(clip => clip.slot !== exclude && clip.startSec + clip.seconds / 2 < centerSec).length
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
