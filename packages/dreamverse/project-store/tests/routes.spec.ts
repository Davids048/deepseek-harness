/**
 * The `/projects` routes on the real DSH web server: the list with its kind filter, one project with its workload data
 * and files, deletion status codes, and removal of the routes when the plugin unloads.
 */
import { request as httpRequest } from 'node:http'
import type { Fiber } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { projectOwner, type AssetId } from '@dreamverse/assets-manager'
import { afterEach, describe, expect, it } from 'vitest'
import * as routes from '../src/routes.ts'
import { startStore, type StoreFixture } from './support.ts'

const fixtures: StoreFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

/** Mount the store, the web server on an OS-assigned port, and the routes plugin. */
async function start(): Promise<StoreFixture & { port: number; routesFiber: Fiber }> {
  const fixture = await startStore()
  fixtures.push(fixture)
  await fixture.context.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' }).await()
  const routesFiber = fixture.context.plugin(routes)
  await routesFiber.await()
  return { ...fixture, port: fixture.context.webServer.port, routesFiber }
}

/** Send one request and parse a JSON body when there is one. */
async function call(port: number, method: string, path: string): Promise<{ status: number; json: unknown }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, agent: false }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const json: unknown = text ? JSON.parse(text) : null
        resolve({ status: response.statusCode ?? 0, json })
      })
    })
    request.on('error', reject)
    request.end()
  })
}

const QUIET_HOLDER = { revoke: async () => {} }

describe('/projects', () => {
  it('lists projects with their thumbnails and filters them by kind', async () => {
    const { store, port } = await start()
    const story = store.create({ kind: 'dreamverse', title: 'Story', workload: { schemaVersion: 1, data: {} } })
    const tree = store.create({ kind: 'multiverse', title: 'Tree', workload: { schemaVersion: 1, data: {} } })
    const lease = await store.acquire(tree.projectId, QUIET_HOLDER)
    const updated = store.setThumbnail(lease, brandString<AssetId>('frame 1'))

    const all = await call(port, 'GET', '/projects')
    expect(all.status).toBe(200)
    expect(all.json).toEqual({
      projects: [
        {
          project_id: tree.projectId, kind: 'multiverse', title: 'Tree', created_at: tree.createdAt,
          updated_at: updated.updatedAt, thumbnail_url: '/assets/frame%201/content',
        },
        {
          project_id: story.projectId, kind: 'dreamverse', title: 'Story', created_at: story.createdAt,
          updated_at: story.updatedAt, thumbnail_url: null,
        },
      ],
    })
    expect(await call(port, 'GET', '/projects?kind=dreamverse')).toMatchObject({
      status: 200, json: { projects: [{ project_id: story.projectId }] },
    })
  })

  it('returns one project with its workload data, holder state, and files', async () => {
    const { store, files, port } = await start()
    const record = store.create({ kind: 'dreamverse', title: 'Story', workload: { schemaVersion: 4, data: { rounds: [['s1']] } } })
    files.addImage(projectOwner(record.projectId), 'frame-1')
    await store.acquire(record.projectId, QUIET_HOLDER)

    expect(await call(port, 'GET', `/projects/${record.projectId}`)).toEqual({
      status: 200,
      json: {
        project_id: record.projectId, kind: 'dreamverse', title: 'Story', created_at: record.createdAt,
        updated_at: record.updatedAt, thumbnail_url: null, held: true,
        workload: { schema_version: 4, data: { rounds: [['s1']] } },
        assets: [{
          asset_id: 'frame-1', name: 'frame-1.png', media_type: 'image', mime_type: 'image/png', size_bytes: 3, width: 16,
          height: 9, duration_sec: null, created_at: '2026-10-02T00:00:00.000Z', content_url: '/assets/frame-1/content',
        }],
      },
    })
    expect(await call(port, 'GET', '/projects/missing')).toEqual({ status: 404, json: { detail: 'Project not found.' } })
  })

  it('deletes a released project with its files, refuses a held one, and reports unknown projects', async () => {
    const { store, files, port } = await start()
    const { projectId } = store.create({ kind: 'multiverse', title: 'Tree', workload: { schemaVersion: 1, data: {} } })
    const lease = await store.acquire(projectId, QUIET_HOLDER)

    expect(await call(port, 'DELETE', `/projects/${projectId}`)).toEqual({
      status: 409, json: { detail: 'This project is open. Close it before deleting.' },
    })
    store.release(lease)
    expect(await call(port, 'DELETE', `/projects/${projectId}`)).toEqual({ status: 204, json: null })
    expect(files.deletedOwners).toEqual([`project:${projectId}`])
    expect(await call(port, 'DELETE', `/projects/${projectId}`)).toEqual({ status: 404, json: { detail: 'Project not found.' } })
  })

  it('removes the routes when the plugin unloads', async () => {
    const { port, routesFiber } = await start()
    expect((await call(port, 'GET', '/projects')).status).toBe(200)
    await routesFiber.dispose()
    expect((await call(port, 'GET', '/projects')).status).toBe(404)
  })
})
