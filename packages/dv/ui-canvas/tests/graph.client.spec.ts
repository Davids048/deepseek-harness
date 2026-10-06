/** Canvas nodes and edges derived from the shared branch state. */
import { describe, expect, it } from 'vitest'
import { fixtureState, record } from '../../ui-kit/tests/fixture.client.tsx'
import { buildCanvasGraph, overlayDraft, referenceText, withImportNames } from '../src/client/graph.ts'

describe('buildCanvasGraph', () => {
  it('draws characters, locations, styles, plans, and takes, and hides reference imports, exports, still grabs, and timeline records', () => {
    const graph = buildCanvasGraph(fixtureState(), new Set(['g3']))
    expect(graph.nodes.map(node => [node.id, node.kind])).toEqual([
      ['bible:hero', 'bible'], ['plan:p1', 'plan'], ['g1', 'take'], ['g2', 'take'], ['g3', 'take'],
    ])
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    expect(byId.get('bible:hero')).toMatchObject({ thumb: 'ref.png', bibleKind: 'character', bibleId: 'hero' })
    expect(byId.get('g1')).toMatchObject({ thumb: 'shot1-last.png', video: 'shot1.mp4', durationSec: 4 })
    expect(byId.get('g2')?.flags.stale).toBe(true)
    expect(byId.get('g2')?.badges).toEqual(['trim'])
    expect(byId.get('g3')?.flags).toMatchObject({ draft: true, rendering: true })
    expect(graph.edges).toEqual([
      { from: 'bible:hero', to: 'g1', kind: 'reference' },
      { from: 'bible:hero', to: 'g2', kind: 'reference' },
      { from: 'g1', to: 'g2', kind: 'first_frame' },
      { from: 'bible:hero', to: 'g3', kind: 'reference' },
      { from: 'g1', to: 'g3', kind: 'take' },
    ])
    expect(byId.get('g2')?.x).toBeGreaterThan(byId.get('g1')?.x ?? Infinity)
    expect(byId.get('g3')?.x).toBe(byId.get('g1')?.x)
    // The original take and its retake are numbered; a shot with one take has no number.
    expect([byId.get('g1')?.take, byId.get('g3')?.take, byId.get('g2')?.take]).toEqual([1, 2, null])
    // Reference images map to their character, location or style; derived assets map up the producer chain to a drawn take.
    expect(graph.assetNodes).toMatchObject({ 'ref.png': 'bible:hero', 'shot1.mp4': 'g1', 'export.mp4': 'g2' })
  })

  it('wraps a long shot list into a block of columns without overlapping cards', () => {
    const full = fixtureState()
    const records = full.components.proj.records
    const g2 = records.find(record => record.id === 'g2')
    if (g2 === undefined) throw new Error('fixture lacks g2')
    const shots = Array.from({ length: 22 }, (_, index) => ({ ...g2, id: `s${String(index)}`, inputs: [], params: { prompt: 'p', shot: index + 1 }, outputs: [] }))
    full.components.proj.records = [...records.filter(record => record.operation !== 'shot.render'), ...shots]
    const graph = buildCanvasGraph(full)
    const takes = graph.nodes.filter(node => node.kind === 'take')
    expect(new Set(takes.map(node => `${String(node.x)},${String(node.y)}`)).size).toBe(22)
    const width = Math.max(...takes.map(node => node.x)) - Math.min(...takes.map(node => node.x))
    const height = Math.max(...takes.map(node => node.y))
    expect(width).toBeGreaterThan(0)
    expect(height).toBeLessThan(width * 2)
  })

  it('draws one node per plan with its latest version, and links each take to the plan by its shot number', () => {
    const full = fixtureState()
    const g2 = full.components.proj.records.find(record => record.id === 'g2')
    if (g2 === undefined) throw new Error('fixture lacks g2')
    const take = (id: string, version: number, shot: number): typeof g2 =>
      ({ ...g2, id, inputs: [], outputs: [], params: { prompt: id, plan: 'p1', plan_version: version, shot } })
    full.components.proj.records = [
      ...full.components.proj.records.filter(record => record.operation !== 'shot.render'),
      take('r1', 1, 1), take('r2', 1, 2), record({ id: 'q2', operation: 'plan.update', params: { plan: 'p1' }, report: { plan: 'p1', version: 2 } }),
      take('r3', 2, 3),
    ]
    const v1 = full.components.plan.plans['p1']?.[0]
    if (v1 === undefined) throw new Error('fixture lacks plan p1')
    full.components.plan.plans['p1'] = [
      v1, { ...v1, version: 2, shots: [...v1.shots, { prompt: 'hero waves' }], created_by: 'q2', approved_by: null },
    ]
    const graph = buildCanvasGraph(full)
    const plans = graph.nodes.filter(node => node.kind === 'plan')
    expect(plans.map(node => [node.id, node.planId, node.subtitle, node.record?.id])).toEqual([['plan:p1', 'p1', '3', 'q2']])
    expect(graph.nodes.filter(node => node.kind === 'take').map(node => [node.id, node.title, node.take]))
      .toEqual([['r1', '1', null], ['r2', '2', null], ['r3', '3', null]])
    expect(graph.edges.filter(edge => edge.kind === 'plan')).toEqual(['r1', 'r2', 'r3'].map(to => ({ from: 'plan:p1', to, kind: 'plan' })))
  })

  it('overlays draft records the base state lacks and flags them as drafts', () => {
    const base = fixtureState()
    base.components.proj.records = base.components.proj.records.filter(record => record.id !== 'g3')
    base.components.bible.characters = {}
    base.components.plan.plans = {}
    const draft = fixtureState()
    draft.components.proj.records = draft.components.proj.records.map(record => record.id === 'g3' ? { ...record, branch: 'main' } : record)
    const merged = overlayDraft(base, draft)
    const graph = buildCanvasGraph(merged, new Set(['g3']))
    expect(graph.nodes.find(node => node.id === 'g3')?.flags.draft).toBe(true)
    expect(merged.components.bible.characters['hero']?.length).toBe(1)
    expect(merged.components.plan.plans['p1']?.length).toBe(1)
    expect(overlayDraft(base, null)).toBe(base)
  })

  it('names an imported asset by this project\'s record, not by the shared asset pool', () => {
    const full = fixtureState()
    const [firstAsset] = full.assets
    if (firstAsset === undefined) throw new Error('fixture lacks an asset')
    full.components.proj.records.push(record({ id: 'u9', operation: 'asset.import', params: { name: 'yi-name.png' }, outputs: ['shared.png'] }))
    const state = withImportNames({ ...full, assets: [...full.assets, { ...firstAsset, id: 'shared.png', mime: 'image/png', name: 'jia-name.png' }] })
    expect(buildCanvasGraph(state).nodes.find(node => node.id === 'u9')?.title).toBe('yi-name.png')
  })

  it('writes stored input references as the reference text of an operation request', () => {
    expect([
      referenceText({ asset: 'a1' }), referenceText({ record: 'g1', output: 1 }), referenceText({ character: 'hero', version: 2 }),
      referenceText({ location: 'alley', version: 1 }), referenceText({ style: 'noir', version: 3 }),
    ]).toEqual(['a1', 'g1#1', 'hero@2', 'alley@1', 'noir@3'])
  })
})
