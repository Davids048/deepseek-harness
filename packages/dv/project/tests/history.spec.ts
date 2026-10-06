/**
 * Tests of the history module: undo, redo and jumps written as `proj.undo` and `proj.redo` records on the working
 * branch (`main` or a draft), one step per record, redo steps, renders that finish after their approval was undone,
 * the history list with its filters, and the marks of each record.
 * Writes go through `drafts.branchForWrite` under the project lock, as the runner does.
 */
import { describe, expect, it } from 'vitest'
import type { ProjectModules } from './support.ts'
import { agentOrigin, createTestProject, OTHER_SESSION, readLines, SESSION, startModules, userOrigin } from './support.ts'
import { draftBranch, MAIN_BRANCH, ProjectError } from '../src/shared.ts'
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
 * Append one `timeline.clip_insert` record on the branch that `branchForWrite` picks for the origin, under the lock.
 * @param m - the modules.
 * @param project - the project.
 * @param origin - who writes.
 * @param value - the record's `params.value`.
 * @returns the record.
 */
function write(m: ProjectModules, project: ProjectId, origin: RecordOrigin, value: number): Promise<ProjectRecord> {
  return m.store.lock(project, () => {
    const branch = m.drafts.branchForWrite(project, origin)
    const head = m.store.getBranch(project, branch)?.head
    if (head === undefined) throw new Error(`no branch ${branch}`)
    return m.store.append(project, {
      parents: [head], branch, kind: 'operation', component: 'timeline', operation: 'timeline.clip_insert', operation_version: '1',
      ...origin, params: { value }, inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: false, status: 'done',
    })
  })
}

/**
 * @param m - the modules.
 * @param project - the project.
 * @returns the test reducer's values on `main`.
 */
function mainValues(m: ProjectModules, project: ProjectId): number[] {
  return m.reducers.getState(project, MAIN_BRANCH).components.history_test?.values ?? []
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
 * Undo or jump on the working branch of the origin's session, under the lock, as the service does.
 * @param m - the modules.
 * @param project - the project.
 * @param origin - who undoes; `session` selects the working branch.
 * @param to - the record to return to, or undefined for one step back.
 * @returns the written record.
 */
function undoOn(m: ProjectModules, project: ProjectId, origin: RecordOrigin, to?: RecordId): Promise<ProjectRecord> {
  return m.store.lock(project, () => m.history.undo(project, m.drafts.workingBranch(project, origin.session).name, origin, to))
}

/**
 * Redo one step on the working branch of the origin's session, under the lock.
 * @param m - the modules.
 * @param project - the project.
 * @param origin - who redoes; `session` selects the working branch.
 * @returns the `proj.redo` record.
 */
function redoOn(m: ProjectModules, project: ProjectId, origin: RecordOrigin): Promise<ProjectRecord> {
  return m.store.lock(project, () => m.history.redo(project, m.drafts.workingBranch(project, origin.session).name, origin))
}

/**
 * @param m - the modules.
 * @param project - the project.
 * @param branch - a branch name.
 * @returns the test reducer's values on the branch.
 */
function valuesOn(m: ProjectModules, project: ProjectId, branch: string): number[] {
  return m.reducers.getState(project, branch).components.history_test?.values ?? []
}

/** A human edit outside any chat session; it always lands on `main`. */
const DIRECT = userOrigin({ session: null })

describe('history', () => {
  it('writes undo and redo as records', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const first = await write(m, project, DIRECT, 1)
    const second = await write(m, project, DIRECT, 2)
    const undo = await undoOn(m, project, DIRECT)
    expect(undo).toMatchObject({
      operation: 'proj.undo', component: 'proj', branch: MAIN_BRANCH, parents: [second.id], params: { to: first.id }, status: 'done',
    })
    expect(m.store.getBranch(project, MAIN_BRANCH)?.head).toBe(undo.id)
    expect(mainValues(m, project)).toEqual(m.reducers.stateAt(project, MAIN_BRANCH, first.id).components.history_test?.values)
    expect(mainValues(m, project)).toEqual([1])
    const redo = await redoOn(m, project, DIRECT)
    expect(redo).toMatchObject({ operation: 'proj.redo', parents: [undo.id], params: { to: second.id } })
    expect(mainValues(m, project)).toEqual([1, 2])
    const ids = readLines(m.root, project).map(line => line.id)
    expect(ids.slice(1)).toEqual([first.id, second.id, undo.id, redo.id])
  })

  it('undoes the records of an accepted draft one step at a time', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const edit = await write(m, project, DIRECT, 1)
    const agentFirst = await write(m, project, agentOrigin('turn-1'), 2)
    await write(m, project, agentOrigin('turn-2'), 3)
    await m.store.lock(project, () => m.drafts.accept(project, userOrigin()))
    expect(mainValues(m, project)).toEqual([1, 2, 3])
    expect((await undoOn(m, project, userOrigin())).params.to).toBe(agentFirst.id)
    expect(mainValues(m, project)).toEqual([1, 2])
    expect((await undoOn(m, project, userOrigin())).params.to).toBe(edit.id)
    expect(mainValues(m, project)).toEqual([1])
    const create = readLines(m.root, project)[0]!.id
    expect((await undoOn(m, project, userOrigin())).params.to).toBe(create)
    expect(mainValues(m, project)).toEqual([])
    await expectCode(() => undoOn(m, project, userOrigin()), 'nothing_to_undo')
  })

  it('jumps back to any step, redoes one step at a time, and jumps forward to a redo step', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const records = []
    for (const value of [1, 2, 3, 4]) records.push(await write(m, project, DIRECT, value))
    const [first, second, third, fourth] = records.map(record => record.id)
    const jump = await undoOn(m, project, DIRECT, first)
    expect(jump).toMatchObject({ operation: 'proj.undo', params: { to: first } })
    expect(mainValues(m, project)).toEqual([1])
    expect(m.history.redoSteps(project, MAIN_BRANCH)).toEqual([second, third, fourth])
    expect((await redoOn(m, project, DIRECT)).params.to).toBe(second)
    expect(mainValues(m, project)).toEqual([1, 2])
    expect(m.history.redoSteps(project, MAIN_BRANCH)).toEqual([third, fourth])
    const forward = await undoOn(m, project, DIRECT, fourth)
    expect(forward).toMatchObject({ operation: 'proj.redo', params: { to: fourth } })
    expect(mainValues(m, project)).toEqual([1, 2, 3, 4])
    expect(m.history.redoSteps(project, MAIN_BRANCH)).toEqual([])
    await expectCode(() => undoOn(m, project, DIRECT, fourth), 'nothing_to_undo')
    await expectCode(() => undoOn(m, project, DIRECT, 'missing' as RecordId), 'unknown_record')
  })

  it('drops the redo steps on any other write after an undo', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const first = await write(m, project, DIRECT, 1)
    const second = await write(m, project, DIRECT, 2)
    await undoOn(m, project, DIRECT, first.id)
    expect(m.history.redoSteps(project, MAIN_BRANCH)).toEqual([second.id])
    await write(m, project, DIRECT, 5)
    expect(m.history.redoSteps(project, MAIN_BRANCH)).toEqual([])
    await expectCode(() => redoOn(m, project, DIRECT), 'nothing_to_redo')
    await expectCode(() => undoOn(m, project, DIRECT, second.id), 'invalid_params')
    expect(mainValues(m, project)).toEqual([1, 5])
    expect(m.history.list({ project, records: [second.id] })[0]?.mark).toBe('undone')
  })

  it('undoes and redoes inside a draft, and accepts the draft as undone', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const edit = await write(m, project, DIRECT, 1)
    const kept = await write(m, project, agentOrigin('turn-1'), 2)
    const undone = await write(m, project, agentOrigin('turn-1'), 3)
    const draft = draftBranch(SESSION)
    const undo = await undoOn(m, project, agentOrigin('turn-2'))
    expect(undo).toMatchObject({ branch: draft, params: { to: kept.id } })
    expect(m.store.getBranch(project, MAIN_BRANCH)?.head).toBe(edit.id)
    expect(valuesOn(m, project, draft)).toEqual([1, 2])
    expect(m.drafts.workingBranch(project, SESSION).counts).toEqual({ agent_changes: 1, human_edits: 0 })
    expect(m.history.redoSteps(project, draft)).toEqual([undone.id])
    const mark = (id: RecordId): string | undefined => m.history.list({ project, records: [id] })[0]?.mark
    expect([mark(kept.id), mark(undone.id), mark(undo.id)]).toEqual(['draft', 'undone', 'draft'])
    await redoOn(m, project, agentOrigin('turn-2'))
    expect(valuesOn(m, project, draft)).toEqual([1, 2, 3])
    await undoOn(m, project, agentOrigin('turn-3'), kept.id)
    // Main moved, so accept replays only the draft's steps on the effective chain.
    await write(m, project, DIRECT, 9)
    const accept = await m.store.lock(project, () => m.drafts.accept(project, userOrigin()))
    expect((accept.params.replayed as RecordId[][]).map(pair => pair[0])).toEqual([kept.id])
    expect(mainValues(m, project)).toEqual([1, 9, 2])
    // One undo on main removes one replayed step.
    await undoOn(m, project, DIRECT)
    expect(mainValues(m, project)).toEqual([1, 9])
  })

  it('refuses to replay a draft that jumped back to a step before it opened', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const create = m.history.list({ project, operation: 'proj.create' })[0]!.record.id
    await write(m, project, DIRECT, 1)
    await write(m, project, agentOrigin('turn-1'), 2)
    await undoOn(m, project, agentOrigin('turn-2'), create)
    expect(valuesOn(m, project, draftBranch(SESSION))).toEqual([])
    await write(m, project, DIRECT, 3)
    await expectCode(() => m.store.lock(project, () => m.drafts.accept(project, userOrigin())), 'draft_conflict')
  })

  it('finishes a render whose approval a jump undid into an undone record, and reuses its take later', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    let renders = 0
    let release: () => void = () => undefined
    const held = new Promise<void>((done) => { release = done })
    m.runner.registerOperation({
      name: 'shot.render', version: '1', component: 'shot', params: { shot: { type: 'integer' } }, confirm: 'never', inputs: {},
      outputs: [], description: 'A test render.', summarize: () => 'render', deterministic: true, resource: 'none',
      execute: async (context) => {
        renders += 1
        await held
        return { outputs: [context.importAsset(Buffer.from('take'), { mime: 'video/mp4', name: 'take.mp4' })] }
      },
    })
    const before = await write(m, project, DIRECT, 1)
    const approval = await write(m, project, DIRECT, 2)
    const run = { project, operation: 'shot.render', params: { shot: 1 }, inputs: [], ...DIRECT }
    const rendering = m.runner.run(run)
    await expect.poll(() => m.store.listRecords(project).find(record => record.operation === 'shot.render')?.status).toBe('running')
    const render = m.store.listRecords(project).find(record => record.operation === 'shot.render')!
    await undoOn(m, project, DIRECT, before.id)
    expect(m.history.redoSteps(project, MAIN_BRANCH)).toEqual([approval.id, render.id])
    release()
    const finished = await rendering
    expect(finished.record).toMatchObject({ id: render.id, status: 'done' })
    expect(finished.outputs).toHaveLength(1)
    expect(m.history.list({ project, records: [render.id] })[0]?.mark).toBe('undone')
    expect(m.reducers.getState(project, MAIN_BRANCH).components.proj.records.map(record => record.id)).not.toContain(render.id)
    // A later identical render reuses the take of the undone record.
    const again = await m.runner.run(run)
    expect(renders).toBe(1)
    expect(again.record).toMatchObject({ status: 'done', cost: { reused: true } })
    expect(again.outputs).toEqual(finished.outputs)
  })

  it('refuses undo with nothing to undo and redo with nothing to redo', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    await expectCode(() => undoOn(m, project, DIRECT), 'nothing_to_undo')
    await expectCode(() => redoOn(m, project, DIRECT), 'nothing_to_redo')
    await write(m, project, DIRECT, 1)
    await undoOn(m, project, DIRECT)
    await expectCode(() => undoOn(m, project, DIRECT), 'nothing_to_undo')
    await write(m, project, DIRECT, 2)
    await expectCode(() => redoOn(m, project, DIRECT), 'nothing_to_redo')
    expect(mainValues(m, project)).toEqual([2])
  })

  it('lists history newest first with filters', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const human = await write(m, project, DIRECT, 1)
    const agentFirst = await write(m, project, agentOrigin('turn-1'), 2)
    const humanOnDraft = await write(m, project, userOrigin(), 3)
    const agentSecond = await write(m, project, agentOrigin('turn-2'), 4)
    const other = await write(m, project, agentOrigin('turn-3', { session: OTHER_SESSION }), 5)
    const create = readLines(m.root, project)[0]!.id
    const ids = (entries: Array<{ record: ProjectRecord }>): RecordId[] => entries.map(entry => entry.record.id)

    expect(ids(m.history.list({ project }))).toEqual([other.id, agentSecond.id, humanOnDraft.id, agentFirst.id, human.id, create])
    expect(ids(m.history.list({ project, actor: 'user' }))).toEqual([humanOnDraft.id, human.id, create])
    expect(ids(m.history.list({ project, branch: draftBranch(SESSION) }))).toEqual([agentSecond.id, humanOnDraft.id, agentFirst.id])
    expect(ids(m.history.list({ project, operation: 'proj.create' }))).toEqual([create])
    expect(ids(m.history.list({ project, session: OTHER_SESSION }))).toEqual([other.id])
    expect(ids(m.history.list({ project, actor: 'agent', session: SESSION }))).toEqual([agentSecond.id, agentFirst.id])
    expect(ids(m.history.list({ project, before: humanOnDraft.id }))).toEqual([agentFirst.id, human.id, create])
    expect(ids(m.history.list({ project, actor: 'agent', limit: 2 }))).toEqual([other.id, agentSecond.id])
    await expectCode(() => m.history.list({ project, before: 'missing' as RecordId }), 'unknown_record')
  })

  it('marks main, draft, undone, discarded and replayed records', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const kept = await write(m, project, DIRECT, 1)
    const undone = await write(m, project, DIRECT, 2)
    const undo = await undoOn(m, project, DIRECT)
    const original = await write(m, project, agentOrigin('turn-1'), 3)
    const otherOrigin = agentOrigin('turn-2', { session: OTHER_SESSION })
    const dropped = await write(m, project, otherOrigin, 4)
    await m.store.lock(project, () => m.drafts.discard(project, otherOrigin, { agent_changes: 1, human_edits: 0 }))
    const discard = m.store.getBranch(project, draftBranch(OTHER_SESSION))
    expect(discard).toBeUndefined()
    // Main moves after the draft of SESSION opened, so accept replays the draft's record as a copy.
    const moved = await write(m, project, DIRECT, 5)
    const accept = await m.store.lock(project, () => m.drafts.accept(project, userOrigin()))
    const copy = (accept.params.replayed as RecordId[][])[0]![1]!
    // The next agent write of the session opens a draft with the same name.
    const drafted = await write(m, project, agentOrigin('turn-3'), 6)
    const explored = await m.store.lock(project, () => m.drafts.createBranch(project, 'explore/look', MAIN_BRANCH, DIRECT))

    const mark = new Map(m.history.list({ project }).map(entry => [entry.record.id, entry.mark]))
    const discardRecord = m.history.list({ project, operation: 'proj.draft_discard' })[0]!.record.id
    expect(Object.fromEntries([
      ['kept', kept.id], ['undo', undo.id], ['moved', moved.id], ['copy', copy], ['accept', accept.id], ['undone', undone.id],
      ['original', original.id], ['dropped', dropped.id], ['discard', discardRecord], ['drafted', drafted.id], ['explored', explored.head],
    ].map(([name, id]) => [name, mark.get(id as RecordId)]))).toEqual({
      kept: 'main', undo: 'main', moved: 'main', copy: 'main', accept: 'main', undone: 'undone', original: 'replayed',
      dropped: 'discarded', discard: 'discarded', drafted: 'draft', explored: 'branch',
    })
    expect(mainValues(m, project)).toEqual([1, 5, 3])
  })

  it('filters by tool call, and by mark before the limit', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const kept = await write(m, project, DIRECT, 1)
    const undone = await write(m, project, DIRECT, 2)
    const undo = await undoOn(m, project, DIRECT)
    const agentFirst = await write(m, project, agentOrigin('turn-1'), 3)
    const agentSecond = await write(m, project, agentOrigin('turn-2'), 4)
    const create = readLines(m.root, project)[0]!.id
    const ids = (entries: Array<{ record: ProjectRecord }>): RecordId[] => entries.map(entry => entry.record.id)

    expect(ids(m.history.list({ project, tool_call: 'call-turn-1' }))).toEqual([agentFirst.id])
    expect(ids(m.history.list({ project, marks: ['main', 'undone'] }))).toEqual([undo.id, undone.id, kept.id, create])
    expect(ids(m.history.list({ project, marks: ['draft'] }))).toEqual([agentSecond.id, agentFirst.id])
    // The mark filter applies first, so the limit counts only the matching entries.
    expect(ids(m.history.list({ project, marks: ['undone'], limit: 1 }))).toEqual([undone.id])
    expect(m.history.list({ project, marks: [] })).toEqual([])
  })
})
