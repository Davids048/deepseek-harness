import { brandString } from '@deepseek-ai/dsh-brand'
import { MAIN_BRANCH, type AssetId, type EntityId, type Op, type OpId, type ProjectId, type TurnId } from '@video-harness/oplog'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SEQUENCE_ID, ENTITY_UPDATE_TOOL, foldChain, inputAsset, parseEntityRef, parseEntityTool, parseOutputRef, SEQUENCE_TOOLS } from '../src/index.ts'

const projectId = brandString<ProjectId>('p')
const turn = brandString<TurnId>('t')
let counter = 0

/** A done record with the given fields, chained after the previous one. */
function record(parent: Op | null, fields: Partial<Op>): Op {
  counter += 1
  return {
    id: brandString<OpId>(`op-${counter}`), parents: parent === null ? [] : [parent.id], turn, branch: MAIN_BRANCH, actor: 'user', surface: 'api',
    intent: 'x', kind: 'tool', inputs: [], params: {}, outputs: [], status: 'done', deterministic: true, created_at: new Date().toISOString(), ...fields,
  }
}

describe('fold helpers', () => {
  it('parses references and tool names', () => {
    expect(parseEntityRef('c1@2')).toEqual({ entity: 'c1', version: 2 })
    expect(parseEntityRef(brandString<AssetId>('c1@x'))).toBeNull()
    expect(parseEntityRef('@1')).toBeNull()
    expect(parseOutputRef('op#1')).toEqual({ op: 'op', index: 1 })
    expect(parseOutputRef('op#-1')).toBeNull()
    expect(parseOutputRef(brandString<AssetId>('op#x'))).toBeNull()
    expect(parseOutputRef(brandString<AssetId>('plain'))).toBeNull()
    expect(parseEntityTool('entity.style.update')).toEqual({ action: 'update', kind: 'style' })
    expect(parseEntityTool('entity.create')).toEqual({ action: 'create', kind: null })
    expect(parseEntityTool(undefined)).toBeNull()
    expect(inputAsset({ role: 'r', ref: brandString<AssetId>('a'), resolved: null })).toBe('a')
    expect(inputAsset({ role: 'r', ref: 'c1@1', resolved: null })).toBeNull()
    expect(inputAsset({ role: 'r', ref: 'op#0', resolved: null })).toBeNull()
    expect(inputAsset({ role: 'r', ref: 'op#0', resolved: brandString<AssetId>('b') })).toBe('b')
  })

  it('folds handcrafted chains: first-version updates, open ranges, and late intents', () => {
    expect(() => foldChain(projectId, [], null)).toThrow('empty chain')
    const start = record(null, { kind: 'intent', intent: '' })
    const update = record(start, { tool: { name: ENTITY_UPDATE_TOOL, version: '1' }, params: { entity: 'c1', refs: ['a'] } })
    const create = record(update, { tool: { name: SEQUENCE_TOOLS.create, version: '1' }, params: { assets: ['a', 'b'] } })
    const range = record(create, { tool: { name: SEQUENCE_TOOLS.setRange, version: '1' }, params: { slot: 1 } })
    const move = record(range, { tool: { name: SEQUENCE_TOOLS.move, version: '1' }, params: { from: 9, to: 1 } })
    const bare = record(move, { tool: { name: ENTITY_UPDATE_TOOL, version: '1' }, params: { entity: 'c2' } })
    const late = record(bare, { kind: 'intent', intent: 'the words' })
    const state = foldChain(projectId, [start, update, create, range, move, bare, late], null)
    expect(state.entities[brandString<EntityId>('c1')]).toEqual([{ kind: 'character', version: 1, name: 'c1', description: '', refs: ['a'], updatedBy: update.id }])
    expect(state.entities[brandString<EntityId>('c2')]?.[0]).toMatchObject({ refs: [], name: 'c2' })
    expect(state.sequence?.items.map(item => item.assetId)).toEqual(['a', 'b'])
    expect(state.sequence?.items[0]).toEqual({ slot: 1, assetId: 'a', inSec: null, outSec: null })
    expect(state.turns[turn]?.intent).toBe('the words')
  })

  it('folds several videos: named creates add, unnamed edits hit the first video, split keeps the asset', () => {
    const seq = (parent: Op | null, name: string, params: Record<string, unknown>): Op => record(parent, { tool: { name, version: '1' }, params })
    const first = seq(null, SEQUENCE_TOOLS.create, { assets: ['a', 'b'] })
    const second = seq(first, SEQUENCE_TOOLS.create, { sequence: 'v2', title: 'B side', assets: ['c'] })
    const split = seq(second, SEQUENCE_TOOLS.split, { sequence: 'v2', slot: 1, atSec: 2 })
    const bad = seq(split, SEQUENCE_TOOLS.split, { slot: 9, atSec: 1 })
    const edit = seq(bad, SEQUENCE_TOOLS.remove, { slot: 2 })
    const retitle = seq(edit, SEQUENCE_TOOLS.create, { sequence: 'v2', assets: ['d'] })
    const unknown = seq(retitle, 'sequence.unknown', {})
    const state = foldChain(projectId, [first, second, split, bad, edit, unknown], null)
    expect(state.sequences.map(sequence => [sequence.id, sequence.title])).toEqual([[DEFAULT_SEQUENCE_ID, '第 1 集'], ['v2', 'B side']])
    expect(state.sequence?.items.map(item => item.assetId)).toEqual(['a'])
    expect(state.sequences[1]?.items).toEqual([
      { slot: 1, assetId: 'c', inSec: null, outSec: 2 },
      { slot: 2, assetId: 'c', inSec: 2, outSec: null },
    ])
    const replaced = foldChain(projectId, [first, second, split, bad, edit, retitle, unknown], null)
    expect(replaced.sequences[1]).toEqual({ id: 'v2', title: 'B side', items: [{ slot: 1, assetId: 'd', inSec: null, outSec: null }] })
    expect(foldChain(projectId, [seq(null, SEQUENCE_TOOLS.remove, { slot: 1 })], null).sequences).toEqual([])
  })

  it('renames a video and deletes only the video a delete names', () => {
    const seq = (parent: Op | null, name: string, params: Record<string, unknown>): Op => record(parent, { tool: { name, version: '1' }, params })
    const first = seq(null, SEQUENCE_TOOLS.create, { assets: ['a'] })
    const second = seq(first, SEQUENCE_TOOLS.create, { sequence: 'v2', title: '第 2 集', assets: [] })
    const rename = seq(second, SEQUENCE_TOOLS.rename, { sequence: 'v2', title: '片尾' })
    const unnamed = seq(rename, SEQUENCE_TOOLS.delete, {})
    const remove = seq(unnamed, SEQUENCE_TOOLS.delete, { sequence: 'v1' })
    expect(foldChain(projectId, [first, second, rename, unnamed], null).sequences.map(sequence => [sequence.id, sequence.title])).toEqual([[DEFAULT_SEQUENCE_ID, '第 1 集'], ['v2', '片尾']])
    const state = foldChain(projectId, [first, second, rename, unnamed, remove], null)
    expect(state.sequences.map(sequence => sequence.id)).toEqual(['v2'])
    expect(state.sequence?.items).toEqual([])
  })

  it('creates the video an insert names when the project has none', () => {
    const insert = record(null, { tool: { name: SEQUENCE_TOOLS.insert, version: '1' }, params: { at: 1, asset: 'a' } })
    expect(foldChain(projectId, [insert], null).sequences).toEqual([
      { id: DEFAULT_SEQUENCE_ID, title: '第 1 集', items: [{ slot: 1, assetId: 'a', inSec: null, outSec: null }] },
    ])
  })
})
