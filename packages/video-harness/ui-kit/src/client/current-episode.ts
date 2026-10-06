/**
 * The episode (cuts video) selected in the DreamVerse cuts editor, shared across client bundles the same way
 * `current-project.ts` shares the open project: the value lives on `window` and changes are announced with the
 * `vh:current-episode` event. The cuts editor publishes the episode the user selects; the shell publishes the episode
 * that a URL names on restore, writes the published episode into the URL, and inserts 加入剪辑 clips into it.
 *
 * An episode ID such as `t2` is unique only inside one project, so the value records its project, and readers ask for
 * the episode of a given project.
 *
 * @module @video-harness/ui-kit/current-episode
 */
import { useSyncExternalStore } from 'react'

/** The `window` event name that announces a change of the selected episode. */
export const VH_CURRENT_EPISODE_EVENT = 'vh:current-episode'

/** The selected episode and the project that holds it. */
export interface CurrentEpisode {
  projectId: string
  episodeId: string
}

/** The `window` field that holds the selected episode, or null when none is selected. */
const FIELD = '__vhCurrentEpisode'

type EpisodeWindow = Window & { [FIELD]?: CurrentEpisode | null }

/** @returns the selected episode and its project, or null when no episode is selected. */
export function getCurrentEpisode(): CurrentEpisode | null {
  return (window as EpisodeWindow)[FIELD] ?? null
}

/**
 * The selected episode of one project.
 * @param projectId - the project to ask about.
 * @returns the episode ID, or null when no episode of that project is selected.
 */
export function getEpisodeOf(projectId: string): string | null {
  const current = getCurrentEpisode()
  return current !== null && current.projectId === projectId ? current.episodeId : null
}

/**
 * Record the selected episode and announce it when it changed.
 * @param projectId - the project that holds the episode.
 * @param episodeId - the episode ID, or null to clear the selection.
 */
export function publishCurrentEpisode(projectId: string, episodeId: string | null): void {
  const current = getCurrentEpisode()
  const next = episodeId === null ? null : { projectId, episodeId }
  if (current?.projectId === next?.projectId && current?.episodeId === next?.episodeId) return
  ;(window as EpisodeWindow)[FIELD] = next
  window.dispatchEvent(new CustomEvent(VH_CURRENT_EPISODE_EVENT, { detail: next }))
}

/**
 * Subscribe a component to the selected episode of one project.
 * @param projectId - the project to watch.
 * @returns the episode ID, or null when no episode of that project is selected.
 */
export function useCurrentEpisode(projectId: string): string | null {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(VH_CURRENT_EPISODE_EVENT, listener)
      return () => { window.removeEventListener(VH_CURRENT_EPISODE_EVENT, listener) }
    },
    () => getEpisodeOf(projectId),
  )
}
