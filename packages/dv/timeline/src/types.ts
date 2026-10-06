/**
 * Types of the Timeline component: the timeline and clip shapes of its state slice, and the slice declaration that
 * adds `timeline` to the project state of `@dv/project`.
 *
 * The slice fields use snake_case because the project state goes to the browser views and the agent.
 *
 * @module @dv/timeline/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AssetId } from '@dv/project'

/** The ID of a timeline, such as `t1`; the operations name it in their `timeline` param. */
export type TimelineId = Branded<'DvTimelineId'>

/**
 * The ID of a clip, such as `cl3`: unique within the project and never reused; the clip operations name a clip by it in
 * their `clip` param.
 */
export type ClipId = Branded<'DvClipId'>

/** One clip of a timeline: an asset that plays from `in_sec` to `out_sec`. */
export interface Clip {
  id: ClipId
  asset: AssetId
  /** Where playback starts inside the asset, in seconds; null for the asset's start. */
  in_sec: number | null
  /** Where playback ends inside the asset, in seconds; null for the asset's end. */
  out_sec: number | null
}

/** One edited video of a project: its clips in playback order and its name; an empty name shows as 时间线 {n} for ID t<n>. */
export interface Timeline {
  id: TimelineId
  name: string
  clips: Clip[]
}

/** The Timeline component's slice: every timeline of the project, in creation order. */
export interface TimelineState {
  timelines: Timeline[]
}

declare module '@dv/project' {
  interface ComponentStates {
    /** The timelines of the project (Timeline). */
    timeline: TimelineState
  }
}
