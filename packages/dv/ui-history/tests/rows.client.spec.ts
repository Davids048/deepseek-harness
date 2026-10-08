/**
 * The History panel's pure readings: action rows and approval folds, labels with subjects, thumbnails, relative times,
 * timeline record sets, focus, the current branch's steps, and the lane layout of the branch tree.
 */
import { describe, expect, it } from 'vitest'
import type { Branch, HistoryEntry, ProjectRecord } from '@dv/ui-kit/types.ts'
import { entryBranch } from '@dv/ui-kit/state.ts'
import { asset, fixtureState, record } from '../../ui-kit/tests/fixture.client.tsx'
import {
  actionLabel, actionRows, branchSteps, branchTree, centerFocus, clipTimelines, operationLabel, relativeTime, stepPlace,
  thumbnailOf, timelineRecords,
} from '../src/client/rows.ts'

/** An entry of a record with a mark and the branch lines that hold it. */
const entry = (fields: Partial<ProjectRecord> & { id: string }, mark: HistoryEntry['mark'] = 'current', branches: string[] = ['main']): HistoryEntry => (
  { record: record(fields), mark, branches }
)

describe('actionRows', () => {
  it('folds the loaded records an approval scheduled under its row, in scheduled order', () => {
    const rows = actionRows([
      entry({ id: 'tl', actor: 'system', operation: 'timeline.update' }),
      entry({ id: 'g2', actor: 'system', operation: 'shot.render_ref2va' }),
      entry({ id: 'g1', actor: 'system', operation: 'shot.render_ref2va' }),
      entry({ id: 'ap', turn: 't2', operation: 'plan.approve', report: { plan: 'p1', version: 2, scheduled: ['g1', 'g2', 'tl', 'gone'] } }),
      entry({ id: 'h1', operation: 'timeline.clip_move' }),
    ])
    expect(rows.map(row => [row.entry.record.id, row.children.map(child => child.record.id)])).toEqual([
      ['ap', ['g1', 'g2', 'tl']], ['h1', []],
    ])
  })

  it('lists no row for undo and redo records', () => {
    const rows = actionRows([entry({ id: 'u', operation: 'proj.undo' }), entry({ id: 'r', operation: 'proj.redo' }), entry({ id: 'h1', operation: 'timeline.clip_move' })])
    expect(rows.map(row => row.entry.record.id)).toEqual(['h1'])
  })

  it('keeps scheduled records as rows of their own while their approval is not loaded', () => {
    expect(actionRows([entry({ id: 'g1', actor: 'system', operation: 'shot.render_ref2va' })]).map(row => row.entry.record.id)).toEqual(['g1'])
  })
})

describe('labels, thumbnails and times', () => {
  it('names the subject of plan, shot render and story bible actions', () => {
    expect(actionLabel(record({ id: 'a', operation: 'plan.create', params: { title: '猫' }, report: { plan: 'p1', version: 1 } })))
      .toEqual(['新建分镜计划《猫》', 'Create plan “猫”'])
    expect(actionLabel(record({ id: 'b', operation: 'plan.create', params: {}, report: { plan: 'p1', version: 1 } })))
      .toEqual(['新建分镜计划 p1', 'Create plan p1'])
    expect(actionLabel(record({ id: 'c', operation: 'plan.update', params: { plan: 'p1' }, report: { plan: 'p1', version: 2 } })))
      .toEqual(['修改分镜计划 p1 → v2', 'Update plan p1 → v2'])
    expect(actionLabel(record({ id: 'd', operation: 'plan.approve', params: { plan: 'p1' }, report: { plan: 'p1', version: 2 } })))
      .toEqual(['批准分镜计划 p1 v2', 'Approve plan p1 v2'])
    expect(actionLabel(record({ id: 'e', operation: 'shot.render_ref2va', params: { plan: 'p1', plan_version: 2, shot: 7 } })))
      .toEqual(['参考图生成镜头 7', 'Render shot from references 7'])
    expect(actionLabel(record({ id: 'f', operation: 'shot.render_t2va', params: { prompt: 'x' } }))).toEqual(['文字生成镜头', 'Render shot from text'])
    expect(actionLabel(record({ id: 'tc', operation: 'timeline.create', params: { timeline: 't2' } }))).toEqual(['新建时间线', 'Create timeline'])
    expect(actionLabel(record({ id: 'tu', operation: 'timeline.update', params: { timeline: 't2' } }))).toEqual(['修改时间线', 'Update timeline'])
    expect(actionLabel(record({ id: 'g', component: 'bible', operation: 'bible.character_create', params: { character: 'c1', name: '阿明' } })))
      .toEqual(['新建角色「阿明」', 'Create character “阿明”'])
  })

  it('shows an image first, a take\'s still for its video, a video frame without a still, and nothing for other files', () => {
    const assets = new Map([
      asset('take.mp4', 'video/mp4', 'g1'), asset('still.png', 'image/png', 'g1'), asset('clip.mp4', 'video/mp4', 'gone'),
      asset('plan.json', 'application/json', 'p'), asset('ref.png', 'image/png', null),
    ].map(item => [item.id, item]))
    const render = record({ id: 'g1', outputs: ['take.mp4', 'still.png'] })
    const records = new Map([[render.id, render]])
    expect(thumbnailOf(render, assets, records)).toEqual({ asset: 'still.png', kind: 'image' })
    const clipRow = record({ id: 'm', inputs: [{ role: 'clip', ref: { record: 'g1', output: 0 }, resolved_asset: 'take.mp4' }] })
    expect(thumbnailOf(clipRow, assets, records)).toEqual({ asset: 'still.png', kind: 'image' })
    expect(thumbnailOf(record({ id: 'v', outputs: ['clip.mp4'] }), assets, records)).toEqual({ asset: 'clip.mp4', kind: 'video' })
    expect(thumbnailOf(record({ id: 'p', outputs: ['plan.json'] }), assets, records)).toBeNull()
    expect(thumbnailOf(record({ id: 'u', outputs: ['unknown'] }), assets, records)).toBeNull()
    expect(thumbnailOf(record({ id: 'ap' }), assets, records, [render, record({ id: 'g2' })])).toEqual({ asset: 'still.png', kind: 'image' })
  })

  it('says how long ago a record was made', () => {
    const now = Date.parse('2026-10-06T12:00:00Z')
    expect(relativeTime('2026-10-06T11:59:30Z', now)).toEqual(['刚刚', 'just now'])
    expect(relativeTime('2026-10-06T11:55:00Z', now)).toEqual(['5 分钟前', '5 min ago'])
    expect(relativeTime('2026-10-06T09:00:00Z', now)).toEqual(['3 小时前', '3 h ago'])
    expect(relativeTime('2026-10-01T12:00:00Z', now)[0]).toMatch(/^10\/1 \d\d:\d\d$/)
  })
})

describe('operation labels', () => {
  it('labels an operation by its tool label, and an unknown one by its name', () => {
    expect(operationLabel('timeline.clip_move')).toEqual(['移动片段', 'Move clip'])
    expect(operationLabel('other.thing')).toEqual(['other.thing', 'other.thing'])
  })
})

describe('timelines and focus', () => {
  const records = [
    record({ id: 'c', operation: 'timeline.create', params: { assets: ['a.mp4', 'b.mp4'] }, report: { clips: ['cl1', 'cl2'] } }),
    record({ id: 'c2', operation: 'timeline.create', params: { timeline: 't2', assets: ['z.mp4'] }, report: { clips: ['cl3'] } }),
    record({ id: 's', operation: 'timeline.clip_split', params: { clip: 'cl2', at_sec: 1 }, report: { clips: ['cl4'] } }),
    record({ id: 'm', operation: 'timeline.clip_move', params: { clip: 'cl4', to: 1 } }),
    record({ id: 'm2', operation: 'timeline.clip_move', params: { clip: 'cl3', to: 1 } }),
    record({ id: 'e', operation: 'deliver.timeline_export', params: { timeline: 't1' }, outputs: ['out.mp4'] }),
  ]

  it('assigns each clip to the timeline of the record that added it, a split to the split clip\'s timeline', () => {
    expect(Object.fromEntries(clipTimelines(records))).toEqual({ cl1: 't1', cl2: 't1', cl3: 't2', cl4: 't1' })
  })

  it('collects a timeline\'s records and the records that made its clips\' assets', () => {
    expect(timelineRecords(records, { 'a.mp4': 'g1' }, 't1', ['a.mp4', 'b.mp4']).sort()).toEqual(['c', 'e', 'g1', 'm', 's'])
    expect(timelineRecords(records, {}, 't2', ['z.mp4'])).toEqual(['c2', 'm2'])
  })

  it('focuses a clip record on the timeline, a render on the canvas, and nothing for proj records or records off the current state', () => {
    const owner = clipTimelines(records)
    expect(centerFocus({ record: records[3] as ProjectRecord, mark: 'current', branches: ['main'] }, owner))
      .toEqual({ event: 'dv:timeline-focus', detail: { timelineId: 't1', clipId: 'cl4' } })
    expect(centerFocus({ record: records[0] as ProjectRecord, mark: 'current', branches: ['main'] }, owner))
      .toEqual({ event: 'dv:timeline-focus', detail: { timelineId: 't1', clipId: 'cl1' } })
    const render = fixtureState().components.proj.records.find(item => item.id === 'g1') as ProjectRecord
    expect(centerFocus({ record: render, mark: 'current', branches: ['main'] }, owner)).toEqual({ event: 'dv:canvas-focus', detail: { recordId: 'g1' } })
    for (const mark of ['redo', 'branch', 'undone'] as const) expect(centerFocus({ record: render, mark, branches: [] }, owner)).toBeNull()
    expect(centerFocus(entry({ id: 'u', operation: 'proj.undo' }), owner)).toBeNull()
  })
})

describe('branchSteps', () => {
  it('makes the newest step of the chain current, the older steps before it, and the redo steps after it', () => {
    const chain = [
      record({ id: 'c', operation: 'proj.create' }), record({ id: 'a', operation: 'timeline.create' }),
      record({ id: 'b', operation: 'timeline.rename' }), record({ id: 'u', operation: 'proj.undo' }),
    ]
    const steps = branchSteps(chain, ['d', 'e'])
    expect(steps.current).toBe('b')
    expect(['c', 'a', 'b', 'u', 'd', 'x'].map(id => stepPlace(id, steps))).toEqual(['before', 'before', 'current', null, 'after', null])
    expect(branchSteps([], []).current).toBeNull()
  })
})

describe('branchTree', () => {
  const branch = (name: string, forkedAt: string | null): Branch => ({ name, title: null, head: '', base: forkedAt === null ? null : 'main', forked_at: forkedAt, tip: '' })
  // Newest first: b2 forked from main at a and wrote x1 and x2; b3 forked from main at m2 and has no step yet.
  const entries = [
    entry({ id: 'x2', branch: 'b2' }, 'branch', ['b2']),
    entry({ id: 'x1', branch: 'b2' }, 'branch', ['b2']),
    entry({ id: 'u', operation: 'proj.undo' }, 'current', ['main']),
    entry({ id: 'z' }, 'undone', []),
    entry({ id: 'm2' }, 'current', ['main', 'b3']),
    entry({ id: 'a' }, 'current', ['main', 'b2', 'b3']),
    entry({ id: 'c', operation: 'proj.create' }, 'current', ['main', 'b2', 'b3']),
  ]

  it('puts each step in its owner\'s lane, runs a forked lane down to its fork point, and marks a branch without steps', () => {
    const tree = branchTree(entries, [branch('main', null), branch('b2', 'a'), branch('b3', 'm2')])
    expect(tree.map(row => [row.entry.record.id, row.lane, row.lines, row.forks])).toEqual([
      ['x2', 1, [{ lane: 1, up: false, down: true }], []],
      ['x1', 1, [{ lane: 1, up: true, down: true }], []],
      ['m2', 0, [{ lane: 0, up: false, down: true }, { lane: 1, up: true, down: true }], [{ lane: 2, empty: true }]],
      ['a', 0, [{ lane: 0, up: true, down: true }], [{ lane: 1, empty: false }]],
      ['c', 0, [{ lane: 0, up: true, down: false }], []],
    ])
  })

  it('runs a lane to the bottom when its fork point is not loaded, and owns a step by the first line when its branch lost it', () => {
    const tree = branchTree(entries.slice(0, 2), [branch('main', null), branch('b2', 'a')])
    expect(tree.map(row => row.lines)).toEqual([[{ lane: 1, up: false, down: true }], [{ lane: 1, up: true, down: true }]])
    expect(entryBranch(entry({ id: 'r', branch: 'b9' }, 'current', ['main', 'b2']), null)).toBe('main')
    expect(entryBranch(entry({ id: 'r', branch: 'b2' }, 'branch', ['main', 'b2']), null)).toBe('b2')
    expect(entryBranch(entry({ id: 'r', branch: 'b2' }, 'branch', ['main', 'b2']), 'main')).toBe('main')
    expect(entryBranch(entry({ id: 'r' }, 'undone', []), 'main')).toBeNull()
  })
})
