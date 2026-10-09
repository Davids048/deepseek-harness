/**
 * Tests of the history module: the project's one line of records, undo written as `proj.undo` records at the end of
 * the line, one step per record, a write after an undo that continues from the earlier state, renders that finish
 * after an undo took back their approval, and the history list with its filters.
 * Writes append after the head under the project lock, as the runner does.
 */
import { describe, expect, it } from 'vitest'
import type { ProjectModules } from './support.ts'
import { agentOrigin, createTestProject, OTHER_SESSION, readLines, SESSION, startModules, userOrigin } from './support.ts'
import { ProjectError } from '../src/shared.ts'
import type { ProjectId, ProjectRecord, RecordId, RecordOrigin } from '../src/types.ts'

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
 * Append one `timeline.clip_insert` record after the head, under the lock.
 * @param m - the modules.
 * @param project - the project.
 * @param origin - who writes.
 * @param value - the record's `params.value`.
 * @returns the record.
 */
function write(m: ProjectModules, project: ProjectId, origin: RecordOrigin, value: number): Promise<ProjectRecord> {
  return m.store.lock(project, () => {
    const head = m.store.head(project)
    if (head === undefined) throw new Error(`project ${project} has no record`)
    return m.store.append(project, {
      parents: [head], kind: 'operation', component: 'timeline', operation: 'timeline.clip_insert', operation_version: '1',
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
 * Undo under the lock, as the service does.
 * @param m - the modules.
 * @param project - the project.
 * @param origin - who undoes.
 * @param to - the record to return to, or undefined for one step back.
 * @returns the written record.
 */
function undo(m: ProjectModules, project: ProjectId, origin: RecordOrigin, to?: RecordId): Promise<ProjectRecord> {
  return m.store.lock(project, () => m.history.undo(project, origin, to))
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
  it('writes an undo as a record at the end of the line, and repeated undos go further back', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const first = await write(m, project, DIRECT, 1)
    const second = await write(m, project, DIRECT, 2)
    const third = await write(m, project, DIRECT, 3)
    const back = await undo(m, project, DIRECT)
    expect(back).toMatchObject({ operation: 'proj.undo', component: 'proj', parents: [third.id], params: { to: second.id }, status: 'done' })
    expect(m.store.head(project)).toBe(back.id)
    expect(values(m, project)).toEqual(m.reducers.stateAt(project, second.id).components.history_test?.values)
    expect(values(m, project)).toEqual([1, 2])
    // The next undo goes back along the current state, past the undo record.
    const further = await undo(m, project, DIRECT)
    expect(further).toMatchObject({ parents: [back.id], params: { to: first.id } })
    expect(values(m, project)).toEqual([1])
    const lines = readLines(m.root, project).map(line => line.id)
    expect(lines.slice(1)).toEqual([first.id, second.id, third.id, back.id, further.id])
  })

  it('continues from the earlier state after an undo, without a fork, and keeps the undone steps in the history', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const first = await write(m, project, DIRECT, 1)
    const second = await write(m, project, DIRECT, 2)
    const back = await undo(m, project, DIRECT)
    const fifth = await write(m, project, agentOrigin(), 5)
    expect(fifth.parents).toEqual([back.id])
    expect(values(m, project)).toEqual([1, 5])
    expect(ids(m.history.list({ project })).slice(0, 4)).toEqual([fifth.id, back.id, second.id, first.id])
    // The undone step is still a target: going back to it brings its state back, and later steps follow it.
    const again = await undo(m, project, DIRECT, second.id)
    expect(again).toMatchObject({ parents: [fifth.id], params: { to: second.id } })
    expect(values(m, project)).toEqual([1, 2])
  })

  it('goes back to any finished record, an undo record and proj.create included, and refuses a target it cannot use', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const create = readLines(m.root, project)[0]!.id as RecordId
    const first = await write(m, project, DIRECT, 1)
    const second = await write(m, project, DIRECT, 2)
    const back = await undo(m, project, DIRECT, first.id)
    await write(m, project, DIRECT, 3)
    // An undo record stands for the state it returned to.
    await undo(m, project, DIRECT, back.id)
    expect(values(m, project)).toEqual([1])
    await expectCode(() => undo(m, project, DIRECT, first.id), 'nothing_to_undo')
    await expectCode(() => undo(m, project, DIRECT, back.id), 'nothing_to_undo')
    await undo(m, project, DIRECT, create)
    expect(values(m, project)).toEqual([])
    await expectCode(() => undo(m, project, DIRECT), 'nothing_to_undo')
    await undo(m, project, DIRECT, second.id)
    expect(values(m, project)).toEqual([1, 2])
    await expectCode(() => undo(m, project, DIRECT, 'missing' as RecordId), 'unknown_record')
    // An unfinished record has no state to return to yet.
    const pending = await m.store.lock(project, () => m.store.append(project, {
      parents: [m.store.head(project)!], kind: 'operation', component: 'timeline', operation: 'timeline.clip_insert', operation_version: '1',
      ...DIRECT, params: { value: 9 }, inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: false, status: 'pending',
    }))
    await expectCode(() => undo(m, project, DIRECT, pending.id), 'invalid_params')
  })

  it('refuses an undo when nothing can be undone', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    await expectCode(() => undo(m, project, DIRECT), 'nothing_to_undo')
    await write(m, project, DIRECT, 1)
    await undo(m, project, DIRECT)
    await expectCode(() => undo(m, project, DIRECT), 'nothing_to_undo')
    await write(m, project, DIRECT, 2)
    expect(values(m, project)).toEqual([2])
  })

  it('finishes a render whose approval an undo took back, keeps it out of the state, and reuses its take later', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    let renders = 0
    let release: () => void = () => undefined
    const held = new Promise<void>((done) => { release = done })
    m.runner.registerOperation({
      name: 'shot.render_ref2va', version: '1', component: 'shot', params: { shot: { type: 'integer' } }, confirm: 'never', inputs: {},
      outputs: [], description: 'A test render.', summarize: () => 'render', deterministic: true, resource: 'none',
      execute: async (context) => {
        renders += 1
        await held
        return { outputs: [context.importAsset(Buffer.from('take'), { mime: 'video/mp4', name: 'take.mp4' })] }
      },
    })
    const before = await write(m, project, DIRECT, 1)
    await write(m, project, DIRECT, 2)
    const run = { project, operation: 'shot.render_ref2va', params: { shot: 1 }, inputs: [], ...DIRECT }
    const rendering = m.runner.run(run)
    await expect.poll(() => m.store.listRecords(project).find(record => record.operation === 'shot.render_ref2va')?.status).toBe('running')
    const render = m.store.listRecords(project).find(record => record.operation === 'shot.render_ref2va')!
    await undo(m, project, DIRECT, before.id)
    release()
    const finished = await rendering
    expect(finished.record).toMatchObject({ id: render.id, status: 'done' })
    expect(finished.outputs).toHaveLength(1)
    expect(m.reducers.getState(project).components.proj.records.map(record => record.id)).not.toContain(render.id)
    // Going back to the render brings its take into the state.
    await undo(m, project, DIRECT, render.id)
    expect(m.reducers.getState(project).components.proj.records.map(record => record.id)).toContain(render.id)
    // A later identical render reuses the take.
    const again = await m.runner.run(run)
    expect(renders).toBe(1)
    expect(again.record).toMatchObject({ status: 'done', cost: { reused: true } })
    expect(again.outputs).toEqual(finished.outputs)
  })

  it('lists every record newest first, undo records included, with filters', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const human = await write(m, project, DIRECT, 1)
    const agentFirst = await write(m, project, agentOrigin('turn-1'), 2)
    const humanInSession = await write(m, project, userOrigin(), 3)
    const back = await undo(m, project, DIRECT)
    const agentSecond = await write(m, project, agentOrigin('turn-2'), 4)
    const other = await write(m, project, agentOrigin('turn-3', { session: OTHER_SESSION }), 5)
    const create = readLines(m.root, project)[0]!.id

    expect(ids(m.history.list({ project }))).toEqual([
      other.id, agentSecond.id, back.id, humanInSession.id, agentFirst.id, human.id, create,
    ])
    expect(ids(m.history.list({ project, actor: 'user' }))).toEqual([back.id, humanInSession.id, human.id, create])
    expect(ids(m.history.list({ project, operation: 'proj.undo' }))).toEqual([back.id])
    expect(ids(m.history.list({ project, session: OTHER_SESSION }))).toEqual([other.id])
    expect(ids(m.history.list({ project, actor: 'agent', session: SESSION }))).toEqual([agentSecond.id, agentFirst.id])
    expect(ids(m.history.list({ project, tool_call: 'call-turn-1' }))).toEqual([agentFirst.id])
    expect(ids(m.history.list({ project, records: [human.id, other.id] }))).toEqual([other.id, human.id])
    expect(ids(m.history.list({ project, before: humanInSession.id }))).toEqual([agentFirst.id, human.id, create])
    expect(ids(m.history.list({ project, actor: 'agent', limit: 2 }))).toEqual([other.id, agentSecond.id])
    await expectCode(() => m.history.list({ project, before: 'missing' as RecordId }), 'unknown_record')
  })
})
