// @vitest-environment jsdom
/** Project card summaries: the cover, the shot count and duration, and the last edit time read from a branch state. */
import { describe, expect, it } from 'vitest'
import { fixtureState, record } from '../../ui-kit/tests/fixture.client.tsx'
import { summarizeProject } from '../src/client/cover.tsx'

describe('summarizeProject', () => {
  it('takes the video and last-frame image of the first finished render, the latest plan shots, and the last record time', () => {
    const state = fixtureState()
    for (const versions of Object.values(state.components.plan.plans)) {
      for (const shot of versions.at(-1)?.shots ?? []) shot.duration_sec = 5
    }
    expect(summarizeProject(state)).toEqual({
      cover: { video: 'shot1.mp4', image: 'shot1-last.png' },
      rendered: true,
      shots: 2,
      durationSec: 10,
      editedAt: '2026-10-05T00:00:00Z',
    })
  })

  it('skips failed renders and reports no cover without a finished render', () => {
    const state = fixtureState()
    const records = state.components.proj.records
    const failed = record({ id: 'f0', operation: 'shot.render_t2va', status: 'failed', outputs: [] })
    state.components.proj.records = [failed, ...records.filter(entry => !entry.operation?.startsWith('shot.render') || entry.id === 'g2')]
    expect(summarizeProject(state).cover).toEqual({ video: 'shot2.mp4', image: 'shot2-last.png' })
    state.components.proj.records = [failed]
    expect(summarizeProject(state).cover).toBeNull()
  })

  it('falls back to the first imported image when no render finished', () => {
    const state = fixtureState()
    state.components.proj.records = state.components.proj.records.filter(entry => !entry.operation?.startsWith('shot.render'))
    expect(summarizeProject(state)).toMatchObject({ cover: { image: 'ref.png', video: null }, rendered: false })
  })
})
