/**
 * The asset import route over the real Project service and asset pool: a stored file becomes an `asset.import` record
 * on the working branch of the named chat session, and malformed requests are refused with their status.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AssetId, ProjectRecord } from '@dv/project'
import { encodeClip, startBase, type BaseFixture } from './support.ts'
import { ASSET_IMPORT_ROUTE, assetImportRoutes } from '../src/asset-import.ts'

const fixtures: BaseFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

it('stores an imported file as an asset.import record with the caller\'s surface and refuses malformed requests', async () => {
  const fixture = await startBase()
  fixtures.push(fixture)
  const projectId = (await fixture.project.createProject('import', { actor: 'user', surface: 'canvas', session: null, turn: null, tool_call: null, intent: 'test' })).id
  const [route] = assetImportRoutes({ project: fixture.project, assets: fixture.assets })
  if (route === undefined) throw new Error('no asset import route')
  const post = async (query: Record<string, string>, body: Uint8Array<ArrayBuffer>): Promise<{ status: number; json: unknown }> => {
    const url = `http://localhost${ASSET_IMPORT_ROUTE}?${new URLSearchParams(query).toString()}`
    const response = await route.fetch(new Request(url, { method: 'POST', body }))
    return { status: response.status, json: await response.json() }
  }

  const { lastFrame } = await encodeClip(mkdtempSync(join(tmpdir(), 'dv-import-ref-')), 192, 108, 24)
  const imported = await post({ project: projectId, name: 'ref.png', mime: 'image/png', surface: 'canvas' }, new Uint8Array(lastFrame))
  expect(imported.status).toBe(200)
  const { asset, record } = imported.json as { asset: AssetId; record: ProjectRecord }
  expect(fixture.assets.read(asset).equals(lastFrame)).toBe(true)
  expect(record.outputs).toEqual([asset])
  expect(record).toMatchObject({
    actor: 'user', surface: 'canvas', operation: 'asset.import', status: 'done', branch: 'main', params: { name: 'ref.png', mime: 'image/png' },
  })

  // With a forked branch current, the import lands on that branch and records the chat session beside the panel.
  await fixture.project.createBranch(projectId, null)
  const fromPanel = { project: projectId, name: 'ref.png', mime: 'image/png', surface: 'asset_pool', session: 's1' }
  const onBranch = await post(fromPanel, new Uint8Array(lastFrame))
  expect(onBranch.json).toMatchObject({ record: { branch: 'b2', session: 's1', actor: 'user', surface: 'asset_pool' } })

  // The surface names the caller, the canvas or the asset pool panel; a missing or other surface is refused.
  for (const surface of [undefined, 'timeline', 'chat']) {
    const query = { project: projectId, name: 'ref.png', mime: 'image/png', ...surface === undefined ? {} : { surface } }
    expect(await post(query, new Uint8Array(lastFrame))).toMatchObject({ status: 400, json: { code: 'invalid_params' } })
  }

  const canvas = { name: 'ref.png', mime: 'image/png', surface: 'canvas' }
  const invalid = { status: 400, json: { error: expect.any(String), code: 'invalid_params' } }
  expect(await post({ ...canvas, project: projectId, name: 'empty.png' }, new Uint8Array())).toMatchObject(invalid)
  expect(await post({ project: projectId, name: 'ref.png', surface: 'canvas' }, new Uint8Array(lastFrame))).toMatchObject(invalid)
  expect(await post(canvas, new Uint8Array(lastFrame))).toMatchObject(invalid)
  expect(await post({ ...canvas, project: 'missing' }, new Uint8Array(lastFrame)))
    .toMatchObject({ status: 404, json: { error: expect.any(String), code: 'unknown_project' } })
})
