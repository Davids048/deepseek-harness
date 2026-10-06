/** Expansion of composer `vh:` references into concrete record and asset IDs. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId, ProjectId, ProjectRecord, ProjectState, RecordId, SessionId, TurnId } from '@dv/project'
import { expansionBlock, formatVhReference, parseVhReferences, type ExpansionSources } from '../src/expand.ts'

const project = brandString<ProjectId>('p1')
const img = brandString<AssetId>('img1')
const vid = brandString<AssetId>('vid1')
const shot: ProjectRecord = {
  id: brandString<RecordId>('rec-shot'), parents: [], branch: 'main', kind: 'operation', component: 'shot', operation: 'generate.video',
  operation_version: '1', actor: 'agent', surface: 'chat', turn: brandString<TurnId>('t1'), session: brandString<SessionId>('s1'),
  tool_call: null, intent: 'shot', params: { prompt: 'a cat walks', duration_sec: 5 },
  inputs: [
    { role: 'reference', ref: { asset: img }, resolved_asset: img },
    { role: 'reference', ref: { character: 'c1', version: 2 }, resolved_asset: null },
  ],
  outputs: [vid, brandString<AssetId>('frame1')], based_on: null, supersedes: [], deterministic: false, status: 'done',
  created_at: '2026-10-05T00:00:00Z',
}
const sources: ExpansionSources = {
  getState: (): ProjectState => ({
    project: { id: project, title: 'p', created_at: '' }, branch: 'main', head: shot.id,
    components: {
      proj: { records: [shot], stale: {}, superseded: {}, created_by: { [vid]: shot.id } },
      timeline: { sequence: null, sequences: [] },
      bible: {
        entities: { c1: [{ kind: 'character', version: 1, name: 'Lead', description: '', refs: [img], updatedBy: shot.id }] },
      },
      plan: { plans: [] },
      shot: { takes: {}, roots: {} },
    },
  }),
  getRecord: (_project, id) => id === shot.id ? shot : undefined,
}

describe('vh references', () => {
  it('round-trips the serialized form', () => {
    const text = `改一下 ${formatVhReference('第1集·第2段', 'vh:clip/seq1/2/vid1')} 的光线`
    expect(parseVhReferences(text)).toEqual([{ label: '第1集·第2段', uri: 'vh:clip/seq1/2/vid1' }])
  })

  it('names the producing record, prompt, inputs, and duration of a clip', () => {
    const block = expansionBlock('@[第1集·第2段](vh:clip/seq1/2/vid1)', project, sources)
    expect(block).toContain('asset vid1 made by record rec-shot (generate.video, done), prompt "a cat walks", duration 5 s')
    expect(block).toContain('inputs [reference=img1, reference=c1@2]')
  })

  it('describes assets, characters, records, and unknown references', () => {
    const text = ['@[a](vh:asset/img1)', '@[b](vh:entity/c1)', '@[c](vh:entity/c9)', // names:allow
      '@[d](vh:op/rec-shot)', '@[e](vh:op/none)', '@[f](vh:other/x)'].join(' ') // names:allow
    const block = expansionBlock(text, project, sources) ?? ''
    expect(block).toContain('asset img1, uploaded (no producing record)') // names:allow
    expect(block).toContain('character c1@1 "Lead", reference images [img1]; pass it as input c1@1')
    expect(block).toContain('no entity c9 on main') // names:allow
    expect(block).toContain('(vh:op/rec-shot): made by record rec-shot')
    expect(block).toContain('record none not found')
    expect(block).toContain('unknown reference kind')
    expect(expansionBlock('@[a](vh:asset/img1)', null, sources)).toContain('call dv_proj_open first')
  })

  it('returns null for text without references', () => {
    expect(expansionBlock('hello', project, sources)).toBeNull()
  })
})
