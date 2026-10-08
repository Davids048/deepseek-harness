/**
 * Tests of the branches module: every write of every actor lands on the project's current branch, a write after an
 * undo forks a new branch and keeps the undone steps on the old one, an explicit fork, switching with and without a
 * step to return to, and renaming.
 * Writes go through `branches.forWrite` under the project lock, as the runner does.
 */
import { describe, expect, it } from 'vitest'
import type { ProjectModules } from './support.ts'
import { agentOrigin, createTestProject, OTHER_SESSION, startModules, userOrigin } from './support.ts'
import { MAIN_BRANCH, ProjectError } from '../src/shared.ts'
import type { ProjectId, ProjectRecord, RecordId, RecordOrigin } from '../src/types.ts'

declare module '@dv/project' {
  interface ComponentStates {
    /** The slice of the test reducer: the `params.value` of every `timeline` record, in chain order. */
    branches_test?: { values: number[] }
  }
}

/**
 * Build the modules with the test reducer that collects the `params.value` of `timeline` records.
 * @returns the modules.
 */
function startWithValues(): ProjectModules {
  const m = startModules()
  m.reducers.register('branches_test', {
    initial: () => ({ values: [] }),
    reduce: (slice, record) => record.component === 'timeline' && typeof record.params.value === 'number'
      ? { values: [...slice?.values ?? [], record.params.value] }
      : slice,
  })
  return m
}

/**
 * Append one `timeline.clip_insert` record on the branch that `forWrite` picks, under the lock.
 * @param m - the modules.
 * @param project - the project.
 * @param origin - who writes.
 * @param value - the record's `params.value`.
 * @returns the record.
 */
function write(m: ProjectModules, project: ProjectId, origin: RecordOrigin, value: number): Promise<ProjectRecord> {
  return m.store.lock(project, () => {
    const branch = m.branches.forWrite(project)
    const head = m.store.getBranch(project, branch)?.head
    if (head === undefined) throw new Error(`no branch ${branch}`)
    return m.store.append(project, {
      parents: [head], branch, kind: 'operation', component: 'timeline', operation: 'timeline.clip_insert', operation_version: '1',
      ...origin, params: { value }, inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: false, status: 'done',
    })
  })
}

/**
 * Jump the current branch back to a record, under the lock.
 * @param m - the modules.
 * @param project - the project.
 * @param to - the record to return to.
 * @returns the `proj.undo` record.
 */
function undoTo(m: ProjectModules, project: ProjectId, to: RecordId): Promise<ProjectRecord> {
  return m.store.lock(project, () => m.history.undo(project, m.branches.current(project).name, userOrigin(), to))
}

/**
 * @param m - the modules.
 * @param project - the project.
 * @param branch - a branch name; defaults to the current branch.
 * @returns the test reducer's values on the branch.
 */
function values(m: ProjectModules, project: ProjectId, branch = m.branches.current(project).name): number[] {
  return m.reducers.getState(project, branch).components.branches_test?.values ?? []
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

describe('branches', () => {
  it('puts every write of every actor and chat session on the current branch at once', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const agent = await write(m, project, agentOrigin(), 1)
    const human = await write(m, project, userOrigin(), 2)
    const other = await write(m, project, agentOrigin('turn-2', { session: OTHER_SESSION }), 3)
    const direct = await write(m, project, userOrigin({ session: null }), 4)
    expect([agent, human, other, direct].map(record => record.branch)).toEqual([MAIN_BRANCH, MAIN_BRANCH, MAIN_BRANCH, MAIN_BRANCH])
    expect(m.branches.list(project).map(branch => branch.name)).toEqual([MAIN_BRANCH])
    expect(m.branches.current(project)).toMatchObject({ name: MAIN_BRANCH, title: null, head: direct.id, tip: direct.id })
    expect(values(m, project)).toEqual([1, 2, 3, 4])
  })

  it('forks a new branch for a write after an undo and keeps the undone steps on the old branch', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const first = await write(m, project, userOrigin(), 1)
    await write(m, project, userOrigin(), 2)
    const third = await write(m, project, userOrigin(), 3)
    await undoTo(m, project, first.id)
    expect(m.branches.current(project)).toMatchObject({ name: MAIN_BRANCH, tip: third.id })
    expect(m.branches.list(project)).toHaveLength(1)

    const fifth = await write(m, project, agentOrigin(), 5)
    expect(fifth).toMatchObject({ branch: 'b2', parents: [first.id] })
    expect(m.branches.current(project)).toMatchObject({ name: 'b2', title: null, base: MAIN_BRANCH, forked_at: first.id, head: fifth.id })
    expect(m.store.getBranch(project, MAIN_BRANCH)?.head).toBe(third.id)
    expect(values(m, project, MAIN_BRANCH)).toEqual([1, 2, 3])
    expect(values(m, project, 'b2')).toEqual([1, 5])
    // The next write continues on b2 without another fork.
    const sixth = await write(m, project, userOrigin(), 6)
    expect(sixth.branch).toBe('b2')
    expect(m.branches.list(project).map(branch => branch.name)).toEqual([MAIN_BRANCH, 'b2'])
  })

  it('does not fork after a redo that returned the branch to its tip', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const first = await write(m, project, userOrigin(), 1)
    await write(m, project, userOrigin(), 2)
    await undoTo(m, project, first.id)
    await m.store.lock(project, () => m.history.redo(project, MAIN_BRANCH, userOrigin()))
    const third = await write(m, project, userOrigin(), 3)
    expect(third.branch).toBe(MAIN_BRANCH)
    expect(values(m, project)).toEqual([1, 2, 3])
  })

  it('forks a named branch on request at the current position without writing a record', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const first = await write(m, project, userOrigin(), 1)
    const second = await write(m, project, userOrigin(), 2)
    const records = m.store.listRecords(project).length
    const created = await m.store.lock(project, () => m.branches.create(project, 'darker'))
    expect(created).toMatchObject({ name: 'b2', title: 'darker', head: second.id, tip: second.id, base: MAIN_BRANCH, forked_at: second.id })
    expect(m.branches.current(project).name).toBe('b2')
    expect(m.store.listRecords(project)).toHaveLength(records)
    // A second fork from main after an undo starts at main's position and numbers the branch b3.
    await m.store.lock(project, () => m.branches.switch(project, MAIN_BRANCH, userOrigin()))
    await undoTo(m, project, first.id)
    const third = await m.store.lock(project, () => m.branches.create(project, null))
    expect(third).toMatchObject({ name: 'b3', head: first.id, forked_at: first.id })
    expect(m.store.getBranch(project, MAIN_BRANCH)?.head).toBe(second.id)
    expect(values(m, project)).toEqual([1])
  })

  it('switches branches, and returns a branch to a step when asked', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    const first = await write(m, project, userOrigin(), 1)
    const second = await write(m, project, userOrigin(), 2)
    await m.store.lock(project, () => m.branches.create(project, null))
    await write(m, project, userOrigin(), 3)
    const switched = await m.store.lock(project, () => m.branches.switch(project, MAIN_BRANCH, userOrigin()))
    expect(switched).toMatchObject({ name: MAIN_BRANCH, head: second.id })
    expect(values(m, project)).toEqual([1, 2])
    // Switching to the step the branch already stands at writes no jump record.
    const records = m.store.listRecords(project).length
    await m.store.lock(project, () => m.branches.switch(project, MAIN_BRANCH, userOrigin(), second.id))
    expect(m.store.listRecords(project)).toHaveLength(records)
    const back = await m.store.lock(project, () => m.branches.switch(project, 'b2', userOrigin(), first.id))
    expect(back).toMatchObject({ name: 'b2' })
    expect(m.store.getRecord(project, back.head)).toMatchObject({ operation: 'proj.undo', branch: 'b2', params: { to: first.id } })
    expect(values(m, project)).toEqual([1])
    await expectCode(() => m.store.lock(project, () => m.branches.switch(project, 'b9', userOrigin())), 'unknown_branch')
    // A refused step leaves the current branch where it was.
    await m.store.lock(project, () => m.branches.switch(project, MAIN_BRANCH, userOrigin()))
    await expectCode(() => m.store.lock(project, () => m.branches.switch(project, 'b2', userOrigin(), 'missing' as RecordId)), 'unknown_record')
    expect(m.branches.current(project).name).toBe(MAIN_BRANCH)
  })

  it('lists forked branches in fork order', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    await write(m, project, userOrigin(), 1)
    for (let n = 0; n < 9; n += 1) await m.store.lock(project, () => m.branches.create(project, null))
    expect(m.branches.list(project).map(branch => branch.name)).toEqual([MAIN_BRANCH, 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10'])
  })

  it('renames a branch and returns to the default label for an empty title', async () => {
    const m = startWithValues()
    const project = await createTestProject(m)
    await write(m, project, userOrigin(), 1)
    await m.store.lock(project, () => m.branches.create(project, null))
    expect((await m.store.lock(project, () => m.branches.rename(project, 'b2', '  night  '))).title).toBe('night')
    expect((await m.store.lock(project, () => m.branches.rename(project, MAIN_BRANCH, 'day'))).title).toBe('day')
    expect((await m.store.lock(project, () => m.branches.rename(project, 'b2', ' '))).title).toBeNull()
    await expectCode(() => m.store.lock(project, () => m.branches.rename(project, 'b9', 'x')), 'unknown_branch')
  })

})
