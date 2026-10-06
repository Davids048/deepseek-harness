/** Canvas nodes and edges derived from the shared branch state. */
import { describe, expect, it } from 'vitest'
import type { PlanVersion, ProjectRecord, WireState } from '@dv/ui-kit/types.ts'
import { asset, fixtureState, record } from '../../ui-kit/tests/fixture.client.tsx'
import { buildCanvasGraph, overlayDraft, referenceText, withImportNames } from '../src/client/graph.ts'

/** Six shot prompts of plan p1 version 1; versions 2 and 3 change shot 3 and add shot 7, version 4 returns to these. */
const PROMPTS = ['rain', 'alley', 'door', 'stairs', 'roof', 'dawn']

/**
 * A project shaped like a creator's real one: plan p1 v1 with 6 shots approved and rendered (r1–r6); v2 changes shot 3
 * and adds shot 7 (s3, s7), with a retake of shot 7 (x7); v3 changes shot 5 (w5); the agent then put the v1 take of shot
 * 3 back on the timeline and wrote v4 equal to v1, whose approval reuses every v1 take. Records after `until` are left
 * out, as an undo or a jump to that record leaves the state.
 * @param until - the last record ID kept; every record by default.
 * @returns the state.
 */
function rollbackProject(until?: string): WireState {
  const hero = { role: 'reference', ref: { character: 'hero', version: 1 }, resolved_asset: 'ref.png' }
  const render = (id: string, version: number, shot: number, basedOn: string | null = null): ProjectRecord => record({
    id, operation: 'shot.render', deterministic: false, inputs: [hero], based_on: basedOn, outputs: [`${id}.mp4`, `${id}.png`],
    params: { prompt: `shot ${String(shot)} v${String(version)}`, plan: 'p1', plan_version: version, shot },
  })
  const layout = (id: string, operation: string, clips: string[]): ProjectRecord => record({
    id, operation, params: { timeline: 't1', plan: 'p1' },
    inputs: clips.map(clip => ({ role: 'clip', ref: { record: clip, output: 0 }, resolved_asset: `${clip}.mp4` })),
  })
  const approve = (id: string, version: number, scheduled: string[]): ProjectRecord =>
    record({ id, operation: 'plan.approve', params: { plan: 'p1', version }, report: { plan: 'p1', version, scheduled } })
  const v1 = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']
  const all = [
    record({ id: 'u1', operation: 'asset.import', params: { name: 'ref.png' }, outputs: ['ref.png'] }),
    record({ id: 'e1', operation: 'bible.character_create', params: { character: 'hero', name: 'Hero' } }),
    record({ id: 'q1', operation: 'plan.create', report: { plan: 'p1', version: 1 } }),
    approve('a1', 1, [...v1, 'l1']), ...v1.map((id, index) => render(id, 1, index + 1)), layout('l1', 'timeline.create', v1),
    record({ id: 'q2', operation: 'plan.update', params: { plan: 'p1' }, report: { plan: 'p1', version: 2 } }),
    approve('a2', 2, ['s3', 's7', 'l2']), render('s3', 2, 3), render('s7', 2, 7), layout('l2', 'timeline.update', ['r1', 'r2', 's3', 'r4', 'r5', 'r6', 's7']),
    render('x7', 2, 7, 's7'),
    record({ id: 'q3', operation: 'plan.update', params: { plan: 'p1' }, report: { plan: 'p1', version: 3 } }),
    approve('a3', 3, ['w5', 'l3']), render('w5', 3, 5), layout('l3', 'timeline.update', ['r1', 'r2', 's3', 'r4', 'w5', 'r6', 's7']),
    record({ id: 'k1', operation: 'timeline.clip_replace', params: { timeline: 't1', clip: 'cl3' }, inputs: [{ role: 'clip', ref: { asset: 'r3.mp4' }, resolved_asset: 'r3.mp4' }] }),
    record({ id: 'q4', operation: 'plan.update', params: { plan: 'p1' }, report: { plan: 'p1', version: 4 } }),
    approve('a4', 4, ['l4']), layout('l4', 'timeline.update', v1),
  ]
  const kept = until === undefined ? all : all.slice(0, all.findIndex(entry => entry.id === until) + 1)
  const ids = new Set(kept.map(entry => entry.id))
  const shots = (count: number, changed: Record<number, string> = {}): PlanVersion['shots'] =>
    Array.from({ length: count }, (_, index) => ({ prompt: changed[index + 1] ?? PROMPTS[index] ?? 'end' }))
  const versions: PlanVersion[] = [
    { version: 1, shots: shots(6), created_by: 'q1', approved_by: 'a1' },
    { version: 2, shots: shots(7, { 3: 'door, closer' }), created_by: 'q2', approved_by: 'a2' },
    { version: 3, shots: shots(7, { 3: 'door, closer', 5: 'roof, wider' }), created_by: 'q3', approved_by: 'a3' },
    { version: 4, shots: shots(6), created_by: 'q4', approved_by: 'a4' },
  ].filter(version => ids.has(version.created_by))
    .map(version => ({ ...version, approved_by: ids.has(version.approved_by) ? version.approved_by : null }))
  const clips = (kept.findLast(entry => entry.operation?.startsWith('timeline.') === true && entry.id.startsWith('l'))?.inputs ?? [])
    .map((input, index) => ({ id: `cl${String(index + 1)}`, asset: input.resolved_asset, source: null, in_sec: null, out_sec: null }))
  if (ids.has('k1') && !ids.has('l4')) clips[2] = { id: 'cl3', asset: 'r3.mp4', source: null, in_sec: null, out_sec: null }
  const renders = kept.filter(entry => entry.operation === 'shot.render')
  const state = fixtureState()
  state.components.proj = {
    records: kept, stale: {}, superseded: {},
    created_by: Object.fromEntries([['ref.png', 'u1'], ...renders.flatMap(entry => entry.outputs.map(output => [output, entry.id]))]),
  }
  state.components.plan.plans = { p1: versions }
  state.components.shot = { takes: {}, roots: {} }
  state.components.timeline.timelines = [{ id: 't1', name: '', clips }]
  state.assets = [
    asset('ref.png', 'image/png', 'u1'),
    ...renders.flatMap(entry => [asset(`${entry.id}.mp4`, 'video/mp4', entry.id, 1), asset(`${entry.id}.png`, 'image/png', entry.id)]),
  ]
  return state
}

/** Record order of the take IDs of {@link rollbackProject}. */
const RECORD_ORDER = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 's3', 's7', 'x7', 'w5']

/** Sort `[id, …]` entries by {@link RECORD_ORDER}. */
function byRecordOrder(a: string | string[], b: string | string[]): number {
  return RECORD_ORDER.indexOf(Array.isArray(a) ? a[0] ?? '' : a) - RECORD_ORDER.indexOf(Array.isArray(b) ? b[0] ?? '' : b)
}

/**
 * The drawn nodes of a state as `[id, kind]` pairs.
 * @param state - the state.
 * @returns the pairs, in node order.
 */
function drawn(state: WireState): string[][] {
  return buildCanvasGraph(state).nodes.map(node => [node.id, node.kind])
}

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

  it('shows the latest plan version and the current take of each of its shots, not every take ever rendered', () => {
    const graph = buildCanvasGraph(rollbackProject())
    // v4 has 6 shots and its approval reused every v1 take: no shot 7, no v2 or v3 take, no retake of the removed shot.
    expect(graph.nodes.map(node => [node.id, node.kind])).toEqual([
      ['bible:hero', 'bible'], ['plan:p1', 'plan'], ...['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map(id => [id, 'take']),
    ])
    const plan = graph.nodes.find(node => node.kind === 'plan')
    expect([plan?.subtitle, plan?.record?.id]).toEqual(['6', 'q4'])
    expect(graph.nodes.filter(node => node.kind === 'take').map(node => [node.title, node.take]))
      .toEqual(['1', '2', '3', '4', '5', '6'].map(shot => [shot, null]))
    expect(graph.edges.filter(edge => edge.kind === 'plan').map(edge => edge.to)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'])
    // Assets of takes the canvas leaves out have no node, so dropping one on the canvas finds none.
    expect(graph.assetNodes['s7.mp4']).toBeUndefined()
    expect(graph.assetNodes['r3.mp4']).toBe('r3')
  })

  it('a jump back to an earlier step changes the canvas to that step\'s plan version and takes', () => {
    // Back to just after the v3 approval: plan v3 with 7 shots, the takes its timeline plays.
    expect(drawn(rollbackProject('l3'))).toEqual([
      ['bible:hero', 'bible'], ['plan:p1', 'plan'], ...['r1', 'r2', 's3', 'r4', 's7', 'x7', 'w5', 'r6'].map(id => [id, 'take']).sort(byRecordOrder),
    ])
    // Back to just after the v1 approval: v1 and its 6 takes only.
    expect(drawn(rollbackProject('l1'))).toEqual([
      ['bible:hero', 'bible'], ['plan:p1', 'plan'], ...['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map(id => [id, 'take']),
    ])
    // Back to before the plan: the character and its reference only.
    expect(drawn(rollbackProject('e1'))).toEqual([['bible:hero', 'bible']])
  })

  it('a take a timeline clip plays is the current take of its shot, and an unapproved latest version keeps the played takes', () => {
    // After the agent put the v1 take of shot 3 back (k1), the v3 timeline plays r3 instead of s3.
    const replaced = drawn(rollbackProject('k1')).map(([id]) => id)
    expect(replaced).toContain('r3')
    expect(replaced).not.toContain('s3')
    // v4 written but not approved yet: the timeline still plays the v3 takes, so they stay; v4 has no takes of its own.
    const pending = rollbackProject('q4')
    expect(pending.components.plan.plans['p1']?.at(-1)?.approved_by).toBeNull()
    expect(drawn(pending).filter(([, kind]) => kind === 'take').map(([id]) => id)).toEqual(['r1', 'r2', 'r3', 'r4', 's7', 'w5', 'r6'].sort(byRecordOrder))
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

  it('overlays the draft as the working branch: a record undone on the draft stays out, a later base record comes in', () => {
    const base = fixtureState()
    const [firstAsset] = base.assets
    if (firstAsset === undefined) throw new Error('fixture lacks an asset')
    // Another session imported m9 on main after the draft forked at x1.
    base.components.proj.records = [
      ...base.components.proj.records.filter(record => record.id !== 'g3'),
      record({ id: 'm9', operation: 'asset.import', params: { name: 'later.png' }, outputs: ['later.png'], created_at: '2026-10-05T01:00:00Z' }),
    ]
    base.components.proj.created_by['later.png'] = 'm9'
    base.assets.push({ ...firstAsset, id: 'later.png', name: 'later.png' })
    // The draft undid g2, which main still holds from before the fork.
    const draft = fixtureState()
    draft.branch = 'draft/s5'
    draft.components.proj.records = draft.components.proj.records.filter(record => record.id !== 'g2')
    delete draft.components.proj.stale['g2']
    const merged = overlayDraft(base, draft)
    expect(merged.components.proj.records.map(record => record.id)).toEqual(expect.arrayContaining(['g3', 'm9']))
    expect(merged.components.proj.records.some(record => record.id === 'g2')).toBe(false)
    const ids = buildCanvasGraph(merged, new Set(['g3'])).nodes.map(node => node.id)
    expect(ids).toEqual(expect.arrayContaining(['g1', 'g3', 'm9']))
    expect(ids).not.toContain('g2')
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
