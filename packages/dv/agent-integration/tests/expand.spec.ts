/** Expansion of composer `dv:` mentions into concrete record and asset IDs. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId, CharacterId, ProjectId, ProjectRecord, ProjectState, RecordId, SessionId, TurnId } from '@dv/project'
import type { ClipId, TimelineId } from '@dv/timeline'
import { expansionBlock, formatMention, parseMentions, type ExpansionSources } from '../src/expand.ts'

const project = brandString<ProjectId>('p1')
const img = brandString<AssetId>('img1')
const vid = brandString<AssetId>('vid1')
const shot: ProjectRecord = {
  id: brandString<RecordId>('rec-shot'), parents: [], branch: 'main', kind: 'operation', component: 'shot', operation: 'shot.render',
  operation_version: '1', actor: 'agent', surface: 'chat', turn: brandString<TurnId>('t1'), session: brandString<SessionId>('s1'),
  tool_call: null, intent: 'shot', params: { prompt: 'a cat walks', duration_sec: 5 },
  inputs: [
    { role: 'reference', ref: { asset: img }, resolved_asset: img },
    { role: 'reference', ref: { character: brandString<CharacterId>('c1'), version: 2 }, resolved_asset: null },
  ],
  outputs: [vid, brandString<AssetId>('frame1')], based_on: null, supersedes: [], deterministic: false, status: 'done',
  created_at: '2026-10-05T00:00:00Z',
}
const lead = { id: brandString<CharacterId>('c1'), version: 1, name: 'Lead', description: '', references: [img], created_by: shot.id }
const sources: ExpansionSources = {
  getState: (): ProjectState => ({
    project: { id: project, title: 'p', created_at: '' }, branch: 'main', head: shot.id, redo_steps: [],
    components: {
      proj: { records: [shot], stale: {}, superseded: {}, created_by: { [vid]: shot.id } },
      timeline: {
        timelines: [{
          id: brandString<TimelineId>('t1'), name: '',
          clips: [
            { id: brandString<ClipId>('cl1'), asset: img, source: null, in_sec: null, out_sec: null },
            { id: brandString<ClipId>('cl2'), asset: vid, source: null, in_sec: null, out_sec: null },
            { id: brandString<ClipId>('cl3'), asset: null, source: { record: shot.id, output: 0 }, in_sec: null, out_sec: null },
          ],
        }],
      },
      bible: { characters: { [lead.id]: [lead] }, locations: {}, styles: {} },
      plan: { plans: {} },
      shot: { takes: {}, roots: {} },
    },
  }),
  getRecord: (_project, id) => id === shot.id ? shot : undefined,
}

describe('dv mentions', () => {
  it('round-trips the serialized form', () => {
    const text = `改一下 ${formatMention('时间线 1·片段 2', 'dv:clip/cl2')} 的光线`
    expect(parseMentions(text)).toEqual([{ label: '时间线 1·片段 2', uri: 'dv:clip/cl2' }])
  })

  it('names the timeline, position, producing record, prompt, inputs, and duration of a clip, and a placeholder clip\'s render', () => {
    const block = expansionBlock('@[时间线 1·片段 2](dv:clip/cl2)', project, sources)
    expect(block).toContain('(dv:clip/cl2): clip cl2, clip 2 of timeline t1, asset vid1')
    expect(block).toContain('asset vid1 made by record rec-shot (dv_shot_render, done)')
    expect(block).toContain('prompt "a cat walks", duration 5 s')
    expect(block).toContain('inputs [reference=img1, reference=c1@2]')
    expect(expansionBlock('@[x](dv:clip/cl9)', project, sources)).toContain('no clip cl9 on main')
    expect(expansionBlock('@[x](dv:clip/cl3)', project, sources))
      .toContain('clip cl3, clip 3 of timeline t1, a placeholder clip (no asset until its render is done), its render made by record rec-shot')
  })

  it('describes assets, characters, records, and unknown mentions', () => {
    const text = ['@[a](dv:asset/img1)', '@[b](dv:character/c1)', '@[c](dv:character/c9)', '@[g](dv:location/c1)',
      '@[d](dv:record/rec-shot)', '@[e](dv:record/none)', '@[f](dv:other/x)'].join(' ')
    const block = expansionBlock(text, project, sources) ?? ''
    expect(block).toContain('asset img1, imported (no producing record)')
    expect(block).toContain('character c1@1 "Lead", reference images [img1]; pass it as input c1@1')
    expect(block).toContain('no character c9 on main')
    expect(block).toContain('no location c1 on main')
    expect(block).toContain('(dv:record/rec-shot): made by record rec-shot')
    expect(block).toContain('record none not found')
    expect(block).toContain('unknown mention kind')
    expect(expansionBlock('@[a](dv:asset/img1)', null, sources)).toContain('call dv_proj_open first')
  })

  it('returns null for text without mentions', () => {
    expect(expansionBlock('hello', project, sources)).toBeNull()
  })
})
