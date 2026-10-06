/**
 * The browser API over the real Project service, components, and asset pool: branch state on the wire, human
 * operation calls from the canvas and the timeline, a chat session's draft (accept, discard with confirmed counts), undo and
 * redo, branches, selections, the Fetch routes, and the event stream.
 */
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import type { OperationSpec, ProjectEvent, ProjectId, RecordId, RecordOrigin, SessionId, TurnId } from '@dv/project'
import { startBase, type BaseFixture } from './support.ts'
import { answer } from '../src/api.ts'
import DvApi, { ApiRequestError, EVENTS_PATH, ROUTES, WORKSPACE_ROUTES, frameOf, mentionedAssets, messageOf, type ApiHandlers } from '../src/index.ts'

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
  dvApi: DvApi
  /** The route handlers of {@link dvApi}. */
  handlers: ApiHandlers
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
 * Mount the base fixture with the API plugin (state directory: the fixture root), a fake Connection, and a fake web
 * server.
 * @returns the fixture.
 */
async function start(): Promise<Fixture> {
  const base = await startBase({ generation: 'none' })
  const connection = new FakeConnection()
  const web = new FakeWebServer()
  base.context.provide('connection', connection)
  base.context.provide('webServer', web)
  await base.context.plugin(DvApi, { keepaliveMs: 50, stateRoot: base.root }).await()
  let calls = 0
  const fixture: Fixture = {
    ...base, dvApi: base.context.dvApi, handlers: base.context.dvApi.api, connection, web,
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

describe('dvApi', () => {
  it('lists projects, reads branch state with its assets, and lists operation declarations', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const imported = await fixture.handlers.runOperation({
      project: projectId, operation: 'asset.import', surface: 'canvas', intent: 'import a reference',
      params: { path: fixture.writeFile('ref.png', 'PNG'), mime: 'image/png' },
    })
    expect(imported).toMatchObject({ status: 'done', actor: 'user', surface: 'canvas', branch: 'main', turn: null, session: null, kind: 'operation' })

    const projects = fixture.handlers.listProjects()
    expect(projects.map(entry => entry.id)).toContain(projectId)
    expect(projects.find(entry => entry.id === projectId)?.heads['main']).toBe(imported.id)
    expect(projects.every(entry => !entry.current)).toBe(true)
    // The project a chat session is bound to comes first and is marked, whatever its age.
    const bound = (await fixture.call('dv_proj_create', { title: 'from chat' })).value as { project_id: string }
    await fixture.newProject('newest')
    expect(fixture.handlers.listProjects('anonymous').map(entry => [entry.title, entry.current])).toEqual([['from chat', true], ['newest', false], ['demo', false]])
    expect(fixture.handlers.listProjects('').map(entry => entry.title)).toEqual(['newest', 'from chat', 'demo'])
    expect(bound.project_id).toBe(fixture.project.sessionProject(brandString<SessionId>('anonymous')))
    const made = await fixture.handlers.createProject({ title: 'from the timeline', surface: 'timeline' })
    expect(made).toMatchObject({ title: 'from the timeline', created_at: expect.any(String) })
    expect(fixture.handlers.getState(made.id).components.proj.records[0]).toMatchObject({ surface: 'timeline', actor: 'user', operation: 'proj.create' })
    expect((await fixture.handlers.createProject({ title: 'from the canvas' })).title).toBe('from the canvas')
    await expect(fixture.handlers.createProject({})).rejects.toThrow(/title/)
    // Two clients that pick the same title get two distinct ones.
    expect((await fixture.handlers.createProject({ title: '未命名项目 6' })).title).toBe('未命名项目 6')
    expect((await fixture.handlers.createProject({ title: '未命名项目 6' })).title).toBe('未命名项目 7')
    expect((await fixture.handlers.createProject({ title: 'from the canvas' })).title).toBe('from the canvas 2')

    const state = fixture.handlers.getState(projectId)
    expect(state.project).toMatchObject({ id: projectId, title: 'demo' })
    expect(state.branch).toBe('main')
    expect(state.components.proj.records.map(record => record.operation)).toEqual(['proj.create', 'asset.import'])
    expect(state.assets.map(asset => asset.id)).toEqual(imported.outputs)
    expect(state.assets[0]?.mime).toBe('image/png')
    expect(state.heads['main']).toBe(state.head)
    expect(state.branches).toEqual([{ name: 'main', head: imported.id, base: null, forked_at: null, session: null, counts: null }])
    expect(state.components.proj.created_by).toEqual({ [imported.outputs[0] ?? '']: imported.id })

    const operations = fixture.handlers.listOperations()
    const still = operations.find(operation => operation.name === 'asset.grab_still')
    expect(still?.deterministic).toBe(true)
    expect(still?.resource).toBe('cpu')
    expect(still?.params['at']).toBeDefined()
    expect(Object.keys(still ?? {})).not.toContain('execute')
    expect(operations.find(operation => operation.name === 'asset.import')?.resource).toBe('none')
  })

  it('refuses malformed and unknown requests with the matching status and code', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    expect(() => fixture.handlers.getState('')).toThrow(ApiRequestError)
    expect(() => fixture.handlers.getState('nope')).toThrow(/Unknown project/)
    expect(() => fixture.handlers.getState(projectId, 'no-such-branch')).toThrow(ApiRequestError)
    await expect(fixture.handlers.runOperation({ project: projectId, operation: 'no.such', surface: 'canvas' })).rejects.toMatchObject({ status: 404, code: 'unknown_operation' })
    await expect(fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', inputs: [{ role: 'x' }] })).rejects.toThrow(/inputs\[\]\.ref/)
    await expect(fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', inputs: 'x' })).rejects.toThrow(/array/)
    // An input error names the operation, the name a view request uses.
    await expect(fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', inputs: [{ role: 'nope', ref: 'a' }] }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_inputs', message: expect.stringMatching(/^Unknown input role "nope" for asset\.import;/) })
    await expect(fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', params: {} }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_params' })
    await expect(fixture.handlers.acceptDraft({ project: projectId, session: 'nobody' })).rejects.toMatchObject({ status: 409, code: 'no_open_draft' })
    await expect(fixture.handlers.discardDraft({ project: projectId })).rejects.toThrow(/branch/)
    expect(() => fixture.handlers.select({ project: projectId, kind: 'thing', id: 'x' })).toThrow(/kind/)
    await expect(fixture.handlers.createBranch({ project: projectId, name: '' })).rejects.toThrow(/name/)
    await expect(fixture.handlers.switchBranch({ project: projectId, branch: 'main' })).rejects.toThrow(/session/)
  })

  it('records timeline gestures on main without a turn and schedules calls that wait for a producer', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const a = await fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'timeline', params: { path: fixture.writeFile('a.mp4', 'A'), mime: 'video/mp4' } })
    const b = await fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'timeline', params: { path: fixture.writeFile('b.mp4', 'B'), mime: 'video/mp4' } })
    const created = await fixture.handlers.runOperation({ project: projectId, operation: 'timeline.create', surface: 'timeline', params: { assets: [a.outputs[0], b.outputs[0]] } })
    expect(created.status).toBe('done')
    const moved = await fixture.handlers.runOperation({ project: projectId, operation: 'timeline.clip_move', surface: 'timeline', intent: 'drag clip 2 before clip 1', params: { clip: 'cl2', to: 1 } })
    expect(moved.intent).toBe('drag clip 2 before clip 1')
    const state = fixture.handlers.getState(projectId)
    expect(state.components.timeline.timelines[0]?.clips).toEqual([
      { id: 'cl2', asset: b.outputs[0], source: null, in_sec: null, out_sec: null },
      { id: 'cl1', asset: a.outputs[0], source: null, in_sec: null, out_sec: null },
    ])
    expect(state.components.proj.records.every(record => record.actor === 'user' && record.turn === null && record.branch === 'main')).toBe(true)

    // A test operation that holds its record running until released, so a view call can name its unfinished output.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const slow: OperationSpec = {
      name: SLOW, component: 'inspect', version: '1', description: 'Slow.', params: {}, inputs: {}, outputs: [{ role: 'note', type: 'text' }],
      confirm: 'never', deterministic: false, resource: 'none', summarize: () => 'slow',
      execute: async (context) => { await held; return { outputs: [context.importAsset(Buffer.from('T'), { mime: 'text/plain', name: 't.txt' })] } },
    }
    fixture.project.registerOperation(slow)
    const running = fixture.handlers.runOperation({ project: projectId, operation: SLOW, surface: 'canvas' })
    await new Promise(resolve => setTimeout(resolve, 50))
    const producer = fixture.handlers.getState(projectId).components.proj.records.find(record => record.operation === SLOW)
    expect(producer?.status).toBe('running')
    const waiting = await fixture.handlers.runOperation({
      project: projectId, operation: 'asset.grab_still', surface: 'canvas', inputs: [{ role: 'video', ref: `${producer?.id ?? ''}#0` }],
    })
    expect(waiting.status).toBe('pending')
    expect(waiting.inputs).toEqual([{ role: 'video', ref: { record: producer?.id, output: 0 }, resolved_asset: null }])
    release()
    await running
    await fixture.project.wait(projectId)
    expect(['done', 'failed']).toContain(fixture.project.getRecord(projectId, waiting.id).status)
  })

  it('puts a chat session\'s edits on its draft, accepts it, and discards only with the confirmed counts', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const mainBefore = fixture.handlers.getState(projectId).head
    await fixture.agentImport(projectId, 's1', 'one.png')
    await fixture.agentImport(projectId, 's1', 'two.png')
    // A human edit beside the chat of s1 lands on that session's draft; one without a session lands on main.
    const human = await fixture.handlers.runOperation({
      project: projectId, operation: 'asset.import', surface: 'canvas', session: 's1', params: { path: fixture.writeFile('h.png', 'H'), mime: 'image/png' },
    })
    expect(human.branch).toBe('draft/s1')
    const state = fixture.handlers.getState(projectId)
    expect(state.head).toBe(mainBefore)
    expect(state.branches.find(branch => branch.name === 'draft/s1')).toMatchObject({ session: 's1', base: 'main', counts: { agent_changes: 2, human_edits: 1 } })
    const draft = fixture.handlers.getState(projectId, 'draft/s1')
    const draftRecords = draft.components.proj.records.filter(record => record.branch === 'draft/s1')
    expect(draftRecords.map(record => [record.kind, record.actor])).toEqual([
      ['request', 'user'], ['operation', 'agent'], ['request', 'user'], ['operation', 'agent'], ['operation', 'user'],
    ])

    // Discard: a dry read returns the counts; stale counts are refused with the current ones; nothing changes.
    expect(await fixture.handlers.discardDraft({ project: projectId, branch: 'draft/s1' })).toEqual({ draft: 'draft/s1', counts: { agent_changes: 2, human_edits: 1 } })
    await expect(fixture.handlers.discardDraft({ project: projectId, session: 's1', counts: { agent_changes: 2, human_edits: 0 } }))
      .rejects.toMatchObject({ status: 409, code: 'draft_changed', details: { counts: { agent_changes: 2, human_edits: 1 } } })
    await expect(fixture.handlers.discardDraft({ project: projectId, session: 's1', counts: { agent_changes: 'x' } })).rejects.toThrow(/counts/)

    const accepted = await fixture.handlers.acceptDraft({ project: projectId, session: 's1', surface: 'timeline' })
    expect(accepted.record).toMatchObject({ operation: 'proj.draft_accept', actor: 'user', surface: 'timeline' })
    expect(accepted.heads['draft/s1']).toBeUndefined()
    const onMain = new Set(fixture.handlers.getState(projectId).components.proj.records.map(record => record.id))
    expect(draftRecords.every(record => onMain.has(record.id))).toBe(true)

    // A second draft of another session, discarded with the counts the human confirmed.
    await fixture.agentImport(projectId, 's2', 'three.png')
    const discarded = await fixture.handlers.discardDraft({ project: projectId, branch: 'draft/s2', surface: 'canvas', counts: { agent_changes: 1, human_edits: 0 } })
    expect(discarded).toMatchObject({ draft: 'draft/s2', counts: { agent_changes: 1, human_edits: 0 } })
    expect(discarded.heads?.['draft/s2']).toBeUndefined()
    expect(fixture.handlers.getState(projectId).branches.map(branch => branch.name)).toEqual(['main'])
  })

  it('undoes and redoes as records, and creates and switches exploration branches', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const first = await fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('u1.png', 'U1'), mime: 'image/png' } })
    const second = await fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('u2.png', 'U2'), mime: 'image/png' } })
    const undone = await fixture.handlers.undo({ project: projectId, surface: 'timeline' })
    expect(undone.record).toMatchObject({ operation: 'proj.undo', params: { to: first.id }, actor: 'user', surface: 'timeline' })
    expect(fixture.handlers.getState(projectId).components.proj.records.map(record => record.id)).not.toContain(second.id)
    const redone = await fixture.handlers.redo({ project: projectId })
    expect(redone.record).toMatchObject({ operation: 'proj.redo' })
    expect(fixture.handlers.getState(projectId).components.proj.records.map(record => record.id)).toContain(second.id)
    await expect(fixture.handlers.redo({ project: projectId })).rejects.toMatchObject({ status: 409, code: 'nothing_to_redo' })
    // A jump back to a record leaves the later steps as redo steps; a jump forward to one of them writes `proj.redo`.
    const jump = await fixture.handlers.undo({ project: projectId, surface: 'history', to: first.id })
    expect(jump.record).toMatchObject({ operation: 'proj.undo', params: { to: first.id }, surface: 'history' })
    expect(fixture.handlers.getState(projectId).redo_steps).toEqual([second.id])
    expect((await fixture.handlers.undo({ project: projectId, to: second.id })).record).toMatchObject({ operation: 'proj.redo', params: { to: second.id } })
    expect(fixture.handlers.getState(projectId).redo_steps).toEqual([])
    await expect(fixture.handlers.undo({ project: projectId, to: 7 })).rejects.toMatchObject({ status: 400, code: 'invalid_params' })
    await expect(fixture.handlers.undo({ project: projectId, to: 'missing' })).rejects.toMatchObject({ status: 404, code: 'unknown_record' })

    const branch = await fixture.handlers.createBranch({ project: projectId, name: 'style-b', at: 'main' })
    expect(branch.branch.name).toBe('explore/style-b')
    expect(branch.heads['explore/style-b']).toBe(branch.branch.head)
    await expect(fixture.handlers.createBranch({ project: projectId, name: 'style-b' })).rejects.toMatchObject({ code: 'branch_exists' })
    const switched = await fixture.handlers.switchBranch({ project: projectId, branch: 'explore/style-b', session: 's3' })
    expect(switched.branch.name).toBe('explore/style-b')
    const onBranch = await fixture.handlers.runOperation({
      project: projectId, operation: 'asset.import', surface: 'canvas', session: 's3', params: { path: fixture.writeFile('e.png', 'E'), mime: 'image/png' },
    })
    expect(onBranch.branch).toBe('explore/style-b')
    expect(fixture.handlers.getState(projectId, 'explore/style-b').components.proj.records.map(record => record.id)).toContain(onBranch.id)
    expect(fixture.handlers.getState(projectId).components.proj.records.map(record => record.id)).not.toContain(onBranch.id)
  })

  it('keeps the last selection per project', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    expect(fixture.dvApi.selection(projectId)).toBeNull()
    const selection = fixture.handlers.select({ project: projectId, kind: 'clip', id: 'cl2', surface: 'timeline' })
    expect(selection).toMatchObject({ kind: 'clip', id: 'cl2', surface: 'timeline' })
    expect(fixture.dvApi.selection(projectId)?.id).toBe('cl2')
    fixture.handlers.select({ project: projectId, kind: 'character', id: 'c1', surface: 'asset_pool' })
    expect(fixture.dvApi.selection(projectId)).toMatchObject({ kind: 'character', id: 'c1', surface: 'asset_pool' })
    fixture.handlers.select({ project: projectId, kind: 'record', id: 'r1', surface: 'chat' })
    expect(fixture.dvApi.selection(projectId)).toMatchObject({ kind: 'record', surface: 'canvas' })
  })

  it('serves the Fetch routes under /api/dv with statuses and codes from the operations', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    for (const path of Object.values(ROUTES)) expect(fixture.connection.routes.has(path)).toBe(true)

    const projects = await call(fixture, ROUTES.projects, { query: { session: 'anonymous' } })
    expect(projects.status).toBe(200)
    expect(JSON.stringify(projects.json)).toContain(projectId)
    const created = await call(fixture, ROUTES.projects, { method: 'POST', body: { title: 'posted', surface: 'canvas' } })
    expect(created.status).toBe(200)
    expect(created.json).toMatchObject({ title: 'posted', id: expect.any(String), created_at: expect.any(String) })
    expect((await call(fixture, ROUTES.projects, { method: 'POST', body: {} })).status).toBe(400)

    const missing = await call(fixture, ROUTES.state, { query: { project: 'nope' } })
    expect(missing.status).toBe(404)

    const invoked = await call(fixture, ROUTES.operation, {
      method: 'POST', body: { project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('f.png', 'F'), mime: 'image/png' } },
    })
    expect(invoked.status).toBe(200)
    const state = await call(fixture, ROUTES.state, { query: { project: projectId, branch: 'main' } })
    expect(state.status).toBe(200)
    expect((state.json as { assets: unknown[] }).assets).toHaveLength(1)

    const operations = await call(fixture, ROUTES.operations)
    expect(Array.isArray(operations.json)).toBe(true)
    expect(await call(fixture, ROUTES.operation, { method: 'POST', body: { project: projectId, operation: 'no.such', surface: 'canvas' } }))
      .toMatchObject({ status: 404, json: { code: 'unknown_operation' } })
    expect(await call(fixture, ROUTES.state, { query: { project: projectId, branch: 'nowhere' } })).toMatchObject({ status: 404, json: { code: 'unknown_branch' } })
    const noDraft = await call(fixture, ROUTES.acceptDraft, { method: 'POST', body: { project: projectId, session: 'x' } })
    expect(noDraft).toMatchObject({ status: 409, json: { code: 'no_open_draft' } })
    await fixture.agentImport(projectId, 's4', 'four.png')
    const changed = await call(fixture, ROUTES.discardDraft, { method: 'POST', body: { project: projectId, session: 's4', counts: { agent_changes: 0, human_edits: 0 } } })
    expect(changed).toMatchObject({ status: 409, json: { code: 'draft_changed', counts: { agent_changes: 1, human_edits: 0 } } })
    expect((await call(fixture, ROUTES.discardDraft, { method: 'POST', body: { project: projectId, session: 's4', counts: { agent_changes: 1, human_edits: 0 } } })).status).toBe(200)
    const noBody = await call(fixture, ROUTES.undo, { method: 'POST' })
    expect(noBody.status).toBe(400)
    expect(await call(fixture, ROUTES.redo, { method: 'POST', body: { project: projectId } })).toMatchObject({ status: 409, json: { code: 'nothing_to_redo' } })
    const branched = await call(fixture, ROUTES.createBranch, { method: 'POST', body: { project: projectId, name: 'b2' } })
    expect(branched.status).toBe(200)
    const switched = await call(fixture, ROUTES.switchBranch, { method: 'POST', body: { project: projectId, branch: 'explore/b2', session: 's5' } })
    expect(switched.status).toBe(200)
    const keep = (record: string) => call(fixture, ROUTES.acceptStale, {
      method: 'POST', body: { project: projectId, record, surface: 'canvas' },
    })
    expect(await keep('nope')).toMatchObject({ status: 404, json: { code: 'unknown_record' } })
    const kept = await keep((invoked.json as { id: string }).id)
    expect(kept).toMatchObject({ status: 200, json: { record: { operation: 'proj.stale_accept', actor: 'user', branch: 'main' } } })
    const selected = await call(fixture, ROUTES.selection, { method: 'POST', body: { project: projectId, kind: 'asset', id: 'a', surface: 'canvas' } })
    expect(selected.status).toBe(200)
    const read = await call(fixture, ROUTES.selection, { query: { project: projectId } })
    expect((read.json as { id: string }).id).toBe('a')
  })

  it('answers every refusal of the project routes with the body {error, code}', async () => {
    const fixture = await start()
    // Every route that names a project: GET routes read it from the query, POST routes from the body.
    const named: Array<{ path: string; method: 'GET' | 'POST' }> = [
      { path: ROUTES.state, method: 'GET' }, { path: ROUTES.operation, method: 'POST' }, { path: ROUTES.acceptDraft, method: 'POST' },
      { path: ROUTES.discardDraft, method: 'POST' }, { path: ROUTES.undo, method: 'POST' }, { path: ROUTES.redo, method: 'POST' },
      { path: ROUTES.createBranch, method: 'POST' }, { path: ROUTES.switchBranch, method: 'POST' }, { path: ROUTES.acceptStale, method: 'POST' },
      { path: ROUTES.history, method: 'POST' }, { path: ROUTES.selection, method: 'GET' }, { path: ROUTES.selection, method: 'POST' },
    ]
    for (const { path, method } of named) {
      const send = (project: string | undefined) => method === 'GET'
        ? call(fixture, path, { query: project === undefined ? {} : { project } })
        : call(fixture, path, { method, body: project === undefined ? {} : { project } })
      expect(await send(undefined), `${method} ${path}`).toEqual({ status: 400, json: { error: "'project' must name a project.", code: 'invalid_params' } })
      expect(await send('nope'), `${method} ${path}`).toEqual({ status: 404, json: { error: "Unknown project 'nope'.", code: 'unknown_project' } })
    }
    expect(await call(fixture, ROUTES.projects, { method: 'POST', body: {} }))
      .toEqual({ status: 400, json: { error: "'title' must be a non-empty string.", code: 'invalid_params' } })
    // A failure that is not a refused request answers 500 with the thrown error's text.
    const failed = await answer(() => { throw new Error('disk gone') })
    expect({ status: failed.status, json: await failed.json() as unknown }).toEqual({ status: 500, json: { error: 'disk gone', code: 'internal_error' } })
  })

  it('lists the history with marks, turn requests, assets, filters and pages, and refuses bad queries', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const human = await fixture.handlers.runOperation({
      project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('h.png', 'H'), mime: 'image/png' },
    })
    const undone = await fixture.handlers.runOperation({
      project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('u.png', 'U'), mime: 'image/png' },
    })
    const undo = await fixture.handlers.undo({ project: projectId, surface: 'history' })
    expect(undo.record.surface).toBe('history')
    const agent = await fixture.agentImport(projectId, 's1', 'a.png')
    const history = async (body: Record<string, unknown>) => {
      const answer = await call(fixture, ROUTES.history, { method: 'POST', body: { project: projectId, ...body } })
      return answer as {
        status: number
        json: {
          entries: Array<{ record: { id: string }; mark: string }>
          requests: Record<string, { intent: string }>
          assets: Array<{ id: string }>
        }
      }
    }
    const ids = (answer: Awaited<ReturnType<typeof history>>): string[] => answer.json.entries.map(entry => entry.record.id)

    const all = await history({ kind: 'operation' })
    expect(all.status).toBe(200)
    expect(all.json.entries.map(entry => [entry.record.id, entry.mark])).toEqual([
      [agent, 'draft'], [undo.record.id, 'main'], [undone.id, 'undone'], [human.id, 'main'], [expect.any(String), 'main'],
    ])
    // The agent's turn is headed by its request record, though the request is not an entry of this page.
    expect(Object.values(all.json.requests).map(request => request.intent)).toEqual(['please import a.png'])
    const named = [...human.outputs, ...undone.outputs, ...fixture.project.getRecord(projectId, agent).outputs]
    expect(all.json.assets.map(asset => asset.id).sort()).toEqual(named.sort())

    expect(ids(await history({ marks: ['main', 'undone'], limit: 2 }))).toEqual([undo.record.id, undone.id])
    expect((await history({ kind: 'request' })).json.entries.map(entry => entry.mark)).toEqual(['draft'])
    expect(ids(await history({ tool_call: 'call-1' }))).toEqual([agent])
    expect(ids(await history({ actor: 'user', component: 'asset', before: undone.id }))).toEqual([human.id])
    expect(ids(await history({ records: [human.id, agent] }))).toEqual([agent, human.id])
    expect((await history({ actor: 'agent', kind: 'operation', session: 's9' })).json).toEqual({ entries: [], requests: {}, assets: [] })

    expect(await call(fixture, ROUTES.history, { method: 'POST', body: {} })).toMatchObject({ status: 400, json: { code: 'invalid_params' } })
    expect(await call(fixture, ROUTES.history, { method: 'POST', body: { project: 'nope' } })).toMatchObject({ status: 404, json: { code: 'unknown_project' } })
    expect(await history({ before: 'missing' })).toMatchObject({ status: 404, json: { code: 'unknown_record' } })
    for (const bad of [{ actor: 'robot' }, { marks: ['kept'] }, { marks: 'main' }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { branch: 3 }]) {
      expect(await history(bad)).toMatchObject({ status: 400, json: { code: 'invalid_params' } })
    }
  })

  it('streams project changes as server-sent events and refuses rejected or unknown requests', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const base = await fixture.web.listen()

    // The stream answers a refusal with the JSON error body of the Fetch routes.
    const noProject = await fetch(`${base}${EVENTS_PATH}`)
    expect({ status: noProject.status, json: await noProject.json() as unknown })
      .toEqual({ status: 400, json: { error: "'project' must name a project.", code: 'invalid_params' } })
    const unknown = await fetch(`${base}${EVENTS_PATH}?project=nope`)
    expect({ status: unknown.status, json: await unknown.json() as unknown })
      .toEqual({ status: 404, json: { error: "Unknown project 'nope'.", code: 'unknown_project' } })
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
    await fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('g.png', 'G'), mime: 'image/png' } })
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
    const imported = await fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('h.png', 'H'), mime: 'image/png' } })
    await fixture.handlers.runOperation({
      project: projectId, operation: 'bible.character_create', surface: 'canvas', params: { character: 'c1', name: 'Hero' },
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
    expect(fixture.handlers.listProjects().map(entry => entry.id).sort()).toEqual([older, projectId].sort())
    await expect(fixture.handlers.undo({ project: older })).rejects.toMatchObject({ status: 409, code: 'nothing_to_undo' })
    await expect(fixture.handlers.createBranch({ project: older, name: 'b', at: 'nowhere' })).rejects.toBeInstanceOf(ApiRequestError)
  })

  it('records based_on and supersedes, lists only known assets, and reads an empty or non-string branch as main', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const first = await fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('r.png', 'R'), mime: 'image/png' } })
    const second = await fixture.handlers.runOperation({
      project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('s.png', 'S'), mime: 'image/png' },
      based_on: first.id, supersedes: [first.id, 7],
    })
    expect(second.based_on).toBe(first.id)
    expect(second.supersedes).toEqual([first.id])
    expect(fixture.handlers.getState(projectId).components.proj.superseded).toEqual({ [first.id]: second.id })
    await expect(fixture.handlers.runOperation({
      project: projectId, operation: 'bible.character_create', surface: 'canvas', params: { character: 'c1', name: 'Hero' },
      inputs: [{ role: 'reference', ref: 'nowhere' }],
    })).rejects.toMatchObject({ code: 'unknown_asset' })
    expect(fixture.handlers.getState(projectId).assets.map(entry => entry.id)).toEqual([...first.outputs, ...second.outputs])
    expect(fixture.handlers.getState(projectId, '').head).toBe(fixture.handlers.getState(projectId, 7).head)
    expect(mentionedAssets(fixture.project.getState(projectId))).toEqual([...first.outputs, ...second.outputs])
  })

  it('links a project to its Workspace and binds a chat session to the project', async () => {
    const fixture = await start()
    const root = fixture.root
    const projectId = await fixture.newProject('linked')
    const listed = await call(fixture, WORKSPACE_ROUTES.workspaces)
    const rows = (listed.json as { entry_path: string; projects: Array<{ id: string; path: string; workspace_id: string | null }> })
    expect(rows.entry_path).toBe(join(root, 'entry'))
    expect(rows.projects.find(row => row.id === projectId)).toMatchObject({ path: join(root, 'projects', projectId), workspace_id: null })
    expect((await call(fixture, WORKSPACE_ROUTES.workspaces, { method: 'POST', body: { project: projectId, workspace_id: 'ws-1' } })).status).toBe(200)
    expect(await call(fixture, WORKSPACE_ROUTES.workspaces, { method: 'POST', body: { project: projectId, workspaceId: 'ws-1' } }))
      .toMatchObject({ status: 400, json: { error: expect.any(String), code: 'invalid_params' } })
    const relisted = (await call(fixture, WORKSPACE_ROUTES.workspaces)).json as {
      projects: Array<{ id: string; workspace_id: string | null }>
      bindings: Record<string, string>
    }
    expect(relisted.projects.find(row => row.id === projectId)?.workspace_id).toBe('ws-1')
    expect(relisted.bindings).toEqual({})
    expect((await call(fixture, WORKSPACE_ROUTES.bind, { method: 'POST', body: { session: 'chat-1', project: projectId } })).json).toEqual({ ok: true })
    expect(fixture.handlers.listProjects('chat-1')[0]).toMatchObject({ id: projectId, current: true })
    // The binding file of `@dv/project` under `<state root>/sessions` reaches the listing.
    expect(((await call(fixture, WORKSPACE_ROUTES.workspaces)).json as { bindings: Record<string, string> }).bindings).toEqual({ 'chat-1': projectId })
    expect(await call(fixture, WORKSPACE_ROUTES.bind, { method: 'POST', body: { session: 'chat-1', project: 'missing' } }))
      .toMatchObject({ status: 404, json: { error: expect.any(String), code: 'unknown_project' } })
    expect(await call(fixture, WORKSPACE_ROUTES.bind, { method: 'POST', body: { project: projectId } }))
      .toMatchObject({ status: 400, json: { code: 'invalid_params' } })
  })
})
