/** Track geometry and the state readings both views share. */
import { describe, expect, it } from 'vitest'
import { assetIndex, branchNames, openDrafts, videoAssets } from '../src/client/state.ts'
import { clipSeconds, FALLBACK_CLIP_SECONDS, formatSeconds, placeClips } from '../src/client/timeline.ts'
import { asset, fixtureState } from './fixture.client.tsx'

describe('placeClips', () => {
  it('lays clips end to end, sized by range, duration, or the fallback, with the producer\'s last frame', () => {
    const state = fixtureState()
    state.sequence?.items.push({ slot: 3, assetId: 'unknown.mp4', inSec: null, outSec: null })
    const { clips, width } = placeClips(state, 10)
    const facts = clips.map(clip => [clip.slot, clip.seconds, clip.x, clip.width, clip.thumbnail, clip.stale, clip.draft, clip.producer])
    expect(facts).toEqual([
      [1, 4, 0, 40, 'shot1-last.png', false, false, 'g1'],
      [2, 3, 40, 30, 'shot2-last.png', true, false, 'g2'],
      [3, FALLBACK_CLIP_SECONDS, 70, 50, null, false, false, null],
    ])
    expect(width).toBe(120)
  })

  it('marks clips of a draft record and keeps slot order', () => {
    const state = fixtureState()
    state.sequence = { items: [{ slot: 2, assetId: 'shot1.mp4', inSec: 1, outSec: 1 }, { slot: 1, assetId: 'draft.mp4', inSec: null, outSec: null }] }
    state.assets.push(asset('draft.mp4', 'video/mp4', 'g3', 2))
    state.producers['draft.mp4'] = 'g3'
    const { clips } = placeClips(state, 1)
    expect(clips.map(clip => [clip.slot, clip.draft, clip.seconds])).toEqual([[1, true, 2], [2, false, 0.1]])
    expect(placeClips({ ...state, sequence: null }, 1)).toEqual({ clips: [], width: 0 })
  })

  it('reads a clip range against the asset duration', () => {
    expect(clipSeconds({ slot: 1, assetId: 'a', inSec: null, outSec: null }, undefined)).toBe(FALLBACK_CLIP_SECONDS)
    expect(clipSeconds({ slot: 1, assetId: 'a', inSec: 2, outSec: null }, asset('a', 'video/mp4', null, 10))).toBe(8)
    expect(formatSeconds(0)).toBe('0:00.0')
    expect(formatSeconds(65.25)).toBe('1:05.3')
    expect(formatSeconds(75)).toBe('1:15.0')
  })
})

describe('state readings', () => {
  it('lists open drafts, orders branches, indexes assets, and picks videos newest first', () => {
    const state = fixtureState()
    expect(openDrafts(state)).toEqual([{ turn: 't5', branch: 'draft/t5', intent: 'retake shot 1', ops: 1 }])
    state.heads['draft/t7'] = 'x'
    state.openTurns.push('t7')
    expect(openDrafts(state).map(draft => [draft.turn, draft.intent, draft.ops])).toEqual([['t5', 'retake shot 1', 1], ['t7', '', 0]])
    // A rejected or stopped draft keeps its head, and its reject record is not on `main`; the server no longer lists it as open.
    state.openTurns.splice(state.openTurns.indexOf('t5'), 1)
    expect(openDrafts(state).map(draft => draft.turn)).toEqual(['t7'])
    state.openTurns.push('t5')
    expect(branchNames(state)).toEqual(['main', 'style-b', 'draft/t5', 'draft/t6', 'draft/t7'])
    expect(assetIndex(state).get('cut.mp4')?.mime).toBe('video/mp4')
    expect(videoAssets(state).map(video => video.id)).toEqual(['shot1.mp4', 'shot2.mp4', 'cut.mp4'])
  })
})
