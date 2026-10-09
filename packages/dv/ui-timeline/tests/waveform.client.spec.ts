// @vitest-environment jsdom
/**
 * The 原声 track's peak computation and envelope cache, the track-area height clamp, and the skip target. The cache tests
 * stub `fetch` and `OfflineAudioContext` and run on fake timers, so each retry delay passes on demand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { clampTrackHeight } from '../src/client/TimelineEditor.tsx'
import { skipTarget } from '../src/client/timelines.ts'
import { clipPeaks, peakEnvelope, useAudioEnvelope } from '../src/client/waveform.ts'

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

describe('useAudioEnvelope', () => {
  /** A media file body that the stub decoder rejects, as `decodeAudioData` rejects a file without an audio track. */
  const NO_AUDIO = 'no audio'
  /** One answer of the stub `fetch`: a network failure, or a status with a body. */
  type Answer = 'network' | { status: number; body?: string }
  let answers: Answer[] = []
  const fetchStub = vi.fn((url: string) => {
    void url
    const answer = answers.length > 1 ? answers.shift() : answers[0]
    if (answer === undefined || answer === 'network') return Promise.reject(new TypeError('Failed to fetch'))
    const bytes = new TextEncoder().encode(answer.body ?? 'audio').buffer
    return Promise.resolve({ ok: answer.status < 300, status: answer.status, arrayBuffer: () => Promise.resolve(bytes) })
  })
  /** A stand-in decoder: one second of samples at 0.5, or a rejection for the {@link NO_AUDIO} body. */
  class StubAudioContext {
    decodeAudioData(bytes: ArrayBuffer): Promise<unknown> {
      if (new TextDecoder().decode(bytes) === NO_AUDIO) return Promise.reject(new DOMException('no audio track', 'EncodingError'))
      const samples = new Float32Array(100).fill(0.5)
      return Promise.resolve({ numberOfChannels: 1, length: 100, sampleRate: 100, getChannelData: () => samples })
    }
  }
  /**
   * Let fake time pass, then 1 ms more: a retry waits for idle time on a zero-delay timer, which the fake clock sets
   * 1 ms ahead when a timer callback schedules it.
   */
  const advance = async (ms: number): Promise<void> => {
    await act(() => vi.advanceTimersByTimeAsync(ms))
    await act(() => vi.advanceTimersByTimeAsync(1))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('OfflineAudioContext', StubAudioContext)
    fetchStub.mockClear()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('asks again after a network failure and after a 5xx answer while the clip stays mounted', async () => {
    answers = ['network', { status: 503 }, { status: 200 }]
    const { result } = renderHook(() => useAudioEnvelope('flaky.mp4'))
    await advance(0)
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(result.current).toBeNull()
    await advance(2000)
    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(result.current).toBeNull()
    await advance(8000)
    expect(fetchStub).toHaveBeenCalledTimes(3)
    expect(result.current?.max).toBe(0.5)
  })

  it('stops asking after the last retry delay, and a later mount fetches the file again', async () => {
    answers = ['network']
    const first = renderHook(() => useAudioEnvelope('offline.mp4'))
    await advance(0)
    await advance(2000)
    await advance(8000)
    await advance(30000)
    expect(fetchStub).toHaveBeenCalledTimes(4)
    await advance(60000)
    expect(fetchStub).toHaveBeenCalledTimes(4)
    expect(first.result.current).toBeNull()
    first.unmount()
    answers = [{ status: 200 }]
    const second = renderHook(() => useAudioEnvelope('offline.mp4'))
    await advance(0)
    expect(fetchStub).toHaveBeenCalledTimes(5)
    expect(second.result.current?.max).toBe(0.5)
  })

  it('keeps a file without an audio track and a missing file settled, so neither is fetched again', async () => {
    answers = [{ status: 200, body: NO_AUDIO }]
    const silent = renderHook(() => useAudioEnvelope('silent.mp4'))
    await advance(0)
    answers = [{ status: 404 }]
    const missing = renderHook(() => useAudioEnvelope('missing.mp4'))
    await advance(60000)
    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(silent.result.current).toBeNull()
    expect(missing.result.current).toBeNull()
    silent.unmount()
    missing.unmount()
    renderHook(() => useAudioEnvelope('silent.mp4'))
    renderHook(() => useAudioEnvelope('missing.mp4'))
    await advance(60000)
    expect(fetchStub).toHaveBeenCalledTimes(2)
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
