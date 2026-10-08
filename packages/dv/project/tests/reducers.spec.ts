/**
 * Tests of the reducer registry and Project's own `proj` slice: slices computed from a branch's records, one reducer
 * per key, stale and superseded marks, stale acceptance, and character references resolved, and their producers
 * found, through the reducer that defines `assetsOf` and `createdBy`. Records are appended on `main` directly
 * through the record store.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import type { ProjectModules } from './support.ts'
import { createTestProject, startModules, userOrigin, versionKey } from './support.ts'
import { MAIN_BRANCH, ProjectError } from '../src/shared.ts'
import type { RecordLineInput } from '../src/record-store.ts'
import type { AssetId, CharacterId, ComponentStates, ProjectId, ProjectRecord, RecordInput } from '../src/types.ts'

declare module '@dv/project' {
  interface ComponentStates {
    /** The slice of the counting test reducer: how many `timeline` records the chain holds. */
    reducers_test?: { count: number }
  }
}

/** The character the `test_bible` reducers record. */
const HERO = brandString<CharacterId>('hero')

/** A record's operation, plus the record-line fields that differ from a plain finished human edit. */
type RecordLineFields = Pick<RecordLineInput, 'component' | 'operation'> & Partial<RecordLineInput>

/**
 * Append one record on `main` at its head, under the lock.
 * @param m - the modules.
 * @param project - the project.
 * @param fields - the record's operation and the fields that differ from a plain finished human edit.
 * @returns the record.
 */
function append(m: ProjectModules, project: ProjectId, fields: RecordLineFields): Promise<ProjectRecord> {
  return m.store.lock(project, () => m.store.append(project, {
    parents: [m.store.getBranch(project, MAIN_BRANCH)!.head], branch: MAIN_BRANCH, kind: 'operation', operation_version: '1',
    ...userOrigin({ session: null }), params: {}, inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: false,
    status: 'done', ...fields,
  }))
}

/**
 * @param asset - an asset.
 * @returns a `reference` input that reads the asset.
 */
function uses(asset: AssetId): RecordInput {
  return { role: 'reference', ref: { asset }, resolved_asset: asset }
}

/**
 * @param m - the modules.
 * @param project - the project.
 * @returns the `proj` slice of `main`.
 */
function projSlice(m: ProjectModules, project: ProjectId): ComponentStates['proj'] {
  return m.reducers.getState(project, MAIN_BRANCH).components.proj
}

/** A shot render: component `shot`, operation `shot.render`. */
const RENDER = { component: 'shot', operation: 'shot.render' } as const
/** A timeline edit: component `timeline`, operation `timeline.clip_insert`. */
const INSERT = { component: 'timeline', operation: 'timeline.clip_insert' } as const

describe('reducers', () => {
  it('computes each registered slice from the branch records', async () => {
    const m = startModules()
    m.reducers.register('reducers_test', {
      initial: () => ({ count: 0 }),
      reduce: (slice, record) => record.component === 'timeline' ? { count: (slice?.count ?? 0) + 1 } : slice,
    })
    const project = await createTestProject(m)
    await append(m, project, INSERT)
    await append(m, project, RENDER)
    const last = await append(m, project, INSERT)
    const state = m.reducers.getState(project, MAIN_BRANCH)
    expect(state).toMatchObject({ branch: MAIN_BRANCH, head: last.id, project: m.store.getProject(project) })
    expect(state.components.reducers_test?.count).toBe(2)
    expect(state.components.proj.records).toEqual(m.store.ancestors(project, last.id))
    expect(() => m.reducers.getState(project, 'b9')).toThrow(ProjectError)
  })

  it('refuses a second reducer for a key', () => {
    const m = startModules()
    const reducer = { initial: () => ({ count: 0 }), reduce: (slice: { count: number }) => slice }
    const remove = m.reducers.register('reducers_test', reducer)
    let error: unknown = null
    try {
      m.reducers.register('reducers_test', reducer)
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeInstanceOf(ProjectError)
    expect((error as ProjectError).code).toBe('reducer_exists')
    remove()
    expect(() => m.reducers.register('reducers_test', reducer)).not.toThrow()
  })

  it('refuses a second reducer that defines createdBy or assetsOf', () => {
    const m = startModules()
    const versions = { initial: () => ({ assets: {}, creators: {} }), reduce: <S>(slice: S) => slice }
    const remove = m.reducers.register('test_bible', { ...versions, createdBy: () => null, assetsOf: () => null })
    const counting = { initial: () => ({ count: 0 }), reduce: (slice: { count: number }) => slice }
    expect(() => m.reducers.register('reducers_test', { ...counting, createdBy: () => null }))
      .toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(() => m.reducers.register('reducers_test', { ...counting, assetsOf: () => null }))
      .toThrow(expect.objectContaining({ code: 'invalid_params' }))
    remove()
    expect(() => m.reducers.register('reducers_test', { ...counting, createdBy: () => null })).not.toThrow()
  })

  it('marks consumers of a superseded record stale', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const x = m.assets.add('take x')
    const y = m.assets.add('export y')
    const a = await append(m, project, { ...RENDER, outputs: [x] })
    const b = await append(m, project, { ...INSERT, inputs: [uses(x)], outputs: [y] })
    const d = await append(m, project, { ...INSERT, inputs: [uses(y)] })
    const c = await append(m, project, { ...RENDER, outputs: [m.assets.add('take x2')], based_on: a.id, supersedes: [a.id] })
    const later = await append(m, project, { ...INSERT, inputs: [uses(x)] })
    const slice = projSlice(m, project)
    expect(slice.superseded).toEqual({ [a.id]: c.id })
    expect(slice.created_by[x]).toBe(a.id)
    expect(slice.stale).toEqual({ [b.id]: c.id, [d.id]: c.id, [later.id]: c.id })
  })

  it('keeps a record fresh after proj.stale_accept', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const x = m.assets.add('take x')
    const y = m.assets.add('export y')
    const a = await append(m, project, { ...RENDER, outputs: [x] })
    const b = await append(m, project, { ...INSERT, inputs: [uses(x)], outputs: [y] })
    const d = await append(m, project, { ...INSERT, inputs: [uses(y)] })
    await append(m, project, { ...RENDER, outputs: [m.assets.add('take x2')], supersedes: [a.id] })
    expect(Object.keys(projSlice(m, project).stale)).toEqual([b.id, d.id])
    await append(m, project, {
      component: 'proj', operation: 'proj.stale_accept', params: { record: b.id }, deterministic: true,
    })
    expect(projSlice(m, project).stale).toEqual({})
    await append(m, project, INSERT)
    expect(projSlice(m, project).stale).toEqual({})
    // A later consumer of the accepted record's output is not stale through it.
    await append(m, project, { ...INSERT, inputs: [uses(y)] })
    expect(projSlice(m, project).stale).toEqual({})
  })

  it('resolves character references through the reducer that defines assetsOf', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const state = m.reducers.getState(project, MAIN_BRANCH)
    const ref = { character: HERO, version: 1 }
    expect(m.reducers.assetsOf(state, ref)).toBeNull()
    const face = m.assets.add('hero face')
    m.reducers.register('test_bible', {
      initial: () => ({ assets: {}, creators: {} }),
      reduce: (slice, record) => record.operation === 'bible.character_create'
        ? { creators: slice?.creators ?? {}, assets: { ...slice?.assets, [`character:${String(record.params.character)}@1`]: record.outputs } }
        : slice,
      assetsOf: (slice, asked) => slice?.assets[versionKey(asked) ?? ''] ?? null,
    })
    await append(m, project, { component: 'bible', operation: 'bible.character_create', params: { character: 'hero' }, outputs: [face] })
    const withBible = m.reducers.getState(project, MAIN_BRANCH)
    expect(m.reducers.assetsOf(withBible, ref)).toEqual([face])
    expect(m.reducers.assetsOf(withBible, { character: HERO, version: 2 })).toBeNull()
  })

  it('marks records that read a superseded character version stale', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const face = m.assets.add('hero face')
    m.reducers.register('test_bible', {
      initial: () => ({ assets: {}, creators: {} }),
      reduce(slice, record) {
        if (record.operation !== 'bible.character_create' && record.operation !== 'bible.character_update') return slice
        const key = versionKey({ character: HERO, version: Object.keys(slice?.creators ?? {}).length + 1 }) ?? ''
        return { assets: { ...slice?.assets, [key]: [face] }, creators: { ...slice?.creators, [key]: record.id } }
      },
      createdBy: (slice, asked) => slice?.creators[versionKey(asked) ?? ''] ?? null,
    })
    /** A render that reads one version of the hero. */
    const reads = (version: number): RecordInput => ({ role: 'reference', ref: { character: HERO, version }, resolved_asset: face })
    const create = await append(m, project, { component: 'bible', operation: 'bible.character_create' })
    const x = m.assets.add('take x')
    const render = await append(m, project, { ...RENDER, inputs: [reads(1)], outputs: [x] })
    const insert = await append(m, project, { ...INSERT, inputs: [uses(x)] })
    const update = await append(m, project, { component: 'bible', operation: 'bible.character_update', supersedes: [create.id] })
    const late = await append(m, project, { ...RENDER, inputs: [reads(1)] })
    await append(m, project, { ...RENDER, inputs: [reads(2)] })
    expect(projSlice(m, project).stale).toEqual({ [render.id]: update.id, [insert.id]: update.id, [late.id]: update.id })
    // Accepting the render also clears the stale mark of the clip made from it.
    await append(m, project, { component: 'proj', operation: 'proj.stale_accept', params: { record: render.id }, deterministic: true })
    expect(projSlice(m, project).stale).toEqual({ [late.id]: update.id })
  })
})
