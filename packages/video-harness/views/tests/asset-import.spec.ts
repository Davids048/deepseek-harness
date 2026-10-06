/**
 * The asset import route over the real runtime, log, and asset store: a stored file becomes an `asset.upload` record,
 * and malformed requests are refused with their status.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ProjectId } from '@video-harness/oplog'
import { renderClip, startTools, type ToolsFixture } from '../../tools/tests/support.ts'
import { ASSET_IMPORT_ROUTE, assetImportRoutes } from '../src/asset-import.ts'

const fixtures: ToolsFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

it('stores an imported file as an asset.upload record and refuses malformed requests', async () => {
  const fixture = await startTools({ perception: false })
  fixtures.push(fixture)
  const projectId: ProjectId = fixture.project.createProject({ title: 'import', actor: 'user', surface: 'canvas' })
  const [route] = assetImportRoutes({ project: fixture.project, log: fixture.log, assets: fixture.assets })
  if (route === undefined) throw new Error('no asset import route')
  const post = async (query: Record<string, string>, body: Uint8Array): Promise<{ status: number; json: unknown }> => {
    const url = `http://localhost${ASSET_IMPORT_ROUTE}?${new URLSearchParams(query).toString()}`
    const response = await route.fetch(new Request(url, { method: 'POST', body }))
    return { status: response.status, json: await response.json() }
  }

  const { lastFrame } = await renderClip(mkdtempSync(join(tmpdir(), 'vh-import-ref-')), 192, 108, 24)
  const imported = await post({ project: projectId, name: 'ref.png', mime: 'image/png' }, new Uint8Array(lastFrame))
  expect(imported.status).toBe(200)
  const assetId = (imported.json as { assetId: string }).assetId
  expect(fixture.assets.read(assetId as never).equals(lastFrame)).toBe(true)
  expect(imported.json).toMatchObject({
    op: {
      actor: 'user', surface: 'canvas', tool: { name: 'asset.upload' }, status: 'done', params: { name: 'ref.png', mime: 'image/png' },
    },
  })

  expect((await post({ project: projectId, name: 'empty.png', mime: 'image/png' }, new Uint8Array())).status).toBe(400)
  expect((await post({ project: projectId, name: 'ref.png' }, new Uint8Array(lastFrame))).status).toBe(400)
  expect((await post({ project: 'missing', name: 'ref.png', mime: 'image/png' }, new Uint8Array(lastFrame))).status).toBe(404)
})
