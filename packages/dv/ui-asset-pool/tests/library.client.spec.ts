/** The asset pool panel's listing over synthetic project states: media groups, order, and render stills by `made_by`. */
import { describe, expect, it } from 'vitest'
import type { ProjectAsset, WireState } from '../../ui-kit/src/client/types.ts'
import { fixtureState } from '../../ui-kit/tests/fixture.client.tsx'
import { assetLibrary } from '../src/client/library.ts'

describe('assetLibrary over a synthetic state', () => {
  /** An asset as the project sees it. */
  const asset = (id: string, mime: string, madeBy: string | null, createdAt = '2026-01-01T00:00:00.000Z'): ProjectAsset => ({
    id, mime, name: id, size_bytes: 10, created_by: null, created_at: createdAt, width: null, height: null, duration_sec: null,
    made_by: madeBy,
  })
  /**
   * A state with the given assets.
   * @param assets - the assets of the project.
   * @returns the state.
   */
  const stateOf = (assets: ProjectAsset[]): WireState => ({ ...fixtureState(), assets })
  const assets = [
    asset('img', 'image/png', 'asset.import', '2026-10-05T09:00:00.000Z'), asset('vid', 'video/mp4', 'shot.render_ref2va', '2026-10-05T09:01:00.000Z'),
    asset('out', 'video/mp4', 'deliver.timeline_export', '2026-10-05T09:03:00.000Z'),
  ]

  it('groups images and videos, newest first, and leaves out assets of other media types', () => {
    const library = assetLibrary(stateOf([
      ...assets, asset('notes', 'application/pdf', 'asset.import'), asset('older', 'video/mp4', 'asset.import', '2025-12-31T00:00:00.000Z'),
    ]))
    expect(library.images.map(row => row.id)).toEqual(['img'])
    expect(library.videos.map(row => row.id)).toEqual(['out', 'vid', 'older'])
    expect([...library.images, ...library.videos, ...library.extracted].map(row => row.id)).not.toContain('notes')
  })

  it('lists the images that shot renders made under extracted, and grabbed stills and referenced images under images', () => {
    const library = assetLibrary(stateOf([
      ...assets, asset('t2v-last', 'image/png', 'shot.render_t2va'), asset('r2v-last', 'image/png', 'shot.render_ref2va'),
      asset('grabbed', 'image/png', 'asset.grab_still'), asset('referenced', 'image/png', null),
    ]))
    expect(library.extracted.map(row => row.id).sort()).toEqual(['r2v-last', 't2v-last'])
    expect(library.images.map(row => row.id).sort()).toEqual(['grabbed', 'img', 'referenced'])
  })

  it('keeps the name and time the project gave each asset', () => {
    const named = { ...asset('img', 'image/png', 'asset.import', '2026-10-05T09:00:00.000Z'), name: 'dropped.png' }
    expect(assetLibrary(stateOf([named])).images).toEqual([named])
    expect(assetLibrary(fixtureState()).extracted.map(row => row.id).sort()).toEqual(['shot1-last.png', 'shot2-last.png'])
  })
})
