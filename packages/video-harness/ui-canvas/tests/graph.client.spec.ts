/** Canvas nodes and edges derived from the shared folded state. */
import { describe, expect, it } from 'vitest'
import { fixtureState } from '../../ui-kit/tests/fixture.client.tsx'
import { buildCanvasGraph, overlayDraft, withImportNames } from '../src/client/graph.ts'

describe('buildCanvasGraph', () => {
  it('draws characters, locations, styles, plans, and clips, and hides imports, exports, inspections, and timeline records', () => {
    const graph = buildCanvasGraph(fixtureState(), new Set(['g3']))
    expect(graph.nodes.map(node => [node.id, node.kind])).toEqual([
      ['entity:hero', 'entity'], ['p1', 'plan'], ['g1', 'clip'], ['g2', 'clip'], ['g3', 'clip'],
    ])
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    expect(byId.get('entity:hero')?.thumb).toBe('ref.png')
    expect(byId.get('g1')).toMatchObject({ thumb: 'shot1-last.png', video: 'shot1.mp4', durationSec: 4 })
    expect(byId.get('g2')?.flags.stale).toBe(true)
    expect(byId.get('g2')?.badges).toEqual(['trim'])
    expect(byId.get('g3')?.flags).toMatchObject({ draft: true, generating: true })
    expect(graph.edges).toEqual([
      { from: 'entity:hero', to: 'g1', kind: 'ref' },
      { from: 'entity:hero', to: 'g2', kind: 'ref' },
      { from: 'g1', to: 'g2', kind: 'frame' },
      { from: 'entity:hero', to: 'g3', kind: 'ref' },
      { from: 'g1', to: 'g3', kind: 'take' },
    ])
    expect(byId.get('g2')?.x).toBeGreaterThan(byId.get('g1')?.x ?? Infinity)
    expect(byId.get('g3')?.x).toBe(byId.get('g1')?.x)
    // The original clip and its retake are numbered versions; a clip with one version has no number.
    expect([byId.get('g1')?.take, byId.get('g3')?.take, byId.get('g2')?.take]).toEqual([1, 2, null])
    // Imported references map to their character, location or style; derived assets map up the producer chain to a drawn clip.
    expect(graph.assetNodes).toMatchObject({ 'ref.png': 'entity:hero', 'shot1.mp4': 'g1', 'export.mp4': 'g2' })
  })

  it('wraps a long shot list into a block of columns without overlapping cards', () => {
    const full = fixtureState()
    const g2 = full.ops.find(op => op.id === 'g2')
    if (g2 === undefined) throw new Error('fixture lacks g2')
    const shots = Array.from({ length: 22 }, (_, index) => ({ ...g2, id: `s${String(index)}`, inputs: [], params: { prompt: 'p', shot: index + 1 }, outputs: [] }))
    const graph = buildCanvasGraph({ ...full, ops: [...full.ops.filter(op => op.tool?.name !== 'shot.render'), ...shots] })
    const clips = graph.nodes.filter(node => node.kind === 'clip')
    expect(new Set(clips.map(node => `${String(node.x)},${String(node.y)}`)).size).toBe(22)
    const width = Math.max(...clips.map(node => node.x)) - Math.min(...clips.map(node => node.x))
    const height = Math.max(...clips.map(node => node.y))
    expect(width).toBeGreaterThan(0)
    expect(height).toBeLessThan(width * 2)
  })

  it('overlays draft records the base state lacks and flags them as drafts', () => {
    const full = fixtureState()
    const base = { ...full, ops: full.ops.filter(op => op.id !== 'g3') }
    const draft = { ...full, ops: full.ops.map(op => op.id === 'g3' ? { ...op, branch: 'main' } : op) }
    const merged = overlayDraft(base, draft)
    const graph = buildCanvasGraph(merged, new Set(['g3']))
    expect(graph.nodes.find(node => node.id === 'g3')?.flags.draft).toBe(true)
    expect(overlayDraft(base, null)).toBe(base)
  })

  it('names an imported asset by this project\'s record, not by the shared asset pool', () => {
    const full = fixtureState()
    const [firstRecord] = full.ops
    const [firstAsset] = full.assets
    if (firstRecord === undefined || firstAsset === undefined) throw new Error('fixture lacks a record or an asset')
    const imported = { ...firstRecord, id: 'u9', tool: { name: 'asset.import', version: '1' }, params: { name: 'yi-name.png' }, outputs: ['shared.png'], status: 'done' as const, inputs: [] }
    const state = withImportNames({ ...full, ops: [...full.ops, imported], assets: [...full.assets, { ...firstAsset, id: 'shared.png', mime: 'image/png', name: 'jia-name.png' }] })
    expect(buildCanvasGraph(state).nodes.find(node => node.id === 'u9')?.title).toBe('yi-name.png')
  })
})
