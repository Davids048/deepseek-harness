/**
 * The state one view keeps about the project it shows: which project and branch, the branch state and the operation
 * declarations, the last failure, and the branch-bar gestures (accept, discard, undo, new branch, branch switch) as API
 * calls on behalf of the chat session the view sits beside. A discard first opens the confirmation dialog of
 * `DiscardDraftDialog.tsx`.
 *
 * @module @dv/ui-kit/useView
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { DvClient, ViewSurface } from './api.ts'
import { useDiscardDraft } from './DiscardDraftDialog.tsx'
import type { WireOperation, WireProject, WireState } from './types.ts'
import { useOperations, useProjectState, useProjects } from './useProject.ts'
import type { Loading } from './useProject.ts'
import type { BranchBarProps } from './BranchBar.tsx'

/** What a view body reads and calls. */
export interface ViewSession {
  client: DvClient
  surface: ViewSurface
  /** The chat session the view sits beside; the view's writes go to its working branch. */
  session: string | null
  projects: Loading<WireProject[]>
  project: string | null
  /** The branch name the view shows. */
  branch: string
  state: Loading<WireState>
  operations: Loading<WireOperation[]>
  /** The message of the last failed call, cleared by the next successful one. */
  notice: string | null
  /** Whether `branch` is a draft, which the view shows without writing to it. */
  readOnly: boolean
  /**
   * Run one write, refetch the state afterwards, and keep the failure message when it throws.
   * @param work - the API call.
   * @returns whether the call succeeded.
   */
  run: (work: () => Promise<unknown>) => Promise<boolean>
  /** The branch bar's data and callbacks, without its copy. */
  bar: Omit<BranchBarProps, 'labels' | 'ask'>
  /** The confirmation dialog of a discard the bar started, or null; the view body renders it. */
  discardDialog: ReactNode
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
 * Keep a view's project, branch, state, and operations, and bind the branch-bar gestures to the API. The first project
 * shown is the one the beside chat session is bound to when the address names a session, else the newest.
 * @param client - the API client.
 * @param surface - the view's name in the records it writes.
 * @param session - the chat session the view sits beside; defaults to the page address.
 * @returns the session.
 */
export function useViewSession(client: DvClient, surface: ViewSurface, session: string | null = sessionFromLocation()): ViewSession {
  const projects = useProjects(client, session)
  const [project, setProject] = useState<string | null>(null)
  const [branch, setBranch] = useState('main')
  const [notice, setNotice] = useState<string | null>(null)
  const list = projects.value
  const first = list === null ? null : (list.find(row => row.current === true) ?? list[0])?.id ?? null
  useEffect(() => {
    if (project === null && first !== null) setProject(first)
  }, [project, first])
  const state = useProjectState(client, project, branch)
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
  const onProject = useCallback((next: string) => { setProject(next); setBranch('main') }, [])
  const discard = useDiscardDraft(client, project, surface, reload)
  const bar: ViewSession['bar'] = {
    projects: projects.value ?? [],
    project,
    state: state.value,
    branch,
    onProject,
    onBranchSelect: (next) => {
      setBranch(next)
      // The session's writes go to its working branch, so showing `main` or an exploration branch also switches to it.
      if (project !== null && session !== null && !next.startsWith('draft/')) void run(() => client.switchBranch(project, next, surface, session))
    },
    onAccept: (draft) => { if (project !== null) void run(() => client.acceptDraft(project, { branch: draft }, surface)) },
    onDiscard: (draft) => { discard.request({ branch: draft }) },
    onUndo: () => { if (project !== null) void run(() => client.undo(project, surface, session)) },
    onBranchCreate: (name, at) => {
      if (project === null) return
      void run(() => client.createBranch(project, name, at, surface, session)).then((ok) => { if (ok) setBranch(`explore/${name}`) })
    },
    onCreate: (title) => {
      void run(() => client.createProject(title, surface)).then((ok) => {
        if (!ok) return
        projects.reload()
        setProject(null)
        setBranch('main')
      })
    },
  }
  return {
    client, surface, session, projects, project, branch, state, operations, notice, readOnly: branch.startsWith('draft/'), run, bar,
    discardDialog: discard.dialog,
  }
}
