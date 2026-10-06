/**
 * Timeline helpers both views share: the length assumed for a clip without a known duration, the shown timeline name,
 * and time formatting.
 *
 * @module @dv/ui-kit/timeline
 */
import type { Timeline } from './types.ts'

/** The length assumed for a clip whose asset reports no duration. */
export const FALLBACK_CLIP_SECONDS = 5

/**
 * The name the interface shows for a timeline: its stored name, else the numbered default for an ID `t<n>`, else the ID.
 * @param timeline - the timeline.
 * @param numbered - the localized default name for number n, such as 时间线 {n}.
 * @returns the shown name.
 */
export function timelineName(timeline: Pick<Timeline, 'id' | 'name'>, numbered: (n: number) => string): string {
  if (timeline.name !== '') return timeline.name
  const match = /^t(\d+)$/.exec(timeline.id)
  return match === null ? timeline.id : numbered(Number(match[1]))
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
