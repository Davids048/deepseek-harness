/** The browser client: routes, bodies, error decoding, and log following. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assetUrl, DvApiError, DvClient } from '../src/client/api.ts'
import { fixtureState, PROJECT, scriptedFetch } from './fixture.client.tsx'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('DvClient', () => {
  it('reads the routes with query strings and posts JSON bodies', async () => {
    const { fetch, writes } = scriptedFetch()
    const client = new DvClient(fetch)
    expect(await client.listProjects()).toEqual([PROJECT])
    expect(await client.listProjects(undefined, 's1')).toEqual([PROJECT])
    expect(await client.createProject('Demo 2', 'canvas')).toMatchObject({ record: { id: 'b1' } })
    expect((await client.getState('p1')).project.id).toBe('p1')
    expect((await client.listOperations()).map(operation => operation.name)).toContain('shot.render_ref2va')
    const record = await client.runOperation({ project: 'p1', operation: 'timeline.clip_move', params: { clip: 'cl2', to: 1 }, surface: 'timeline' })
    expect(record.operation).toBe('timeline.clip_move')
    expect(await client.undo('p1')).toEqual({ tip: 'g3', at: 'g3' })
    await client.moveTo('p1', 'g1')
    expect(await client.redo('p1')).toEqual({ tip: 'g3', at: 'g3' })
    await client.acceptStale('p1', 'g2', 'timeline', 's5')
    await client.renameProject('p1', 'Demo 3')
    await client.deleteProject('p1')
    await client.updateLayout('p1', { positions: { g1: { x: 1, y: 2 } } })
    await client.placeOnCanvas('p1', ['a1'], true, 's5')
    await client.placeOnCanvas('p1', ['a1'], false)
    await client.linkWorkspace('p1', 'w1')
    await client.bindSession('s5', 'p1')
    expect(writes.map(write => write.path)).toEqual([
      '/api/dv/projects', '/api/dv/operation', '/api/dv/undo', '/api/dv/undo', '/api/dv/redo', '/api/dv/stale/accept',
      '/api/dv/projects/rename', '/api/dv/projects/delete', '/api/dv/layout', '/api/dv/operation', '/api/dv/operation', '/api/dv/workspaces',
      '/api/dv/workspaces/bind',
    ])
    expect(writes[0]?.body).toEqual({ title: 'Demo 2', surface: 'canvas' })
    expect(writes[2]?.body).toEqual({ project: 'p1' })
    expect(writes[3]?.body).toEqual({ project: 'p1', to: 'g1' })
    expect(writes[4]?.body).toEqual({ project: 'p1' })
    expect(writes[5]?.body).toEqual({ project: 'p1', record: 'g2', surface: 'timeline', session: 's5' })
    expect(writes[8]?.body).toEqual({ project: 'p1', positions: { g1: { x: 1, y: 2 } } })
    expect(writes[9]?.body).toEqual({ project: 'p1', operation: 'asset.place', surface: 'canvas', inputs: [{ role: 'asset', ref: 'a1' }], session: 's5' })
    expect(writes[10]?.body).toEqual({ project: 'p1', operation: 'asset.unplace', surface: 'canvas', inputs: [{ role: 'asset', ref: 'a1' }] })
    expect(writes[11]?.body).toEqual({ project: 'p1', workspace_id: 'w1' })
    expect(writes[12]?.body).toEqual({ session: 's5', project: 'p1' })
    expect(assetUrl('a/b')).toBe('/dv/assets/a%2Fb')
  })

  it('uses the browser fetch when none is given', async () => {
    const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(new Response('[]')))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await new DvClient().listProjects()).toEqual([])
    expect(fetchSpy).toHaveBeenCalledWith('/api/dv/projects', { signal: null })
  })

  it('posts a history query as a JSON body and decodes the history answer and its errors', async () => {
    const calls: Array<{ path: string; init: RequestInit | undefined }> = []
    const answer = { entries: [{ record: { id: 'g1' } }], assets: [] }
    const fetchImpl: typeof fetch = (input, init) => {
      calls.push({ path: String(input), init })
      return Promise.resolve(new Response(JSON.stringify(answer)))
    }
    const controller = new AbortController()
    const history = await new DvClient(fetchImpl).listHistory(
      { project: 'p1', records: ['g1', 'g2'], tool_call: 'call-1', limit: 50 }, controller.signal,
    )
    expect(history).toEqual(answer)
    expect(calls[0]?.path).toBe('/api/dv/history')
    expect(calls[0]?.init).toMatchObject({ method: 'POST', signal: controller.signal })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      project: 'p1', records: ['g1', 'g2'], tool_call: 'call-1', limit: 50,
    })
    const unknown: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({ error: 'No record', code: 'unknown_record' }), { status: 404 }))
    await expect(new DvClient(unknown).listHistory({ project: 'p1', before: 'x' })).rejects.toMatchObject({ status: 404, code: 'unknown_record' })
  })

  it('turns error statuses into DvApiError', async () => {
    const failing: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({ error: 'Unknown project' }), { status: 404 }))
    const client = new DvClient(failing)
    await expect(client.getState('nope')).rejects.toMatchObject({ name: 'DvApiError', status: 404, message: 'Unknown project' })
    const noBody: typeof fetch = () => Promise.resolve(new Response('not json', { status: 500 }))
    await expect(new DvClient(noBody).listProjects()).rejects.toThrow(new DvApiError(500, 'HTTP 500'))
    // A refused Project call carries its code.
    const unknown: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
      error: 'Project p1 has no record r9.', code: 'unknown_record',
    }), { status: 404 }))
    await expect(new DvClient(unknown).moveTo('p1', 'r9')).rejects.toMatchObject({ status: 404, code: 'unknown_record' })
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
    const stop = new DvClient().subscribe('p1', (event) => { seen.push(event) })
    expect([...listeners.keys()]).toEqual(['ready', 'record', 'update', 'line'])
    listeners.get('record')?.(new MessageEvent('record', { data: JSON.stringify({ kind: 'record', record: fixtureState().components.proj.records[1] }) }))
    listeners.get('update')?.(new MessageEvent('update', { data: 'not json' }))
    expect(seen).toEqual([{ kind: 'record', record: fixtureState().components.proj.records[1] }, null])
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
    const streams = (): unknown => (globalThis as typeof globalThis & { __dvStreams?: number }).__dvStreams
    const stopA = new DvClient().subscribe('shared-1', () => {})
    const stopB = new DvClient().subscribe('shared-1', () => {})
    const stopC = new DvClient().subscribe('shared-2', () => {})
    expect(opened).toEqual(['/dv/events?project=shared-1', '/dv/events?project=shared-2'])
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
    const stop = new DvClient().subscribe('p1', onChange, 100)
    vi.advanceTimersByTime(250)
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledWith(null)
    stop()
    vi.advanceTimersByTime(200)
    expect(onChange).toHaveBeenCalledTimes(2)
  })
})
