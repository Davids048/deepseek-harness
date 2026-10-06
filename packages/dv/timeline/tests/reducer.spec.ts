/** The pure `timeline` reducer: every operation's effect on the slice, the clip and clip ID checks, and replay conflicts. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId, ComponentStates, ProjectRecord, ProjectState, RecordId } from '@dv/project'
import { describe, expect, it } from 'vitest'
import { FIRST_TIMELINE_ID, timelineReducer } from '../src/reducer.ts'
import type {} from '../src/types.ts'

let counter = 0

/** A finished record of one operation with the given params. */
function edit(operation: string, params: Record<string, unknown>, fields: Partial<ProjectRecord> = {}): ProjectRecord {
  counter += 1
  return {
    id: brandString<RecordId>(`record-${counter}`), parents: [], branch: 'main', kind: 'operation', component: 'timeline', operation,
    operation_version: '1', actor: 'user', surface: 'timeline', turn: null, session: null, tool_call: null, intent: 'edit', params,
    inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: false, status: 'done', created_at: new Date().toISOString(),
    ...fields,
  }
}

/** A finished record of an operation that adds clips, with the clip IDs it stored in `report.clips`. */
function adding(operation: string, params: Record<string, unknown>, clips: string[], fields: Partial<ProjectRecord> = {}): ProjectRecord {
  return edit(operation, params, { report: { clips }, ...fields })
}

/** Reduce records in order from the initial slice. */
function reduceAll(records: ProjectRecord[], slice: ComponentStates['timeline'] = timelineReducer.initial()): ComponentStates['timeline'] {
  return records.reduce((current, record) => timelineReducer.reduce(current, record), slice)
}

/** The clips of one timeline as `id asset in-out` text, for compact expectations. */
function clipsOf(slice: ComponentStates['timeline'], id = 't1'): string[] {
  const timeline = slice.timelines.find(candidate => candidate.id === id)
  return timeline?.clips.map(clip => `${clip.id} ${clip.asset} ${String(clip.in_sec)}-${String(clip.out_sec)}`) ?? []
}

const conflict = (slice: ComponentStates['timeline'], record: ProjectRecord): string | null => timelineReducer.conflict?.(slice, record) ?? null

/** A slice with timeline t1 holding clips cl1, cl2 and cl3 of assets a, b and c. */
const base = (): ComponentStates['timeline'] => reduceAll([adding('timeline.create', { assets: ['a', 'b', 'c'] }, ['cl1', 'cl2', 'cl3'])])

describe('timeline reducer', () => {
  it('creates, updates, renames and deletes whole timelines', () => {
    const first = adding('timeline.create', { assets: ['a', 'b'] }, ['cl1', 'cl2'])
    const second = adding('timeline.create', { timeline: 't2', name: 'B side', assets: ['c'] }, ['cl3'])
    const slice = reduceAll([first, second])
    expect(slice.timelines.map(timeline => [timeline.id, timeline.name])).toEqual([[FIRST_TIMELINE_ID, ''], ['t2', 'B side']])
    expect(clipsOf(slice)).toEqual(['cl1 a null-null', 'cl2 b null-null'])
    // create only creates: a create of an existing ID changes nothing; update replaces the clips and keeps the name.
    expect(reduceAll([adding('timeline.create', { assets: ['d'] }, ['cl4'])], slice)).toBe(slice)
    expect(clipsOf(reduceAll([adding('timeline.update', { timeline: 't1', assets: ['d'] }, ['cl4'])], slice))).toEqual(['cl4 d null-null'])
    expect(reduceAll([adding('timeline.update', { timeline: 't2', assets: [] }, [])], slice).timelines[1]).toEqual({ id: 't2', name: 'B side', clips: [] })
    const renamed = reduceAll([edit('timeline.rename', { timeline: 't2', name: '片尾' })], slice)
    expect(renamed.timelines.map(timeline => timeline.name)).toEqual(['', '片尾'])
    expect(reduceAll([edit('timeline.delete', { timeline: 't1' })], slice).timelines.map(timeline => timeline.id)).toEqual(['t2'])
    expect(reduceAll([adding('timeline.create', { timeline: 't3' }, [])], slice).timelines[2]).toEqual({ id: 't3', name: '', clips: [] })
  })

  it('keeps a clip input whose render is not done as a placeholder clip with its clip ID', () => {
    const producer = brandString<RecordId>('shot')
    const asset = brandString<AssetId>('v')
    const inputs = [
      { role: 'clip', ref: { record: producer, output: 0 }, resolved_asset: asset },
      { role: 'clip', ref: { record: producer, output: 1 }, resolved_asset: null },
      { role: 'other', ref: { asset }, resolved_asset: asset },
    ]
    const created = reduceAll([adding('timeline.create', { plan: 'p1' }, ['cl1', 'cl2'], { inputs })])
    expect(clipsOf(created)).toEqual(['cl1 v null-null', 'cl2 null null-null'])
    expect(created.timelines[0]?.clips.map(clip => clip.source)).toEqual([{ record: producer, output: 0 }, { record: producer, output: 1 }])
    const updated = reduceAll([adding('timeline.update', { timeline: 't1', plan: 'p1' }, ['cl3', 'cl4'], { inputs })], created)
    expect(clipsOf(updated)).toEqual(['cl3 v null-null', 'cl4 null null-null'])
    // A clip of an asset param has no source.
    expect(base().timelines[0]?.clips[0]?.source).toBeNull()
  })

  it('refuses to trim or split a placeholder clip, and moves, removes and replaces it', () => {
    const inputs = [{ role: 'clip', ref: { record: brandString<RecordId>('shot'), output: 0 }, resolved_asset: null }]
    const slice = reduceAll([adding('timeline.create', { assets: ['a'] }, ['cl1']), adding('timeline.update', { timeline: 't1' }, ['cl2'], { inputs })])
    const placeholder = reduceAll([adding('timeline.clip_insert', { at: 1, asset: 'a' }, ['cl3'])], slice)
    expect(conflict(placeholder, edit('timeline.clip_trim', { clip: 'cl2', in_sec: 1 }))).toBe('Clip cl2 is still rendering.')
    expect(conflict(placeholder, adding('timeline.clip_split', { clip: 'cl2', at_sec: 1 }, ['cl4']))).toBe('Clip cl2 is still rendering.')
    expect(clipsOf(reduceAll([edit('timeline.clip_move', { clip: 'cl2', to: 1 })], placeholder))).toEqual(['cl2 null null-null', 'cl3 a null-null'])
    expect(clipsOf(reduceAll([edit('timeline.clip_remove', { clip: 'cl2' })], placeholder))).toEqual(['cl3 a null-null'])
    const replaced = reduceAll([edit('timeline.clip_replace', { clip: 'cl2', asset: 'z' })], placeholder)
    expect(replaced.timelines[0]?.clips[1]).toEqual({ id: 'cl2', asset: 'z', source: null, in_sec: null, out_sec: null })
  })

  it('inserts, moves, removes, splits, trims and replaces clips by clip ID', () => {
    const slice = base()
    expect(clipsOf(reduceAll([adding('timeline.clip_insert', { at: 4, asset: 'd' }, ['cl4'])], slice)))
      .toEqual(['cl1 a null-null', 'cl2 b null-null', 'cl3 c null-null', 'cl4 d null-null'])
    expect(clipsOf(reduceAll([edit('timeline.clip_move', { clip: 'cl3', to: 1 })], slice))).toEqual(['cl3 c null-null', 'cl1 a null-null', 'cl2 b null-null'])
    expect(clipsOf(reduceAll([edit('timeline.clip_remove', { clip: 'cl2' })], slice))).toEqual(['cl1 a null-null', 'cl3 c null-null'])
    expect(clipsOf(reduceAll([edit('timeline.clip_replace', { clip: 'cl1', asset: 'z' })], slice))).toEqual(['cl1 z null-null', 'cl2 b null-null', 'cl3 c null-null'])
    const trimmed = reduceAll([edit('timeline.clip_trim', { clip: 'cl2', in_sec: 0.5, out_sec: 3 })], slice)
    expect(clipsOf(trimmed)).toEqual(['cl1 a null-null', 'cl2 b 0.5-3', 'cl3 c null-null'])
    // `at_sec` is a time inside the asset: both parts play the same asset; the second part gets the assigned ID.
    expect(clipsOf(reduceAll([adding('timeline.clip_split', { clip: 'cl2', at_sec: 1 }, ['cl4'])], trimmed)))
      .toEqual(['cl1 a null-null', 'cl2 b 0.5-1', 'cl4 b 1-3', 'cl3 c null-null'])
    // A trim without points plays the whole asset again; a replace keeps the ID and resets the points.
    expect(clipsOf(reduceAll([edit('timeline.clip_trim', { clip: 'cl2' })], trimmed))).toEqual(['cl1 a null-null', 'cl2 b null-null', 'cl3 c null-null'])
    expect(clipsOf(reduceAll([edit('timeline.clip_replace', { clip: 'cl2', asset: 'y' })], trimmed))).toEqual(['cl1 a null-null', 'cl2 y null-null', 'cl3 c null-null'])
  })

  it('edits the timeline that holds the clip, and creates the timeline an insert names when it does not exist', () => {
    const slice = reduceAll([adding('timeline.create', { assets: ['a'] }, ['cl1']), adding('timeline.create', { timeline: 't2', assets: ['b'] }, ['cl2'])])
    const removed = reduceAll([edit('timeline.clip_remove', { clip: 'cl2' })], slice)
    expect([clipsOf(removed), clipsOf(removed, 't2')]).toEqual([['cl1 a null-null'], []])
    expect(reduceAll([adding('timeline.clip_insert', { at: 1, asset: 'a' }, ['cl1'])]).timelines).toEqual([
      { id: FIRST_TIMELINE_ID, name: '', clips: [{ id: 'cl1', asset: 'a', source: null, in_sec: null, out_sec: null }] },
    ])
    expect(clipsOf(reduceAll([adding('timeline.clip_insert', { timeline: 't9', at: 1, asset: 'c' }, ['cl3'])], slice), 't9')).toEqual(['cl3 c null-null'])
  })

  it('ignores unfinished records, records of other components, calls that do not apply, and records without their clip IDs', () => {
    const slice = base()
    const ignored = [
      edit('timeline.clip_remove', { clip: 'cl1' }, { status: 'pending' }),
      edit('plan.create', { shots: [] }),
      edit('timeline.clip_remove', { clip: 'cl5' }),
      adding('timeline.clip_split', { clip: 'cl1', at_sec: 0 }, ['cl4']),
      edit('timeline.rename', { timeline: 't7', name: 'x' }),
      // A record written before clips had IDs, a record with too many IDs, and one that reuses an ID.
      edit('timeline.clip_insert', { at: 1, asset: 'd' }),
      adding('timeline.clip_insert', { at: 1, asset: 'd' }, ['cl4', 'cl5']),
      adding('timeline.clip_insert', { at: 1, asset: 'd' }, ['cl2']),
      adding('timeline.update', { timeline: 't1', assets: ['d', 'e'] }, ['cl4', 'cl4']),
    ]
    expect(reduceAll(ignored, slice)).toBe(slice)
    expect(timelineReducer.reduce(slice, { ...edit('timeline.create', {}), operation: null })).toBe(slice)
  })

  it('reports why a draft record cannot apply to a main that moved', () => {
    const main = reduceAll([adding('timeline.create', { assets: ['a', 'b'] }, ['cl1', 'cl2'])])
    const ranged = reduceAll([edit('timeline.clip_trim', { clip: 'cl1', in_sec: 1, out_sec: 2 })], main)
    expect(conflict(main, edit('timeline.clip_remove', { clip: 'cl2' }))).toBeNull()
    expect(conflict(main, edit('timeline.clip_remove', { clip: 'cl3' }))).toBe('Clip cl3 does not exist.')
    expect(conflict(main, edit('timeline.clip_move', { clip: 'cl1', to: 3 }))).toBe('Timeline t1 has 2 clips; position 3 is not between 1 and 2.')
    expect(conflict(main, adding('timeline.clip_insert', { at: 3, asset: 'c' }, ['cl3']))).toBeNull()
    expect(conflict(main, adding('timeline.clip_insert', { at: 4, asset: 'c' }, ['cl3']))).toContain('not between 1 and 3')
    expect(conflict(main, adding('timeline.clip_insert', { at: 1, asset: 'c' }, ['cl2']))).toBe('Clip cl2 already exists.')
    expect(conflict(main, edit('timeline.clip_insert', { at: 1, asset: 'c' }))).toBe('The record stored 0 clip IDs for the 1 clips it adds.')
    expect(conflict(main, adding('timeline.clip_insert', { timeline: 't2', at: 2, asset: 'c' }, ['cl3'])))
      .toBe('Timeline t2 has 0 clips; position 2 is not between 1 and 1.')
    expect(conflict(main, adding('timeline.create', { assets: [] }, []))).toBe('Timeline t1 exists; call dv_timeline_update to replace its clips.')
    expect(conflict(main, adding('timeline.update', { timeline: 't2', assets: [] }, []))).toBe('Timeline t2 does not exist.')
    expect(conflict(main, edit('timeline.rename', { timeline: 't2', name: 'x' }))).toBe('Timeline t2 does not exist.')
    expect(conflict(timelineReducer.initial(), edit('timeline.rename', { name: 'x' }))).toBe('The project has no timeline.')
    expect(conflict(timelineReducer.initial(), adding('timeline.create', {}, []))).toBeNull()
    expect(conflict(main, edit('plan.create', {}))).toBeNull()
    // A record that did not finish done changes nothing, so it cannot conflict.
    expect(conflict(main, edit('timeline.clip_remove', { clip: 'cl3' }, { status: 'failed' }))).toBeNull()
    expect(conflict(ranged, adding('timeline.clip_split', { clip: 'cl1', at_sec: 1.5 }, ['cl3']))).toBeNull()
    expect(conflict(ranged, adding('timeline.clip_split', { clip: 'cl1', at_sec: 2 }, ['cl3']))).toContain('does not play 2s of its asset')
    expect(conflict(main, adding('timeline.clip_split', { clip: 'cl1', at_sec: 'x' }, ['cl3']))).toContain('does not play null')
    expect(conflict(main, edit('timeline.clip_trim', { clip: 'cl1', in_sec: -1 }))).toBe('The in point -1s is before the asset\'s start.')
    expect(conflict(main, edit('timeline.clip_trim', { clip: 'cl1', in_sec: 2, out_sec: 2 }))).toBe('The out point 2s is not after the in point 2s.')
    expect(conflict(main, edit('timeline.clip_trim', { clip: 'cl1', out_sec: 0 }))).toBe('The out point 0s is not after the in point 0s.')
    expect(conflict(main, edit('timeline.clip_trim', { clip: 'cl1', out_sec: 2 }))).toBeNull()
  })

  it('lists every timeline with its clips by clip ID, their URLs, and the status of placeholder clips in the agent summary', () => {
    const running = edit('shot.render', {}, { status: 'running' })
    const failed = edit('shot.render', {}, { status: 'failed' })
    const inputs = [running, failed].map(producer => ({ role: 'clip', ref: { record: producer.id, output: 0 }, resolved_asset: null }))
    const slice = reduceAll([
      adding('timeline.create', { assets: ['a', 'b'] }, ['cl1', 'cl2']), edit('timeline.clip_trim', { clip: 'cl2', in_sec: 1, out_sec: 2 }),
      adding('timeline.create', { timeline: 't2' }, ['cl3', 'cl4'], { inputs }),
    ])
    // The summary reads only the records of the state, for the status of each placeholder's render.
    const state = { components: { proj: { records: [running, failed] } } } as unknown as ProjectState
    expect(timelineReducer.agentSummary?.(slice, { url: asset => `/dv/assets/${asset}` }, state)).toEqual({
      timelines: [{
        id: FIRST_TIMELINE_ID, name: '', clips: [
          { clip: 'cl1', asset: 'a', url: '/dv/assets/a', in_sec: null, out_sec: null },
          { clip: 'cl2', asset: 'b', url: '/dv/assets/b', in_sec: 1, out_sec: 2 },
        ],
      }, {
        id: 't2', name: '', clips: [
          { clip: 'cl3', asset: null, status: 'rendering', record: running.id, in_sec: null, out_sec: null },
          { clip: 'cl4', asset: null, status: 'failed', record: failed.id, in_sec: null, out_sec: null },
        ],
      }],
    })
  })
})
