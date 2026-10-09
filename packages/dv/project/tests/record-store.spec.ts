/**
 * Record store tests: the record format on disk, the append rule (one line, the head is the last record) and the update
 * rules, the current form of records, reload from disk, the project lock, project rename and delete, and change events.
 * The record store calls no other module, so these tests build it alone on a temporary root.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import { RecordStore, type RecordLineInput } from '../src/record-store.ts'
import { ProjectError } from '../src/shared.ts'
import type { AssetId, ProjectEvent, ProjectId, ProjectRecord, RecordId } from '../src/types.ts'
import { readLines, tempRoot, userOrigin } from './support.ts'

/** A loaded record store on a temporary root, and the events it emitted. */
interface OpenStore {
  root: string
  store: RecordStore
  events: Array<{ project: ProjectId; event: ProjectEvent }>
}

/**
 * Build and load a record store.
 * @param root - the store root; a fresh temporary directory by default.
 * @returns the store and its event list.
 */
function openStore(root = tempRoot()): OpenStore {
  const events: OpenStore['events'] = []
  const store = new RecordStore(root, (project, event) => { events.push({ project, event }) })
  store.load()
  return { root, store, events }
}

/**
 * A record line for an operation of the `timeline` component.
 * @param parent - the project's head, or null for the first record.
 * @param overrides - fields to change.
 * @returns the line.
 */
function line(parent: RecordId | null, overrides: Partial<RecordLineInput> = {}): RecordLineInput {
  return {
    parents: parent === null ? [] : [parent], kind: 'operation', component: 'timeline',
    operation: 'timeline.clip_move', operation_version: '1', ...userOrigin(), params: {}, inputs: [], outputs: [],
    based_on: null, supersedes: [], deterministic: true, status: 'pending', ...overrides,
  }
}

/**
 * Create a project with its first record, `proj.create`, as the service does.
 * @param store - the store.
 * @param id - the project ID text.
 * @param created_at - the creation time.
 * @returns the project ID and its first record.
 */
function createProject(
  store: RecordStore, id = 'project-1', created_at = new Date().toISOString(),
): { project: ProjectId; first: ProjectRecord } {
  const project = brandString<ProjectId>(id)
  store.createProject({ id: project, title: `Title of ${id}`, created_at })
  const first = store.append(project, line(null, { component: 'proj', operation: 'proj.create', params: { title: id }, status: 'done' }))
  return { project, first }
}

/**
 * @param fn - a call that should be refused.
 * @returns the code of the `ProjectError` it threw.
 */
function errorCode(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof ProjectError) return error.code
    throw error
  }
  throw new Error('the call was not refused')
}

/**
 * @param ms - how long to wait.
 * @returns a promise that resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const ASSET_X = brandString<AssetId>('asset-x')
const ASSET_Y = brandString<AssetId>('asset-y')

describe('RecordStore', () => {
  it('writes a record line and an update line', () => {
    const { root, store } = openStore()
    const { project, first } = createProject(store)
    const record = store.append(project, line(first.id))
    const startedAt = new Date().toISOString()
    store.update(project, { update: record.id, status: 'running', started_at: startedAt })
    const cost = { gpu_seconds: 3, wall_seconds: 4.5, reused: false }
    store.update(project, { update: record.id, status: 'done', finished_at: startedAt, outputs: [ASSET_X], cost })

    const lines = readLines(root, project)
    expect(lines).toHaveLength(4)
    expect(Object.keys(lines[1] ?? {})).toEqual([
      'id', 'parents', 'kind', 'component', 'operation', 'operation_version', 'actor', 'surface', 'turn', 'session',
      'tool_call', 'intent', 'params', 'inputs', 'outputs', 'based_on', 'supersedes', 'deterministic', 'status', 'created_at',
    ])
    expect(lines[2]).toEqual({ update: record.id, status: 'running', started_at: startedAt })
    expect(lines[3]).toEqual({ update: record.id, status: 'done', finished_at: startedAt, outputs: [ASSET_X], cost })
    expect(store.getRecord(project, record.id)).toEqual({
      ...record, status: 'done', started_at: startedAt, finished_at: startedAt, outputs: [ASSET_X], cost,
    })
    expect(store.head(project)).toBe(record.id)
    expect(readdirSync(join(root, project)).sort()).toEqual(['project.json', 'records.jsonl'])
  })

  it('refuses an append whose parent is not the head', () => {
    const { root, store, events } = openStore()
    const { project, first } = createProject(store)
    store.append(project, line(first.id))
    const before = readFileSync(join(root, project, 'records.jsonl'), 'utf8')
    const eventCount = events.length

    expect(errorCode(() => store.append(project, line(first.id)))).toBe('parent_not_head')
    expect(errorCode(() => store.append(project, line(null)))).toBe('parent_not_head')
    expect(readFileSync(join(root, project, 'records.jsonl'), 'utf8')).toBe(before)
    expect(events).toHaveLength(eventCount)
  })

  it('refuses a backward or repeated status', () => {
    const { store } = openStore()
    const { project, first } = createProject(store)
    const running = store.append(project, line(first.id))
    store.update(project, { update: running.id, status: 'running' })
    expect(errorCode(() => store.update(project, { update: running.id, status: 'running' }))).toBe('status_backwards')
    expect(errorCode(() => store.update(project, { update: running.id, status: 'pending' }))).toBe('status_backwards')
    store.update(project, { update: running.id, status: 'done' })
    expect(errorCode(() => store.update(project, { update: running.id, status: 'running' }))).toBe('record_finished')
  })

  it('refuses an update of a finished record', () => {
    const { store } = openStore()
    const { project, first } = createProject(store)
    let head = first.id
    for (const status of ['done', 'failed', 'cancelled'] as const) {
      const record = store.append(project, line(head))
      head = record.id
      store.update(project, { update: record.id, status })
      expect(errorCode(() => store.update(project, { update: record.id, report: { late: true } }))).toBe('record_finished')
    }
    expect(errorCode(() => store.update(project, { update: brandString<RecordId>('missing'), status: 'done' }))).toBe('unknown_record')
  })

  it('reloads records, updates and the head from disk', () => {
    const { root, store } = openStore()
    const { project, first } = createProject(store)
    const record = store.append(project, line(first.id))
    store.update(project, { update: record.id, status: 'done', outputs: [ASSET_X] })
    const last = store.append(project, line(record.id))

    const reloaded = openStore(root).store
    expect(reloaded.listProjects()).toEqual(store.listProjects())
    expect(reloaded.listRecords(project)).toEqual(store.listRecords(project))
    expect(reloaded.head(project)).toBe(last.id)
  })

  it('fills resolved_asset of an output input once the producer is done', () => {
    const { root, store } = openStore()
    const { project, first } = createProject(store)
    const producer = store.append(project, line(first.id))
    const consumer = store.append(project, line(producer.id, {
      inputs: [{ role: 'source', ref: { record: producer.id, output: 1 }, resolved_asset: null }],
    }))
    expect(store.getRecord(project, consumer.id).inputs[0]?.resolved_asset).toBeNull()

    store.update(project, { update: producer.id, status: 'done', outputs: [ASSET_X, ASSET_Y] })
    expect(store.getRecord(project, consumer.id).inputs[0]?.resolved_asset).toBe(ASSET_Y)
    expect(store.listRecords(project)[2]?.inputs[0]?.resolved_asset).toBe(ASSET_Y)
    const consumerLine = readLines(root, project).find(entry => entry.id === consumer.id)
    expect(consumerLine?.inputs).toEqual([{ role: 'source', ref: { record: producer.id, output: 1 }, resolved_asset: null }])
  })

  it('returns copies that callers cannot use to change the store', () => {
    const { store } = openStore()
    const { project, first } = createProject(store)
    const record = store.getRecord(project, first.id)
    record.params.title = 'changed'
    record.parents.push(first.id)
    const listed = store.listRecords(project)[0]
    if (listed !== undefined) listed.status = 'failed'
    expect(store.getRecord(project, first.id)).toEqual(first)
  })

  it('serializes work under the project lock', async () => {
    const { store } = openStore()
    const project = brandString<ProjectId>('project-1')
    const other = brandString<ProjectId>('project-2')
    const steps: string[] = []
    const work = (name: string, ms: number) => async () => {
      steps.push(`${name} start`)
      await delay(ms)
      steps.push(`${name} end`)
      return name
    }
    const failing = store.lock(project, async () => {
      await work('a', 30)()
      throw new Error('a failed')
    })
    const second = store.lock(project, work('b', 5))
    const concurrent = store.lock(other, work('c', 5))
    await expect(failing).rejects.toThrow('a failed')
    await expect(second).resolves.toBe('b')
    await expect(concurrent).resolves.toBe('c')
    expect(steps.indexOf('b start')).toBeGreaterThan(steps.indexOf('a end'))
    expect(steps.indexOf('c end')).toBeLessThan(steps.indexOf('a end'))
  })

  it('renames and deletes a project', () => {
    const { root, store } = openStore()
    const { project } = createProject(store, 'project-1', '2026-01-02T00:00:00.000Z')
    const older = createProject(store, 'project-0', '2026-01-01T00:00:00.000Z').project
    expect(store.listProjects().map(info => info.id)).toEqual([older, project])
    expect(errorCode(() => { store.createProject({ id: project, title: 'again', created_at: '2026-01-03T00:00:00.000Z' }) }))
      .toBe('invalid_params')

    expect(store.renameProject(project, 'Renamed').title).toBe('Renamed')
    expect(JSON.parse(readFileSync(join(root, project, 'project.json'), 'utf8'))).toMatchObject({ id: project, title: 'Renamed' })
    expect(store.getProject(project).title).toBe('Renamed')

    store.deleteProject(project)
    expect(existsSync(join(root, project))).toBe(false)
    expect(readdirSync(join(root, '.trash')).filter(name => name.startsWith(`${project}-`))).toHaveLength(1)
    expect(errorCode(() => store.getProject(project))).toBe('unknown_project')
    expect(openStore(root).store.listProjects().map(info => info.id)).toEqual([older])
  })

  it('emits record and update events after the write', () => {
    const { root, store, events } = openStore()
    const project = brandString<ProjectId>('project-1')
    store.createProject({ id: project, title: 'Events', created_at: new Date().toISOString() })
    expect(events).toEqual([])
    // Each event must find its change on disk when it arrives.
    const seen: string[] = []
    const checked = new RecordStore(root, (eventProject, event) => {
      const text = readFileSync(join(root, eventProject, 'records.jsonl'), 'utf8')
      if (event.kind === 'record') expect(text).toContain(event.record.id)
      if (event.kind === 'update') expect(text).toContain(`"update":"${event.record.id}","status":"${event.record.status}"`)
      seen.push(event.kind)
      events.push({ project: eventProject, event })
    })
    checked.load()
    const first = checked.append(project, line(null, { component: 'proj', operation: 'proj.create', status: 'done' }))
    const record = checked.append(project, line(first.id))
    const done = checked.update(project, { update: record.id, status: 'done', outputs: [ASSET_X] })

    expect(seen).toEqual(['record', 'record', 'update'])
    expect(events.map(entry => entry.event)).toEqual([
      { kind: 'record', record: first },
      { kind: 'record', record },
      { kind: 'update', record: done },
    ])
    expect(done.outputs).toEqual([ASSET_X])
  })
})
