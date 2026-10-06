/** The pure `timeline` reducer: every operation's effect on the slice, the clip checks, and replay conflicts. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId, ComponentStates, ProjectRecord, RecordId } from '@dv/project'
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

/** Reduce records in order from the initial slice. */
function reduceAll(records: ProjectRecord[], slice: ComponentStates['timeline'] = timelineReducer.initial()): ComponentStates['timeline'] {
  return records.reduce((current, record) => timelineReducer.reduce(current, record), slice)
}

/** The clips of one timeline as `asset in-out` text, for compact expectations. */
function clipsOf(slice: ComponentStates['timeline'], id = 't1'): string[] {
  const timeline = slice.timelines.find(candidate => candidate.id === id)
  return timeline?.clips.map(clip => `${clip.asset} ${String(clip.in_sec)}-${String(clip.out_sec)}`) ?? []
}

const conflict = (slice: ComponentStates['timeline'], record: ProjectRecord): string | null => timelineReducer.conflict?.(slice, record) ?? null

describe('timeline reducer', () => {
  it('creates, replaces, renames and deletes whole timelines', () => {
    const first = edit('timeline.create', { assets: ['a', 'b'] })
    const second = edit('timeline.create', { timeline: 't2', name: 'B side', assets: ['c'] })
    const slice = reduceAll([first, second])
    expect(slice.timelines.map(timeline => [timeline.id, timeline.name])).toEqual([[FIRST_TIMELINE_ID, '第 1 集'], ['t2', 'B side']])
    expect(clipsOf(slice)).toEqual(['a null-null', 'b null-null'])
    // Without an ID, create replaces the first timeline's clips and keeps its name; with a known ID, that timeline's.
    expect(clipsOf(reduceAll([edit('timeline.create', { assets: ['d'] })], slice))).toEqual(['d null-null'])
    expect(reduceAll([edit('timeline.create', { timeline: 't2', assets: [] })], slice).timelines[1]).toEqual({ id: 't2', name: 'B side', clips: [] })
    const renamed = reduceAll([edit('timeline.rename', { timeline: 't2', name: '片尾' })], slice)
    expect(renamed.timelines.map(timeline => timeline.name)).toEqual(['第 1 集', '片尾'])
    expect(reduceAll([edit('timeline.delete', { timeline: 't1' })], slice).timelines.map(timeline => timeline.id)).toEqual(['t2'])
    expect(reduceAll([edit('timeline.create', { timeline: 't3' })], slice).timelines[2]).toEqual({ id: 't3', name: '第 3 集', clips: [] })
  })

  it('assembles a scheduled create from the resolved assets of its clip inputs', () => {
    const producer = brandString<RecordId>('shot')
    const asset = brandString<AssetId>('v')
    const assembly = edit('timeline.create', { plan: 'p1' }, {
      inputs: [
        { role: 'clip', ref: { record: producer, output: 0 }, resolved_asset: asset },
        { role: 'clip', ref: { record: producer, output: 0 }, resolved_asset: null },
        { role: 'other', ref: { asset }, resolved_asset: asset },
      ],
    })
    expect(clipsOf(reduceAll([assembly]))).toEqual(['v null-null'])
  })

  it('inserts, moves, removes, splits, trims and replaces clips by position', () => {
    const base = reduceAll([edit('timeline.create', { assets: ['a', 'b', 'c'] })])
    expect(clipsOf(reduceAll([edit('timeline.clip_insert', { at: 4, asset: 'd' })], base))).toEqual(['a null-null', 'b null-null', 'c null-null', 'd null-null'])
    expect(clipsOf(reduceAll([edit('timeline.clip_move', { clip: 3, to: 1 })], base))).toEqual(['c null-null', 'a null-null', 'b null-null'])
    expect(clipsOf(reduceAll([edit('timeline.clip_remove', { clip: 2 })], base))).toEqual(['a null-null', 'c null-null'])
    expect(clipsOf(reduceAll([edit('timeline.clip_replace', { clip: 1, asset: 'z' })], base))).toEqual(['z null-null', 'b null-null', 'c null-null'])
    const trimmed = reduceAll([edit('timeline.clip_trim', { clip: 2, in_sec: 0.5, out_sec: 3 })], base)
    expect(clipsOf(trimmed)).toEqual(['a null-null', 'b 0.5-3', 'c null-null'])
    // `at_sec` is a time inside the asset: both parts play the same asset.
    expect(clipsOf(reduceAll([edit('timeline.clip_split', { clip: 2, at_sec: 1 })], trimmed))).toEqual(['a null-null', 'b 0.5-1', 'b 1-3', 'c null-null'])
    // A trim without points plays the whole asset again; a replace resets the points.
    expect(clipsOf(reduceAll([edit('timeline.clip_trim', { clip: 2 })], trimmed))).toEqual(['a null-null', 'b null-null', 'c null-null'])
    expect(clipsOf(reduceAll([edit('timeline.clip_replace', { clip: 2, asset: 'y' })], trimmed))).toEqual(['a null-null', 'y null-null', 'c null-null'])
  })

  it('edits the timeline a call names, and creates the timeline an insert names when it does not exist', () => {
    const base = reduceAll([edit('timeline.create', { assets: ['a'] }), edit('timeline.create', { timeline: 't2', assets: ['b'] })])
    const named = reduceAll([edit('timeline.clip_remove', { timeline: 't2', clip: 1 })], base)
    expect([clipsOf(named), clipsOf(named, 't2')]).toEqual([['a null-null'], []])
    expect(reduceAll([edit('timeline.clip_insert', { at: 1, asset: 'a' })]).timelines).toEqual([
      { id: FIRST_TIMELINE_ID, name: '第 1 集', clips: [{ asset: 'a', in_sec: null, out_sec: null }] },
    ])
    expect(clipsOf(reduceAll([edit('timeline.clip_insert', { timeline: 't9', at: 1, asset: 'c' })], base), 't9')).toEqual(['c null-null'])
  })

  it('ignores unfinished records, records of other components, and calls that do not apply', () => {
    const base = reduceAll([edit('timeline.create', { assets: ['a'] })])
    const ignored = [
      edit('timeline.clip_remove', { clip: 1 }, { status: 'pending' }),
      edit('plan.create', { shots: [] }),
      edit('timeline.clip_remove', { clip: 5 }),
      edit('timeline.clip_split', { clip: 1, at_sec: 0 }),
      edit('timeline.rename', { timeline: 't7', name: 'x' }),
    ]
    expect(reduceAll(ignored, base)).toBe(base)
    expect(timelineReducer.reduce(base, { ...edit('timeline.create', {}), operation: null })).toBe(base)
  })

  it('reports why a draft record cannot apply to a main that moved', () => {
    const main = reduceAll([edit('timeline.create', { assets: ['a', 'b'] })])
    const ranged = reduceAll([edit('timeline.clip_trim', { clip: 1, in_sec: 1, out_sec: 2 })], main)
    expect(conflict(main, edit('timeline.clip_remove', { clip: 2 }))).toBeNull()
    expect(conflict(main, edit('timeline.clip_remove', { clip: 3 }))).toBe('Timeline t1 has 2 clips; position 3 is not between 1 and 2.')
    expect(conflict(main, edit('timeline.clip_move', { clip: 1, to: 3 }))).toBe('Timeline t1 has 2 clips; position 3 is not between 1 and 2.')
    expect(conflict(main, edit('timeline.clip_insert', { at: 3, asset: 'c' }))).toBeNull()
    expect(conflict(main, edit('timeline.clip_insert', { at: 4, asset: 'c' }))).toContain('not between 1 and 3')
    expect(conflict(main, edit('timeline.clip_insert', { timeline: 't2', at: 2, asset: 'c' }))).toBe('Timeline t2 has 0 clips; position 2 is not between 1 and 1.')
    expect(conflict(main, edit('timeline.rename', { timeline: 't2', name: 'x' }))).toBe('Timeline t2 does not exist.')
    expect(conflict(timelineReducer.initial(), edit('timeline.clip_remove', { clip: 1 }))).toBe('The project has no timeline.')
    expect(conflict(timelineReducer.initial(), edit('timeline.create', {}))).toBeNull()
    expect(conflict(main, edit('plan.create', {}))).toBeNull()
    expect(conflict(ranged, edit('timeline.clip_split', { clip: 1, at_sec: 1.5 }))).toBeNull()
    expect(conflict(ranged, edit('timeline.clip_split', { clip: 1, at_sec: 2 }))).toContain('does not play 2s of its asset')
    expect(conflict(main, edit('timeline.clip_split', { clip: 1, at_sec: 'x' }))).toContain('does not play null')
    expect(conflict(main, edit('timeline.clip_trim', { clip: 1, in_sec: -1 }))).toBe('The in point -1s is before the asset\'s start.')
    expect(conflict(main, edit('timeline.clip_trim', { clip: 1, in_sec: 2, out_sec: 2 }))).toBe('The out point 2s is not after the in point 2s.')
    expect(conflict(main, edit('timeline.clip_trim', { clip: 1, out_sec: 0 }))).toBe('The out point 0s is not after the in point 0s.')
    expect(conflict(main, edit('timeline.clip_trim', { clip: 1, out_sec: 2 }))).toBeNull()
  })

  it('lists every timeline with its clips by position and their URLs in the agent summary', () => {
    const slice = reduceAll([edit('timeline.create', { assets: ['a', 'b'] }), edit('timeline.clip_trim', { clip: 2, in_sec: 1, out_sec: 2 })])
    expect(timelineReducer.agentSummary?.(slice, { url: asset => `/dv/assets/${asset}` })).toEqual({
      timelines: [{
        id: FIRST_TIMELINE_ID, name: '第 1 集', clips: [
          { clip: 1, asset: 'a', url: '/dv/assets/a', in_sec: null, out_sec: null },
          { clip: 2, asset: 'b', url: '/dv/assets/b', in_sec: 1, out_sec: 2 },
        ],
      }],
    })
  })
})
