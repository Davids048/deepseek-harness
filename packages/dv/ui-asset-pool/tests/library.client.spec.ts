/** The asset pool panel's listing over synthetic project states: names, media groups, render stills, and undone records. */
import { describe, expect, it } from 'vitest'
import type { Asset, ProjectRecord, WireState } from '../../ui-kit/src/client/types.ts'
import { fixtureState, record } from '../../ui-kit/tests/fixture.client.tsx'
import { assetLibrary } from '../src/client/library.ts'

describe('assetLibrary over a synthetic state', () => {
  /** A done record with one output. */
  const done = (id: string, operation: string, output: string, params: Record<string, unknown>, createdAt: string): ProjectRecord =>
    record({ id, turn: null, surface: 'canvas', operation, params, outputs: [output], created_at: createdAt })
  /** An asset as the asset pool first recorded it. */
  const asset = (id: string, mime: string, name: string, createdAt = '2026-01-01T00:00:00.000Z'): Asset => ({
    id, mime, name, size_bytes: 10, created_by: null, created_at: createdAt, width: null, height: null, duration_sec: null,
  })
  /**
   * A state with the given records and assets and an empty story bible.
   * @param records - the records of the current state.
   * @param assets - the assets of the project.
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
    done('o2', 'shot.render_ref2va', 'vid', {}, '2026-10-05T09:01:00.000Z'),
    done('o4', 'deliver.timeline_export', 'out', { timeline: 't1' }, '2026-10-05T09:03:00.000Z'),
  ]
  const assets = [
    asset('img', 'image/png', 'ref.png'), asset('vid', 'video/mp4', 'clip.mp4'),
    asset('out', 'video/mp4', 'export.mp4', '2026-01-02T00:00:00.000Z'),
  ]
  const state = stateOf(records, assets)

  it('names an imported file by this project\'s import record, not the asset pool\'s first import of the same bytes', () => {
    expect(assetLibrary(state).images)
      .toEqual([expect.objectContaining({ id: 'img', name: 'dropped.png', created_at: '2026-10-05T09:00:00.000Z' })])
  })

  it('groups images and videos, newest first, and leaves out assets of other media types', () => {
    const library = assetLibrary(stateOf(records, [
      ...assets, asset('notes', 'application/pdf', 'notes.pdf'), asset('older', 'video/mp4', 'older.mp4', '2025-12-31T00:00:00.000Z'),
    ]))
    expect(library.images.map(row => row.id)).toEqual(['img'])
    expect(library.videos.map(row => row.id)).toEqual(['out', 'vid', 'older'])
    expect([...library.images, ...library.videos, ...library.extracted].map(row => row.id)).not.toContain('notes')
  })

  it('lists the images that shot renders output under extracted and the stills of asset.grab_still under images', () => {
    const library = assetLibrary(stateOf([
      ...records,
      record({ id: 'o5', turn: null, surface: 'canvas', operation: 'shot.render_t2va', params: {}, outputs: ['vid2', 'vid2-last'] }),
      done('o6', 'asset.grab_still', 'grabbed', { at: 'first' }, '2026-10-05T09:04:00.000Z'),
    ], [
      ...assets, asset('vid2', 'video/mp4', 'take.mp4'), asset('vid2-last', 'image/png', 'take-last.png'),
      asset('grabbed', 'image/png', 'grab.png'),
    ]))
    expect(library.extracted.map(row => row.id)).toEqual(['vid2-last'])
    expect(library.images.map(row => row.id).sort()).toEqual(['grabbed', 'img'])
    expect(library.videos.map(row => row.id)).toContain('vid2')
  })

  it('lists an image that a character references under images', () => {
    const library = assetLibrary(fixtureState())
    expect(library.images.map(row => row.id)).toContain('ref.png')
  })

  it('reads the records an undo went back past for the render stills and import names of the project\'s other assets', () => {
    // The state lists every asset of the project; o7 and o8 are history records outside the current state.
    const project = stateOf(records, [
      ...assets, asset('later-vid', 'video/mp4', 'take.mp4'), asset('later-still', 'image/png', 'take-last.png'),
      asset('later-img', 'image/png', 'pool.png'),
    ])
    const history = [
      record({ id: 'o7', turn: null, surface: 'canvas', operation: 'shot.render_ref2va', params: {}, outputs: ['later-vid', 'later-still'] }),
      done('o8', 'asset.import', 'later-img', { name: 'later.png' }, '2026-10-05T09:08:00.000Z'),
      // A record of the state may repeat in the history list.
      ...records,
    ]
    const library = assetLibrary(project, history)
    expect(library.videos.map(row => row.id).sort()).toEqual(['later-vid', 'out', 'vid'])
    expect(library.extracted.map(row => row.id)).toEqual(['later-still'])
    expect(library.images).toEqual([
      expect.objectContaining({ id: 'later-img', name: 'later.png' }), expect.objectContaining({ id: 'img', name: 'dropped.png' }),
    ])
  })
})
