/** The 原声 track's peak computation, the track-area height clamp, and the skip target, as pure functions. */
import { describe, expect, it } from 'vitest'
import { clampTrackHeight } from '../src/client/TimelineEditor.tsx'
import { skipTarget } from '../src/client/timelines.ts'
import { clipPeaks, peakEnvelope } from '../src/client/waveform.ts'

describe('peakEnvelope', () => {
  it('keeps the largest absolute sample of each window across all channels', () => {
    // 8 samples per second, 2 windows per second: windows of 4 samples.
    const left = [0.1, -0.5, 0.2, 0, 0, 0, 0.3, 0]
    const right = [0, 0.2, 0, 0, -0.9, 0, 0, 0]
    const envelope = peakEnvelope([left, right], 8, 2)
    expect(Array.from(envelope.peaks)).toEqual([0.5, 0.9].map(Math.fround))
    expect(envelope.rate).toBe(2)
    expect(envelope.max).toBeCloseTo(0.9)
  })

  it('gives a partial last window its own peak and an empty buffer no windows', () => {
    expect(Array.from(peakEnvelope([[0.25, 0, 0, 0, -0.5]], 4, 1).peaks)).toEqual([0.25, 0.5])
    expect(peakEnvelope([], 8, 2)).toEqual({ peaks: new Float32Array(0), rate: 2, max: 0 })
  })
})

describe('clipPeaks', () => {
  // Ten windows per second over two seconds: 0.0, 0.1, … 1.0 at window 10, then 0.5 to the end.
  const peaks = Float32Array.from({ length: 20 }, (_, at) => at <= 10 ? at / 10 : 0.5)
  const envelope = { peaks, rate: 10, max: 1 }

  it('splits the played range into bars, each the largest peak inside it relative to the asset peak', () => {
    expect(clipPeaks(envelope, 0, 2, 4).map(peak => Math.round(peak * 100) / 100)).toEqual([0.4, 0.9, 1, 0.5])
    expect(clipPeaks({ ...envelope, max: 2 }, 0, 2, 2).map(peak => Math.round(peak * 100) / 100)).toEqual([0.45, 0.5])
  })

  it('reads only the trimmed range between the in and out points', () => {
    expect(clipPeaks(envelope, 0.2, 0.4, 2).map(peak => Math.round(peak * 100) / 100)).toEqual([0.2, 0.3])
  })

  it('repeats a window for bars narrower than it, and reads silence past the decoded audio', () => {
    expect(clipPeaks(envelope, 0.5, 0.6, 4).map(peak => Math.round(peak * 100) / 100)).toEqual([0.5, 0.5, 0.5, 0.5])
    expect(clipPeaks(envelope, 2, 3, 2)).toEqual([0, 0])
  })

  it('returns no bars for an empty range and zeros for silent audio', () => {
    expect(clipPeaks(envelope, 1, 1, 4)).toEqual([])
    expect(clipPeaks(envelope, 0, 1, 0)).toEqual([])
    expect(clipPeaks({ peaks: new Float32Array(10), rate: 10, max: 0 }, 0, 1, 2)).toEqual([0, 0])
  })
})

describe('clampTrackHeight', () => {
  it('keeps at least 160 px for the preview and at least the track rows\' own height', () => {
    expect(clampTrackHeight(300, 800, 220)).toBe(300)
    expect(clampTrackHeight(700, 800, 220)).toBe(640)
    expect(clampTrackHeight(100, 800, 220)).toBe(220)
    // A short editor gives the track rows their height and the preview the rest.
    expect(clampTrackHeight(300, 300, 220)).toBe(220)
  })
})

describe('skipTarget', () => {
  it('moves the playhead by the skip and clamps it to the timeline', () => {
    expect(skipTarget(3, 5, 30)).toBe(8)
    expect(skipTarget(28, 5, 30)).toBe(30)
    expect(skipTarget(3, -5, 30)).toBe(0)
    expect(skipTarget(0, 5, 0)).toBe(0)
  })
})
