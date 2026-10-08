/**
 * Waveforms of the 原声 track: the browser fetches a clip's media file (the same URL the preview's `<video>` plays),
 * decodes its audio with `OfflineAudioContext.decodeAudioData`, and reduces the samples to a peak envelope (the largest
 * absolute sample of each short window). The envelope is cached per asset in memory, so a re-render or a zoom change
 * only regroups the cached peaks into bars for the clip's played range. Decodes run one at a time, each after the
 * browser reports idle time, so they do not compete with the preview for the main thread. A media file that cannot be
 * fetched is not cached, so the clip asks for it again.
 */
import { useEffect, useState } from 'react'
import { assetUrl } from '@dv/ui-kit/api.ts'

/** The peak envelope of one asset's audio. */
export interface AudioEnvelope {
  /** The largest absolute sample of each window, across all channels, in [0, 1]. */
  peaks: Float32Array
  /** Windows per second of asset time. */
  rate: number
  /** The largest value in `peaks`; bars are drawn relative to it. */
  max: number
}

/** Envelope windows per second: 5 ms windows, finer than one bar at the largest zoom (200 px/s, 3 px per bar). */
const ENVELOPE_RATE = 200
/** Sample rate the decoder resamples to; peaks for a track display need no more. */
const DECODE_SAMPLE_RATE = 16000
/** Rounding error, in envelope windows, that bar edges ignore. */
const EDGE_TOLERANCE = 1e-6

/**
 * Reduce decoded samples to a peak envelope.
 * @param channels - the sample arrays of each channel, all of the same length.
 * @param sampleRate - samples per second of each channel.
 * @param rate - envelope windows per second.
 * @returns the envelope.
 */
export function peakEnvelope(channels: ArrayLike<number>[], sampleRate: number, rate: number): AudioEnvelope {
  const samples = channels[0]?.length ?? 0
  const windows = Math.ceil(samples * rate / sampleRate)
  const peaks = new Float32Array(windows)
  let max = 0
  for (let window = 0; window < windows; window += 1) {
    const start = Math.floor(window * sampleRate / rate)
    const end = Math.min(samples, Math.floor((window + 1) * sampleRate / rate))
    let peak = 0
    for (const channel of channels) {
      for (let at = start; at < end; at += 1) {
        const value = Math.abs(channel[at] ?? 0)
        if (value > peak) peak = value
      }
    }
    const value = Math.min(1, peak)
    peaks[window] = value
    if (value > max) max = value
  }
  return { peaks, rate, max }
}

/**
 * The bar heights of one clip: the asset time from the in point to the out point split into equal bars, each the
 * largest envelope peak inside it relative to the asset's largest peak. Time past the end of the decoded audio is
 * silent.
 * @param envelope - the asset's envelope.
 * @param inSec - asset time where the clip starts playing.
 * @param outSec - asset time where the clip stops playing.
 * @param bars - the number of bars.
 * @returns one height in [0, 1] per bar.
 */
export function clipPeaks(envelope: AudioEnvelope, inSec: number, outSec: number, bars: number): number[] {
  if (bars <= 0 || outSec <= inSec) return []
  const { peaks, rate, max } = envelope
  const span = (outSec - inSec) / bars
  return Array.from({ length: bars }, (_, bar) => {
    // The tolerance keeps a bar edge that lands on a window edge, such as 0.3 s * 10 = 3.0000000000000004, from
    // reaching into the next window.
    const start = Math.max(0, Math.floor((inSec + bar * span) * rate + EDGE_TOLERANCE))
    // Each bar reads at least one window, so bars narrower than a window repeat its peak instead of reading nothing.
    const end = Math.min(peaks.length, Math.max(start + 1, Math.ceil((inSec + (bar + 1) * span) * rate - EDGE_TOLERANCE)))
    let peak = 0
    for (let at = start; at < end; at += 1) peak = Math.max(peak, peaks[at] ?? 0)
    return max > 0 ? peak / max : 0
  })
}

// Settled envelopes (null when the asset has no decodable audio), the decode of each asset, and the tail of the queue
// that runs the decodes one at a time. An asset whose media file could not be fetched stays out of both maps, so a
// later request decodes it again.
const settled = new Map<string, AudioEnvelope | null>()
const decoding = new Map<string, Promise<AudioEnvelope | null>>()
let decodeQueue: Promise<unknown> = Promise.resolve()

/** Delays, in milliseconds, before a mounted clip asks again for an envelope whose media file could not be fetched. */
const RETRY_DELAYS_MS = [2000, 8000, 30000]

/** A failure to fetch an asset's media file that a later attempt can overcome: a network error or a 5xx status. */
class MediaFetchError extends Error {}

/**
 * Whether this browser can decode audio off-screen.
 * @returns whether `OfflineAudioContext` and `fetch` exist.
 */
function canDecode(): boolean {
  return typeof OfflineAudioContext === 'function' && typeof fetch === 'function'
}

/**
 * Wait for idle main-thread time, so a decode does not start while the page is busy.
 * @returns a promise that resolves when the browser is idle, or after two seconds at most.
 */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => { resolve() }, { timeout: 2000 })
    else setTimeout(resolve, 0)
  })
}

/**
 * Download one asset's whole media file.
 * @param assetId - the asset.
 * @returns the file's bytes, or null when the server answers with a 4xx status.
 * @throws {MediaFetchError} when the request fails on the network or the server answers with a 5xx status.
 */
async function fetchMedia(assetId: string): Promise<ArrayBuffer | null> {
  try {
    const response = await fetch(assetUrl(assetId))
    if (response.status >= 500) throw new MediaFetchError(`HTTP ${String(response.status)}`)
    if (!response.ok) return null
    return await response.arrayBuffer()
  } catch (error) {
    throw error instanceof MediaFetchError ? error : new MediaFetchError(String(error))
  }
}

/**
 * Fetch and decode one asset's audio into its envelope.
 * @param assetId - the asset.
 * @returns the envelope, or null when the server has no such file or the file has no decodable audio track.
 * @throws {MediaFetchError} when the media file could not be fetched.
 */
async function decodeEnvelope(assetId: string): Promise<AudioEnvelope | null> {
  const bytes = await fetchMedia(assetId)
  if (bytes === null) return null
  // The context only decodes; its own length and channel count do not limit the decoded buffer.
  const context = new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE)
  const buffer = await context.decodeAudioData(bytes)
  if (buffer.numberOfChannels === 0 || buffer.length === 0) return null
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
  return peakEnvelope(channels, buffer.sampleRate, ENVELOPE_RATE)
}

/**
 * The envelope of an asset, decoding it once behind every decode queued before it. A fetch failure leaves the asset
 * unsettled, so the next call fetches it again.
 * @param assetId - the asset.
 * @returns the envelope, or null when the asset has no decodable audio.
 * @throws {MediaFetchError} when the media file could not be fetched.
 */
function loadEnvelope(assetId: string): Promise<AudioEnvelope | null> {
  const known = decoding.get(assetId)
  if (known !== undefined) return known
  const result = decodeQueue
    .then(idle)
    .then(() => decodeEnvelope(assetId))
    .then(
      (envelope) => { settled.set(assetId, envelope); return envelope },
      (error: unknown) => {
        if (error instanceof MediaFetchError) {
          decoding.delete(assetId)
          throw error
        }
        // A media file without an audio track rejects `decodeAudioData`; the clip keeps its plain block.
        settled.set(assetId, null)
        return null
      },
    )
  decoding.set(assetId, result)
  // The next decode waits for this one whether or not it succeeds.
  decodeQueue = result.catch(() => undefined)
  return result
}

/**
 * The envelope of a clip's asset for rendering: null while it decodes, when the asset has no decodable audio, or when
 * the browser cannot decode audio. When the media file cannot be fetched, the clip asks again after each delay of
 * {@link RETRY_DELAYS_MS} while it stays mounted, and a later mount starts over.
 * @param assetId - the clip's asset, or null for a placeholder clip.
 * @returns the envelope, or null.
 */
export function useAudioEnvelope(assetId: string | null): AudioEnvelope | null {
  const cached = assetId === null ? null : settled.get(assetId) ?? null
  const [loaded, setLoaded] = useState<{ assetId: string; envelope: AudioEnvelope | null } | null>(null)
  useEffect(() => {
    if (assetId === null || settled.has(assetId) || !canDecode()) return
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const attempt = (failures: number): void => {
      void loadEnvelope(assetId).then(
        (envelope) => { if (alive) setLoaded({ assetId, envelope }) },
        () => {
          const delay = RETRY_DELAYS_MS[failures]
          if (alive && delay !== undefined) retry = setTimeout(() => { attempt(failures + 1) }, delay)
        },
      )
    }
    attempt(0)
    return () => { alive = false; clearTimeout(retry) }
  }, [assetId])
  return cached ?? (loaded !== null && loaded.assetId === assetId ? loaded.envelope : null)
}
