/**
 * The browser API over the real runtime, tools, and log: folded state on the wire, user invocations from the canvas and
 * the timeline, draft acceptance, undo, branches, selections, the Fetch routes, and the event stream.
 */
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import type { OpLogEvent } from '@video-harness/oplog'
import { startTools, type ToolsFixture } from '../../tools/tests/support.ts'
import { WORKSPACE_ROUTES } from '../src/workspaces.ts'
import VhViews, { EVENTS_PATH, ROUTES, ViewsRequestError, frameOf, mentionedAssets, messageOf } from '../src/index.ts'

/** Keeps the registered Fetch routes and admits every request. */
class FakeConnection {
  readonly routes = new Map<string, ConnectionFetchRoute>()
  rejection: 401 | 403 | undefined = undefined
  readonly fetch = {
    register: (route: ConnectionFetchRoute): (() => Promise<void>) => {
      this.routes.set(route.path, route)
      return () => { this.routes.delete(route.path); return Promise.resolve() }
    },
  }

  requestRejection(): 401 | 403 | undefined {
    return this.rejection
  }
}

/** Keeps the registered prefix routes and serves them on a local port. */
class FakeWebServer {
  readonly routes = new Map<string, WebRoute>()
  server: Server | null = null

  register(route: WebRoute): () => void {
    this.routes.set(route.path, route)
    return () => { this.routes.delete(route.path) }
  }

  async listen(): Promise<string> {
    this.server = createServer((request, response) => {
      const route = [...this.routes.values()].find(candidate => (request.url ?? '').startsWith(candidate.path))
      if (route === undefined) response.writeHead(404).end()
      else void route.handler(request, response)
    })
    await new Promise<void>((resolve) => { this.server?.listen(0, '127.0.0.1', resolve) })
    return `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`
  }

  async close(): Promise<void> {
    const server = this.server
    if (server === null) return
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
}

interface Fixture extends ToolsFixture {
  views: VhViews
  connection: FakeConnection
  web: FakeWebServer
}

const fixtures: Fixture[] = []

async function start(): Promise<Fixture> {
  const base = await startTools({ perception: false, generation: 'none' })
  const connection = new FakeConnection()
  const web = new FakeWebServer()
  base.context.provide('connection', connection)
  base.context.provide('webServer', web)
  await base.context.plugin(VhViews, { keepaliveMs: 50 }).await()
  const fixture = { ...base, views: base.context.vhViews, connection, web }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.web.close()
    await fixture.dispose()
  }
})

/** Call a registered Fetch route the way the Connection would. */
async function call(
  fixture: Fixture,
  path: string,
  init: { method?: string; query?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
  const route = fixture.connection.routes.get(path)
  if (route === undefined) throw new Error(`No route ${path}`)
  const url = new URL(`http://localhost${path}`)
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value)
  const request = new Request(url, {
    method: init.method ?? 'GET',
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }),
  })
  const response = await route.fetch(request)
  return { status: response.status, json: await response.json() }
}

describe('vhViews', () => {
  it('lists projects, folds state with asset records, and lists tool declarations', async () => {
    const fixture = await start()
    const projectId = fixture.project.createProject({ title: 'demo' })
    const upload = await fixture.views.api.invoke({
      project: projectId, tool: 'asset.upload', surface: 'canvas', intent: 'upload a reference',
      params: { path: fixture.writeFile('ref.png', 'PNG'), mime: 'image/png' },
    })
    expect(upload.status).toBe('done')
    expect(upload.actor).toBe('user')
    expect(upload.surface).toBe('canvas')

    const projects = fixture.views.api.projects()
    expect(projects.map(entry => entry.projectId)).toContain(projectId)
    expect(projects[0]?.heads['main']).toBeDefined()
    expect(projects.every(entry => !entry.current)).toBe(true)
    // The project a chat session is bound to comes first and is marked, whatever its age.
    const bound = (await fixture.call('vh_project_create', { title: 'from chat' })).value as { project_id: string }
    fixture.project.createProject({ title: 'newest' })
    expect(fixture.views.api.projects('anonymous').map(entry => [entry.title, entry.current])).toEqual([['from chat', true], ['newest', false], ['demo', false]])
    expect(fixture.views.api.projects('').map(entry => entry.title)).toEqual(['newest', 'from chat', 'demo'])
    expect(bound.project_id).toBe(fixture.tools.sessionProject('anonymous'))
    const made = fixture.views.api.create({ title: 'from the timeline', surface: 'timeline' })
    expect(fixture.views.api.state(made.projectId).ops[0]).toMatchObject({ surface: 'timeline', actor: 'user' })
    expect(fixture.views.api.create({ title: 'from the canvas' }).title).toBe('from the canvas')
    expect(() => fixture.views.api.create({})).toThrow(/title/)
    // Two clients that pick the same title get two distinct ones.
    expect(fixture.views.api.create({ title: '未命名项目 6' }).title).toBe('未命名项目 6')
    expect(fixture.views.api.create({ title: '未命名项目 6' }).title).toBe('未命名项目 7')
    expect(fixture.views.api.create({ title: 'from the canvas' }).title).toBe('from the canvas 2')

    const state = fixture.views.api.state(projectId)
    expect(state.project.title).toBe('demo')
    expect(state.ops.map(op => op.tool?.name)).toContain('asset.upload')
    expect(state.assets.map(asset => asset.id)).toEqual(upload.outputs)
    expect(state.assets[0]?.mime).toBe('image/png')
    expect(state.heads['main']).toBe(state.head)

    const tools = fixture.views.api.tools()
    const frame = tools.find(tool => tool.name === 'media.extract_frame')
    expect(frame?.deterministic).toBe(true)
    expect(frame?.params['at']).toBeDefined()
    expect(Object.keys(frame ?? {})).not.toContain('execute')
  })

  it('refuses malformed and unknown requests with the matching status', async () => {
    const fixture = await start()
    const projectId = fixture.project.createProject({ title: 'demo' })
    expect(() => fixture.views.api.state('')).toThrow(ViewsRequestError)
    expect(() => fixture.views.api.state('nope')).toThrow(/Unknown project/)
    expect(() => fixture.views.api.state(projectId, 'no-such-branch')).toThrow(ViewsRequestError)
    await expect(fixture.views.api.invoke({ project: projectId, tool: 'no.such', surface: 'canvas' })).rejects.toThrow(/Unknown tool/)
    await expect(fixture.views.api.invoke({ project: projectId, tool: 'asset.upload', surface: 'canvas', inputs: [{ role: 'x' }] })).rejects.toThrow(/inputs\[\]\.ref/)
    await expect(fixture.views.api.invoke({ project: projectId, tool: 'asset.upload', surface: 'canvas', inputs: 'x' })).rejects.toThrow(/array/)
    expect(() => fixture.views.api.turn({ project: projectId, turn: 't', action: 'other' })).toThrow(/accept or reject/)
    expect(() => fixture.views.api.turn({ project: projectId, turn: 'unknown', action: 'accept' })).toThrow(ViewsRequestError)
    expect(() => fixture.views.api.select({ project: projectId, kind: 'thing', id: 'x' })).toThrow(/kind/)
    expect(() => fixture.views.api.branch({ project: projectId, name: '' })).toThrow(/name/)
  })

  it('records timeline gestures as user turns on main and schedules calls that wait for a producer', async () => {
    const fixture = await start()
    const projectId = fixture.project.createProject({ title: 'demo' })
    const a = await fixture.views.api.invoke({ project: projectId, tool: 'asset.upload', surface: 'timeline', params: { path: fixture.writeFile('a.mp4', 'A'), mime: 'video/mp4' } })
    const b = await fixture.views.api.invoke({ project: projectId, tool: 'asset.upload', surface: 'timeline', params: { path: fixture.writeFile('b.mp4', 'B'), mime: 'video/mp4' } })
    const created = await fixture.views.api.invoke({ project: projectId, tool: 'sequence.create', surface: 'timeline', params: { assets: [a.outputs[0], b.outputs[0]] } })
    expect(created.status).toBe('done')
    const moved = await fixture.views.api.invoke({ project: projectId, tool: 'sequence.move', surface: 'timeline', intent: 'drag clip 2 before clip 1', params: { from: 2, to: 1 } })
    expect(moved.intent).toBe('drag clip 2 before clip 1')
    const state = fixture.views.api.state(projectId)
    expect(state.sequence?.items.map(item => item.assetId)).toEqual([b.outputs[0], a.outputs[0]])
    expect(Object.values(state.turns).every(turn => turn.actor === 'user' && turn.accepted)).toBe(true)

    const pending = await fixture.views.api.invoke({
      project: projectId, tool: 'asset.upload', surface: 'canvas', params: { path: fixture.writeFile('c.png', 'C'), mime: 'image/png' },
      inputs: [{ role: 'ignored', ref: `${a.id}#0` }],
    })
    expect(['done', 'pending', 'running']).toContain(pending.status)
    await fixture.project.whenIdle(projectId)
    expect(fixture.log.get(projectId, pending.id).status).toBe('done')
  })

  it('accepts and rejects agent drafts, undoes the latest turn, and starts branches', async () => {
    const fixture = await start()
    const projectId = fixture.project.createProject({ title: 'demo' })
    const draft = fixture.project.beginTurn(projectId, { actor: 'agent', surface: 'chat', intent: 'plan' })
    await fixture.project.invoke(projectId, {
      tool: 'asset.upload', inputs: [], params: { path: fixture.writeFile('d.png', 'D'), mime: 'image/png' },
      actor: 'agent', surface: 'chat', intent: 'upload', turn: draft.turn,
    })
    const mainBefore = fixture.log.heads(projectId)['main']
    expect(fixture.views.api.state(projectId).openTurns).toEqual([draft.turn])
    expect(fixture.views.api.state(projectId, draft.branch).ops.length).toBeGreaterThan(fixture.views.api.state(projectId).ops.length)
    const heads = fixture.views.api.turn({ project: projectId, turn: draft.turn, action: 'accept', surface: 'canvas' })
    expect(heads['main']).not.toBe(mainBefore)
    expect(fixture.views.api.state(projectId).turns[draft.turn]?.accepted).toBe(true)

    const second = fixture.project.beginTurn(projectId, { actor: 'agent', surface: 'chat', intent: 'again' })
    fixture.views.api.turn({ project: projectId, turn: second.turn, action: 'reject', surface: 'timeline' })
    expect(fixture.log.heads(projectId)['main']).toBe(heads['main'])
    // The rejected draft keeps its head, but the state no longer lists it as open.
    expect(fixture.log.heads(projectId)[second.branch]).toBeDefined()
    expect(fixture.views.api.state(projectId).openTurns).toEqual([])

    const undone = fixture.views.api.undo({ project: projectId })
    expect(undone.turn).toBe(draft.turn)
    expect(undone.heads['main']).toBe(mainBefore)

    const branch = fixture.views.api.branch({ project: projectId, name: 'style-b', at: 'main' })
    expect(branch.heads['style-b']).toBe(branch.op.id)
    const onBranch = await fixture.views.api.invoke({ project: projectId, tool: 'asset.upload', surface: 'canvas', branch: 'style-b', params: { path: fixture.writeFile('e.png', 'E'), mime: 'image/png' } })
    expect(onBranch.branch).toBe('style-b')
    expect(fixture.views.api.state(projectId, 'style-b').ops.map(op => op.id)).toContain(onBranch.id)
    expect(fixture.views.api.state(projectId).ops.map(op => op.id)).not.toContain(onBranch.id)
  })

  it('keeps the last selection per project', async () => {
    const fixture = await start()
    const projectId = fixture.project.createProject({ title: 'demo' })
    expect(fixture.views.selection(projectId)).toBeNull()
    const selection = fixture.views.api.select({ project: projectId, kind: 'clip', id: 'asset-1', slot: 2, surface: 'timeline' })
    expect(selection.slot).toBe(2)
    expect(fixture.views.selection(projectId)?.id).toBe('asset-1')
    fixture.views.api.select({ project: projectId, kind: 'op', id: 'op-1', surface: 'canvas' })
    expect(fixture.views.selection(projectId)?.kind).toBe('op')
    expect(fixture.views.selection(projectId)?.slot).toBeUndefined()
  })

  it('serves the Fetch routes under /api/vh with statuses from the operations', async () => {
    const fixture = await start()
    const projectId = fixture.project.createProject({ title: 'demo' })
    for (const path of Object.values(ROUTES)) expect(fixture.connection.routes.has(path)).toBe(true)

    const projects = await call(fixture, ROUTES.projects, { query: { session: 'anonymous' } })
    expect(projects.status).toBe(200)
    expect(JSON.stringify(projects.json)).toContain(projectId)
    const created = await call(fixture, ROUTES.projects, { method: 'POST', body: { title: 'posted', surface: 'canvas' } })
    expect(created.status).toBe(200)
    expect((created.json as { title: string }).title).toBe('posted')
    expect((await call(fixture, ROUTES.projects, { method: 'POST', body: {} })).status).toBe(400)

    const missing = await call(fixture, ROUTES.state, { query: { project: 'nope' } })
    expect(missing.status).toBe(404)

    const invoked = await call(fixture, ROUTES.invoke, {
      method: 'POST', body: { project: projectId, tool: 'asset.upload', surface: 'canvas', params: { path: fixture.writeFile('f.png', 'F'), mime: 'image/png' } },
    })
    expect(invoked.status).toBe(200)
    const state = await call(fixture, ROUTES.state, { query: { project: projectId, head: 'main' } })
    expect(state.status).toBe(200)
    expect((state.json as { assets: unknown[] }).assets).toHaveLength(1)

    const tools = await call(fixture, ROUTES.tools)
    expect(Array.isArray(tools.json)).toBe(true)
    const badTurn = await call(fixture, ROUTES.turn, { method: 'POST', body: { project: projectId, turn: 'x', action: 'accept' } })
    expect(badTurn.status).toBe(409)
    const noBody = await call(fixture, ROUTES.undo, { method: 'POST' })
    expect(noBody.status).toBe(400)
    const branched = await call(fixture, ROUTES.branch, { method: 'POST', body: { project: projectId, name: 'b2' } })
    expect(branched.status).toBe(200)
    const selected = await call(fixture, ROUTES.selection, { method: 'POST', body: { project: projectId, kind: 'asset', id: 'a', surface: 'canvas' } })
    expect(selected.status).toBe(200)
    const read = await call(fixture, ROUTES.selection, { query: { project: projectId } })
    expect((read.json as { id: string }).id).toBe('a')
  })

  it('streams log changes as server-sent events and refuses rejected or unknown requests', async () => {
    const fixture = await start()
    const projectId = fixture.project.createProject({ title: 'demo' })
    const base = await fixture.web.listen()

    const noProject = await fetch(`${base}${EVENTS_PATH}`)
    expect(noProject.status).toBe(400)
    const unknown = await fetch(`${base}${EVENTS_PATH}?project=nope`)
    expect(unknown.status).toBe(404)
    fixture.connection.rejection = 401
    const rejected = await fetch(`${base}${EVENTS_PATH}?project=${projectId}`)
    expect(rejected.status).toBe(401)
    fixture.connection.rejection = undefined

    const controller = new AbortController()
    const response = await fetch(`${base}${EVENTS_PATH}?project=${projectId}`, { signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('no body')
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (needle: string): Promise<void> => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value)
      }
    }
    await readUntil(': connected')
    await fixture.views.api.invoke({ project: projectId, tool: 'asset.upload', surface: 'canvas', params: { path: fixture.writeFile('g.png', 'G'), mime: 'image/png' } })
    await readUntil('event: op')
    expect(text).toContain('"kind":"append"')
    await readUntil(': keepalive')
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  it('frames head moves and appends, and lists every asset a state mentions', async () => {
    const fixture = await start()
    const projectId = fixture.project.createProject({ title: 'demo' })
    const head: OpLogEvent = { kind: 'head', branch: 'main', to: fixture.log.heads(projectId)['main'] as NonNullable<ReturnType<typeof fixture.log.heads>['main']> }
    expect(frameOf(head)).toMatch(/^event: head\ndata: \{.*\}\n\n$/)
    const upload = await fixture.views.api.invoke({ project: projectId, tool: 'asset.upload', surface: 'canvas', params: { path: fixture.writeFile('h.png', 'H'), mime: 'image/png' } })
    await fixture.views.api.invoke({ project: projectId, tool: 'entity.character.create', surface: 'canvas', params: { entity: 'c1', name: 'Hero', refs: upload.outputs } })
    const state = fixture.project.fold(projectId)
    expect(mentionedAssets(state)).toEqual(upload.outputs)
  })

  it('names errors, orders projects, and refuses an undo without turns or a branch at an unknown record', async () => {
    expect(messageOf(new Error('boom'))).toBe('boom')
    expect(messageOf('plain')).toBe('plain')
    const fixture = await start()
    const older = fixture.project.createProject({ title: 'older' })
    const projectId = fixture.project.createProject({ title: 'demo' })
    expect(fixture.views.api.projects().map(entry => entry.projectId).sort()).toEqual([older, projectId].sort())
    expect(() => fixture.views.api.undo({ project: older })).toThrow(ViewsRequestError)
    expect(() => fixture.views.api.branch({ project: older, name: 'b', at: 'nowhere' })).toThrow(ViewsRequestError)
  })

  it('records base_op and supersedes, lists only known assets, and folds an empty or non-string head as main', async () => {
    const fixture = await start()
    const projectId = fixture.project.createProject({ title: 'demo' })
    const first = await fixture.views.api.invoke({ project: projectId, tool: 'asset.upload', surface: 'canvas', params: { path: fixture.writeFile('r.png', 'R'), mime: 'image/png' } })
    const second = await fixture.views.api.invoke({
      project: projectId, tool: 'asset.upload', surface: 'canvas', params: { path: fixture.writeFile('s.png', 'S'), mime: 'image/png' },
      inputs: [{ role: 'ignored', ref: first.outputs[0] }], base_op: first.id, supersedes: [first.id, 7],
    })
    expect(second.base_op).toBe(first.id)
    expect(second.supersedes).toEqual([first.id])
    await fixture.views.api.invoke({ project: projectId, tool: 'entity.character.create', surface: 'canvas', params: { entity: 'c1', name: 'Hero', refs: ['nowhere'] } })
    expect(fixture.views.api.state(projectId).assets.map(entry => entry.id)).toEqual([...first.outputs, ...second.outputs])
    expect(fixture.views.api.state(projectId, '').head).toBe(fixture.views.api.state(projectId, 7).head)
    const folded = fixture.project.fold(projectId)
    const unresolved = { ...folded, ops: folded.ops.map(op => ({ ...op, inputs: [{ role: 'clip', ref: 'zzz#0' as const, resolved: null }] })) }
    expect(mentionedAssets(unresolved)).toEqual([...first.outputs, ...second.outputs, 'nowhere'])
  })

  it('schedules a call whose input waits for a record that is still running', async () => {
    const fixture = await start()
    const projectId = fixture.project.createProject({ title: 'demo' })
    const slowTurn = fixture.project.beginTurn(projectId, { actor: 'user', surface: 'api', intent: 'slow' })
    // A tool that writes its output after 0.3 s keeps its record running while the view call arrives.
    fixture.project.registerTool({
      name: 'slow', version: '1', deterministic: false,
      execute: async (execution) => {
        await new Promise(resolve => setTimeout(resolve, 300))
        return { outputs: [execution.assets.put(Buffer.from('T'), { mime: 'text/plain' })] }
      },
    })
    const slow = fixture.project.schedule(projectId, { tool: 'slow', inputs: [], params: {}, actor: 'user', surface: 'api', intent: 'slow', turn: slowTurn.turn })
    const waiting = await fixture.views.api.invoke({
      project: projectId, tool: 'asset.upload', surface: 'canvas', params: { path: fixture.writeFile('t.png', 'T'), mime: 'image/png' },
      inputs: [{ role: 'ignored', ref: `${slow.id}#0` }],
    })
    expect(waiting.status).toBe('pending')
    await fixture.project.whenIdle(projectId)
    expect(fixture.log.get(projectId, waiting.id).status).toBe('done')
  })

  it('reports a run that fails outside the request checks as 500', async () => {
    const fixture = await start()
    const projectId = fixture.project.createProject({ title: 'demo' })
    const body = { project: projectId, tool: 'media.probe', surface: 'canvas', inputs: [{ role: 'clip', ref: 'missing#0' }] }
    await expect(fixture.views.api.invoke(body)).rejects.toThrow()
    const response = await call(fixture, ROUTES.invoke, { method: 'POST', body })
    expect(response.status).toBe(500)
  })

  it('links a project to its Workspace and binds a chat session to the project', async () => {
    const previous = process.env['VH_STATE_ROOT']
    const root = mkdtempSync(join(tmpdir(), 'vh-workspaces-'))
    process.env['VH_STATE_ROOT'] = root
    try {
      const fixture = await start()
      const projectId = fixture.project.createProject({ title: 'linked' })
      const listed = await call(fixture, WORKSPACE_ROUTES.workspaces)
      const rows = (listed.json as { entryPath: string; projects: Array<{ projectId: string; path: string; workspaceId: string | null }> })
      expect(rows.entryPath).toBe(join(root, 'entry'))
      expect(rows.projects.find(row => row.projectId === projectId)).toMatchObject({ path: join(root, 'projects', projectId), workspaceId: null })
      expect((await call(fixture, WORKSPACE_ROUTES.workspaces, { method: 'POST', body: { project: projectId, workspaceId: 'ws-1' } })).status).toBe(200)
      const relisted = (await call(fixture, WORKSPACE_ROUTES.workspaces)).json as {
        projects: Array<{ projectId: string; workspaceId: string | null }>
      }
      expect(relisted.projects.find(row => row.projectId === projectId)?.workspaceId).toBe('ws-1')
      expect((await call(fixture, WORKSPACE_ROUTES.bind, { method: 'POST', body: { session: 'chat-1', project: projectId } })).json).toEqual({ ok: true })
      expect(fixture.views.api.projects('chat-1')[0]).toMatchObject({ projectId, current: true })
      expect((await call(fixture, WORKSPACE_ROUTES.bind, { method: 'POST', body: { session: 'chat-1', project: 'missing' } })).status).toBe(400)
    } finally {
      if (previous === undefined) delete process.env['VH_STATE_ROOT']
      else process.env['VH_STATE_ROOT'] = previous
    }
  })
})
