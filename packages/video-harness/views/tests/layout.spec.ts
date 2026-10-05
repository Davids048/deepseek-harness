/** The canvas layout route: read, merge, and refusals. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type VhOpLog from '@video-harness/oplog'
import { CanvasLayoutStore, LAYOUT_ROUTE, layoutRoutes } from '../src/layout.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** The route over a temporary directory and a log that knows only project `p1`. */
function route() {
  const root = mkdtempSync(join(tmpdir(), 'vh-layout-'))
  roots.push(root)
  const log = { project: (id: string) => { if (id !== 'p1') throw new Error('unknown') } } as Pick<VhOpLog, 'project'>
  const [entry] = layoutRoutes(log, new CanvasLayoutStore(root))
  if (entry === undefined) throw new Error('no route')
  const call = async (method: 'GET' | 'POST', query: string, body?: unknown) => {
    const response = await entry.fetch(new Request(`http://host${LAYOUT_ROUTE}${query}`, { method, ...body === undefined ? {} : { body: JSON.stringify(body) } }))
    return { status: response.status, json: await response.json() as unknown }
  }
  return { entry, call }
}

describe('layoutRoutes', () => {
  it('stores merged positions and the viewport per project', async () => {
    const { entry, call } = route()
    expect(entry.methods).toEqual(['GET', 'POST'])
    expect((await call('GET', '?project=p1')).json).toEqual({ positions: {}, viewport: null })
    await call('POST', '', { project: 'p1', positions: { g1: { x: 1, y: 2 } }, viewport: { x: 0, y: 0, zoom: 1 } })
    await call('POST', '', { project: 'p1', positions: { g2: { x: 3, y: 4 }, bad: { x: 'no', y: 1 } } })
    expect((await call('GET', '?project=p1')).json).toEqual({ positions: { g1: { x: 1, y: 2 }, g2: { x: 3, y: 4 } }, viewport: { x: 0, y: 0, zoom: 1 } })
  })

  it('answers 400 without a project and 404 for an unknown one', async () => {
    const { call } = route()
    expect((await call('GET', '')).status).toBe(400)
    expect((await call('POST', '', { project: 'nope', positions: {} })).status).toBe(404)
  })
})
