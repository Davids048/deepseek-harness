/** The asset pool panel's listing over synthetic branch states: names, sections, and the assets of an open draft. */
import { describe, expect, it } from 'vitest'
import type { Asset, ProjectRecord, WireState } from '../../ui-kit/src/client/types.ts'
import { fixtureState, record } from '../../ui-kit/tests/fixture.client.tsx'
import { assetLibrary } from '../src/client/library.ts'

describe('assetLibrary over a synthetic state', () => {
  /** A done record with one output. */
  const done = (id: string, operation: string, output: string, params: Record<string, unknown>, createdAt: string): ProjectRecord =>
    record({ id, turn: null, surface: 'canvas', operation, params, outputs: [output], created_at: createdAt })
  /** An asset as the asset pool first recorded it. */
  const asset = (id: string, mime: string, name: string): Asset => ({
    id, mime, name, size_bytes: 10, created_by: null, created_at: '2026-01-01T00:00:00.000Z', width: null, height: null, duration_sec: null,
  })
  /**
   * A state with the given records and assets and an empty story bible.
   * @param records - the records of the branch.
   * @param assets - the assets of the branch.
   * @returns the state.
   */
  const stateOf = (records: ProjectRecord[], assets: Asset[]): WireState => {
    const state = fixtureState()
    state.components.proj.records = records
    state.components.bible = { characters: {}, locations: {}, styles: {} }
    state.assets = assets
    return state
  }
  const records = [
    done('o1', 'asset.import', 'img', { name: 'dropped.png' }, '2026-10-05T09:00:00.000Z'),
    done('o2', 'shot.render', 'vid', {}, '2026-10-05T09:01:00.000Z'),
    done('o4', 'deliver.timeline_export', 'out', { timeline: 't1' }, '2026-10-05T09:03:00.000Z'),
  ]
  const assets = [asset('img', 'image/png', 'ref.png'), asset('vid', 'video/mp4', 'clip.mp4'), asset('out', 'video/mp4', 'export.mp4')]
  const state = stateOf(records, assets)

  it('names an imported file by this project\'s import record, not the asset pool\'s first import of the same bytes', () => {
    expect(assetLibrary(state).imported)
      .toEqual([expect.objectContaining({ id: 'img', name: 'dropped.png', created_at: '2026-10-05T09:00:00.000Z' })])
  })

  it('lists takes under the rendered section and exported timelines under the exports section', () => {
    const library = assetLibrary(state)
    expect(library.rendered.map(row => row.id)).toEqual(['vid'])
    expect(library.exports.map(row => row.id)).toEqual(['out'])
  })

  it('sorts character reference images apart from the reference images of locations and styles', () => {
    const fixture = fixtureState()
    fixture.components.bible.locations = {
      harbor: [{ id: 'harbor', version: 1, name: 'Harbor', description: '', references: ['shot1-last.png'], created_by: 'e1' }],
    }
    const library = assetLibrary(fixture)
    expect(library.characters.map(row => row.id)).toEqual(['ref.png'])
    expect(library.references.map(row => row.id)).toEqual(['shot1-last.png'])
  })

  it('lists the assets only an open draft has and flags them as drafts', () => {
    const draft = stateOf(
      [...records, done('o3', 'shot.render', 'draft-vid', {}, '2026-10-05T09:02:00.000Z')],
      [...assets, asset('draft-vid', 'video/mp4', 'draft.mp4')],
    )
    const library = assetLibrary(state, [{ branch: 'draft/s1', state: draft }])
    expect(library.rendered.map(row => row.id).sort()).toEqual(['draft-vid', 'vid'])
    expect([...library.draft]).toEqual(['draft-vid'])
  })
})
