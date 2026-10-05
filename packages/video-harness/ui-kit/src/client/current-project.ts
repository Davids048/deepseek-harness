/**
 * The project that the DreamVerse shell has open, shared across client bundles. Each DreamVerse panel is a separate
 * bundle with its own module instances, so the value lives on `window` and changes are announced with the
 * `vh:current-project` event. Only `@video-harness/ui-shell` calls `publishCurrentProject`; panels read the value with
 * `useCurrentProject`.
 *
 * @module @video-harness/ui-kit/current-project
 */
import { useSyncExternalStore } from 'react'

/** The `window` event name that announces a change of the open project. */
export const VH_CURRENT_PROJECT_EVENT = 'vh:current-project'

/** The `window` field that holds the open project ID, or null on the entry page. */
const FIELD = '__vhCurrentProject'

type ProjectWindow = Window & { [FIELD]?: string | null }

/** @returns the open project ID, or null when no project is open. */
export function getCurrentProject(): string | null {
  return (window as ProjectWindow)[FIELD] ?? null
}

/**
 * Record the open project and announce it when it changed.
 * @param projectId - the open project ID, or null on the entry page.
 */
export function publishCurrentProject(projectId: string | null): void {
  if (getCurrentProject() === projectId) return
  ;(window as ProjectWindow)[FIELD] = projectId
  window.dispatchEvent(new CustomEvent(VH_CURRENT_PROJECT_EVENT, { detail: { projectId } }))
}

/**
 * Subscribe a component to the open project.
 * @returns the open project ID, or null when no project is open.
 */
export function useCurrentProject(): string | null {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(VH_CURRENT_PROJECT_EVENT, listener)
      return () => { window.removeEventListener(VH_CURRENT_PROJECT_EVENT, listener) }
    },
    getCurrentProject,
  )
}
