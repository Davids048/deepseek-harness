/**
 * The browser API over the real Project service, components, and asset pool: the project state on the wire, human
 * operation calls from the canvas and the timeline, the one history line that every edit joins, undo, the history,
 * the Fetch routes, and the event stream.
 */
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import { importedAssets } from '@dv/asset-pool'
import type { AssetId, OperationSpec, ProjectEvent, ProjectId, ProjectRecord, RecordId, RecordOrigin, SessionId, TurnId } from '@dv/project'
import { FFMPEG, startBase, type BaseFixture } from './support.ts'
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
  /** Run `asset.import` as the agent of chat session `session`; the record goes at the end of the project's history. */
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
        tool_call: `call-${String(calls)}`, intent: `import ${name}`,
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
  it('lists projects, reads the project state with its assets, and lists operation declarations', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const imported = await fixture.handlers.runOperation({
      project: projectId, operation: 'asset.import', surface: 'canvas', intent: 'import a reference',
      params: { path: fixture.writeFile('ref.png', 'PNG'), mime: 'image/png' },
    })
    expect(imported).toMatchObject({ status: 'done', actor: 'user', surface: 'canvas', turn: null, session: null, kind: 'operation' })

    const projects = fixture.handlers.listProjects()
    expect(projects.map(entry => entry.id)).toContain(projectId)
    expect(projects.find(entry => entry.id === projectId)).toEqual({ id: projectId, title: 'demo', created_at: expect.any(String), current: false })
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
    expect(Object.keys(state)).toEqual(['project', 'head', 'tip', 'components', 'assets'])
    expect(state.head).toBe(imported.id)
    expect(state.components.proj.records.map(record => record.operation)).toEqual(['proj.create', 'asset.import'])
    expect(state.assets.map(asset => asset.id)).toEqual(imported.outputs)
    expect(state.assets[0]?.mime).toBe('image/png')
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
    await expect(fixture.handlers.runOperation({ project: projectId, operation: 'no.such', surface: 'canvas' })).rejects.toMatchObject({ status: 404, code: 'unknown_operation' })
    await expect(fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', inputs: [{ role: 'x' }] })).rejects.toThrow(/inputs\[\]\.ref/)
    await expect(fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', inputs: 'x' })).rejects.toThrow(/array/)
    // An input error names the operation, the name a view request uses.
    await expect(fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', inputs: [{ role: 'nope', ref: 'a' }] }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_inputs', message: expect.stringMatching(/^Unknown input role "nope" for asset\.import;/) })
    await expect(fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', params: {} }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_params' })
    await expect(fixture.handlers.undo({ project: projectId, to: 7 })).rejects.toMatchObject({ status: 400, code: 'invalid_params' })
  })

  it('records timeline gestures without a turn and schedules calls that wait for a producer', async () => {
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
    expect(state.components.proj.records.every(record => record.actor === 'user' && record.turn === null)).toBe(true)

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

  it('puts every edit of the agent and the human at the end of one history line', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const agent = await fixture.agentImport(projectId, 's1', 'one.png')
    // A human edit beside the chat follows the agent's edit at once.
    const human = await fixture.handlers.runOperation({
      project: projectId, operation: 'asset.import', surface: 'canvas', session: 's1', params: { path: fixture.writeFile('h.png', 'H'), mime: 'image/png' },
    })
    expect(human.parents).toEqual([agent])
    expect(fixture.handlers.getState(projectId).head).toBe(human.id)
    const other = await fixture.agentImport(projectId, 's2', 'two.png')
    expect(fixture.project.getRecord(projectId, other).parents).toEqual([human.id])
    const history = await fixture.handlers.listHistory({ project: projectId })
    expect(history.entries.map(entry => entry.record.id).slice(0, 3)).toEqual([other, human.id, agent])
    expect(history.entries[0]).toEqual({ record: expect.objectContaining({ id: other }), place: 'current' })
  })

  it('moves the current position on undo and redo, discards the later steps on a write, and keeps every import in the state', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const first = await fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('u1.png', 'U1'), mime: 'image/png' } })
    const second = await fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('u2.png', 'U2'), mime: 'image/png' } })
    expect(await fixture.handlers.undo({ project: projectId })).toEqual({ tip: second.id, at: first.id })
    const state = fixture.handlers.getState(projectId)
    expect(Object.keys(state)).toEqual(['project', 'head', 'tip', 'components', 'assets'])
    expect(state).toMatchObject({ head: first.id, tip: second.id })
    expect(state.components.proj.records.map(record => record.id)).not.toContain(second.id)
    // An imported asset stays listed through the whole history, so the state still lists the undone import's asset.
    expect(state.assets.map(asset => asset.id)).toEqual([...first.outputs, ...second.outputs])
    expect(await fixture.handlers.redo({ project: projectId })).toEqual({ tip: second.id, at: second.id })
    await expect(fixture.handlers.redo({ project: projectId })).rejects.toMatchObject({ status: 409, code: 'nothing_to_redo' })
    expect(await fixture.handlers.undo({ project: projectId, to: first.id })).toEqual({ tip: second.id, at: first.id })
    // A write after the move follows the current position and discards the later step; its import stays in the state.
    const third = await fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('u3.png', 'U3'), mime: 'image/png' } })
    expect(third.parents).toEqual([first.id])
    expect(fixture.handlers.getState(projectId)).toMatchObject({ head: third.id, tip: third.id })
    expect(fixture.handlers.getState(projectId).assets.map(asset => asset.id)).toContain(second.outputs[0])
    await expect(fixture.handlers.undo({ project: projectId, to: second.id })).rejects.toMatchObject({ status: 400, code: 'invalid_params' })
    await expect(fixture.handlers.undo({ project: projectId, to: 7 })).rejects.toMatchObject({ status: 400, code: 'invalid_params' })
    await expect(fixture.handlers.undo({ project: projectId, to: 'missing' })).rejects.toMatchObject({ status: 404, code: 'unknown_record' })
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
    const state = await call(fixture, ROUTES.state, { query: { project: projectId } })
    expect(state.status).toBe(200)
    expect((state.json as { assets: unknown[] }).assets).toHaveLength(1)

    const operations = await call(fixture, ROUTES.operations)
    expect(Array.isArray(operations.json)).toBe(true)
    expect(await call(fixture, ROUTES.operation, { method: 'POST', body: { project: projectId, operation: 'no.such', surface: 'canvas' } }))
      .toMatchObject({ status: 404, json: { code: 'unknown_operation' } })
    expect(Object.keys(ROUTES)).toEqual(['projects', 'state', 'operations', 'operation', 'undo', 'redo', 'acceptStale', 'history'])
    for (const gone of ['/api/dv/branches/create', '/api/dv/branches/switch', '/api/dv/branches/rename']) {
      expect(fixture.connection.routes.has(gone)).toBe(false)
    }
    const noBody = await call(fixture, ROUTES.undo, { method: 'POST' })
    expect(noBody.status).toBe(400)
    const importId = (invoked.json as { id: string }).id
    expect(await call(fixture, ROUTES.undo, { method: 'POST', body: { project: projectId } }))
      .toMatchObject({ status: 200, json: { tip: importId } })
    expect(await call(fixture, ROUTES.redo, { method: 'POST', body: { project: projectId } }))
      .toEqual({ status: 200, json: { tip: importId, at: importId } })
    const keep = (record: string) => call(fixture, ROUTES.acceptStale, {
      method: 'POST', body: { project: projectId, record, surface: 'canvas' },
    })
    expect(await keep('nope')).toMatchObject({ status: 404, json: { code: 'unknown_record' } })
    const kept = await keep(importId)
    expect(kept).toMatchObject({ status: 200, json: { operation: 'proj.stale_accept', actor: 'user' } })
  })

  it('answers every refusal of the project routes with the body {error, code}', async () => {
    const fixture = await start()
    // Every route that names a project: GET routes read it from the query, POST routes from the body.
    const named: Array<{ path: string; method: 'GET' | 'POST' }> = [
      { path: ROUTES.state, method: 'GET' }, { path: ROUTES.operation, method: 'POST' }, { path: ROUTES.undo, method: 'POST' },
      { path: ROUTES.acceptStale, method: 'POST' }, { path: ROUTES.history, method: 'POST' },
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

  it('lists the whole history with assets, filters and pages, and refuses bad queries', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const human = await fixture.handlers.runOperation({
      project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('h.png', 'H'), mime: 'image/png' },
    })
    const undone = await fixture.handlers.runOperation({
      project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('u.png', 'U'), mime: 'image/png' },
    })
    await fixture.handlers.undo({ project: projectId })
    // The agent's write after the undo follows the current position and discards the undone record.
    const agent = await fixture.agentImport(projectId, 's1', 'a.png')
    const history = async (body: Record<string, unknown>) => {
      const answer = await call(fixture, ROUTES.history, { method: 'POST', body: { project: projectId, ...body } })
      return answer as {
        status: number
        json: {
          entries: Array<{ record: { id: string } }>
          assets: Array<{ id: string }>
        }
      }
    }
    const ids = (answer: Awaited<ReturnType<typeof history>>): string[] => answer.json.entries.map(entry => entry.record.id)

    const all = await history({ kind: 'operation' })
    expect(all.status).toBe(200)
    expect(ids(all)).toEqual([agent, human.id, expect.any(String)])
    expect(Object.keys(all.json.entries[0] ?? {})).toEqual(['record', 'place'])
    const named = [...human.outputs, ...fixture.project.getRecord(projectId, agent).outputs]
    expect(all.json.assets.map(asset => asset.id).sort()).toEqual(named.sort())

    expect(ids(await history({ limit: 2 }))).toEqual([agent, human.id])
    expect(ids(await history({ operation: 'asset.import' }))).toEqual([agent, human.id])
    expect(ids(await history({ tool_call: 'call-1' }))).toEqual([agent])
    expect(ids(await history({ actor: 'user', component: 'asset', before: agent }))).toEqual([human.id])
    // A discarded record is not in the history, so it cannot page it.
    expect(await history({ before: undone.id })).toMatchObject({ status: 404, json: { code: 'unknown_record' } })
    expect(ids(await history({ records: [human.id, agent] }))).toEqual([agent, human.id])
    expect((await history({ actor: 'agent', kind: 'operation', session: 's9' })).json).toEqual({ entries: [], assets: [] })

    expect(await call(fixture, ROUTES.history, { method: 'POST', body: {} })).toMatchObject({ status: 400, json: { code: 'invalid_params' } })
    expect(await call(fixture, ROUTES.history, { method: 'POST', body: { project: 'nope' } })).toMatchObject({ status: 404, json: { code: 'unknown_project' } })
    expect(await history({ before: 'missing' })).toMatchObject({ status: 404, json: { code: 'unknown_record' } })
    const refused = [
      { actor: 'robot' }, { kind: 'request' }, { records: 'r1' }, { records: [1] }, { limit: 0 }, { limit: 201 }, { limit: 1.5 },
      { operation: 3 },
    ]
    for (const bad of refused) {
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
    expect(text).not.toContain('event: branch')
    await readUntil(': keepalive')
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  it('frames each project change by its kind, and lists every asset a project mentions', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const imported = await fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('h.png', 'H'), mime: 'image/png' } })
    const event: ProjectEvent = { kind: 'record', record: imported }
    expect(frameOf(event)).toBe(`event: record\ndata: ${JSON.stringify(event)}\n\n`)
    await fixture.handlers.runOperation({
      project: projectId, operation: 'bible.character_create', surface: 'canvas', params: { character: 'c1', name: 'Hero' },
      inputs: imported.outputs.map(ref => ({ role: 'reference', ref })),
    })
    const imports = (): Map<AssetId, ProjectRecord> => importedAssets(fixture.project.listRecords(projectId))
    expect(mentionedAssets(fixture.project.getState(projectId), imports())).toEqual(imported.outputs)
    // An imported asset of an undone step stays mentioned through the whole history.
    const later = await fixture.handlers.runOperation({ project: projectId, operation: 'asset.import', surface: 'canvas', params: { path: fixture.writeFile('l.png', 'L'), mime: 'image/png' } })
    await fixture.handlers.undo({ project: projectId })
    expect(mentionedAssets(fixture.project.getState(projectId), imports())).toEqual([...imported.outputs, ...later.outputs])
  })

  it.skipIf(!existsSync(FFMPEG))('lists a generated asset while its step is in the current state, and an imported asset through the whole history', async () => {
    const fixture = await start()
    const projectId = await fixture.newProject('demo')
    const { outputs } = await fixture.context.dvFfmpeg.run({
      argv: ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=1:r=10', '-pix_fmt', 'yuv420p', '{{out:clip.mp4}}'],
      inputs: [], outputs: ['clip.mp4'], dir: fixture.root,
    })
    const imported = await fixture.handlers.runOperation({
      project: projectId, operation: 'asset.import', surface: 'asset_pool', params: { path: outputs[0], mime: 'video/mp4', name: '开场.mp4' },
    })
    const video = imported.outputs[0] ?? ''
    const still = await fixture.handlers.runOperation({
      project: projectId, operation: 'asset.grab_still', surface: 'canvas', params: { at: 'first' }, inputs: [{ role: 'video', ref: video }],
    })
    const listed = () => new Map(fixture.handlers.getState(projectId).assets.map(asset => [asset.id, asset]))
    // The import carries this project's name and the media facts read at import; the still names the step that made it.
    expect(listed().get(brandString<AssetId>(video))).toMatchObject({ name: '开场.mp4', made_by: 'asset.import', width: 160, height: 90 })
    expect(listed().get(brandString<AssetId>(video))?.duration_sec).toBeCloseTo(1, 1)
    expect(listed().get(still.outputs[0] ?? brandString<AssetId>(''))).toMatchObject({ made_by: 'asset.grab_still' })
    // Undo the still: the generated asset leaves the list; undo the import too: the imported asset stays.
    await fixture.handlers.undo({ project: projectId })
    expect(listed().has(still.outputs[0] ?? brandString<AssetId>(''))).toBe(false)
    await fixture.handlers.undo({ project: projectId })
    expect(listed().get(brandString<AssetId>(video))).toMatchObject({ made_by: 'asset.import' })
  })

  it('names errors, orders projects, and refuses an undo without changes', async () => {
    expect(messageOf(new Error('boom'))).toBe('boom')
    expect(messageOf('plain')).toBe('plain')
    const fixture = await start()
    const older = await fixture.newProject('older')
    const projectId = await fixture.newProject('demo')
    expect(fixture.handlers.listProjects().map(entry => entry.id).sort()).toEqual([older, projectId].sort())
    await expect(fixture.handlers.undo({ project: older })).rejects.toMatchObject({ status: 409, code: 'nothing_to_undo' })
  })

  it('records based_on and supersedes, and lists only known assets', async () => {
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
    const imports = importedAssets(fixture.project.listRecords(projectId))
    expect(mentionedAssets(fixture.project.getState(projectId), imports)).toEqual([...first.outputs, ...second.outputs])
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
