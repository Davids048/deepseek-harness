/**
 * The state one view keeps about the project it shows: which project, the project's current state and the operation
 * declarations, the last failure, and the gestures of the project and undo bar (`ProjectBar`: undo, new project) as API
 * calls on behalf of the chat session the view sits beside.
 *
 * @module @dv/ui-kit/useView
 */
import { useCallback, useEffect, useState } from 'react'
import type { DvClient, ViewSurface } from './api.ts'
import type { WireOperation, WireProject, WireState } from './types.ts'
import { useOperations, useProjectState, useProjects } from './useProject.ts'
import type { Loading } from './useProject.ts'
import type { ProjectBarProps } from './ProjectBar.tsx'

/** What a view body reads and calls. */
export interface ViewSession {
  client: DvClient
  surface: ViewSurface
  /** The chat session the view sits beside, recorded as the `session` of the view's writes. */
  session: string | null
  projects: Loading<WireProject[]>
  project: string | null
  /** The project's current state, which the view shows and writes after. */
  state: Loading<WireState>
  operations: Loading<WireOperation[]>
  /** The message of the last failed call, cleared by the next successful one. */
  notice: string | null
  /**
   * Run one write, refetch the state afterwards, and keep the failure message when it throws.
   * @param work - the API call.
   * @returns whether the call succeeded.
   */
  run: (work: () => Promise<unknown>) => Promise<boolean>
  /** The project and undo bar's data and callbacks, without its copy. */
  bar: Omit<ProjectBarProps, 'labels' | 'ask'>
}

/**
 * The chat session a view sits beside, read from the page address (`?session=<id>`), or null.
 * @param search - the page's query string; defaults to the browser's.
 * @returns the session ID or null.
 */
export function sessionFromLocation(search: string = window.location.search): string | null {
  const value = new URLSearchParams(search).get('session')
  return value === null || value.length === 0 ? null : value
}

/**
 * Keep a view's project, state, and operations, and bind the project and undo bar's gestures to the API. The first project
 * shown is the one the beside chat session is bound to when the address names a session, else the newest.
 * @param client - the API client.
 * @param surface - the view's name in the records it writes.
 * @param session - the chat session the view sits beside; defaults to the page address.
 * @returns the session.
 */
export function useViewSession(client: DvClient, surface: ViewSurface, session: string | null = sessionFromLocation()): ViewSession {
  const projects = useProjects(client, session)
  const [project, setProject] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const list = projects.value
  const first = list === null ? null : (list.find(row => row.current === true) ?? list[0])?.id ?? null
  useEffect(() => {
    if (project === null && first !== null) setProject(first)
  }, [project, first])
  const state = useProjectState(client, project)
  const operations = useOperations(client)
  const reload = state.reload
  const run = useCallback(async (work: () => Promise<unknown>): Promise<boolean> => {
    try {
      await work()
      setNotice(null)
      reload()
      return true
    } catch (failure: unknown) {
      setNotice(failure instanceof Error ? failure.message : String(failure))
      return false
    }
  }, [reload])
  const bar: ViewSession['bar'] = {
    projects: projects.value ?? [],
    project,
    onProject: setProject,
    onUndo: () => { if (project !== null) void run(() => client.undo(project)) },
    onCreate: (title) => {
      void run(() => client.createProject(title, surface)).then((ok) => {
        if (!ok) return
        projects.reload()
        setProject(null)
      })
    },
  }
  return { client, surface, session, projects, project, state, operations, notice, run, bar }
}
