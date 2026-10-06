/** The graph: which records become nodes, where the edges come from, and how the layers fall. */
import { describe, expect, it } from 'vitest'
import { buildDag, DAG_METRICS, layoutDag, opLabel } from '../src/client/dag.ts'
import { fixtureState, op } from './fixture.client.tsx'

describe('buildDag', () => {
  it('hides bookkeeping records and collapses an approved plan into one node', () => {
    const dag = buildDag(fixtureState())
    const ids = dag.nodes.map(node => node.id)
    expect(ids).toEqual(['entity:hero', 'u1', 'e1', 'p1', 'c1', 'x1', 'g3'])
    const plan = dag.nodes.find(node => node.id === 'p1')
    expect(plan?.kind).toBe('plan')
    expect(plan?.children).toEqual(['g1', 'g2', 's1'])
    expect(plan?.detail).toBe('plan')
    // The join's clip came from a hidden child, so the edge comes from the plan.
    expect(dag.edges).toContainEqual({ from: 'p1', to: 'c1', label: 'clip', asset: 'shot2.mp4' })
    // The probe's input is the join's output.
    expect(dag.edges).toContainEqual({ from: 'c1', to: 'x1', label: 'media', asset: 'cut.mp4' })
    // The entity edge points at the retake on the draft branch.
    expect(dag.edges).toContainEqual({ from: 'entity:hero', to: 'g3', label: 'reference', asset: 'ref.png' })
    const take = dag.nodes.find(node => node.id === 'g3')
    expect(take).toMatchObject({ draft: true, takeOf: 'g1', status: 'running', actor: 'agent' })
    expect(dag.nodes.find(node => node.id === 'c1')).toMatchObject({ superseded: true, stale: false })
    expect(dag.nodes.find(node => node.id === 'entity:hero')).toMatchObject({ kind: 'entity', label: 'Hero', detail: 'character @1', status: 'entity' })
  })

  it('shows a plan\'s children when expanded, with plan edges and the asset flow between them', () => {
    const dag = buildDag(fixtureState(), new Set(['p1']))
    const ids = dag.nodes.map(node => node.id)
    expect(ids).toContain('g1')
    expect(ids).toContain('g2')
    expect(ids).toContain('s1')
    expect(dag.edges).toContainEqual({ from: 'p1', to: 'g1', label: 'plan', asset: null })
    expect(dag.edges).toContainEqual({ from: 'g1', to: 'g2', label: 'first_frame', asset: 'shot1-last.png' })
    expect(dag.edges).toContainEqual({ from: 'g2', to: 'c1', label: 'clip', asset: 'shot2.mp4' })
    expect(dag.nodes.find(node => node.id === 'g2')?.stale).toBe(true)
    // The entity feeds both shots; the two edges differ by target and stay.
    expect(dag.edges.filter(edge => edge.from === 'entity:hero').map(edge => edge.to)).toEqual(['g1', 'g2', 'g3'])
  })

  it('skips self references, unknown producers, and empty entity histories, and dedupes repeated edges', () => {
    const state = fixtureState()
    state.entities['ghost'] = []
    state.ops.push(op({ id: 'loop', tool: { name: 'media.probe', version: '1' }, inputs: [{ role: 'clip', ref: 'loop#0', resolved: 'self.mp4' }, { role: 'clip', ref: 'external.mp4', resolved: null }, { role: 'clip', ref: 'cut.mp4', resolved: 'cut.mp4' }, { role: 'clip', ref: 'cut.mp4', resolved: 'cut.mp4' }], outputs: ['self.mp4'] }))
    const dag = buildDag(state)
    expect(dag.nodes.some(node => node.id === 'entity:ghost')).toBe(false)
    const incoming = dag.edges.filter(edge => edge.to === 'loop')
    expect(incoming).toEqual([{ from: 'c1', to: 'loop', label: 'clip', asset: 'cut.mp4' }])
  })

  it('falls back to the fold\'s producer table for assets whose producer is visible but recorded later', () => {
    const state = fixtureState()
    state.ops.push(op({ id: 'late', tool: { name: 'media.probe', version: '1' }, inputs: [{ role: 'clip', ref: 'future.mp4', resolved: 'future.mp4' }] }))
    state.ops.push(op({ id: 'maker', tool: { name: 'asset.upload', version: '1' }, outputs: ['future.mp4'] }))
    state.producers['future.mp4'] = 'maker'
    expect(buildDag(state).edges).toContainEqual({ from: 'maker', to: 'late', label: 'clip', asset: 'future.mp4' })
  })
})

describe('opLabel', () => {
  it('prefers the prompt, then the tool, then the kind', () => {
    expect(opLabel(op({ id: 'a', params: { prompt: 'short' } }))).toBe('short')
    expect(opLabel(op({ id: 'b', params: { prompt: 'hero walks through the rain at night in the city' } }))).toBe('hero walks through the rain …')
    expect(opLabel(op({ id: 'c', tool: { name: 'media.probe', version: '1' } }))).toBe('media.probe')
    expect(opLabel(op({ id: 'e', kind: 'branch' }))).toBe('branch')
  })
})

describe('layoutDag', () => {
  it('places each node one layer right of its longest input chain and sizes the drawing', () => {
    const layout = layoutDag(buildDag(fixtureState(), new Set(['p1'])))
    const layerOf = (id: string): number | undefined => layout.nodes.find(node => node.id === id)?.layer
    expect(layerOf('entity:hero')).toBe(0)
    expect(layerOf('p1')).toBe(0)
    expect(layerOf('g1')).toBe(1)
    expect(layerOf('g2')).toBe(2)
    expect(layerOf('c1')).toBe(3)
    expect(layerOf('x1')).toBe(4)
    expect(layout.width).toBe(DAG_METRICS.padding * 2 + 5 * DAG_METRICS.width + 4 * DAG_METRICS.gapX)
    const column0 = layout.nodes.filter(node => node.layer === 0)
    const rowY = (row: number): number => DAG_METRICS.padding + row * (DAG_METRICS.height + DAG_METRICS.gapY)
    expect(column0.map(node => node.y)).toEqual(column0.map((_, row) => rowY(row)))
    expect(layout.height).toBe(DAG_METRICS.padding * 2 + column0.length * DAG_METRICS.height + (column0.length - 1) * DAG_METRICS.gapY)
  })

  it('treats an edge from or to a node outside the graph as absent', () => {
    const node = { id: 'a', kind: 'op' as const, label: 'a', detail: '', status: 'done' as const, stale: false, superseded: false, draft: false, actor: 'user' as const, children: [], takeOf: null, op: null, entity: null }
    const layout = layoutDag({ nodes: [node], edges: [{ from: 'ghost', to: 'a', label: 'x', asset: null }, { from: 'a', to: 'ghost', label: 'y', asset: null }] })
    expect(layout.nodes.map(placed => placed.layer)).toEqual([1])
  })

  it('survives a cycle and an empty graph', () => {
    const cyclic = layoutDag({
      nodes: [
        { id: 'a', kind: 'op', label: 'a', detail: '', status: 'done', stale: false, superseded: false, draft: false, actor: 'user', children: [], takeOf: null, op: null, entity: null },
        { id: 'b', kind: 'op', label: 'b', detail: '', status: 'done', stale: false, superseded: false, draft: false, actor: 'user', children: [], takeOf: null, op: null, entity: null },
      ],
      edges: [{ from: 'a', to: 'b', label: 'x', asset: null }, { from: 'b', to: 'a', label: 'y', asset: null }],
    })
    expect(cyclic.nodes.map(node => node.layer)).toEqual([2, 1])
    const empty = layoutDag({ nodes: [], edges: [] })
    expect(empty).toEqual({
      nodes: [], edges: [], width: DAG_METRICS.padding * 2 + DAG_METRICS.width, height: DAG_METRICS.padding * 2 + DAG_METRICS.height,
    })
  })
})
