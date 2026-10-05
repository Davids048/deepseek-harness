/**
 * Tool session routes over the real runtime, log, and asset store with the fake generation backend: create and rename
 * sessions, upload an asset, generate into a session, and read the session's results and the model limits.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { afterEach, expect, it } from 'vitest'
import type { ProjectId } from '@video-harness/oplog'
import { renderClip, startTools, type ToolsFixture } from '../../tools/tests/support.ts'
import { TOOL_SESSION_ROUTES, ToolSessionStore, toolSessionRoutes } from '../src/tool-sessions.ts'

const fixtures: ToolsFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

/** Call one route by path. */
async function call(
  routes: ConnectionFetchRoute[],
  path: string,
  init: { method?: string; query?: Record<string, string>; body?: BodyInit; json?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`no route ${path}`)
  const url = `http://localhost${path}?${new URLSearchParams(init.query ?? {}).toString()}`
  const body = init.json === undefined ? init.body : JSON.stringify(init.json)
  const response = await route.fetch(new Request(url, { method: init.method ?? (body === undefined ? 'GET' : 'POST'), ...(body === undefined ? {} : { body }) }))
  return { status: response.status, json: await response.json() }
}

it('creates a Tool session, uploads, generates into it, and lists the results', async () => {
  const fixture = await startTools({ perception: false, generation: 'fake' })
  fixtures.push(fixture)
  const projectId: ProjectId = fixture.project.createProject({ title: 'tool', actor: 'user', surface: 'canvas' })
  const routes = toolSessionRoutes(
    { project: fixture.project, log: fixture.log, assets: fixture.assets, model: () => fixture.context.get('dreamverseGeneration')?.model() ?? null },
    new ToolSessionStore(mkdtempSync(join(tmpdir(), 'vh-tool-sessions-'))),
  )

  const created = await call(routes, TOOL_SESSION_ROUTES.sessions, { json: { project: projectId } })
  expect(created.json).toMatchObject({ title: 'Tool 会话 1' })
  const session = (created.json as { id: string }).id
  expect((await call(routes, TOOL_SESSION_ROUTES.sessions, { json: { project: projectId } })).json).toMatchObject({ id: session })
  await call(routes, TOOL_SESSION_ROUTES.rename, { json: { project: projectId, session, title: '雨夜镜头' } })
  expect((await call(routes, TOOL_SESSION_ROUTES.sessions, { query: { project: projectId } })).json).toEqual([expect.objectContaining({ id: session, title: '雨夜镜头' })])

  const { lastFrame } = await renderClip(mkdtempSync(join(tmpdir(), 'vh-tool-ref-')), 192, 108, 24)
  const upload = await call(routes, TOOL_SESSION_ROUTES.upload, { query: { project: projectId, name: 'ref.png', mime: 'image/png' }, body: new Uint8Array(lastFrame) })
  expect(upload.status).toBe(200)
  const reference = (upload.json as { assetId: string }).assetId
  expect(fixture.assets.read(reference as never).equals(lastFrame)).toBe(true)

  const caps = await call(routes, TOOL_SESSION_ROUTES.capabilities)
  expect(caps.json).toMatchObject({ available: true, modelName: 'Test Ref2VA' })

  const generated = await call(routes, TOOL_SESSION_ROUTES.generate, { json: { project: projectId, session, prompt: 'a red car', references: [reference], duration_sec: (caps.json as { minDurationSec: number }).minDurationSec } })
  expect(generated.status).toBe(200)
  await fixture.project.whenIdle(projectId)
  const results = await call(routes, TOOL_SESSION_ROUTES.results, { query: { project: projectId, session } })
  expect(results.json).toEqual([expect.objectContaining({ actor: 'user', surface: 'tool', status: 'done', params: expect.objectContaining({ tool_session: session, prompt: 'a red car' }) })])
  expect((await call(routes, TOOL_SESSION_ROUTES.results, { query: { project: projectId, session: 'ts-missing' } })).status).toBe(404)

  // A session with a generation is no longer empty, so the next create makes one, and the one after reuses it.
  const second = await call(routes, TOOL_SESSION_ROUTES.sessions, { json: { project: projectId } })
  expect(second.json).toMatchObject({ title: 'Tool 会话 2' })
  expect((second.json as { id: string }).id).not.toBe(session)
  expect((await call(routes, TOOL_SESSION_ROUTES.sessions, { json: { project: projectId } })).json).toEqual(second.json)

  // Deleting a session drops it from the list; the next default title skips numbers still in use.
  expect((await call(routes, TOOL_SESSION_ROUTES.delete, { json: { project: projectId, session } })).json).toEqual({ deleted: session })
  expect((await call(routes, TOOL_SESSION_ROUTES.sessions, { query: { project: projectId } })).json)
    .toEqual([expect.objectContaining({ id: (second.json as { id: string }).id })])
  expect((await call(routes, TOOL_SESSION_ROUTES.delete, { json: { project: projectId, session } })).status).toBe(404)
  await call(routes, TOOL_SESSION_ROUTES.generate, { json: { project: projectId, session: (second.json as { id: string }).id, prompt: 'a blue car' } })
  expect((await call(routes, TOOL_SESSION_ROUTES.sessions, { json: { project: projectId } })).json).toMatchObject({ title: 'Tool 会话 3' })
})
