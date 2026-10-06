/**
 * The browser API over the real Project service, tools, and asset store: branch state on the wire, human operation
 * calls from the canvas and the timeline, a chat session's draft (accept, discard with confirmed counts), undo and
 * redo, branches, selections, the Fetch routes, and the event stream.
 */
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import type { OperationSpec, ProjectEvent, ProjectId, RecordId, RecordOrigin, SessionId, TurnId } from '@dv/project'
import { startBase, type BaseFixture } from './support.ts'
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

interface Fixture extends BaseFixture {
  views: VhViews
  connection: FakeConnection
  web: FakeWebServer
  /** Create a project as a human outside any chat session; returns its ID. */
  newProject(title: string): Promise<ProjectId>
  /** Run `asset.import` as the agent of chat session `session`, which opens or extends that session's draft. */
  agentImport(projectId: ProjectId, session: string, name: string): Promise<RecordId>
}

const fixtures: Fixture[] = []

/** A test-only operation that holds its record running until the test releases it. */
const SLOW = 'inspect.slow' // names:allow (a test-only operation)

/** A human action outside any chat session. */
const HUMAN: RecordOrigin = { actor: 'user', surface: 'api', session: null, turn: null, tool_call: null, intent: 'test' }

/**
 * Mount the base fixture with the views plugin, a fake Connection, and a fake web server.
 * @returns the fixture.
 */
async function start(): Promise<Fixture> {
  const base = await startBase({ generation: 'none' })
  const connection = new FakeConnection()
  const web = new FakeWebServer()
  base.context.provide('connection', connection)
  base.context.provide('webServer', web)
  await base.context.plugin(VhViews, { keepaliveMs: 50 }).await()
  let calls = 0
  const fixture: Fixture = {
    ...base, views: base.context.vhViews, connection, web,
    newProject: async title => (await base.project.createProject(title, HUMAN)).id,
    agentImport: async (projectId, session, name) => {
      calls += 1
      const { record } = await base.project.run({
        project: projectId, operation: 'asset.import', params: { path: base.writeFile(name, name), mime: 'image/png' }, inputs: [],
        actor: 'agent', surface: 'chat', session: brandString<SessionId>(session), turn: brandString<TurnId>(`turn-${String(calls)}`),
        tool_call: `call-${String(calls)}`, intent: `import ${name}`, request_text: `please import ${name}`,
      })
      if (record === null) throw new Error('asset.import wrote no record')
      return record.id
    },
  }
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
  it('lists projects, reads branch state with asset records, and lists tool declarations', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const imported = await fixture.views.api.invoke({
      project: projectId, tool: 'asset.import', surface: 'canvas', intent: 'import a reference',
      params: { path: fixture.writeFile('ref.png', 'PNG'), mime: 'image/png' },
    })
    expect(imported).toMatchObject({ status: 'done', actor: 'user', surface: 'canvas', branch: 'main', turn: null, session: null, kind: 'operation' })

    const projects = fixture.views.api.projects()
    expect(projects.map(entry => entry.projectId)).toContain(projectId)
    expect(projects.find(entry => entry.projectId === projectId)?.heads['main']).toBe(imported.id)
    expect(projects.every(entry => !entry.current)).toBe(true)
    // The project a chat session is bound to comes first and is marked, whatever its age.
    const bound = (await fixture.call('dv_proj_create', { title: 'from chat' })).value as { project_id: string }
    await fixture.newProject('newest')
    expect(fixture.views.api.projects('anonymous').map(entry => [entry.title, entry.current])).toEqual([['from chat', true], ['newest', false], ['demo', false]])
    expect(fixture.views.api.projects('').map(entry => entry.title)).toEqual(['newest', 'from chat', 'demo'])
    expect(bound.project_id).toBe(fixture.project.sessionProject(brandString<SessionId>('anonymous')))
    const made = await fixture.views.api.create({ title: 'from the timeline', surface: 'timeline' })
    expect(fixture.views.api.state(made.projectId).ops[0]).toMatchObject({ surface: 'timeline', actor: 'user', tool: { name: 'proj.create' } })
    expect((await fixture.views.api.create({ title: 'from the canvas' })).title).toBe('from the canvas')
    await expect(fixture.views.api.create({})).rejects.toThrow(/title/)
    // Two clients that pick the same title get two distinct ones.
    expect((await fixture.views.api.create({ title: '未命名项目 6' })).title).toBe('未命名项目 6')
    expect((await fixture.views.api.create({ title: '未命名项目 6' })).title).toBe('未命名项目 7')
    expect((await fixture.views.api.create({ title: 'from the canvas' })).title).toBe('from the canvas 2')

    const state = fixture.views.api.state(projectId)
    expect(state.project).toMatchObject({ projectId, title: 'demo' })
    expect(state.ops.map(op => op.tool?.name)).toEqual(['proj.create', 'asset.import'])
    expect(state.assets.map(asset => asset.id)).toEqual(imported.outputs)
    expect(state.assets[0]?.mime).toBe('image/png')
    expect(state.heads['main']).toBe(state.head)
    expect(state.branches).toEqual([{ name: 'main', head: imported.id, base: null, forked_at: null, session: null, counts: null }])
    expect(state.producers).toEqual({ [imported.outputs[0] ?? '']: imported.id })

    const tools = fixture.views.api.tools()
    const still = tools.find(tool => tool.name === 'asset.grab_still')
    expect(still?.deterministic).toBe(true)
    expect(still?.cost).toBe('cpu')
    expect(still?.params['at']).toBeDefined()
    expect(Object.keys(still ?? {})).not.toContain('execute')
    expect(tools.find(tool => tool.name === 'asset.import')?.cost).toBe('free')
  })

  it('refuses malformed and unknown requests with the matching status and code', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    expect(() => fixture.views.api.state('')).toThrow(ViewsRequestError)
    expect(() => fixture.views.api.state('nope')).toThrow(/Unknown project/)
    expect(() => fixture.views.api.state(projectId, 'no-such-branch')).toThrow(ViewsRequestError)
    await expect(fixture.views.api.invoke({ project: projectId, tool: 'no.such', surface: 'canvas' })).rejects.toThrow(/Unknown tool/)
    await expect(fixture.views.api.invoke({ project: projectId, tool: 'asset.import', surface: 'canvas', inputs: [{ role: 'x' }] })).rejects.toThrow(/inputs\[\]\.ref/)
    await expect(fixture.views.api.invoke({ project: projectId, tool: 'asset.import', surface: 'canvas', inputs: 'x' })).rejects.toThrow(/array/)
    await expect(fixture.views.api.invoke({ project: projectId, tool: 'asset.import', surface: 'canvas', inputs: [{ role: 'nope', ref: 'a' }] }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Unknown input role/) })
    await expect(fixture.views.api.invoke({ project: projectId, tool: 'asset.import', surface: 'canvas', params: {} }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_params' })
    await expect(fixture.views.api.acceptDraft({ project: projectId, session: 'nobody' })).rejects.toMatchObject({ status: 409, code: 'no_open_draft' })
    await expect(fixture.views.api.discardDraft({ project: projectId })).rejects.toThrow(/branch/)
    expect(() => fixture.views.api.select({ project: projectId, kind: 'thing', id: 'x' })).toThrow(/kind/)
    await expect(fixture.views.api.branch({ project: projectId, name: '' })).rejects.toThrow(/name/)
    await expect(fixture.views.api.switchBranch({ project: projectId, branch: 'main' })).rejects.toThrow(/session/)
  })

  it('records timeline gestures on main without a turn and schedules calls that wait for a producer', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const a = await fixture.views.api.invoke({ project: projectId, tool: 'asset.import', surface: 'timeline', params: { path: fixture.writeFile('a.mp4', 'A'), mime: 'video/mp4' } })
    const b = await fixture.views.api.invoke({ project: projectId, tool: 'asset.import', surface: 'timeline', params: { path: fixture.writeFile('b.mp4', 'B'), mime: 'video/mp4' } })
    const created = await fixture.views.api.invoke({ project: projectId, tool: 'timeline.create', surface: 'timeline', params: { assets: [a.outputs[0], b.outputs[0]] } })
    expect(created.status).toBe('done')
    const moved = await fixture.views.api.invoke({ project: projectId, tool: 'timeline.clip_move', surface: 'timeline', intent: 'drag clip 2 before clip 1', params: { clip: 2, to: 1 } })
    expect(moved.intent).toBe('drag clip 2 before clip 1')
    const state = fixture.views.api.state(projectId)
    expect(state.sequences[0]?.items).toEqual([ // names:allow
      { slot: 1, assetId: b.outputs[0], inSec: null, outSec: null }, // names:allow
      { slot: 2, assetId: a.outputs[0], inSec: null, outSec: null }, // names:allow
    ])
    expect(state.sequence?.items).toEqual(state.sequences[0]?.items) // names:allow
    expect(state.ops.every(op => op.actor === 'user' && op.turn === null && op.branch === 'main')).toBe(true)

    // A test operation that holds its record running until released, so a view call can name its unfinished output.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const slow: OperationSpec = {
      name: SLOW, component: 'inspect', version: '1', description: 'Slow.', params: {}, inputs: {}, outputs: [{ role: 'note', type: 'text' }],
      confirm: 'never', deterministic: false, resource: 'none', summarize: () => 'slow',
      execute: async (context) => { await held; return { outputs: [context.importAsset(Buffer.from('T'), { mime: 'text/plain', name: 't.txt' })] } },
    }
    fixture.project.registerOperation(slow)
    const running = fixture.views.api.invoke({ project: projectId, tool: SLOW, surface: 'canvas' })
    await new Promise(resolve => setTimeout(resolve, 50))
    const producer = fixture.views.api.state(projectId).ops.find(op => op.tool?.name === SLOW)
    expect(producer?.status).toBe('running')
    const waiting = await fixture.views.api.invoke({
      project: projectId, tool: 'asset.grab_still', surface: 'canvas', inputs: [{ role: 'video', ref: `${producer?.id ?? ''}#0` }],
    })
    expect(waiting.status).toBe('pending')
    expect(waiting.inputs).toEqual([{ role: 'video', ref: `${producer?.id ?? ''}#0`, resolved: null }])
    release()
    await running
    await fixture.project.wait(projectId)
    expect(['done', 'failed']).toContain(fixture.project.getRecord(projectId, waiting.id as RecordId).status)
  })

  it('puts a chat session\'s edits on its draft, accepts it, and discards only with the confirmed counts', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const mainBefore = fixture.views.api.state(projectId).head
    await fixture.agentImport(projectId, 's1', 'one.png')
    await fixture.agentImport(projectId, 's1', 'two.png')
    // A human edit beside the chat of s1 lands on that session's draft; one without a session lands on main.
    const human = await fixture.views.api.invoke({
      project: projectId, tool: 'asset.import', surface: 'canvas', session: 's1', params: { path: fixture.writeFile('h.png', 'H'), mime: 'image/png' },
    })
    expect(human.branch).toBe('draft/s1')
    const state = fixture.views.api.state(projectId)
    expect(state.head).toBe(mainBefore)
    expect(state.branches.find(branch => branch.name === 'draft/s1')).toMatchObject({ session: 's1', base: 'main', counts: { agent_changes: 2, human_edits: 1 } })
    const draft = fixture.views.api.state(projectId, 'draft/s1')
    expect(draft.ops.filter(op => op.branch === 'draft/s1').map(op => [op.kind, op.actor])).toEqual([
      ['request', 'user'], ['operation', 'agent'], ['request', 'user'], ['operation', 'agent'], ['operation', 'user'],
    ])

    // Discard: a dry read returns the counts; stale counts are refused with the current ones; nothing changes.
    expect(await fixture.views.api.discardDraft({ project: projectId, branch: 'draft/s1' })).toEqual({ draft: 'draft/s1', counts: { agent_changes: 2, human_edits: 1 } })
    await expect(fixture.views.api.discardDraft({ project: projectId, session: 's1', counts: { agent_changes: 2, human_edits: 0 } }))
      .rejects.toMatchObject({ status: 409, code: 'draft_changed', details: { counts: { agent_changes: 2, human_edits: 1 } } })
    await expect(fixture.views.api.discardDraft({ project: projectId, session: 's1', counts: { agent_changes: 'x' } })).rejects.toThrow(/counts/)

    const accepted = await fixture.views.api.acceptDraft({ project: projectId, session: 's1', surface: 'timeline' })
    expect(accepted.record).toMatchObject({ tool: { name: 'proj.draft_accept' }, actor: 'user', surface: 'timeline' })
    expect(accepted.heads['draft/s1']).toBeUndefined()
    const onMain = new Set(fixture.views.api.state(projectId).ops.map(op => op.id))
    expect(draft.ops.filter(op => op.branch === 'draft/s1').every(op => onMain.has(op.id))).toBe(true)

    // A second draft of another session, discarded with the counts the human confirmed.
    await fixture.agentImport(projectId, 's2', 'three.png')
    const discarded = await fixture.views.api.discardDraft({ project: projectId, branch: 'draft/s2', surface: 'canvas', counts: { agent_changes: 1, human_edits: 0 } })
    expect(discarded).toMatchObject({ draft: 'draft/s2', counts: { agent_changes: 1, human_edits: 0 } })
    expect(discarded.heads?.['draft/s2']).toBeUndefined()
    expect(fixture.views.api.state(projectId).branches.map(branch => branch.name)).toEqual(['main'])
  })

  it('undoes and redoes as records, and creates and switches exploration branches', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const first = await fixture.views.api.invoke({ project: projectId, tool: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('u1.png', 'U1'), mime: 'image/png' } })
    const second = await fixture.views.api.invoke({ project: projectId, tool: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('u2.png', 'U2'), mime: 'image/png' } })
    const undone = await fixture.views.api.undo({ project: projectId, surface: 'timeline' })
    expect(undone.record).toMatchObject({ tool: { name: 'proj.undo' }, params: { to: first.id }, actor: 'user', surface: 'timeline' })
    expect(fixture.views.api.state(projectId).ops.map(op => op.id)).not.toContain(second.id)
    const redone = await fixture.views.api.redo({ project: projectId })
    expect(redone.record).toMatchObject({ tool: { name: 'proj.redo' } })
    expect(fixture.views.api.state(projectId).ops.map(op => op.id)).toContain(second.id)
    await expect(fixture.views.api.redo({ project: projectId })).rejects.toMatchObject({ status: 409, code: 'nothing_to_redo' })

    const branch = await fixture.views.api.branch({ project: projectId, name: 'style-b', at: 'main' })
    expect(branch.branch.name).toBe('explore/style-b')
    expect(branch.heads['explore/style-b']).toBe(branch.branch.head)
    await expect(fixture.views.api.branch({ project: projectId, name: 'style-b' })).rejects.toMatchObject({ code: 'branch_exists' })
    const switched = await fixture.views.api.switchBranch({ project: projectId, branch: 'explore/style-b', session: 's3' })
    expect(switched.branch.name).toBe('explore/style-b')
    const onBranch = await fixture.views.api.invoke({
      project: projectId, tool: 'asset.import', surface: 'canvas', session: 's3', params: { path: fixture.writeFile('e.png', 'E'), mime: 'image/png' },
    })
    expect(onBranch.branch).toBe('explore/style-b')
    expect(fixture.views.api.state(projectId, 'explore/style-b').ops.map(op => op.id)).toContain(onBranch.id)
    expect(fixture.views.api.state(projectId).ops.map(op => op.id)).not.toContain(onBranch.id)
  })

  it('keeps the last selection per project', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    expect(fixture.views.selection(projectId)).toBeNull()
    const selection = fixture.views.api.select({ project: projectId, kind: 'clip', id: 'asset-1', slot: 2, surface: 'timeline' })
    expect(selection.slot).toBe(2)
    expect(fixture.views.selection(projectId)?.id).toBe('asset-1')
    fixture.views.api.select({ project: projectId, kind: 'op', id: 'op-1', surface: 'canvas' })
    expect(fixture.views.selection(projectId)?.kind).toBe('op')
    expect(fixture.views.selection(projectId)?.slot).toBeUndefined()
  })

  it('serves the Fetch routes under /api/vh with statuses and codes from the operations', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
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
      method: 'POST', body: { project: projectId, tool: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('f.png', 'F'), mime: 'image/png' } },
    })
    expect(invoked.status).toBe(200)
    const state = await call(fixture, ROUTES.state, { query: { project: projectId, head: 'main' } })
    expect(state.status).toBe(200)
    expect((state.json as { assets: unknown[] }).assets).toHaveLength(1)

    const tools = await call(fixture, ROUTES.tools)
    expect(Array.isArray(tools.json)).toBe(true)
    const noDraft = await call(fixture, ROUTES.acceptDraft, { method: 'POST', body: { project: projectId, session: 'x' } })
    expect(noDraft).toMatchObject({ status: 409, json: { code: 'no_open_draft' } })
    await fixture.agentImport(projectId, 's4', 'four.png')
    const changed = await call(fixture, ROUTES.discardDraft, { method: 'POST', body: { project: projectId, session: 's4', counts: { agent_changes: 0, human_edits: 0 } } })
    expect(changed).toMatchObject({ status: 409, json: { code: 'draft_changed', counts: { agent_changes: 1, human_edits: 0 } } })
    expect((await call(fixture, ROUTES.discardDraft, { method: 'POST', body: { project: projectId, session: 's4', counts: { agent_changes: 1, human_edits: 0 } } })).status).toBe(200)
    const noBody = await call(fixture, ROUTES.undo, { method: 'POST' })
    expect(noBody.status).toBe(400)
    expect(await call(fixture, ROUTES.redo, { method: 'POST', body: { project: projectId } })).toMatchObject({ status: 409, json: { code: 'nothing_to_redo' } })
    const branched = await call(fixture, ROUTES.branch, { method: 'POST', body: { project: projectId, name: 'b2' } })
    expect(branched.status).toBe(200)
    const switched = await call(fixture, ROUTES.switchBranch, { method: 'POST', body: { project: projectId, branch: 'explore/b2', session: 's5' } })
    expect(switched.status).toBe(200)
    const keep = (record: string) => call(fixture, ROUTES.acceptStale, {
      method: 'POST', body: { project: projectId, record, surface: 'canvas' },
    })
    expect(await keep('nope')).toMatchObject({ status: 404, json: { code: 'unknown_record' } })
    const kept = await keep((invoked.json as { id: string }).id)
    expect(kept).toMatchObject({ status: 200, json: { record: { tool: { name: 'proj.stale_accept' }, actor: 'user', branch: 'main' } } })
    const selected = await call(fixture, ROUTES.selection, { method: 'POST', body: { project: projectId, kind: 'asset', id: 'a', surface: 'canvas' } })
    expect(selected.status).toBe(200)
    const read = await call(fixture, ROUTES.selection, { query: { project: projectId } })
    expect((read.json as { id: string }).id).toBe('a')
  })

  it('streams project changes as server-sent events and refuses rejected or unknown requests', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
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
    await fixture.views.api.invoke({ project: projectId, tool: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('g.png', 'G'), mime: 'image/png' } })
    await readUntil('event: update')
    expect(text).toContain('event: record\ndata: {"kind":"record"')
    expect(text).toContain('event: branch\ndata: {"kind":"branch"')
    await readUntil(': keepalive')
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  it('frames each project change by its kind, and lists every asset a state mentions', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const event: ProjectEvent = { kind: 'branch', name: 'main', branch: null }
    expect(frameOf(event)).toBe(`event: branch\ndata: ${JSON.stringify(event)}\n\n`)
    const imported = await fixture.views.api.invoke({ project: projectId, tool: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('h.png', 'H'), mime: 'image/png' } })
    await fixture.views.api.invoke({
      project: projectId, tool: 'bible.character_create', surface: 'canvas', params: { character: 'c1', name: 'Hero' },
      inputs: imported.outputs.map(ref => ({ role: 'reference', ref })),
    })
    expect(mentionedAssets(fixture.project.getState(projectId))).toEqual(imported.outputs)
  })

  it('names errors, orders projects, and refuses an undo without changes or a branch at an unknown record', async () => {
    expect(messageOf(new Error('boom'))).toBe('boom')
    expect(messageOf('plain')).toBe('plain')
    const fixture = await start()
    const older = await fixture.newProject('older')
    const projectId = await fixture.newProject('demo')
    expect(fixture.views.api.projects().map(entry => entry.projectId).sort()).toEqual([older, projectId].sort())
    await expect(fixture.views.api.undo({ project: older })).rejects.toMatchObject({ status: 409, code: 'nothing_to_undo' })
    await expect(fixture.views.api.branch({ project: older, name: 'b', at: 'nowhere' })).rejects.toBeInstanceOf(ViewsRequestError)
  })

  it('records base_op and supersedes, lists only known assets, and reads an empty or non-string head as main', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const first = await fixture.views.api.invoke({ project: projectId, tool: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('r.png', 'R'), mime: 'image/png' } })
    const second = await fixture.views.api.invoke({
      project: projectId, tool: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('s.png', 'S'), mime: 'image/png' },
      base_op: first.id, supersedes: [first.id, 7],
    })
    expect(second.base_op).toBe(first.id)
    expect(second.supersedes).toEqual([first.id])
    expect(fixture.views.api.state(projectId).superseded).toEqual({ [first.id]: second.id })
    await expect(fixture.views.api.invoke({
      project: projectId, tool: 'bible.character_create', surface: 'canvas', params: { character: 'c1', name: 'Hero' },
      inputs: [{ role: 'reference', ref: 'nowhere' }],
    })).rejects.toMatchObject({ code: 'unknown_asset' })
    expect(fixture.views.api.state(projectId).assets.map(entry => entry.id)).toEqual([...first.outputs, ...second.outputs])
    expect(fixture.views.api.state(projectId, '').head).toBe(fixture.views.api.state(projectId, 7).head)
    expect(mentionedAssets(fixture.project.getState(projectId))).toEqual([...first.outputs, ...second.outputs])
  })

  it('links a project to its Workspace and binds a chat session to the project', async () => {
    const previous = process.env['VH_STATE_ROOT']
    const root = mkdtempSync(join(tmpdir(), 'vh-workspaces-'))
    process.env['VH_STATE_ROOT'] = root
    try {
      const fixture = await start()
      const projectId = await fixture.newProject('linked')
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
