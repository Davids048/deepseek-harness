/**
 * Tests of the history module: the history list and its current position, as in the History panel of an image editor.
 * Undo, redo and moves to a step move the position and write no record; a write after a move discards the steps that
 * were after the position, and the runner cancels a discarded step that has not finished; the history list shows the
 * steps of the list with their place. Plain writes append after the position under the project lock, as the runner does.
 */
import { describe, expect, it } from 'vitest'
import type { ProjectModules } from './support.ts'
import { agentOrigin, createTestProject, OTHER_SESSION, readLines, SESSION, startModules, userOrigin } from './support.ts'
import { discardedSteps } from '../src/history.ts'
import { ProjectError } from '../src/shared.ts'
import type { ProjectId, ProjectRecord, RecordId, RecordOrigin, RunRequest } from '../src/types.ts'

declare module '@dv/project' {
  interface ComponentStates {
    /** The slice of the test reducer: the `params.value` of every `timeline` record, in chain order. */
    history_test?: { values: number[] }
  }
}

/**
 * Build the modules with the test reducer that collects the `params.value` of `timeline` records.
 * @returns the modules.
 */
function startWithValues(): ProjectModules {
  const m = startModules()
  m.reducers.register('history_test', {
    initial: () => ({ values: [] }),
    reduce: (slice, record) => record.component === 'timeline' && typeof record.params.value === 'number'
      ? { values: [...slice?.values ?? [], record.params.value] }
      : slice,
  })
  return m
}

/**
 * Append one `timeline.clip_insert` record after the current position, under the lock.
 * @param m - the modules.
 * @param project - the project.
 * @param origin - who writes.
 * @param value - the record's `params.value`.
 * @returns the record.
 */
function write(m: ProjectModules, project: ProjectId, origin: RecordOrigin, value: number): Promise<ProjectRecord> {
  return m.store.lock(project, () => {
    const at = m.store.line(project)?.at
    if (at === undefined) throw new Error(`project ${project} has no record`)
    return m.store.append(project, {
      parents: [at], kind: 'operation', component: 'timeline', operation: 'timeline.clip_insert', operation_version: '1',
      ...origin, params: { value }, inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: false, status: 'done',
    })
  })
}

/**
 * @param m - the modules.
 * @param project - the project.
 * @returns the test reducer's values in the current state.
 */
function values(m: ProjectModules, project: ProjectId): number[] {
  return m.reducers.getState(project).components.history_test?.values ?? []
}

/**
 * Expect a call to throw a `ProjectError` with a code.
 * @param fn - the call.
 * @param code - the expected code.
 */
async function expectCode(fn: () => unknown, code: string): Promise<void> {
  const error: unknown = await Promise.resolve().then(fn).then(() => null, (thrown: unknown) => thrown)
  expect(error).toBeInstanceOf(ProjectError)
  expect((error as ProjectError).code).toBe(code)
}

/**
 * @param entries - history entries.
 * @returns their record IDs.
 */
function ids(entries: Array<{ record: ProjectRecord }>): RecordId[] {
  return entries.map(entry => entry.record.id)
}

/** A human edit outside any chat session. */
const DIRECT = userOrigin({ session: null })

describe('history', () => {
  it('moves the current position on undo and redo without writing a record, and the state follows it', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const create = readLines(m.root, project)[0]!.id as RecordId
    const first = await write(m, project, DIRECT, 1)
    const second = await write(m, project, DIRECT, 2)
    const lines = readLines(m.root, project).length
    expect(await m.store.lock(project, () => m.history.undo(project))).toEqual({ tip: second.id, at: first.id })
    expect(values(m, project)).toEqual([1])
    expect(m.reducers.getState(project).head).toBe(first.id)
    await m.store.lock(project, () => m.history.undo(project))
    expect(values(m, project)).toEqual([])
    await expectCode(() => m.store.lock(project, () => m.history.undo(project)), 'nothing_to_undo')
    expect(m.store.line(project)).toEqual({ tip: second.id, at: create })
    expect(await m.store.lock(project, () => m.history.redo(project))).toEqual({ tip: second.id, at: first.id })
    await m.store.lock(project, () => m.history.redo(project))
    expect(values(m, project)).toEqual([1, 2])
    await expectCode(() => m.store.lock(project, () => m.history.redo(project)), 'nothing_to_redo')
    // Moves write no record; each one emits a `line` event.
    expect(readLines(m.root, project)).toHaveLength(lines)
    expect(m.events.filter(entry => entry.event.kind === 'line').at(-1)?.event).toEqual({ kind: 'line', tip: second.id, at: second.id })
  })

  it('moves to a step before or after the current position, and a move to the current position changes nothing', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const first = await write(m, project, DIRECT, 1)
    const second = await write(m, project, DIRECT, 2)
    const third = await write(m, project, DIRECT, 3)
    await m.store.lock(project, () => m.history.moveTo(project, first.id))
    expect(values(m, project)).toEqual([1])
    await m.store.lock(project, () => m.history.moveTo(project, third.id))
    expect(values(m, project)).toEqual([1, 2, 3])
    const events = m.events.length
    expect(await m.store.lock(project, () => m.history.moveTo(project, third.id))).toEqual({ tip: third.id, at: third.id })
    expect(m.events).toHaveLength(events)
    await m.store.lock(project, () => m.history.moveTo(project, second.id))
    expect(m.history.list({ project }).map(entry => [entry.record.id, entry.place]).slice(0, 3))
      .toEqual([[third.id, 'after'], [second.id, 'current'], [first.id, 'before']])
    await expectCode(() => m.store.lock(project, () => m.history.moveTo(project, 'missing' as RecordId)), 'unknown_record')
  })

  it('discards the steps after the current position on a write: they leave the list and stay on disk', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const first = await write(m, project, DIRECT, 1)
    const second = await write(m, project, DIRECT, 2)
    const third = await write(m, project, DIRECT, 3)
    await m.store.lock(project, () => m.history.moveTo(project, first.id))
    expect(discardedSteps(m.store, project).map(record => record.id)).toEqual([second.id, third.id])
    const fifth = await write(m, project, agentOrigin(), 5)
    expect(fifth.parents).toEqual([first.id])
    expect(m.store.line(project)).toEqual({ tip: fifth.id, at: fifth.id })
    expect(values(m, project)).toEqual([1, 5])
    expect(ids(m.history.list({ project })).slice(0, 2)).toEqual([fifth.id, first.id])
    expect(ids(m.history.list({ project }))).not.toContain(second.id)
    // A discarded step cannot come back: redo has nothing to bring back, and a move to it is refused.
    await expectCode(() => m.store.lock(project, () => m.history.redo(project)), 'nothing_to_redo')
    await expectCode(() => m.store.lock(project, () => m.history.moveTo(project, second.id)), 'invalid_params')
    expect(m.store.listRecords(project).map(record => record.id)).toEqual(expect.arrayContaining([second.id, third.id]))
  })

  it('cancels a discarded running step and a discarded queued step, and leaves the new step running', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    let started = 0
    // A slow render that ends only when it is aborted.
    m.runner.registerOperation({
      name: 'shot.render_ref2va', version: '1', component: 'shot', params: { shot: { type: 'integer' } }, confirm: 'never', inputs: {},
      outputs: [], description: 'A test render.', summarize: () => 'render', deterministic: false, resource: 'none',
      execute: async (context) => {
        started += 1
        await new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })
        return { outputs: [] }
      },
    })
    m.runner.registerOperation({
      name: 'timeline.rename', version: '1', component: 'timeline', params: { value: { type: 'integer' } }, confirm: 'never', inputs: {},
      outputs: [], description: 'A test edit.', summarize: () => 'edit', deterministic: false, resource: 'none',
      execute: () => Promise.resolve({ outputs: [] }),
    })
    const before = await write(m, project, DIRECT, 1)
    const render: RunRequest = { project, operation: 'shot.render_ref2va', params: { shot: 1 }, inputs: [], ...DIRECT }
    const rendering = m.runner.run(render)
    await expect.poll(() => m.store.listRecords(project).find(record => record.operation === 'shot.render_ref2va')?.status).toBe('running')
    const running = m.store.listRecords(project).find(record => record.operation === 'shot.render_ref2va')!
    const queued = await m.runner.run({ ...render, params: { shot: 2 }, after: [running.id] })
    expect(queued.record?.status).toBe('pending')
    await m.store.lock(project, () => m.history.moveTo(project, before.id))
    // A move alone cancels nothing.
    expect(m.store.getRecord(project, running.id).status).toBe('running')
    const edit = await m.runner.run({ project, operation: 'timeline.rename', params: { value: 2 }, inputs: [], ...DIRECT })
    expect(edit.record).toMatchObject({ status: 'done', parents: [before.id] })
    const ended = await rendering
    expect(ended.record).toMatchObject({ id: running.id, status: 'cancelled', error: { code: 'discarded' } })
    expect(m.store.getRecord(project, queued.record!.id)).toMatchObject({ status: 'cancelled', error: { code: 'discarded' } })
    await m.scheduler.wait(project)
    expect(started).toBe(1)
  })

  it('lists the steps of the list newest first with their place, and filters them', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const human = await write(m, project, DIRECT, 1)
    const agentFirst = await write(m, project, agentOrigin('turn-1'), 2)
    const humanInSession = await write(m, project, userOrigin(), 3)
    const agentSecond = await write(m, project, agentOrigin('turn-2'), 4)
    const other = await write(m, project, agentOrigin('turn-3', { session: OTHER_SESSION }), 5)
    const create = readLines(m.root, project)[0]!.id
    await m.store.lock(project, () => m.history.moveTo(project, humanInSession.id))

    expect(m.history.list({ project }).map(entry => [entry.record.id, entry.place])).toEqual([
      [other.id, 'after'], [agentSecond.id, 'after'], [humanInSession.id, 'current'], [agentFirst.id, 'before'],
      [human.id, 'before'], [create, 'before'],
    ])
    expect(ids(m.history.list({ project, actor: 'user' }))).toEqual([humanInSession.id, human.id, create])
    expect(ids(m.history.list({ project, session: OTHER_SESSION }))).toEqual([other.id])
    expect(ids(m.history.list({ project, actor: 'agent', session: SESSION }))).toEqual([agentSecond.id, agentFirst.id])
    expect(ids(m.history.list({ project, tool_call: 'call-turn-1' }))).toEqual([agentFirst.id])
    expect(ids(m.history.list({ project, records: [human.id, other.id] }))).toEqual([other.id, human.id])
    expect(ids(m.history.list({ project, before: humanInSession.id }))).toEqual([agentFirst.id, human.id, create])
    expect(ids(m.history.list({ project, actor: 'agent', limit: 2 }))).toEqual([other.id, agentSecond.id])
    await expectCode(() => m.history.list({ project, before: 'missing' as RecordId }), 'unknown_record')
  })
})
