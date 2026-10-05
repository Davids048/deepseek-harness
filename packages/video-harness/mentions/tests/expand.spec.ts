/** Expansion of composer `vh:` references into concrete record and asset IDs. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId, Op, OpId, ProjectId, TurnId } from '@video-harness/oplog'
import type { ProjectState } from '@video-harness/runtime'
import { expansionBlock, formatVhReference, parseVhReferences, type ExpansionSources } from '../src/expand.ts'

const project = brandString<ProjectId>('p1')
const img = brandString<AssetId>('img1')
const shot: Op = {
  id: brandString<OpId>('op-shot'), parents: [], turn: brandString<TurnId>('t1'), branch: 'main', actor: 'agent', surface: 'chat', intent: 'shot',
  kind: 'tool', tool: { name: 'generate.video', version: '1' }, inputs: [{ role: 'reference', ref: img, resolved: img }],
  params: { prompt: 'a cat walks', duration_sec: 5 }, outputs: [brandString<AssetId>('vid1'), brandString<AssetId>('frame1')],
  status: 'done', deterministic: false, created_at: '2026-10-05T00:00:00Z',
}
const sources: ExpansionSources = {
  fold: (): ProjectState => ({
    projectId: project, head: shot.id, ops: [shot], assets: new Set(), producers: { [brandString<AssetId>('vid1')]: shot.id }, entities: {},
    sequence: null, sequences: [], stale: {}, superseded: {}, turns: {}, takes: {}, plans: [],
  }),
  op: (_project, id) => id === shot.id ? shot : undefined,
}

describe('vh references', () => {
  it('round-trips the serialized form', () => {
    const text = `改一下 ${formatVhReference('第1集·第2段', 'vh:clip/seq1/2/vid1')} 的光线`
    expect(parseVhReferences(text)).toEqual([{ label: '第1集·第2段', uri: 'vh:clip/seq1/2/vid1' }])
  })

  it('names the producing record, prompt, inputs, and duration of a clip', () => {
    const block = expansionBlock('@[第1集·第2段](vh:clip/seq1/2/vid1)', project, sources)
    expect(block).toContain('asset vid1 made by record op-shot (generate.video, done), prompt "a cat walks", duration 5 s')
    expect(block).toContain('inputs [reference=img1]')
  })

  it('returns null for text without references', () => {
    expect(expansionBlock('hello', project, sources)).toBeNull()
  })
})
