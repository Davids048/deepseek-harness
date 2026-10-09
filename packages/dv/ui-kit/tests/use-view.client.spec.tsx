// @vitest-environment jsdom
/** The hooks: loading, reload on project changes, and the view session's gestures as API calls. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { DvClient } from '../src/client/api.ts'
import { useProjectState } from '../src/client/useProject.ts'
import { sessionFromLocation, useViewSession } from '../src/client/useView.ts'
import { fixtureState, PROJECT, scriptedFetch } from './fixture.client.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('sessionFromLocation', () => {
  it('reads the chat session from the page address', () => {
    expect(sessionFromLocation('?session=s1&x=1')).toBe('s1')
    expect(sessionFromLocation('?session=')).toBeNull()
    expect(sessionFromLocation('')).toBeNull()
    expect(sessionFromLocation()).toBeNull()
  })
})

describe('useViewSession', () => {
  it('asks for the session\'s projects, shows the bound one first, and switches to a project it creates', async () => {
    const reads: string[] = []
    const { fetch, writes } = scriptedFetch({ projects: [PROJECT, { ...PROJECT, id: 'p2', title: 'Bound', current: true }] })
    const logging: typeof fetch = (input, init) => { reads.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); return fetch(input, init) }
    const client = new DvClient(logging)
    const { result } = renderHook(() => useViewSession(client, 'timeline', 's1'))
    await waitFor(() => { expect(result.current.project).toBe('p2') })
    expect(reads[0]).toBe('/api/dv/projects?session=s1')
    act(() => { result.current.bar.onProject('p1') })
    act(() => { result.current.bar.onCreate('Demo 3') })
    await waitFor(() => { expect(writes).toHaveLength(1) })
    expect(writes[0]).toEqual({ path: '/api/dv/projects', body: { title: 'Demo 3', surface: 'timeline' } })
    await waitFor(() => { expect(result.current.project).toBe('p2') })
  })

  it('selects the first project, loads its state and the operations, and binds the bar gestures', async () => {
    const { fetch, writes } = scriptedFetch()
    const client = new DvClient(fetch)
    const { result } = renderHook(() => useViewSession(client, 'canvas'))
    expect(result.current.project).toBeNull()
    await waitFor(() => { expect(result.current.state.value).not.toBeNull() })
    expect(result.current.project).toBe('p1')
    expect(result.current.operations.value?.length).toBeGreaterThan(0)
    expect(result.current.state.value?.head).toBe('g3')
    act(() => { result.current.bar.onUndo() })
    await waitFor(() => { expect(writes).toHaveLength(1) })
    expect(writes).toEqual([{ path: '/api/dv/undo', body: { project: 'p1' } }])
    act(() => { result.current.bar.onProject('p2') })
    expect(result.current.project).toBe('p2')
  })

  it('keeps the chat session beside the view, and undoes by moving the project\'s current position', async () => {
    const { fetch, writes } = scriptedFetch()
    const client = new DvClient(fetch)
    const { result } = renderHook(() => useViewSession(client, 'canvas', 's5'))
    await waitFor(() => { expect(result.current.state.value).not.toBeNull() })
    expect(result.current.session).toBe('s5')
    act(() => { result.current.bar.onUndo() })
    await waitFor(() => { expect(writes).toHaveLength(1) })
    expect(writes[0]).toEqual({ path: '/api/dv/undo', body: { project: 'p1' } })
  })

  it('keeps the failure message of a write and clears it on the next success', async () => {
    const refused = (path: string): boolean => path === '/api/dv/undo' || path === '/api/dv/projects'
    const { fetch } = scriptedFetch({
      post: path => refused(path) ? { status: 409, body: { error: 'nothing to undo' } } : { status: 200, body: { record: {} } },
    })
    const client = new DvClient(fetch)
    const { result } = renderHook(() => useViewSession(client, 'timeline'))
    await waitFor(() => { expect(result.current.project).toBe('p1') })
    let ok = true
    await act(async () => { ok = await result.current.run(() => client.undo('p1', 'timeline')) })
    expect(ok).toBe(false)
    expect(result.current.notice).toBe('nothing to undo')
    await act(async () => { ok = await result.current.run(() => client.acceptStale('p1', 'g2', 'timeline')) })
    expect(ok).toBe(true)
    expect(result.current.notice).toBeNull()
    await act(async () => { ok = await result.current.run(() => Promise.reject(new Error('boom'))) })
    expect(result.current.notice).toBe('boom')
    const plain = vi.fn<() => Promise<unknown>>().mockRejectedValue('plain')
    await act(async () => { await result.current.run(plain) })
    expect(result.current.notice).toBe('plain')
    act(() => { result.current.bar.onCreate('refused') })
    await waitFor(() => { expect(result.current.notice).toBe('nothing to undo') })
    expect(result.current.project).toBe('p1')
  })

  it('does nothing on the bar gestures while no project exists', async () => {
    const { fetch, writes } = scriptedFetch({ projects: [] })
    const client = new DvClient(fetch)
    const { result } = renderHook(() => useViewSession(client, 'canvas'))
    await waitFor(() => { expect(result.current.projects.value).toEqual([]) })
    await waitFor(() => { expect(result.current.state.error).toBe('no project') })
    act(() => {
      result.current.bar.onUndo()
    })
    expect(writes).toHaveLength(0)
  })
})

describe('useProjectState', () => {
  it('refetches once per burst of project changes and stops following on unmount', async () => {
    const listeners = new Map<string, EventListener>()
    const close = vi.fn()
    class FakeEventSource {
      constructor(readonly url: string) {}
      addEventListener(type: string, listener: EventListener): void { listeners.set(type, listener) }
      removeEventListener(type: string): void { listeners.delete(type) }
      close = close
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    let reads = 0
    const { fetch } = scriptedFetch({ state: () => { reads += 1; return fixtureState() } })
    const client = new DvClient(fetch)
    const { result, unmount } = renderHook(() => useProjectState(client, 'p1'))
    await waitFor(() => { expect(result.current.value).not.toBeNull() })
    expect(reads).toBe(1)
    expect(result.current.loading).toBe(false)
    vi.useFakeTimers()
    const appended = JSON.stringify({ kind: 'record', record: fixtureState().components.proj.records[0] })
    const fire = (): void => { listeners.get('record')?.(new MessageEvent('record', { data: appended })) }
    act(() => { fire(); fire(); fire() })
    act(() => { vi.advanceTimersByTime(200) })
    vi.useRealTimers()
    await waitFor(() => { expect(reads).toBe(2) })
    unmount()
    expect(close).toHaveBeenCalledOnce()
  })

  it('reports a failed read and keeps the last value through a reload', async () => {
    let fail = false
    const { fetch } = scriptedFetch({ state: () => { if (fail) throw new Error('offline'); return fixtureState() } })
    const client = new DvClient(fetch)
    const { result } = renderHook(() => useProjectState(client, 'p1'))
    await waitFor(() => { expect(result.current.value).not.toBeNull() })
    fail = true
    act(() => { result.current.reload() })
    await waitFor(() => { expect(result.current.error).toBe('offline') })
    expect(result.current.value).not.toBeNull()
  })

  it('reports a rejection that is not an Error as text', async () => {
    const failing = vi.fn<typeof fetch>().mockRejectedValue('offline')
    const client = new DvClient(failing)
    const { result } = renderHook(() => useProjectState(client, 'p1'))
    await waitFor(() => { expect(result.current.error).toBe('offline') })
  })

  it('ignores a rejection that arrives after the inputs changed', async () => {
    const pending: Array<() => void> = []
    const slow: typeof fetch = () => new Promise<Response>((_resolve, reject) => { pending.push(() => { reject(new Error('late')) }) })
    const client = new DvClient(slow)
    const { result, rerender } = renderHook(({ project }: { project: string }) => useProjectState(client, project), { initialProps: { project: 'p1' } })
    rerender({ project: 'p2' })
    const first = pending.shift()
    if (first === undefined) throw new Error('a read expected')
    await act(async () => { first(); await Promise.resolve() })
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(true)
  })

  it('ignores a response that arrives after the inputs changed', async () => {
    const pending: Array<(state: ReturnType<typeof fixtureState>) => void> = []
    const slow: typeof fetch = (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.includes('/api/dv/state')) return Promise.resolve(new Response('[]'))
      return new Promise<Response>((resolve) => { pending.push((state) => { resolve(new Response(JSON.stringify(state))) }) })
    }
    const client = new DvClient(slow)
    const { result, rerender } = renderHook(({ project }: { project: string }) => useProjectState(client, project), { initialProps: { project: 'p1' } })
    rerender({ project: 'p2' })
    const first = pending.shift()
    const second = pending.shift()
    if (first === undefined || second === undefined) throw new Error('two reads expected')
    const stale = fixtureState()
    stale.head = 'stale'
    await act(async () => { first(stale); await Promise.resolve() })
    expect(result.current.value).toBeNull()
    const fresh = fixtureState()
    fresh.head = 'fresh'
    await act(async () => { second(fresh) })
    await waitFor(() => { expect(result.current.value?.head).toBe('fresh') })
  })
})
