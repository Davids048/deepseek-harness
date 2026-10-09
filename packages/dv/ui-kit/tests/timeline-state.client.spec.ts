/** Timeline helpers and the state readings both views share. */
import { describe, expect, it } from 'vitest'
import { assetIndex, videoAssets } from '../src/client/state.ts'
import { formatSeconds, timelineName } from '../src/client/timeline.ts'
import { fixtureState } from './fixture.client.tsx'

describe('timeline helpers', () => {
  it('shows a stored name as is, an empty name as the numbered default, and an unnumbered ID as the ID', () => {
    const numbered = (n: number): string => `时间线 ${String(n)}`
    expect(timelineName({ id: 't1', name: '片尾' }, numbered)).toBe('片尾')
    expect(timelineName({ id: 't12', name: '' }, numbered)).toBe('时间线 12')
    expect(timelineName({ id: 'main-cut', name: '' }, numbered)).toBe('main-cut')
  })

  it('formats seconds as minutes and tenths', () => {
    expect(formatSeconds(0)).toBe('0:00.0')
    expect(formatSeconds(65.25)).toBe('1:05.3')
    expect(formatSeconds(75)).toBe('1:15.0')
  })
})

describe('state readings', () => {
  it('indexes assets and picks videos newest first', () => {
    const state = fixtureState()
    expect(assetIndex(state).get('export.mp4')?.mime).toBe('video/mp4')
    expect(videoAssets(state).map(video => video.id)).toEqual(['shot1.mp4', 'shot2.mp4', 'export.mp4'])
  })
})
