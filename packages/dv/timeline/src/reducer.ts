/**
 * The Timeline reducer and the clip checks it shares with the operations: how each finished `timeline.*` record
 * changes the timelines of a project, and why a record cannot apply to a given slice.
 *
 * A clip is named by its 1-based position. The operations check positions against the state before they record
 * anything; `conflict` runs the same check when a draft replays on a `main` that moved.
 *
 * @module @dv/timeline/reducer
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId, ProjectRecord, Reducer } from '@dv/project'
import type { Clip, Timeline, TimelineId, TimelineState } from './types.ts'

/** The nine Timeline operations by verb. */
export const OPERATIONS = {
  create: 'timeline.create',
  rename: 'timeline.rename',
  delete: 'timeline.delete',
  insert: 'timeline.clip_insert',
  move: 'timeline.clip_move',
  remove: 'timeline.clip_remove',
  split: 'timeline.clip_split',
  trim: 'timeline.clip_trim',
  replace: 'timeline.clip_replace',
} as const

/** The ID the first timeline gets when a `timeline.create` or `timeline.clip_insert` names none. */
export const FIRST_TIMELINE_ID = brandString<TimelineId>('t1')

type Slice = TimelineState

/** The part of a record the reducer and the checks read. */
type TimelineCall = Pick<ProjectRecord, 'operation' | 'params' | 'inputs'>

/** A params field as text, or null when it is absent, empty, or not a string. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** A params field as a finite number, or null. */
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The timeline a call names in its `timeline` param, or null when the param is absent. */
export function namedTimeline(params: Record<string, unknown>): TimelineId | null {
  const id = text(params['timeline'])
  return id === null ? null : brandString<TimelineId>(id)
}

/** The name a timeline gets when its creating call names none: 第 N 集, N counting the timelines after it. */
function defaultName(timelines: Timeline[]): string {
  return `第 ${String(timelines.length + 1)} 集`
}

/** The ID of the timeline a call edits: its `timeline` param, else the first timeline, else null. */
function targetOf(slice: Slice, params: Record<string, unknown>): TimelineId | null {
  return namedTimeline(params) ?? slice.timelines[0]?.id ?? null
}

/** A clip that plays the whole asset. */
function wholeClip(asset: AssetId): Clip {
  return { asset, in_sec: null, out_sec: null }
}

/**
 * The clips a `timeline.create` lays out: its `assets` param, else the resolved assets of its `clip` inputs in order
 * (a scheduled create names the outputs of renders that had not finished when it was recorded).
 * @param call - the create call.
 * @returns the clips.
 */
function createdClips(call: TimelineCall): Clip[] {
  const assets = Array.isArray(call.params['assets'])
    ? call.params['assets'].filter((asset): asset is string => typeof asset === 'string').map(asset => brandString<AssetId>(asset))
    : call.inputs.filter(input => input.role === 'clip').map(input => input.resolved_asset)
      .filter((asset): asset is AssetId => asset !== null)
  return assets.map(wholeClip)
}

/**
 * Why a clip position is not on a timeline.
 * @param timeline - the timeline.
 * @param position - a 1-based position from the call's params.
 * @param last - the highest valid position.
 * @returns the reason, or null for a valid position.
 */
function positionProblem(timeline: Timeline, position: number | null, last: number): string | null {
  if (position !== null && Number.isInteger(position) && position >= 1 && position <= last) return null
  const count = timeline.clips.length
  return `Timeline ${timeline.id} has ${String(count)} clip${count === 1 ? '' : 's'}; position ${String(position)} is not between 1 and ${String(last)}.`
}

/**
 * Why a `timeline.*` call cannot apply to a slice: an unknown timeline, a clip position outside the timeline, a split
 * time outside the clip, or an empty trim range. The operations throw it before they record; accept replay reports it
 * as the conflict of a draft record.
 * @param slice - the slice the call applies to.
 * @param call - the call's operation and params.
 * @returns the reason a creator can read, or null when the call applies.
 */
export function clipProblem(slice: Slice, call: TimelineCall): string | null {
  const operation = call.operation
  if (!isTimelineCall(call) || operation === OPERATIONS.create) return null
  const params = call.params
  const id = targetOf(slice, params)
  const timeline = slice.timelines.find(candidate => candidate.id === id)
  if (operation === OPERATIONS.insert) {
    // Inserting into a timeline that does not exist creates it, so the only valid position is 1.
    const into = timeline ?? { id: id ?? FIRST_TIMELINE_ID, name: '', clips: [] }
    return positionProblem(into, number(params['at']), into.clips.length + 1)
  }
  if (timeline === undefined) return id === null ? 'The project has no timeline.' : `Timeline ${id} does not exist.`
  if (operation === OPERATIONS.rename || operation === OPERATIONS.delete) return null
  const count = timeline.clips.length
  const problem = positionProblem(timeline, number(params['clip']), count)
    ?? (operation === OPERATIONS.move ? positionProblem(timeline, number(params['to']), count) : null)
  if (problem !== null) return problem
  const clip = timeline.clips[Number(params['clip']) - 1] as Clip
  if (operation === OPERATIONS.split) {
    const at = number(params['at_sec'])
    const inside = at !== null && at > (clip.in_sec ?? 0) && (clip.out_sec === null || at < clip.out_sec)
    return inside ? null : `Clip ${String(params['clip'])} of timeline ${timeline.id} does not play ${String(at)}s of its asset; split inside its in and out points.`
  }
  if (operation === OPERATIONS.trim) {
    const inSec = number(params['in_sec'])
    const outSec = number(params['out_sec'])
    if ((inSec ?? 0) < 0) return `The in point ${String(inSec)}s is before the asset's start.`
    if (outSec !== null && outSec <= (inSec ?? 0)) return `The out point ${String(outSec)}s is not after the in point ${String(inSec ?? 0)}s.`
  }
  return null
}

/**
 * Apply one clip edit to the clips of one timeline. The call has passed `clipProblem`, so its positions are valid.
 * @param clips - the clips before the call.
 * @param call - a clip operation call.
 * @returns the clips after it.
 */
function editClips(clips: Clip[], call: TimelineCall): Clip[] {
  const params = call.params
  const index = Number(params['clip']) - 1
  const edited = [...clips]
  switch (call.operation) {
    case OPERATIONS.insert:
      edited.splice(Number(params['at']) - 1, 0, wholeClip(brandString<AssetId>(String(params['asset']))))
      return edited
    case OPERATIONS.move: {
      const [clip] = edited.splice(index, 1)
      if (clip !== undefined) edited.splice(Number(params['to']) - 1, 0, clip)
      return edited
    }
    case OPERATIONS.remove:
      edited.splice(index, 1)
      return edited
    case OPERATIONS.split: {
      // `at_sec` is a time inside the clip's asset, so both parts play the same asset: the first ends there and the
      // second starts there.
      const clip = clips[index] as Clip
      const at = Number(params['at_sec'])
      edited.splice(index, 1, { ...clip, out_sec: at }, { ...clip, in_sec: at })
      return edited
    }
    case OPERATIONS.trim:
      edited[index] = { ...clips[index] as Clip, in_sec: number(params['in_sec']), out_sec: number(params['out_sec']) }
      return edited
    case OPERATIONS.replace:
      edited[index] = wholeClip(brandString<AssetId>(String(params['asset'])))
      return edited
    /* v8 ignore next 2 -- `reduce` passes only the six clip operations. */
    default:
      return clips
  }
}

/**
 * Apply one finished `timeline.*` call to the timelines. `timeline.create` with a new ID adds a timeline, with a known
 * ID replaces its clips, and without an ID replaces the first timeline's clips (adding `t1` when there is none).
 * `timeline.clip_insert` into a timeline that does not exist adds it. The other operations edit the timeline their
 * `timeline` param names, else the first timeline.
 * @param timelines - the timelines before the call.
 * @param call - a valid call.
 * @returns the timelines after it.
 */
function applyCall(timelines: Timeline[], call: TimelineCall): Timeline[] {
  const params = call.params
  const id = namedTimeline(params) ?? timelines[0]?.id ?? FIRST_TIMELINE_ID
  const existing = timelines.find(timeline => timeline.id === id)
  switch (call.operation) {
    case OPERATIONS.create: {
      const created: Timeline = { id, name: text(params['name']) ?? existing?.name ?? defaultName(timelines), clips: createdClips(call) }
      return existing === undefined ? [...timelines, created] : timelines.map(timeline => timeline.id === id ? created : timeline)
    }
    case OPERATIONS.rename:
      return timelines.map(timeline => timeline.id === id ? { ...timeline, name: String(params['name']) } : timeline)
    case OPERATIONS.delete:
      return timelines.filter(timeline => timeline.id !== id)
    default:
      if (existing === undefined) return [...timelines, { id, name: defaultName(timelines), clips: editClips([], call) }]
      return timelines.map(timeline => timeline.id === id ? { ...timeline, clips: editClips(timeline.clips, call) } : timeline)
  }
}

/** Whether a record is a call of a Timeline operation. */
function isTimelineCall(record: TimelineCall): boolean {
  return Object.values(OPERATIONS).includes(record.operation as never)
}

/**
 * The `timeline` reducer: the timelines and their clips, from the finished `timeline.*` records. A record that does
 * not apply to the slice it reaches (a replayed record whose clip `main` removed) leaves the slice unchanged.
 */
export const timelineReducer: Reducer<'timeline'> = {
  initial: () => ({ timelines: [] }),
  reduce(slice, record) {
    if (record.status !== 'done' || !isTimelineCall(record) || clipProblem(slice, record) !== null) return slice
    return { timelines: applyCall(slice.timelines, record) }
  },
  conflict(slice, record) {
    return isTimelineCall(record) ? clipProblem(slice, record) : null
  },
  agentSummary(slice, assets) {
    // Clips are named by their 1-based position, the way the `clip` param of the timeline operations names them.
    return {
      timelines: slice.timelines.map(entry => ({
        id: entry.id, name: entry.name,
        clips: entry.clips.map((clip, index) => ({
          clip: index + 1, asset: clip.asset, url: assets.url(clip.asset), in_sec: clip.in_sec, out_sec: clip.out_sec,
        })),
      })),
    }
  },
}
