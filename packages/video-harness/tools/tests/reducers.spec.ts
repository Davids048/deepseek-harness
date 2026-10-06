/** The stage 2 bridge reducers: timelines, story bible versions and the records that wrote them, plan approvals, and takes. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId, ProjectRecord, RecordId, Reducer, RunRequest } from '@dv/project'
import { afterEach, describe, expect, it } from 'vitest'
import { bibleReducer, DEFAULT_SEQUENCE_ID, parseEntityOperation, planReducer, shotReducer, timelineReducer } from '../src/reducers.ts'
import { startTools, type ToolsFixture } from './support.ts'

let counter = 0

/** A finished record with the given fields. */
function record(fields: Partial<ProjectRecord>): ProjectRecord {
  counter += 1
  return {
    id: brandString<RecordId>(`record-${counter}`), parents: [], branch: 'main', kind: 'operation', component: 'timeline', operation: null,
    operation_version: '1', actor: 'user', surface: 'api', turn: null, session: null, tool_call: null, intent: 'x', params: {}, inputs: [],
    outputs: [], based_on: null, supersedes: [], deterministic: true, status: 'done', created_at: new Date().toISOString(), ...fields,
  }
}

/** Reduce records in order from the reducer's initial slice. */
function reduceAll<K extends 'timeline' | 'bible' | 'plan' | 'shot'>(reducer: Reducer<K>, records: ProjectRecord[]) {
  return records.reduce((slice, next) => reducer.reduce(slice, next), reducer.initial())
}

/** A timeline record of one operation. */
function edit(operation: string, params: Record<string, unknown>, fields: Partial<ProjectRecord> = {}): ProjectRecord {
  return record({ operation, params, ...fields })
}

const asset = (text: string): AssetId => brandString<AssetId>(text)

describe('timeline reducer', () => {
  it('adds named timelines, edits the first one by default, and splits a clip into two parts of one asset', () => {
    const first = edit('sequence.create', { assets: ['a', 'b'] }) // names:allow
    const second = edit('sequence.create', { sequence: 'v2', title: 'B side', assets: ['c'] }) // names:allow
    const split = edit('sequence.split', { sequence: 'v2', slot: 1, atSec: 2 }) // names:allow
    const outside = edit('sequence.split', { slot: 9, atSec: 1 }) // names:allow
    const remove = edit('sequence.remove', { slot: 2 }) // names:allow
    const unknown = edit('sequence.unknown', {}) // names:allow
    const slice = reduceAll(timelineReducer, [first, second, split, outside, remove, unknown])
    const titles = slice.sequences.map(timeline => [timeline.id, timeline.title]) // names:allow
    expect(titles).toEqual([[DEFAULT_SEQUENCE_ID, '第 1 集'], ['v2', 'B side']])
    expect(slice.sequence?.items.map(item => item.assetId)).toEqual(['a']) // names:allow
    expect(slice.sequences[1]?.items).toEqual([ // names:allow
      { slot: 1, assetId: 'c', inSec: null, outSec: 2 }, // names:allow
      { slot: 2, assetId: 'c', inSec: 2, outSec: null }, // names:allow
    ])
    const replaced = reduceAll(timelineReducer, [first, second, edit('sequence.create', { sequence: 'v2', assets: ['d'] })]) // names:allow
    const clip = { slot: 1, assetId: 'd', inSec: null, outSec: null } // names:allow
    expect(replaced.sequences[1]).toEqual({ id: 'v2', title: 'B side', items: [clip] }) // names:allow
    expect(reduceAll(timelineReducer, [edit('sequence.remove', { slot: 1 })])).toEqual({ sequence: null, sequences: [] }) // names:allow
  })

  it('renames a timeline, deletes only the one a delete names, and ignores unfinished and other records', () => {
    const first = edit('sequence.create', { assets: ['a'] }) // names:allow
    const second = edit('sequence.create', { sequence: 'v2', title: '第 2 集', assets: [] }) // names:allow
    const rename = edit('sequence.rename', { sequence: 'v2', title: '片尾' }) // names:allow
    const unnamed = edit('sequence.delete', {}) // names:allow
    const pending = edit('sequence.delete', { sequence: 'v2' }, { status: 'pending' }) // names:allow
    const other = edit('plan.create', { shots: [] })
    const kept = reduceAll(timelineReducer, [first, second, rename, unnamed, pending, other])
    expect(kept.sequences.map(timeline => [timeline.id, timeline.title])) // names:allow
      .toEqual([[DEFAULT_SEQUENCE_ID, '第 1 集'], ['v2', '片尾']])
    const slice = reduceAll(timelineReducer, [first, second, rename, edit('sequence.delete', { sequence: 'v1' })]) // names:allow
    expect(slice.sequences.map(timeline => timeline.id)).toEqual(['v2']) // names:allow
    expect(slice.sequence?.items).toEqual([]) // names:allow
  })

  it('creates the timeline an insert names when the project has none, and assembles clips from resolved inputs', () => {
    expect(reduceAll(timelineReducer, [edit('sequence.insert', { at: 1, asset: 'a' })]).sequences).toEqual([ // names:allow
      { id: DEFAULT_SEQUENCE_ID, title: '第 1 集', items: [{ slot: 1, assetId: 'a', inSec: null, outSec: null }] }, // names:allow
    ])
    const producer = brandString<RecordId>('shot')
    const assembly = edit('sequence.create', {}, { // names:allow
      inputs: [
        { role: 'clip', ref: { record: producer, output: 0 }, resolved_asset: asset('v') },
        { role: 'clip', ref: { record: producer, output: 0 }, resolved_asset: null },
      ],
    })
    const range = edit('sequence.set_range', { slot: 1 }) // names:allow
    const slice = reduceAll(timelineReducer, [assembly, range, edit('sequence.move', { from: 9, to: 1 })]) // names:allow
    expect(slice.sequence?.items).toEqual([{ slot: 1, assetId: 'v', inSec: null, outSec: null }]) // names:allow
  })
})

describe('bible reducer', () => {
  it('versions characters and names the record that wrote each version', () => {
    expect(parseEntityOperation('entity.style.update')).toEqual({ action: 'update', kind: 'style' }) // names:allow
    expect(parseEntityOperation('plan.create')).toBeNull()
    expect(parseEntityOperation(null)).toBeNull()
    const create = edit('entity.character.create', { entity: 'c1', name: 'Lead', refs: ['a'] }, { component: 'bible' }) // names:allow
    const failed = edit('entity.character.update', { entity: 'c1', refs: ['x'] }, { status: 'failed' }) // names:allow
    const update = edit('entity.character.update', { entity: 'c1', description: 'v2' }, { component: 'bible' }) // names:allow
    const bare = edit('entity.location.update', { entity: 'l1' }) // names:allow
    const slice = reduceAll(bibleReducer, [create, failed, update, bare])
    expect(slice.entities['c1']).toEqual([ // names:allow
      { kind: 'character', version: 1, name: 'Lead', description: '', refs: ['a'], updatedBy: create.id },
      { kind: 'character', version: 2, name: 'Lead', description: 'v2', refs: ['a'], updatedBy: update.id },
    ])
    const location = { kind: 'location', version: 1, name: 'l1', description: '', refs: [], updatedBy: bare.id }
    expect(slice.entities['l1']).toEqual([location]) // names:allow
    expect(bibleReducer.createdBy?.(slice, { character: 'c1', version: 1 })).toBe(create.id)
    expect(bibleReducer.createdBy?.(slice, { character: 'c1', version: 2 })).toBe(update.id)
    expect(bibleReducer.createdBy?.(slice, { location: 'c1', version: 1 })).toBeNull()
    expect(bibleReducer.createdBy?.(slice, { character: 'c1', version: 3 })).toBeNull()
  })

  it('names the assets of a version only for the kind that owns the ID', () => {
    const slice = reduceAll(bibleReducer, [edit('entity.style.create', { entity: 's1', name: 'noir', refs: ['a', 'b'] })]) // names:allow
    expect(bibleReducer.assetsOf?.(slice, { style: 's1', version: 1 })).toEqual(['a', 'b'])
    expect(bibleReducer.assetsOf?.(slice, { character: 's1', version: 1 })).toBeNull()
    expect(bibleReducer.assetsOf?.(slice, { style: 's1', version: 2 })).toBeNull()
    expect(bibleReducer.assetsOf?.(slice, { asset: asset('a') })).toBeNull()
  })
})

describe('plan and shot reducers', () => {
  it('lists plans and marks the one a finished approval names', () => {
    const plan = edit('plan.create', { shots: [] }, { status: 'failed' })
    const revised = edit('plan.update', { shots: [] })
    const running = edit('plan.approve', { plan: revised.id }, { status: 'running' })
    const done = edit('plan.approve', { plan: revised.id })
    expect(reduceAll(planReducer, [plan, revised, running]).plans.map(summary => summary.approved)).toEqual([false, false])
    expect(reduceAll(planReducer, [plan, revised, running, done]).plans).toEqual([
      { op: plan.id, approved: false, approvedBy: null },
      { op: revised.id, approved: true, approvedBy: done.id },
    ])
  })

  it('groups takes under the root record of their based_on chain', () => {
    const root = record({})
    const retake = record({ based_on: root.id })
    const third = record({ based_on: retake.id })
    expect(reduceAll(shotReducer, [root, retake, third]).takes).toEqual({ [root.id]: [root.id, retake.id, third.id] })
  })
})

describe('bridge reducers on the Project service', () => {
  const fixtures: ToolsFixture[] = []
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.dispose()
  })

  it('computes every slice of main from the records the operations wrote', async () => {
    const fixture = await startTools({ dsh: false, perception: false, generation: 'none' }) // names:allow
    fixtures.push(fixture)
    const origin = { actor: 'user' as const, surface: 'canvas' as const, session: null, turn: null, tool_call: null, intent: 'edit' }
    const project = (await fixture.project.createProject('reducers', origin)).id
    const run = async (operation: string, params: Record<string, unknown>, extra: { based_on?: RecordId } = {}): Promise<ProjectRecord> => {
      const result = await fixture.project.run({ ...origin, project, operation, params, inputs: [], ...extra })
      if (result.record === null) throw new Error(`${operation} wrote no record`)
      return result.record
    }
    const imported = await run('asset.upload', { base64: Buffer.from('face').toString('base64'), mime: 'image/png' }) // names:allow
    const image = imported.outputs[0] as AssetId
    await run('entity.character.create', { entity: 'c1', name: 'Lead', refs: [image] }) // names:allow
    await run('sequence.create', { assets: [image, image] }) // names:allow
    await run('sequence.move', { from: 2, to: 1 }) // names:allow
    const plan = await run('plan.create', { shots: [{ prompt: 'one' }] })
    const revised = await run('plan.update', { shots: [{ prompt: 'two' }] }, { based_on: plan.id })
    const state = fixture.project.getState(project)
    expect(state.components.bible.entities['c1']?.[0]).toMatchObject({ kind: 'character', version: 1, refs: [image] }) // names:allow
    expect(state.components.timeline.sequence?.items.map(item => item.slot)).toEqual([1, 2]) // names:allow
    expect(state.components.plan.plans.map(summary => summary.op)).toEqual([plan.id, revised.id])
    expect(state.components.shot.takes).toEqual({ [plan.id]: [plan.id, revised.id] })
  })

  it('marks what read an older character version stale, downstream records included, until the human keeps it', async () => {
    const fixture = await startTools({ dsh: false, perception: false })
    fixtures.push(fixture)
    const origin = { actor: 'user' as const, surface: 'canvas' as const, session: null, turn: null, tool_call: null, intent: 'edit' }
    const project = (await fixture.project.createProject('versions', origin)).id
    const run = async (operation: string, params: Record<string, unknown>, inputs: RunRequest['inputs'] = []): Promise<ProjectRecord> => {
      const result = await fixture.project.run({ ...origin, project, operation, params, inputs })
      if (result.record === null) throw new Error(`${operation} wrote no record`)
      return result.record
    }
    const imported = await run('asset.upload', { base64: Buffer.from('face').toString('base64'), mime: 'image/png' }) // names:allow
    const create = await run('entity.character.create', { entity: 'c1', name: 'Lead', refs: imported.outputs }) // names:allow
    const reads = (version: number): RunRequest['inputs'] => [{ role: 'reference', ref: { character: 'c1', version } }]
    const shot = await run('generate.video', { prompt: 'Picture 1 waves', duration_sec: 1 }, reads(1)) // names:allow
    const frame = await run('media.extract_frame', { atSec: 0.5 }, [{ role: 'clip', ref: { asset: shot.outputs[0] as AssetId } }]) // names:allow
    const update = await run('entity.character.update', { entity: 'c1', description: 'blue coat' }) // names:allow
    const current = await run('generate.video', { prompt: 'Picture 1 bows', duration_sec: 1 }, reads(2)) // names:allow
    expect(update.supersedes).toEqual([create.id])
    const proj = () => fixture.project.getState(project).components.proj
    expect(proj().superseded).toEqual({ [create.id]: update.id })
    expect(proj().stale).toEqual({ [shot.id]: update.id, [frame.id]: update.id })
    expect(current.id in proj().stale).toBe(false)
    await fixture.project.acceptStale(project, shot.id, origin)
    expect(proj().stale).toEqual({})
  })
})
