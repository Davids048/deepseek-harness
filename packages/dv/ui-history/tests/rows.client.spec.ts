/** The History panel's pure readings: turn groups, mark badges, the branch filter query, timeline record sets, focus. */
import { describe, expect, it } from 'vitest'
import type { HistoryEntry, ProjectRecord } from '@dv/ui-kit/types.ts'
import { fixtureState, record } from '../../ui-kit/tests/fixture.client.tsx'
import {
  branchQuery, centerFocus, clipTimelines, groupByTurn, markBadge, markStyle, operationLabel, timelineRecords, turnToolCall,
} from '../src/client/rows.ts'

/** An entry of a record with a mark. */
const entry = (fields: Partial<ProjectRecord> & { id: string }, mark: HistoryEntry['mark'] = 'main'): HistoryEntry => ({ record: record(fields), mark })

describe('groupByTurn', () => {
  it('drops request records, joins consecutive records of one turn, and keeps records without a turn alone', () => {
    const groups = groupByTurn([
      entry({ id: 'a3', turn: 't2', operation: 'shot.render' }),
      entry({ id: 'a2', turn: 't2', operation: 'plan.approve' }),
      entry({ id: 'r2', turn: 't2', kind: 'request' }),
      entry({ id: 'h1', turn: null, operation: 'timeline.clip_move' }),
      entry({ id: 'h0', turn: null, operation: 'timeline.clip_move' }),
      entry({ id: 'a1', turn: 't1', operation: 'plan.create' }),
    ])
    expect(groups.map(group => [group.turn, group.entries.map(item => item.record.id)])).toEqual([
      ['t2', ['a3', 'a2']], [null, ['h1']], [null, ['h0']], ['t1', ['a1']],
    ])
  })

  it('splits a turn interleaved with another record into two groups', () => {
    const groups = groupByTurn([entry({ id: 'a2', turn: 't1' }), entry({ id: 'h1', turn: null }), entry({ id: 'a1', turn: 't1' })])
    expect(groups.map(group => group.turn)).toEqual(['t1', null, 't1'])
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

  it('links a turn header to the turn\'s oldest loaded tool call', () => {
    const turn = [
      entry({ id: 'b', session: 's1', tool_call: 'call-2' }), entry({ id: 'a', session: 's1', tool_call: 'call-1' }), entry({ id: 'h' }),
    ]
    expect(turnToolCall(turn)).toEqual({ session: 's1', toolCall: 'call-1' })
    expect(turnToolCall([entry({ id: 'h' })])).toBeNull()
  })
})
