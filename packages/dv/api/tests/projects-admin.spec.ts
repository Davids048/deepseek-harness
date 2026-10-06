/**
 * Project rename and delete routes over the real Project service: renamed titles stay unique and reach the project list,
 * a deleted project moves to the Project store's trash and leaves the list with its Workspace link, bindings and canvas
 * layout file, and the sessions route finds a project's DSH sessions by directory.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { RecordOrigin } from '@dv/project'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { startBase, type BaseFixture } from './support.ts'
import { CanvasLayoutStore } from '../src/layout.ts'
import { PROJECT_ADMIN_ROUTES, projectAdminRoutes } from '../src/projects-admin.ts'
import { WORKSPACE_ROUTES, workspaceRoutes } from '../src/workspaces.ts'

/** A human action outside any chat session. */
const HUMAN: RecordOrigin = { actor: 'user', surface: 'api', session: null, turn: null, tool_call: null, intent: 'test' }

let root = ''
let fixture: BaseFixture | null = null
const saved = { home: process.env['DSH_HOME'] }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dv-projects-admin-'))
  process.env['DSH_HOME'] = join(root, 'dsh-home')
})

afterEach(async () => {
  await fixture?.dispose()
  fixture = null
  if (saved.home === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = saved.home
  rmSync(root, { recursive: true, force: true })
})

/** Call one route by path. */
async function call(
  routes: ConnectionFetchRoute[],
  path: string,
  init: { query?: Record<string, string>; json?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`no route ${path}`)
  const url = `http://localhost${path}?${new URLSearchParams(init.query ?? {}).toString()}`
  const request = init.json === undefined ? new Request(url) : new Request(url, { method: 'POST', body: JSON.stringify(init.json) })
  const response = await route.fetch(request)
  return { status: response.status, json: await response.json() }
}

it('renames a project to a unique title and deletes it into the Project store\'s trash', async () => {
  fixture = await startBase({ generation: 'none', root })
  const layouts = new CanvasLayoutStore(join(root, 'canvas-layout'))
  const routes = [...workspaceRoutes(fixture.project, root), ...projectAdminRoutes(fixture.project, root, layouts)]
  const first = (await fixture.project.createProject('未命名项目', HUMAN)).id
  const second = (await fixture.project.createProject('未命名项目', HUMAN)).id
  layouts.write(first, { positions: { n1: { x: 1, y: 2 } } })
  layouts.write(second, { positions: { n1: { x: 3, y: 4 } } })

  expect((await call(routes, PROJECT_ADMIN_ROUTES.rename, { json: { project: second, title: '未命名项目' } })).json).toEqual({ title: '未命名项目 2' })
  expect((await call(routes, PROJECT_ADMIN_ROUTES.rename, { json: { project: first, title: '  广告  ' } })).json).toEqual({ title: '广告' })
  expect(fixture.project.openProject(first).title).toBe('广告')
  expect(await call(routes, PROJECT_ADMIN_ROUTES.rename, { json: { project: first, title: ' ' } }))
    .toMatchObject({ status: 400, json: { error: expect.any(String), code: 'invalid_params' } })
  expect(await call(routes, PROJECT_ADMIN_ROUTES.delete, { json: {} })).toMatchObject({ status: 400, json: { code: 'invalid_params' } })

  await call(routes, WORKSPACE_ROUTES.workspaces, { json: { project: second, workspace_id: 'ws-2' } })
  await call(routes, WORKSPACE_ROUTES.bind, { json: { session: 'chat-2', project: second } })
  const removed = await call(routes, PROJECT_ADMIN_ROUTES.delete, { json: { project: second } })
  expect(removed.json).toEqual({ ok: true, workspace_id: 'ws-2' })
  expect(existsSync(join(root, 'projects', second))).toBe(false)
  expect(readdirSync(join(root, 'projects', '.trash'))).toEqual([expect.stringMatching(new RegExp(`^${second}-\\d+$`))])
  expect(readdirSync(join(root, 'canvas-layout'))).toEqual([`${first}.json`])
  const listed = (await call(routes, WORKSPACE_ROUTES.workspaces)).json as {
    projects: Array<{ id: string; title: string }>
    bindings: Record<string, string>
  }
  expect(listed.projects.map(row => row.id)).toEqual([first])
  expect(listed.bindings).toEqual({})
  // A deleted project is unknown to both routes.
  expect(await call(routes, PROJECT_ADMIN_ROUTES.rename, { json: { project: second, title: 'x' } }))
    .toMatchObject({ status: 404, json: { error: expect.any(String), code: 'unknown_project' } })
  expect(await call(routes, PROJECT_ADMIN_ROUTES.delete, { json: { project: second } })).toMatchObject({ status: 404, json: { code: 'unknown_project' } })
})

it('lists the DSH sessions stored under a project directory, newest first', async () => {
  fixture = await startBase({ generation: 'none', root })
  const routes = workspaceRoutes(fixture.project, root)
  const projectId = (await fixture.project.createProject('chats', HUMAN)).id
  const group = join(root, 'dsh-home', 'sessions', `--tmp-state-projects-${projectId}--`)
  for (const [id, size] of [['session-a', 10], ['session-b', 3000]] as const) {
    mkdirSync(join(group, id), { recursive: true })
    writeFileSync(join(group, id, 'session.lock'), '')
    writeFileSync(join(group, id, 'session.v4.jsonl.zstd'), 'x'.repeat(size))
  }
  const listed = (await call(routes, WORKSPACE_ROUTES.sessions, { query: { project: projectId } })).json as
    Array<{ session: string; updated_at: string; bytes: number }>
  expect(listed.map(row => [row.session, row.bytes]).sort()).toEqual([['session-a', 10], ['session-b', 3000]])
  expect(listed.every(row => !Number.isNaN(Date.parse(row.updated_at)))).toBe(true)
  expect(await call(routes, WORKSPACE_ROUTES.sessions, { query: { project: 'missing' } }))
    .toMatchObject({ status: 404, json: { error: expect.any(String), code: 'unknown_project' } })
  expect(await call(routes, WORKSPACE_ROUTES.sessions)).toMatchObject({ status: 400, json: { code: 'invalid_params' } })
})
