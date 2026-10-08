/** The pure `bible` reducer: versions from `bible.*` records and the two version lookups. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId, ProjectRecord, ProjectState, RecordId, RecordInput } from '@dv/project'
import { describe, expect, it } from 'vitest'
import { bibleReducer, type CharacterId, type LocationId, type StoryBibleState, type StyleId } from '../src/index.ts'

const FACE = brandString<AssetId>('face')
const COAT = brandString<AssetId>('coat')

/**
 * A finished record of one operation.
 * @param id - the record ID.
 * @param operation - the operation name.
 * @param params - its params.
 * @param references - the assets of its `reference` input.
 * @param status - its status.
 * @returns the record.
 */
function record(
  id: string, operation: string, params: Record<string, unknown>, references: AssetId[] = [], status: ProjectRecord['status'] = 'done',
): ProjectRecord {
  const inputs: RecordInput[] = references.map(asset => ({ role: 'reference', ref: { asset }, resolved_asset: asset }))
  return {
    id: brandString<RecordId>(id), parents: [], branch: 'main', kind: 'operation', component: operation.split('.')[0] ?? '', operation,
    operation_version: '1', actor: 'user', surface: 'canvas', turn: null, session: null, tool_call: null, intent: '', params, inputs,
    outputs: [], based_on: null, supersedes: [], deterministic: false, status, created_at: '2026-10-06T00:00:00.000Z',
  }
}

/**
 * @param records - the records in order.
 * @returns the slice after them.
 */
function reduceAll(records: ProjectRecord[]): StoryBibleState {
  return records.reduce((slice, entry) => bibleReducer.reduce(slice, entry), bibleReducer.initial())
}

describe('bibleReducer', () => {
  it('writes version 1 on create and the next version on each update, for every kind', () => {
    const slice = reduceAll([
      record('r1', 'bible.character_create', { character: 'c1', name: 'Lead', description: 'red coat' }, [FACE]),
      record('r2', 'bible.character_update', { character: 'c1', description: 'blue coat' }),
      record('r3', 'bible.character_update', { character: 'c1', name: 'Hero' }, [COAT]),
      record('r4', 'bible.location_create', { location: 'l1', name: 'Beach' }),
      record('r5', 'bible.style_create', { style: 's1', name: 'Film', description: 'grain' }, [COAT]),
      record('r6', 'bible.style_update', { style: 's1', name: 'Film 2' }),
      record('r7', 'bible.location_update', { location: 'l1', name: 'Shore' }, [FACE]),
    ])
    expect(slice.characters).toEqual({
      c1: [
        { id: 'c1', version: 1, name: 'Lead', description: 'red coat', references: [FACE], created_by: 'r1' },
        { id: 'c1', version: 2, name: 'Lead', description: 'blue coat', references: [FACE], created_by: 'r2' },
        { id: 'c1', version: 3, name: 'Hero', description: 'blue coat', references: [COAT], created_by: 'r3' },
      ],
    })
    expect(slice.locations).toEqual({
      l1: [
        { id: 'l1', version: 1, name: 'Beach', description: '', references: [], created_by: 'r4' },
        { id: 'l1', version: 2, name: 'Shore', description: '', references: [FACE], created_by: 'r7' },
      ],
    })
    expect(slice.styles['s1' as StyleId]?.map(version => [version.version, version.name, version.description, version.references]))
      .toEqual([[1, 'Film', 'grain', [COAT]], [2, 'Film 2', 'grain', [COAT]]])
  })

  it('ignores records of other components and records that did not finish done', () => {
    const initial = bibleReducer.initial()
    for (const entry of [
      record('r1', 'timeline.create', { character: 'c1' }),
      record('r2', 'bible.character_create', { character: 'c1', name: 'Lead' }, [], 'failed'),
      record('r3', 'bible.character_create', { character: 'c1', name: 'Lead' }, [], 'pending'),
    ]) expect(bibleReducer.reduce(initial, entry)).toBe(initial)
  })

  it('answers assetsOf and createdBy for each kind and null for unknown versions and other refs', () => {
    const slice = reduceAll([
      record('r1', 'bible.character_create', { character: 'c1', name: 'Lead' }, [FACE]),
      record('r2', 'bible.character_update', { character: 'c1' }, [COAT, FACE]),
      record('r3', 'bible.location_create', { location: 'l1', name: 'Beach' }, [COAT]),
      record('r4', 'bible.style_create', { style: 's1', name: 'Film' }),
    ])
    const c1 = brandString<CharacterId>('c1')
    expect(bibleReducer.assetsOf?.(slice, { character: c1, version: 1 })).toEqual([FACE])
    expect(bibleReducer.assetsOf?.(slice, { character: c1, version: 2 })).toEqual([COAT, FACE])
    expect(bibleReducer.createdBy?.(slice, { character: c1, version: 2 })).toBe('r2')
    expect(bibleReducer.assetsOf?.(slice, { location: brandString<LocationId>('l1'), version: 1 })).toEqual([COAT])
    expect(bibleReducer.createdBy?.(slice, { style: brandString<StyleId>('s1'), version: 1 })).toBe('r4')
    expect(bibleReducer.assetsOf?.(slice, { character: c1, version: 3 })).toBeNull()
    expect(bibleReducer.createdBy?.(slice, { location: brandString<LocationId>('c1'), version: 1 })).toBeNull()
    expect(bibleReducer.assetsOf?.(slice, { asset: FACE })).toBeNull()
    expect(bibleReducer.createdBy?.(slice, { record: brandString<RecordId>('r1'), output: 0 })).toBeNull()
  })

  it('lists the latest version of each character, location and style in the agent summary', () => {
    const slice = reduceAll([
      record('c', 'bible.character_create', { character: 'c1', name: 'Hero', description: 'red coat' }, [FACE]),
      record('u', 'bible.character_update', { character: 'c1', description: 'blue coat' }),
      record('l', 'bible.location_create', { location: 'l1', name: 'Pier' }, [COAT]),
    ])
    expect(bibleReducer.agentSummary?.(slice, { url: asset => `/dv/assets/${asset}` }, {} as ProjectState)).toEqual({
      characters: [{ id: 'c1', version: 2, name: 'Hero', description: 'blue coat', references: [FACE] }],
      locations: [{ id: 'l1', version: 1, name: 'Pier', description: '', references: [COAT] }],
      styles: [],
    })
  })
})
