/**
 * The timeline selected in the DreamVerse timeline editor, shared across client bundles the same way
 * `current-project.ts` shares the open project: the value lives on `window` and changes are announced with the
 * `dv:current-timeline` event. The timeline editor publishes the timeline the user selects; the shell publishes the
 * timeline that a URL names on restore, writes the published timeline into the URL, and inserts 插入片段 clips into it.
 *
 * A timeline ID such as `t2` is unique only inside one project, so the value records its project, and readers ask for
 * the timeline of a given project.
 *
 * @module @dv/ui-kit/current-timeline
 */
import { useSyncExternalStore } from 'react'

/** The `window` event name that announces a change of the selected timeline. */
export const DV_CURRENT_TIMELINE_EVENT = 'dv:current-timeline'

/** The selected timeline and the project that holds it. */
export interface CurrentTimeline {
  projectId: string
  timelineId: string
}

/** The `window` field that holds the selected timeline, or null when none is selected. */
const FIELD = '__dvCurrentTimeline'

type TimelineWindow = Window & { [FIELD]?: CurrentTimeline | null }

/** @returns the selected timeline and its project, or null when no timeline is selected. */
export function getCurrentTimeline(): CurrentTimeline | null {
  return (window as TimelineWindow)[FIELD] ?? null
}

/**
 * The selected timeline of one project.
 * @param projectId - the project to ask about.
 * @returns the timeline ID, or null when no timeline of that project is selected.
 */
export function getTimelineOf(projectId: string): string | null {
  const current = getCurrentTimeline()
  return current !== null && current.projectId === projectId ? current.timelineId : null
}

/**
 * Record the selected timeline and announce it when it changed.
 * @param projectId - the project that holds the timeline.
 * @param timelineId - the timeline ID, or null to clear the selection.
 */
export function publishCurrentTimeline(projectId: string, timelineId: string | null): void {
  const current = getCurrentTimeline()
  const next = timelineId === null ? null : { projectId, timelineId }
  if (current?.projectId === next?.projectId && current?.timelineId === next?.timelineId) return
  ;(window as TimelineWindow)[FIELD] = next
  window.dispatchEvent(new CustomEvent(DV_CURRENT_TIMELINE_EVENT, { detail: next }))
}

/**
 * Subscribe a component to the selected timeline of one project.
 * @param projectId - the project to watch.
 * @returns the timeline ID, or null when no timeline of that project is selected.
 */
export function useCurrentTimeline(projectId: string): string | null {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(DV_CURRENT_TIMELINE_EVENT, listener)
      return () => { window.removeEventListener(DV_CURRENT_TIMELINE_EVENT, listener) }
    },
    () => getTimelineOf(projectId),
  )
}
