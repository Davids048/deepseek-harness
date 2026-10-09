/**
 * The History panel's pure readings: action rows and approval folds, labels with subjects (undo records included),
 * thumbnails, relative times, focus, and the rows that offer 回到这一步.
 */
import { describe, expect, it } from 'vitest'
import type { HistoryEntry, ProjectRecord } from '@dv/ui-kit/types.ts'
import { asset, fixtureState, record } from '../../ui-kit/tests/fixture.client.tsx'
import {
  actionLabel, actionRows, canGoBack, centerFocus, clipTimelines, operationLabel, relativeTime, thumbnailOf,
} from '../src/client/rows.ts'

/** An entry of a record. */
const entry = (fields: Partial<ProjectRecord> & { id: string }): HistoryEntry => ({ record: record(fields) })

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

  it('lists undo records as rows of their own', () => {
    const rows = actionRows([entry({ id: 'u', operation: 'proj.undo', params: { to: 'h1' } }), entry({ id: 'h1', operation: 'timeline.clip_move' })])
    expect(rows.map(row => row.entry.record.id)).toEqual(['u', 'h1'])
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

  it('names the step an undo record returned to, through earlier undo records, and an unloaded target generically', () => {
    const move = record({ id: 'm', operation: 'timeline.clip_move' })
    const first = record({ id: 'u1', operation: 'proj.undo', params: { to: 'm' } })
    const second = record({ id: 'u2', operation: 'proj.undo', params: { to: 'u1' } })
    const loaded = new Map([move, first, second].map(item => [item.id, item]))
    expect(actionLabel(first, loaded)).toEqual(['回到「移动片段」', 'Go back to “Move clip”'])
    expect(actionLabel(second, loaded)).toEqual(['回到「移动片段」', 'Go back to “Move clip”'])
    expect(actionLabel(record({ id: 'u3', operation: 'proj.undo', params: { to: 'gone' } }), loaded))
      .toEqual(['回到之前的一步', 'Go back to an earlier step'])
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

  it('focuses a clip record on the timeline, a render on the canvas, and nothing for proj records or records off the current state', () => {
    const owner = clipTimelines(records)
    const render = fixtureState().components.proj.records.find(item => item.id === 'g1') as ProjectRecord
    const inState = new Set(['m', 'c', 'g1', 'u'])
    expect(centerFocus({ record: records[3] as ProjectRecord }, owner, inState))
      .toEqual({ event: 'dv:timeline-focus', detail: { timelineId: 't1', clipId: 'cl4' } })
    expect(centerFocus({ record: records[0] as ProjectRecord }, owner, inState))
      .toEqual({ event: 'dv:timeline-focus', detail: { timelineId: 't1', clipId: 'cl1' } })
    expect(centerFocus({ record: render }, owner, inState)).toEqual({ event: 'dv:canvas-focus', detail: { recordId: 'g1' } })
    expect(centerFocus({ record: render }, owner, new Set())).toBeNull()
    expect(centerFocus(entry({ id: 'u', operation: 'proj.undo' }), owner, inState)).toBeNull()
  })
})

describe('canGoBack', () => {
  it('offers 回到这一步 on finished records except the newest one and the one the newest undo returned to', () => {
    const done = record({ id: 'a', operation: 'timeline.clip_move' })
    const running = record({ id: 'r', operation: 'shot.render_ref2va', status: 'running' })
    const newest = record({ id: 'n', operation: 'timeline.rename' })
    expect([done, running, newest].map(item => canGoBack(item, newest))).toEqual([true, false, false])
    const undo = record({ id: 'u', operation: 'proj.undo', params: { to: 'a' } })
    expect([done, newest].map(item => canGoBack(item, undo))).toEqual([false, true])
    expect(canGoBack(done, undefined)).toBe(false)
  })
})
