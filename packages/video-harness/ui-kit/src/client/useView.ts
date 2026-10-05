/**
 * The state one view keeps about the project it shows: which project and head, the folded state and the tool
 * declarations, the last failure, and the branch-bar gestures (accept, reject, undo, new branch) as API calls.
 *
 * @module @video-harness/ui-kit/useView
 */
import { useCallback, useEffect, useState } from 'react'
import type { VhClient } from './api.ts'
import type { WireProject, WireState, WireToolSpec } from './types.ts'
import { useProjectState, useProjects, useTools } from './useProject.ts'
import type { Loading } from './useProject.ts'
import type { BranchBarProps } from './BranchBar.tsx'

/** Where the view's writes say they came from. */
export type ViewSurface = 'canvas' | 'timeline'

/** What a view body reads and calls. */
export interface ViewSession {
  client: VhClient
  surface: ViewSurface
  projects: Loading<WireProject[]>
  project: string | null
  head: string
  state: Loading<WireState>
  tools: Loading<WireToolSpec[]>
  /** The message of the last failed call, cleared by the next successful one. */
  notice: string | null
  /** Whether `head` is an agent draft, where user writes are refused. */
  readOnly: boolean
  /**
   * Run one write, refetch the state afterwards, and keep the failure message when it throws.
   * @param work - the API call.
   * @returns whether the call succeeded.
   */
  run: (work: () => Promise<unknown>) => Promise<boolean>
  /** The branch bar's data and callbacks, without its copy. */
  bar: Omit<BranchBarProps, 'labels' | 'ask'>
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
 * Keep a view's project, head, state, and tools, and bind the branch-bar gestures to the API. The first project
 * shown is the one the beside chat session is bound to when the address names a session, else the newest.
 * @param client - the API client.
 * @param surface - the view's name in the records it writes.
 * @param session - the chat session the view sits beside; defaults to the page address.
 * @returns the session.
 */
export function useViewSession(client: VhClient, surface: ViewSurface, session: string | null = sessionFromLocation()): ViewSession {
  const projects = useProjects(client, session)
  const [project, setProject] = useState<string | null>(null)
  const [head, setHead] = useState('main')
  const [notice, setNotice] = useState<string | null>(null)
  const list = projects.value
  const first = list === null ? null : (list.find(row => row.current === true) ?? list[0])?.projectId ?? null
  useEffect(() => {
    if (project === null && first !== null) setProject(first)
  }, [project, first])
  const state = useProjectState(client, project, head)
  const tools = useTools(client)
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
  const onProject = useCallback((next: string) => { setProject(next); setHead('main') }, [])
  const bar: ViewSession['bar'] = {
    projects: projects.value ?? [],
    project,
    state: state.value,
    head,
    onProject,
    onHead: setHead,
    onAccept: (turn) => { if (project !== null) void run(() => client.turn(project, turn, 'accept', surface)) },
    onReject: (turn) => { if (project !== null) void run(() => client.turn(project, turn, 'reject', surface)) },
    onUndo: () => { if (project !== null) void run(() => client.undo(project)) },
    onBranch: (name, at) => {
      if (project === null) return
      void run(() => client.branch(project, name, at)).then((ok) => { if (ok) setHead(name) })
    },
    onCreate: (title) => {
      void run(() => client.createProject(title, surface)).then((ok) => {
        if (!ok) return
        projects.reload()
        setProject(null)
        setHead('main')
      })
    },
  }
  return { client, surface, projects, project, head, state, tools, notice, readOnly: head.startsWith('draft/'), run, bar }
}
