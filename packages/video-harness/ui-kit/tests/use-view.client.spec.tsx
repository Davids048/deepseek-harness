// @vitest-environment jsdom
/** The hooks: loading, reload on project changes, and the view session's gestures as API calls. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { VhClient } from '../src/client/api.ts'
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
    const { fetch, writes } = scriptedFetch({ projects: [PROJECT, { ...PROJECT, projectId: 'p2', title: 'Bound', current: true }] })
    const logging: typeof fetch = (input, init) => { reads.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); return fetch(input, init) }
    const client = new VhClient(logging)
    const { result } = renderHook(() => useViewSession(client, 'timeline', 's1'))
    await waitFor(() => { expect(result.current.project).toBe('p2') })
    expect(reads[0]).toBe('/api/vh/projects?session=s1')
    act(() => { result.current.bar.onProject('p1') })
    act(() => { result.current.bar.onCreate('Demo 3') })
    await waitFor(() => { expect(writes).toHaveLength(1) })
    expect(writes[0]).toEqual({ path: '/api/vh/projects', body: { title: 'Demo 3', surface: 'timeline' } })
    await waitFor(() => { expect(result.current.project).toBe('p2') })
    expect(result.current.head).toBe('main')
  })

  it('selects the first project, loads its state and the tools, and binds the bar gestures', async () => {
    const { fetch, writes } = scriptedFetch()
    const client = new VhClient(fetch)
    const { result } = renderHook(() => useViewSession(client, 'canvas'))
    expect(result.current.project).toBeNull()
    await waitFor(() => { expect(result.current.state.value).not.toBeNull() })
    expect(result.current.project).toBe('p1')
    expect(result.current.tools.value?.length).toBeGreaterThan(0)
    expect(result.current.readOnly).toBe(false)
    act(() => { result.current.bar.onAccept('draft/s5') })
    act(() => { result.current.bar.onDiscard('draft/s5') })
    act(() => { result.current.bar.onUndo() })
    await waitFor(() => { expect(writes).toHaveLength(3) })
    expect(writes.map(write => write.path)).toEqual(['/api/vh/drafts/accept', '/api/vh/drafts/discard', '/api/vh/undo'])
    expect(writes[0]?.body).toEqual({ project: 'p1', branch: 'draft/s5', surface: 'canvas' })
    // Discard confirms the counts the state showed for that draft.
    expect(writes[1]?.body).toEqual({ project: 'p1', branch: 'draft/s5', surface: 'canvas', counts: { agent_changes: 1, human_edits: 0 } })
    act(() => { result.current.bar.onBranch('alt', 'main') })
    await waitFor(() => { expect(result.current.head).toBe('explore/alt') })
    expect(writes[3]?.body).toEqual({ project: 'p1', name: 'alt', at: 'main' })
    act(() => { result.current.bar.onHead('draft/s5') })
    expect(result.current.readOnly).toBe(true)
    act(() => { result.current.bar.onProject('p2') })
    expect(result.current.project).toBe('p2')
    expect(result.current.head).toBe('main')
  })

  it('switches the chat session\'s working branch when the bar shows main or an exploration branch', async () => {
    const { fetch, writes } = scriptedFetch()
    const client = new VhClient(fetch)
    const { result } = renderHook(() => useViewSession(client, 'canvas', 's5'))
    await waitFor(() => { expect(result.current.state.value).not.toBeNull() })
    expect(result.current.session).toBe('s5')
    act(() => { result.current.bar.onHead('explore/style-b') })
    act(() => { result.current.bar.onHead('draft/s5') })
    act(() => { result.current.bar.onUndo() })
    await waitFor(() => { expect(writes).toHaveLength(2) })
    expect(writes[0]).toEqual({ path: '/api/vh/branch/switch', body: { project: 'p1', branch: 'explore/style-b', session: 's5' } })
    expect(writes[1]).toEqual({ path: '/api/vh/undo', body: { project: 'p1', session: 's5' } })
  })

  it('keeps the failure message of a write and clears it on the next success', async () => {
    const { fetch } = scriptedFetch({ post: path => path === '/api/vh/undo' || path === '/api/vh/branch' || path === '/api/vh/projects' ? { status: 409, body: { error: 'nothing to undo' } } : { status: 200, body: { heads: {} } } })
    const client = new VhClient(fetch)
    const { result } = renderHook(() => useViewSession(client, 'timeline'))
    await waitFor(() => { expect(result.current.project).toBe('p1') })
    let ok = true
    await act(async () => { ok = await result.current.run(() => client.undo('p1')) })
    expect(ok).toBe(false)
    expect(result.current.notice).toBe('nothing to undo')
    await act(async () => { ok = await result.current.run(() => client.acceptDraft('p1', { session: 's5' }, 'timeline')) })
    expect(ok).toBe(true)
    expect(result.current.notice).toBeNull()
    await act(async () => { ok = await result.current.run(() => Promise.reject(new Error('boom'))) })
    expect(result.current.notice).toBe('boom')
    const plain = vi.fn<() => Promise<unknown>>().mockRejectedValue('plain')
    await act(async () => { await result.current.run(plain) })
    expect(result.current.notice).toBe('plain')
    act(() => { result.current.bar.onBranch('alt', 'main') })
    await waitFor(() => { expect(result.current.notice).toBe('nothing to undo') })
    expect(result.current.head).toBe('main')
    act(() => { result.current.bar.onHead('explore/style-b') })
    act(() => { result.current.bar.onCreate('refused') })
    await waitFor(() => { expect(result.current.notice).toBe('nothing to undo') })
    expect(result.current.head).toBe('explore/style-b')
    expect(result.current.project).toBe('p1')
  })

  it('does nothing on the bar gestures while no project exists', async () => {
    const { fetch, writes } = scriptedFetch({ projects: [] })
    const client = new VhClient(fetch)
    const { result } = renderHook(() => useViewSession(client, 'canvas'))
    await waitFor(() => { expect(result.current.projects.value).toEqual([]) })
    await waitFor(() => { expect(result.current.state.error).toBe('no project') })
    act(() => {
      result.current.bar.onAccept('t')
      result.current.bar.onDiscard('t')
      result.current.bar.onUndo()
      result.current.bar.onBranch('x', 'main')
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
    const client = new VhClient(fetch)
    const { result, unmount } = renderHook(() => useProjectState(client, 'p1', 'main'))
    await waitFor(() => { expect(result.current.value).not.toBeNull() })
    expect(reads).toBe(1)
    expect(result.current.loading).toBe(false)
    vi.useFakeTimers()
    const fire = (): void => { listeners.get('branch')?.(new MessageEvent('branch', { data: '{"kind":"branch","name":"main","branch":null}' })) }
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
    const client = new VhClient(fetch)
    const { result } = renderHook(() => useProjectState(client, 'p1', 'main'))
    await waitFor(() => { expect(result.current.value).not.toBeNull() })
    fail = true
    act(() => { result.current.reload() })
    await waitFor(() => { expect(result.current.error).toBe('offline') })
    expect(result.current.value).not.toBeNull()
  })

  it('reports a rejection that is not an Error as text', async () => {
    const failing = vi.fn<typeof fetch>().mockRejectedValue('offline')
    const client = new VhClient(failing)
    const { result } = renderHook(() => useProjectState(client, 'p1', 'main'))
    await waitFor(() => { expect(result.current.error).toBe('offline') })
  })

  it('ignores a rejection that arrives after the inputs changed', async () => {
    const pending: Array<() => void> = []
    const slow: typeof fetch = () => new Promise<Response>((_resolve, reject) => { pending.push(() => { reject(new Error('late')) }) })
    const client = new VhClient(slow)
    const { result, rerender } = renderHook(({ head }: { head: string }) => useProjectState(client, 'p1', head), { initialProps: { head: 'main' } })
    rerender({ head: 'style-b' })
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
      if (!url.includes('/api/vh/state')) return Promise.resolve(new Response('[]'))
      return new Promise<Response>((resolve) => { pending.push((state) => { resolve(new Response(JSON.stringify(state))) }) })
    }
    const client = new VhClient(slow)
    const { result, rerender } = renderHook(({ head }: { head: string }) => useProjectState(client, 'p1', head), { initialProps: { head: 'main' } })
    rerender({ head: 'style-b' })
    const first = pending.shift()
    const second = pending.shift()
    if (first === undefined || second === undefined) throw new Error('two reads expected')
    const stale = fixtureState()
    stale.head = 'stale'
    await act(async () => { first(stale); await Promise.resolve() })
    expect(result.current.value).toBeNull()
    const fresh = fixtureState()
    fresh.head = 'style-b'
    await act(async () => { second(fresh) })
    await waitFor(() => { expect(result.current.value?.head).toBe('style-b') })
  })
})
