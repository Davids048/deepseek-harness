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

/** One clip of a timeline: an asset that plays from `in_sec` to `out_sec`. A clip is named by its 1-based position. */
export interface Clip {
  asset: AssetId
  /** Where playback starts inside the asset, in seconds; null for the asset's start. */
  in_sec: number | null
  /** Where playback ends inside the asset, in seconds; null for the asset's end. */
  out_sec: number | null
}

/** One edited video of a project: its clips in playback order and the name the interface shows, such as 第 1 集. */
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
