/** The browser client: routes, bodies, error decoding, advisory selection, and log following. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assetUrl, VhApiError, VhClient } from '../src/client/api.ts'
import { fixtureState, PROJECT, scriptedFetch } from './fixture.client.tsx'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('VhClient', () => {
  it('reads the routes with query strings and posts JSON bodies', async () => {
    const { fetch, writes } = scriptedFetch()
    const client = new VhClient(fetch)
    expect(await client.projects()).toEqual([PROJECT])
    expect(await client.projects(undefined, 's1')).toEqual([PROJECT])
    expect(await client.createProject('Demo 2', 'canvas')).toMatchObject({ heads: { main: 'x' } })
    expect((await client.state('p1', 'explore/style-b')).project.projectId).toBe('p1')
    expect((await client.tools()).map(tool => tool.name)).toContain('shot.render')
    const record = await client.invoke({ project: 'p1', tool: 'timeline.clip_move', params: { clip: 2, to: 1 }, surface: 'timeline' })
    expect(record.tool?.name).toBe('timeline.clip_move')
    await client.acceptDraft('p1', { session: 's5' }, 'canvas')
    await client.undo('p1')
    await client.branch('p1', 'alt', 'main')
    await client.select({ project: 'p1', kind: 'op', id: 'g1', surface: 'canvas' })
    await client.discardDraft('p1', { branch: 'draft/s5' }, 'timeline')
    await client.discardDraft('p1', { session: 's5' }, 'canvas', { agent_changes: 1, human_edits: 0 })
    await client.redo('p1', 's5')
    await client.switchBranch('p1', 'main', 's5')
    expect(writes.map(write => write.path)).toEqual([
      '/api/vh/projects', '/api/vh/invoke', '/api/vh/drafts/accept', '/api/vh/undo', '/api/vh/branch', '/api/vh/selection',
      '/api/vh/drafts/discard', '/api/vh/drafts/discard', '/api/vh/redo', '/api/vh/branch/switch',
    ])
    expect(writes[0]?.body).toEqual({ title: 'Demo 2', surface: 'canvas' })
    expect(writes[2]?.body).toEqual({ project: 'p1', session: 's5', surface: 'canvas' })
    expect(writes[3]?.body).toEqual({ project: 'p1' })
    expect(writes[4]?.body).toEqual({ project: 'p1', name: 'alt', at: 'main' })
    // Without counts the discard is a dry read; with them it discards.
    expect(writes[6]?.body).toEqual({ project: 'p1', branch: 'draft/s5', surface: 'timeline' })
    expect(writes[7]?.body).toEqual({ project: 'p1', session: 's5', surface: 'canvas', counts: { agent_changes: 1, human_edits: 0 } })
    expect(writes[8]?.body).toEqual({ project: 'p1', session: 's5' })
    expect(writes[9]?.body).toEqual({ project: 'p1', branch: 'main', session: 's5' })
    expect(assetUrl('a/b')).toBe('/dv/assets/a%2Fb')
  })

  it('uses the browser fetch when none is given', async () => {
    const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(new Response('[]')))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await new VhClient().projects()).toEqual([])
    expect(fetchSpy).toHaveBeenCalledWith('/api/vh/projects', { signal: null })
  })

  it('turns error statuses into VhApiError and swallows selection failures', async () => {
    const failing: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({ error: 'Unknown project' }), { status: 404 }))
    const client = new VhClient(failing)
    await expect(client.state('nope', 'main')).rejects.toMatchObject({ name: 'VhApiError', status: 404, message: 'Unknown project' })
    const noBody: typeof fetch = () => Promise.resolve(new Response('not json', { status: 500 }))
    await expect(new VhClient(noBody).projects()).rejects.toThrow(new VhApiError(500, 'HTTP 500'))
    await expect(client.select({ project: 'nope', kind: 'clip', id: 'a', slot: 1, surface: 'timeline' })).resolves.toBeUndefined()
    // A refused Project call carries its code and the rest of the body, such as a changed draft's counts.
    const changed: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
      error: 'The draft changed.', code: 'draft_changed', counts: { agent_changes: 2, human_edits: 0 },
    }), { status: 409 }))
    await expect(new VhClient(changed).discardDraft('p1', { session: 's5' }, 'canvas', { agent_changes: 1, human_edits: 0 })).rejects.toMatchObject({
      status: 409, code: 'draft_changed', body: { counts: { agent_changes: 2, human_edits: 0 } },
    })
  })

  it('follows the project changes through EventSource when the browser has it', () => {
    const listeners = new Map<string, EventListener>()
    const close = vi.fn()
    class FakeEventSource {
      constructor(readonly url: string) {}
      addEventListener(type: string, listener: EventListener): void { listeners.set(type, listener) }
      removeEventListener(type: string): void { listeners.delete(type) }
      close = close
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    const seen: unknown[] = []
    const stop = new VhClient().subscribe('p1', (event) => { seen.push(event) })
    expect([...listeners.keys()]).toEqual(['ready', 'record', 'update', 'branch'])
    listeners.get('record')?.(new MessageEvent('record', { data: JSON.stringify({ kind: 'record', record: fixtureState().ops[1] }) }))
    listeners.get('branch')?.(new MessageEvent('branch', { data: 'not json' }))
    expect(seen).toEqual([{ kind: 'record', record: fixtureState().ops[1] }, null])
    stop()
    expect(close).toHaveBeenCalledOnce()
  })

  it('shares one EventSource per project across clients and closes it after the last subscriber stops', () => {
    const opened: string[] = []
    const close = vi.fn()
    class FakeEventSource {
      constructor(readonly url: string) { opened.push(url) }
      addEventListener(): void {}
      removeEventListener(): void {}
      close = close
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    const streams = (): unknown => (globalThis as typeof globalThis & { __vhStreams?: number }).__vhStreams
    const stopA = new VhClient().subscribe('shared-1', () => {})
    const stopB = new VhClient().subscribe('shared-1', () => {})
    const stopC = new VhClient().subscribe('shared-2', () => {})
    expect(opened).toEqual(['/vh/events?project=shared-1', '/vh/events?project=shared-2'])
    expect(streams()).toBe(2)
    stopA()
    stopA()
    expect(close).not.toHaveBeenCalled()
    stopB()
    stopC()
    expect(close).toHaveBeenCalledTimes(2)
    expect(streams()).toBe(0)
  })

  it('polls when EventSource is missing', () => {
    vi.stubGlobal('EventSource', undefined)
    vi.useFakeTimers()
    const onChange = vi.fn()
    const stop = new VhClient().subscribe('p1', onChange, 100)
    vi.advanceTimersByTime(250)
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledWith(null)
    stop()
    vi.advanceTimersByTime(200)
    expect(onChange).toHaveBeenCalledTimes(2)
  })
})
