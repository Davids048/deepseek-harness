/**
 * The History panel's pure readings: action rows and approval folds, labels with subjects, thumbnails, relative times,
 * mark badges, the branch filter query, timeline record sets, focus.
 */
import { describe, expect, it } from 'vitest'
import type { HistoryEntry, ProjectRecord } from '@dv/ui-kit/types.ts'
import { asset, fixtureState, record } from '../../ui-kit/tests/fixture.client.tsx'
import {
  actionLabel, actionRows, branchQuery, centerFocus, clipTimelines, markBadge, markStyle, operationLabel, relativeTime, thumbnailOf,
  timelineRecords,
} from '../src/client/rows.ts'

/** An entry of a record with a mark. */
const entry = (fields: Partial<ProjectRecord> & { id: string }, mark: HistoryEntry['mark'] = 'main'): HistoryEntry => ({ record: record(fields), mark })

describe('actionRows', () => {
  it('drops request records and folds the loaded records an approval scheduled under its row, in scheduled order', () => {
    const rows = actionRows([
      entry({ id: 'tl', actor: 'system', operation: 'timeline.update' }),
      entry({ id: 'g2', actor: 'system', operation: 'shot.render' }),
      entry({ id: 'g1', actor: 'system', operation: 'shot.render' }),
      entry({ id: 'ap', turn: 't2', operation: 'plan.approve', report: { plan: 'p1', version: 2, scheduled: ['g1', 'g2', 'tl', 'gone'] } }),
      entry({ id: 'r2', turn: 't2', kind: 'request' }),
      entry({ id: 'h1', operation: 'timeline.clip_move' }),
    ])
    expect(rows.map(row => [row.entry.record.id, row.children.map(child => child.record.id)])).toEqual([
      ['ap', ['g1', 'g2', 'tl']], ['h1', []],
    ])
  })

  it('keeps scheduled records as rows of their own while their approval is not loaded', () => {
    expect(actionRows([entry({ id: 'g1', actor: 'system', operation: 'shot.render' })]).map(row => row.entry.record.id)).toEqual(['g1'])
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
    expect(actionLabel(record({ id: 'e', operation: 'shot.render', params: { plan: 'p1', plan_version: 2, shot: 7 } })))
      .toEqual(['渲染镜头 7', 'Render shot 7'])
    expect(actionLabel(record({ id: 'f', operation: 'shot.render', params: { prompt: 'x' } }))).toEqual(['渲染镜头', 'Render shot'])
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

describe('marks', () => {
  it('badges an accepted draft record, open drafts, undone, discarded, replayed and exploration records', () => {
    expect(markBadge(entry({ id: 'm' }))).toBeNull()
    expect(markBadge(entry({ id: 'a', branch: 'draft/s1' }))).toEqual({ zh: '已接受', en: 'Accepted' })
    expect(markBadge(entry({ id: 'd', branch: 'draft/s1' }, 'draft'))).toEqual({ zh: '草稿', en: 'Draft' })
    expect(markBadge(entry({ id: 'u' }, 'undone'))).toEqual({ zh: '已撤销', en: 'Undone' })
    expect(markBadge(entry({ id: 'x', branch: 'draft/s1' }, 'discarded'))).toEqual({ zh: '已丢弃', en: 'Discarded' })
    expect(markBadge(entry({ id: 'p', branch: 'draft/s1' }, 'replayed'))).toEqual({ zh: '已重放', en: 'Replayed' })
    expect(markBadge(entry({ id: 'b', branch: 'explore/b' }, 'branch'))).toEqual({ branch: 'explore/b' })
    expect([markStyle('undone'), markStyle('discarded'), markStyle('replayed'), markStyle('draft')]).toEqual(['struck', 'struck', 'dimmed', 'normal'])
  })

  it('maps the branch filter to marks: main includes undone records, a draft its open records', () => {
    expect(branchQuery('')).toEqual({})
    expect(branchQuery('main')).toEqual({ marks: ['main', 'undone'] })
    expect(branchQuery('draft/s5')).toEqual({ branch: 'draft/s5', marks: ['draft'] })
    expect(branchQuery('explore/b')).toEqual({ branch: 'explore/b' })
  })

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

  it('focuses a clip record on the timeline, a render on the canvas, and nothing for proj records or other branches', () => {
    const owner = clipTimelines(records)
    expect(centerFocus({ record: records[3] as ProjectRecord, mark: 'main' }, owner))
      .toEqual({ event: 'dv:timeline-focus', detail: { timelineId: 't1', clipId: 'cl4' } })
    expect(centerFocus({ record: records[0] as ProjectRecord, mark: 'draft' }, owner))
      .toEqual({ event: 'dv:timeline-focus', detail: { timelineId: 't1', clipId: 'cl1' } })
    const render = fixtureState().components.proj.records.find(item => item.id === 'g1') as ProjectRecord
    expect(centerFocus({ record: render, mark: 'main' }, owner)).toEqual({ event: 'dv:canvas-focus', detail: { recordId: 'g1' } })
    expect(centerFocus({ record: render, mark: 'undone' }, owner)).toBeNull()
    expect(centerFocus(entry({ id: 'u', operation: 'proj.undo' }), owner)).toBeNull()
  })
})
