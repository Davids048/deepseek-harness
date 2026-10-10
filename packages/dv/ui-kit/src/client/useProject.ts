/**
 * React hooks that keep a view's copy of a project in step with the host: the project list, the project's current
 * state, and the operation declarations. The state is refetched after every project change.
 *
 * @module @dv/ui-kit/useProject
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DvClient } from './api.ts'
import type { WireOperation, WireProject, WireState } from './types.ts'

/** What the hooks expose about a request. */
export interface Loading<T> {
  value: T | null
  error: string | null
  loading: boolean
  /** Fetch again. */
  reload: () => void
}

/**
 * Run a loader once and again on demand, keeping the last value while reloading.
 * @param load - the loader.
 * @param deps - values whose change restarts the load.
 * @returns the loading state.
 */
export function useLoader<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]): Loading<T> {
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    load(controller.signal).then((next) => {
      if (controller.signal.aborted) return
      setValue(next)
      setError(null)
      setLoading(false)
    }, (failure: unknown) => {
      if (controller.signal.aborted) return
      setError(failure instanceof Error ? failure.message : String(failure))
      setLoading(false)
    })
    return () => { controller.abort() }
    // The caller lists the inputs of `load`; `tick` forces a reload.
  }, [...deps, tick])
  const reload = useCallback(() => { setTick(count => count + 1) }, [])
  return { value, error, loading, reload }
}

/**
 * The project list.
 * @param client - the API client.
 * @param session - the chat session the view sits beside, when known; its project is flagged `current`.
 * @returns the projects, the session's first, then newest first.
 */
export function useProjects(client: DvClient, session: string | null = null): Loading<WireProject[]> {
  return useLoader(signal => client.listProjects(signal, session), [client, session])
}

/**
 * The operation declarations.
 * @param client - the API client.
 * @returns the operations.
 */
export function useOperations(client: DvClient): Loading<WireOperation[]> {
  return useLoader(signal => client.listOperations(signal), [client])
}

/**
 * The project's current state, refetched on every project change while the component is mounted.
 * @param client - the API client.
 * @param project - the project, or null before one is chosen.
 * @returns the state.
 */
export function useProjectState(client: DvClient, project: string | null): Loading<WireState> {
  const loader = useLoader(
    signal => project === null ? Promise.reject(new Error('no project')) : client.getState(project, signal),
    [client, project],
  )
  const reload = loader.reload
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (project === null) return
    return client.subscribe(project, () => {
      // Several events arrive per turn; one refetch per burst is enough.
      if (pending.current !== null) clearTimeout(pending.current)
      pending.current = setTimeout(() => { pending.current = null; reload() }, 150)
    })
  }, [client, project, reload])
  return loader
}
