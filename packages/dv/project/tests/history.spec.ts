/**
 * Tests of the history module: undo and redo written as `proj.undo` and `proj.redo` records, undo of an accepted
 * draft as one change unit, the history list with its filters, and the marks of each record.
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

/** A human edit outside any chat session; it always lands on `main`. */
const DIRECT = userOrigin({ session: null })

describe('history', () => {
  it('writes undo and redo as records', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const first = await write(m, project, DIRECT, 1)
    const second = await write(m, project, DIRECT, 2)
    const undo = await m.store.lock(project, () => m.history.undo(project, DIRECT))
    expect(undo).toMatchObject({
      operation: 'proj.undo', component: 'proj', branch: MAIN_BRANCH, parents: [second.id], params: { to: first.id }, status: 'done',
    })
    expect(m.store.getBranch(project, MAIN_BRANCH)?.head).toBe(undo.id)
    expect(mainValues(m, project)).toEqual(m.reducers.stateAt(project, MAIN_BRANCH, first.id).components.history_test?.values)
    expect(mainValues(m, project)).toEqual([1])
    const redo = await m.store.lock(project, () => m.history.redo(project, DIRECT))
    expect(redo).toMatchObject({ operation: 'proj.redo', parents: [undo.id], params: { to: second.id } })
    expect(mainValues(m, project)).toEqual([1, 2])
    const ids = readLines(m.root, project).map(line => line.id)
    expect(ids.slice(1)).toEqual([first.id, second.id, undo.id, redo.id])
  })

  it('undoes an accepted draft as one change', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const edit = await write(m, project, DIRECT, 1)
    await write(m, project, agentOrigin('turn-1'), 2)
    await write(m, project, agentOrigin('turn-2'), 3)
    const accept = await m.store.lock(project, () => m.drafts.accept(project, userOrigin()))
    expect(mainValues(m, project)).toEqual([1, 2, 3])
    const undo = await m.store.lock(project, () => m.history.undo(project, userOrigin()))
    expect(accept.params.base).toBe(edit.id)
    expect(undo.params.to).toBe(edit.id)
    expect(mainValues(m, project)).toEqual([1])
    // A second undo walks further back, past the human edit.
    const create = readLines(m.root, project)[0]!.id
    expect((await m.store.lock(project, () => m.history.undo(project, userOrigin()))).params.to).toBe(create)
    expect(mainValues(m, project)).toEqual([])
  })

  it('refuses undo with nothing to undo and redo with nothing to redo', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    await expectCode(() => m.history.undo(project, DIRECT), 'nothing_to_undo')
    await expectCode(() => m.history.redo(project, DIRECT), 'nothing_to_redo')
    await write(m, project, DIRECT, 1)
    await m.store.lock(project, () => m.history.undo(project, DIRECT))
    await expectCode(() => m.history.undo(project, DIRECT), 'nothing_to_undo')
    await write(m, project, DIRECT, 2)
    await expectCode(() => m.history.redo(project, DIRECT), 'nothing_to_redo')
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
    const undo = await m.store.lock(project, () => m.history.undo(project, DIRECT))
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
})
