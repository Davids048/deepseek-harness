/**
 * The title of one Tool session, read from `/api/vh/tool-sessions`, for the workspace breadcrumb.
 *
 * @module @video-harness/ui-shell/useToolSessionTitle
 */
import { useEffect, useState } from 'react'
import { ToolApi, toolSessionTitle, VH_TOOL_SESSIONS_CHANGED_EVENT } from '@video-harness/ui-kit/tool-api.ts'

/** The one client the breadcrumb's reads share. */
const api = new ToolApi()

/**
 * Read a Tool session's title whenever the project or the session changes, and again after the Tool session list of
 * the project changes (a rename, for example).
 * @param projectId - the open project.
 * @param toolSessionId - the Tool session shown in the center, or null.
 * @returns the title in the interface language, or undefined before it is read or when the session is unknown.
 */
export function useToolSessionTitle(projectId: string, toolSessionId: string | null): string | undefined {
  const [title, setTitle] = useState<{ id: string; title: string } | undefined>(undefined)
  useEffect(() => {
    if (toolSessionId === null) return
    let live = true
    const read = (): void => {
      api.sessions(projectId).then((rows) => {
        const row = rows.find(item => item.id === toolSessionId)
        if (live && row !== undefined) setTitle({ id: row.id, title: row.title })
      }, (error: unknown) => { console.warn('ui-shell: Tool session read failed', error) })
    }
    const changed = (event: Event): void => { if ((event as CustomEvent<string>).detail === projectId) read() }
    read()
    window.addEventListener(VH_TOOL_SESSIONS_CHANGED_EVENT, changed)
    return () => {
      live = false
      window.removeEventListener(VH_TOOL_SESSIONS_CHANGED_EVENT, changed)
    }
  }, [projectId, toolSessionId])
  return title?.id === toolSessionId ? toolSessionTitle(title.title) : undefined
}
