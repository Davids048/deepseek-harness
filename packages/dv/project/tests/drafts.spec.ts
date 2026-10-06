/**
 * Tests of the drafts module: the working branch of a chat session, drafts that span turns, human edits on the
 * working branch, accept by fast-forward and by replay, conflicts, discard with counts, and exploration branches.
 * Writes go through `drafts.branchForWrite` under the project lock, as the runner does.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProjectModules } from './support.ts'
import { agentOrigin, createTestProject, OTHER_SESSION, readLines, SESSION, startModules, userOrigin } from './support.ts'
import { DraftConflictError, draftBranch, MAIN_BRANCH, ProjectError } from '../src/shared.ts'
import type { ProjectId, ProjectRecord, RecordId, RecordOrigin, RecordStatus } from '../src/types.ts'

declare module '../src/types.ts' {
  interface ComponentStates {
    /** The slice of the test reducer that reports conflicts during accept replay. */
    drafts_test: { applied: number }
  }
}

const DRAFT = draftBranch(SESSION)

/**
 * Append one `timeline.clip_insert` record on the branch that `branchForWrite` picks for the origin, under the lock.
 * @param m - the modules.
 * @param project - the project.
 * @param origin - who writes.
 * @param options - the record's status and params.
 * @returns the record.
 */
function write(
  m: ProjectModules, project: ProjectId, origin: RecordOrigin,
  options: { status?: RecordStatus; params?: Record<string, unknown> } = {},
): Promise<ProjectRecord> {
  return m.store.lock(project, () => {
    const branch = m.drafts.branchForWrite(project, origin)
    const head = m.store.getBranch(project, branch)?.head
    if (head === undefined) throw new Error(`no branch ${branch}`)
    return m.store.append(project, {
      parents: [head], branch, kind: 'operation', component: 'timeline', operation: 'timeline.clip_insert', operation_version: '1',
      ...origin, params: options.params ?? {}, inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: false,
      status: options.status ?? 'done',
    })
  })
}

/**
 * @param m - the modules.
 * @param project - the project.
 * @param name - a branch name.
 * @returns the branch head.
 */
function headOf(m: ProjectModules, project: ProjectId, name: string): RecordId | undefined {
  return m.store.getBranch(project, name)?.head
}

/**
 * The project's `records.jsonl` and `branches.json` text.
 * @param m - the modules.
 * @param project - the project.
 * @returns both files.
 */
function files(m: ProjectModules, project: ProjectId): string[] {
  return ['records.jsonl', 'branches.json'].map(file => readFileSync(join(m.root, project, file), 'utf8'))
}

describe('drafts', () => {
  it('opens one draft on the first agent write and keeps it across turns', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const mainHead = headOf(m, project, MAIN_BRANCH)
    const first = await write(m, project, agentOrigin('turn-1'))
    const forkedAt = m.store.getBranch(project, DRAFT)?.forked_at
    const second = await write(m, project, agentOrigin('turn-2'))
    expect([first.branch, second.branch]).toEqual([DRAFT, DRAFT])
    expect(second.parents).toEqual([first.id])
    expect(forkedAt).toBe(mainHead)
    expect(m.store.getBranch(project, DRAFT)).toMatchObject({ head: second.id, base: MAIN_BRANCH, forked_at: mainHead, session: SESSION })
    expect(m.store.listBranches(project).filter(branch => branch.session === SESSION)).toHaveLength(1)
    expect(headOf(m, project, MAIN_BRANCH)).toBe(mainHead)
    expect(m.drafts.workingBranch(project, SESSION)).toMatchObject({ name: DRAFT, counts: { agent_changes: 2, human_edits: 0 } })
  })

  it("puts a human edit with a session on that session's draft", async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const beforeDraft = await write(m, project, userOrigin())
    expect(beforeDraft.branch).toBe(MAIN_BRANCH)
    expect(m.store.getBranch(project, DRAFT)).toBeUndefined()
    await write(m, project, agentOrigin())
    const onDraft = await write(m, project, userOrigin())
    expect(onDraft.branch).toBe(DRAFT)
    const otherSession = await write(m, project, userOrigin({ session: OTHER_SESSION }))
    expect(otherSession.branch).toBe(MAIN_BRANCH)
    expect(m.store.getBranch(project, draftBranch(OTHER_SESSION))).toBeUndefined()
    const noSession = await write(m, project, userOrigin({ session: null }))
    expect(noSession.branch).toBe(MAIN_BRANCH)
    expect(m.drafts.workingBranch(project, null)).toMatchObject({ name: MAIN_BRANCH, counts: null })
    expect(m.drafts.workingBranch(project, SESSION).counts).toEqual({ agent_changes: 1, human_edits: 1 })
  })

  it('accepts by fast-forward when main did not move', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const forkedAt = headOf(m, project, MAIN_BRANCH)
    const change = await write(m, project, agentOrigin())
    const accepted = await m.store.lock(project, () => m.drafts.accept(project, userOrigin({ surface: 'chat' })))
    expect(accepted).toMatchObject({
      branch: DRAFT, parents: [change.id], component: 'proj', operation: 'proj.draft_accept', status: 'done',
      params: { draft: DRAFT, base: forkedAt, replayed: [] },
    })
    expect(headOf(m, project, MAIN_BRANCH)).toBe(accepted.id)
    expect(m.store.getBranch(project, DRAFT)).toBeUndefined()
    expect(m.drafts.workingBranch(project, SESSION)).toMatchObject({ name: MAIN_BRANCH, head: accepted.id, counts: null })
  })

  it('replays the draft on a main that moved', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const asset = m.assets.add('take')
    // The first draft record runs and finishes with an output, so its copy must repeat the update fields.
    const rendered = await write(m, project, agentOrigin(), { status: 'pending', params: { n: 1 } })
    m.store.update(project, { update: rendered.id, status: 'running', started_at: new Date().toISOString() })
    m.store.update(project, {
      update: rendered.id, status: 'done', finished_at: new Date().toISOString(), outputs: [asset],
      cost: { gpu_seconds: 3, wall_seconds: 4, reused: false }, report: { seed: 7 },
    })
    const edit = await write(m, project, userOrigin(), { params: { n: 2 } })
    const otherEdit = await write(m, project, userOrigin({ session: OTHER_SESSION }), { params: { n: 3 } })
    expect(otherEdit.branch).toBe(MAIN_BRANCH)

    const accepted = await m.store.lock(project, () => m.drafts.accept(project, userOrigin()))
    const replayed = accepted.params.replayed as Array<[RecordId, RecordId]>
    expect(accepted.params).toMatchObject({ draft: DRAFT, base: otherEdit.id })
    expect(replayed.map(([original]) => original)).toEqual([rendered.id, edit.id])
    const copies = replayed.map(([, copy]) => m.store.getRecord(project, copy))
    expect(copies.map(copy => copy.parents[0])).toEqual([otherEdit.id, copies[0]?.id])
    expect(accepted.parents).toEqual([copies[1]?.id])
    // A copy keeps every field of the original's current form except id, parents and created_at.
    for (const [index, original] of [rendered, edit].entries()) {
      const { id, parents, created_at, ...fields } = m.store.getRecord(project, original.id)
      const { id: copyId, parents: copyParents, created_at: copyCreatedAt, ...copyFields } = copies[index] as ProjectRecord
      void parents
      void created_at
      void copyParents
      void copyCreatedAt
      expect(copyId).not.toBe(id)
      expect(copyFields).toEqual(fields)
    }
    expect(copies[0]).toMatchObject({ outputs: [asset], cost: { gpu_seconds: 3, wall_seconds: 4, reused: false }, report: { seed: 7 } })
    const copyLines = readLines(m.root, project).filter(line => line.id === copies[0]?.id || line.update === copies[0]?.id)
    expect(copyLines.map(line => line.status)).toEqual(['pending', 'done'])

    expect(headOf(m, project, MAIN_BRANCH)).toBe(accepted.id)
    expect(m.store.getBranch(project, DRAFT)).toBeUndefined()
    const mainRecords = m.reducers.getState(project, MAIN_BRANCH).components.proj.records.map(record => record.id)
    expect(mainRecords).toEqual(expect.arrayContaining([otherEdit.id, ...copies.map(copy => copy.id), accepted.id]))
    expect(mainRecords).not.toContain(rendered.id)
  })

  it('stops with DraftConflictError and writes nothing on a conflict', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    m.reducers.register('drafts_test', {
      initial: () => ({ applied: 0 }),
      reduce: (slice, record) => (record.component === 'timeline' ? { applied: slice.applied + 1 } : slice),
      conflict: (_slice, record) => (record.params.clash === true ? 'The clip was removed on main.' : null),
    })
    await write(m, project, agentOrigin())
    const clash = await write(m, project, agentOrigin('turn-2'), { params: { clash: true } })
    await write(m, project, userOrigin({ session: OTHER_SESSION }))
    const mainHead = headOf(m, project, MAIN_BRANCH)
    const draftHead = headOf(m, project, DRAFT)
    const before = files(m, project)
    const eventCount = m.events.length

    const refused = m.store.lock(project, () => m.drafts.accept(project, userOrigin()))
    await expect(refused).rejects.toBeInstanceOf(DraftConflictError)
    await refused.catch((error: unknown) => {
      expect(error).toMatchObject({ code: 'draft_conflict', draft: DRAFT, record: clash.id, reason: 'The clip was removed on main.' })
      expect((error as Error).message).toContain(clash.id)
    })
    expect(files(m, project)).toEqual(before)
    expect(m.events).toHaveLength(eventCount)
    expect(headOf(m, project, MAIN_BRANCH)).toBe(mainHead)
    expect(headOf(m, project, DRAFT)).toBe(draftHead)
  })

  it('counts and discards a draft', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const mainHead = headOf(m, project, MAIN_BRANCH)
    const records = [
      await write(m, project, agentOrigin()),
      await write(m, project, agentOrigin('turn-2')),
      await write(m, project, userOrigin()),
    ]
    expect(m.drafts.workingBranch(project, SESSION).counts).toEqual({ agent_changes: 2, human_edits: 1 })
    expect(m.drafts.listBranches(project).map(branch => [branch.name, branch.counts])).toEqual([
      [MAIN_BRANCH, null], [DRAFT, { agent_changes: 2, human_edits: 1 }],
    ])

    const stale = m.store.lock(project, () => m.drafts.discard(project, userOrigin(), { agent_changes: 1, human_edits: 1 }))
    await expect(stale).rejects.toMatchObject({ code: 'draft_changed' })
    const counts = await m.store.lock(project, () => m.drafts.discard(project, userOrigin(), { agent_changes: 2, human_edits: 1 }))
    expect(counts).toEqual({ agent_changes: 2, human_edits: 1 })
    const discard = m.store.listRecords(project).at(-1)
    expect(discard).toMatchObject({
      branch: DRAFT, operation: 'proj.draft_discard',
      params: { draft: DRAFT, base: mainHead, agent_changes: 2, human_edits: 1 },
    })
    expect(m.drafts.workingBranch(project, SESSION)).toMatchObject({ name: MAIN_BRANCH, head: mainHead, counts: null })
    expect(readLines(m.root, project).map(line => line.id)).toEqual(expect.arrayContaining(records.map(record => record.id)))
    await expect(m.store.lock(project, () => m.drafts.discard(project, userOrigin(), counts))).rejects.toMatchObject({
      code: 'no_open_draft',
    })
  })

  it('refuses accept and discard while a draft record runs', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const render = await write(m, project, agentOrigin(), { status: 'pending' })
    const counts = { agent_changes: 1, human_edits: 0 }
    for (const status of ['pending', 'running'] as const) {
      if (status === 'running') m.store.update(project, { update: render.id, status, started_at: new Date().toISOString() })
      await expect(m.store.lock(project, () => m.drafts.accept(project, userOrigin()))).rejects.toMatchObject({ code: 'draft_busy' })
      await expect(m.store.lock(project, () => m.drafts.discard(project, userOrigin(), counts))).rejects.toMatchObject({
        code: 'draft_busy',
      })
    }
    expect(m.store.getBranch(project, DRAFT)?.head).toBe(render.id)
  })

  it('creates and switches to an exploration branch', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const mainHead = headOf(m, project, MAIN_BRANCH)
    const created = await m.store.lock(project, () => m.drafts.createBranch(project, 'explore/alt', MAIN_BRANCH, userOrigin()))
    const createRecord = m.store.getRecord(project, created.head)
    expect(createRecord).toMatchObject({
      branch: 'explore/alt', parents: [mainHead], operation: 'proj.branch_create', params: { name: 'explore/alt', at: mainHead },
    })
    expect(created).toMatchObject({ name: 'explore/alt', base: null, forked_at: null, session: null, counts: null })
    await expect(m.store.lock(project, () => m.drafts.createBranch(project, 'explore/alt', MAIN_BRANCH, userOrigin())))
      .rejects.toMatchObject({ code: 'branch_exists' })
    await expect(m.store.lock(project, () => m.drafts.createBranch(project, 'alt', MAIN_BRANCH, userOrigin())))
      .rejects.toBeInstanceOf(ProjectError)

    const switched = await m.store.lock(project, () => m.drafts.switchBranch(project, 'explore/alt', userOrigin()))
    expect(m.store.getRecord(project, switched.head)).toMatchObject({
      branch: 'explore/alt', parents: [created.head], operation: 'proj.branch_switch', params: { from: MAIN_BRANCH, to: 'explore/alt' },
    })
    expect(m.drafts.workingBranch(project, SESSION).name).toBe('explore/alt')
    expect(m.drafts.workingBranch(project, OTHER_SESSION).name).toBe(MAIN_BRANCH)

    const change = await write(m, project, agentOrigin())
    expect(change.branch).toBe(DRAFT)
    expect(m.store.getBranch(project, DRAFT)).toMatchObject({ base: 'explore/alt', forked_at: switched.head })
    const accepted = await m.store.lock(project, () => m.drafts.accept(project, userOrigin()))
    expect(headOf(m, project, 'explore/alt')).toBe(accepted.id)
    expect(headOf(m, project, MAIN_BRANCH)).toBe(mainHead)
    expect(m.drafts.workingBranch(project, SESSION)).toMatchObject({ name: 'explore/alt', head: accepted.id })
  })
})
