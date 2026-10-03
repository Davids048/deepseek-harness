/**
 * The project store service over a temporary root: records, listing order and kind filter, atomic record writes, the
 * write lease and its takeover order, deletion with the project's files, and migration of unrecognized records.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectInUseError, ProjectNotFoundError, StaleLeaseError, type ProjectHolder } from '../src/index.ts'
import { startStore, type StoreFixture } from './support.ts'

const fixtures: StoreFixture[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

/** Mount a store and dispose it after the spec. */
async function start(): Promise<StoreFixture> {
  const fixture = await startStore()
  fixtures.push(fixture)
  return fixture
}

/** A holder that resolves its revocation at once. */
const QUIET_HOLDER: ProjectHolder = { revoke: async () => {} }

const WORKLOAD = { schemaVersion: 1, data: { scenes: [] } }

describe('project records', () => {
  it('stores a created project as a schema-2 record and lists projects by kind, most recently updated first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { store, root } = await start()
    vi.setSystemTime(new Date('2026-10-02T01:00:00.000Z'))
    const story = store.create({ kind: 'dreamverse', title: 'Story', workload: WORKLOAD })
    vi.setSystemTime(new Date('2026-10-02T02:00:00.000Z'))
    const tree = store.create({ kind: 'multiverse', title: 'Tree', workload: { schemaVersion: 3, data: null } })
    vi.setSystemTime(new Date('2026-10-02T03:00:00.000Z'))
    const lease = await store.acquire(story.projectId, QUIET_HOLDER)
    store.setTitle(lease, 'Story, edited')

    expect(store.list().map(record => [record.title, record.updatedAt])).toEqual([
      ['Story, edited', '2026-10-02T03:00:00.000Z'],
      ['Tree', '2026-10-02T02:00:00.000Z'],
    ])
    expect(store.list({ kind: 'multiverse' }).map(record => record.projectId)).toEqual([tree.projectId])
    expect(store.get(tree.projectId)).toEqual(tree)
    expect(JSON.parse(readFileSync(join(root, story.projectId, 'project.json'), 'utf8'))).toEqual({
      schema_version: 2,
      project_id: story.projectId,
      kind: 'dreamverse',
      title: 'Story, edited',
      created_at: '2026-10-02T01:00:00.000Z',
      updated_at: '2026-10-02T03:00:00.000Z',
      thumbnail_asset_id: null,
      workload: { schema_version: 1, data: { scenes: [] } },
    })
  })

  it('replaces the record through a temporary file and keeps the kind fixed', async () => {
    const { store, root } = await start()
    const record = store.create({ kind: 'dreamverse', title: 'Story', workload: WORKLOAD })
    const lease = await store.acquire(record.projectId, QUIET_HOLDER)
    store.updateWorkload(lease, { schemaVersion: 2, data: { scenes: ['a'] } })
    const updated = store.setThumbnail(lease, 'frame-1')

    expect(readdirSync(join(root, record.projectId))).toEqual(['project.json'])
    expect(updated).toMatchObject({ kind: 'dreamverse', thumbnailAssetId: 'frame-1', workload: { schemaVersion: 2, data: { scenes: ['a'] } } })
    expect(store.get(record.projectId)).toEqual(updated)
    expect(store.get('../escape')).toBeUndefined()
  })
})

describe('write lease', () => {
  it('revokes the current holder and waits for it before granting the project to a later holder', async () => {
    const { store } = await start()
    const { projectId } = store.create({ kind: 'dreamverse', title: 'Story', workload: WORKLOAD })
    const events: string[] = []
    let finishRevoke = (): void => {}
    const first = await store.acquire(projectId, {
      revoke: () => new Promise<void>((resolve) => {
        events.push('revoke')
        finishRevoke = () => {
          events.push('revoked')
          resolve()
        }
      }),
    })
    const second = store.acquire(projectId, QUIET_HOLDER).then((lease) => {
      events.push('granted')
      return lease
    })
    await vi.waitFor(() => { expect(events).toEqual(['revoke']) })
    // The revoked holder keeps writing until its revocation resolves.
    expect(store.setTitle(first, 'Last write').title).toBe('Last write')

    finishRevoke()
    const lease = await second
    expect(events).toEqual(['revoke', 'revoked', 'granted'])
    expect(() => store.setTitle(first, 'Late write')).toThrow(StaleLeaseError)
    expect(store.setTitle(lease, 'New holder').title).toBe('New holder')
    expect(store.isHeld(projectId)).toBe(true)
  })

  it('rejects writes after release, ignores a repeated release, and refuses unknown projects', async () => {
    const { store } = await start()
    const { projectId } = store.create({ kind: 'dreamverse', title: 'Story', workload: WORKLOAD })
    const lease = await store.acquire(projectId, QUIET_HOLDER)
    store.release(lease)
    store.release(lease)

    expect(store.isHeld(projectId)).toBe(false)
    expect(() => store.updateWorkload(lease, WORKLOAD)).toThrow(StaleLeaseError)
    await expect(store.acquire('missing', QUIET_HOLDER)).rejects.toThrow(ProjectNotFoundError)
  })
})

describe('deletion', () => {
  it('refuses a held project, then deletes its files and its directory once released', async () => {
    const { store, files, root } = await start()
    const { projectId } = store.create({ kind: 'multiverse', title: 'Tree', workload: WORKLOAD })
    const lease = await store.acquire(projectId, QUIET_HOLDER)

    expect(() => { store.delete(projectId) }).toThrow(ProjectInUseError)
    expect(files.deletedOwners).toEqual([])
    store.release(lease)
    store.delete(projectId)

    expect(files.deletedOwners).toEqual([`project:${projectId}`])
    expect(existsSync(join(root, projectId))).toBe(false)
    expect(() => { store.delete(projectId) }).toThrow(ProjectNotFoundError)
  })
})

describe('unrecognized records', () => {
  it('skips records of other schemas when listing and migrates them, keeping the old record', async () => {
    const { store, root } = await start()
    const legacy = { schema_version: 1, project_id: 'legacy-1', title: 'Old story', segments: [] }
    mkdirSync(join(root, 'legacy-1'))
    writeFileSync(join(root, 'legacy-1', 'project.json'), JSON.stringify(legacy))
    mkdirSync(join(root, 'broken'))
    writeFileSync(join(root, 'broken', 'project.json'), '{not json')
    mkdirSync(join(root, 'interrupted'))
    writeFileSync(join(root, 'interrupted', 'project.legacy.json'), JSON.stringify({ schema_version: 1 }))

    expect(store.list()).toEqual([])
    expect(store.get('legacy-1')).toBeUndefined()
    expect(store.listUnrecognized().sort((a, b) => a.projectId.localeCompare(b.projectId))).toEqual([
      { projectId: 'broken', directory: join(root, 'broken'), record: null },
      { projectId: 'interrupted', directory: join(root, 'interrupted'), record: { schema_version: 1 } },
      { projectId: 'legacy-1', directory: join(root, 'legacy-1'), record: legacy },
    ])

    const migrated = store.migrate('legacy-1', {
      kind: 'dreamverse', title: 'Old story', createdAt: '2026-09-01T00:00:00.000Z', workload: WORKLOAD,
    })
    expect(migrated).toMatchObject({ projectId: 'legacy-1', kind: 'dreamverse', createdAt: '2026-09-01T00:00:00.000Z' })
    expect(JSON.parse(readFileSync(join(root, 'legacy-1', 'project.legacy.json'), 'utf8'))).toEqual(legacy)
    expect(store.list().map(record => record.projectId)).toEqual(['legacy-1'])
    expect(() => store.migrate('legacy-1', { kind: 'dreamverse', title: 'Again', createdAt: '2026-09-01T00:00:00.000Z', workload: WORKLOAD }))
      .toThrow('already has a schema 2 record')

    store.migrate('interrupted', { kind: 'dreamverse', title: 'Resumed', createdAt: '2026-09-02T00:00:00.000Z', workload: WORKLOAD })
    expect(readdirSync(join(root, 'interrupted')).sort()).toEqual(['project.json', 'project.legacy.json'])
    expect(store.listUnrecognized().map(project => project.projectId)).toEqual(['broken'])
  })
})
