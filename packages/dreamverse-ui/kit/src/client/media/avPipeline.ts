/** Play streamed fragmented MP4 chunks through MediaSource or ManagedMediaSource and archive them by segment. */

/** Fallback MIME type for received media: H.264 Constrained Baseline video with AAC-LC audio. */
export const DEFAULT_AV_MIME = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"'

const AV_MIME_FALLBACKS = [
  'video/mp4; codecs="avc1.4d401e,mp4a.40.2"',
  'video/mp4; codecs="avc1.42e01e,mp4a.40.2"',
  'video/mp4; codecs="avc1.640028,mp4a.40.2"',
  'video/mp4',
]

const AV_INITIAL_MIN_START_DELAY_MS = 0
const AV_INITIAL_PREBUFFER_SECONDS = 1.0
const AV_INITIAL_MAX_START_WAIT_MS = 500

type MediaSourceLike = MediaSource

type MediaSourceLikeConstructor = {
  new (): MediaSourceLike
  isTypeSupported: (mime: string) => boolean
}

interface ManagedMediaSourceLike extends MediaSource {
  streaming?: boolean
}

interface MediaSourceWindow extends Window {
  ManagedMediaSource?: MediaSourceLikeConstructor
  MediaSource?: MediaSourceLikeConstructor
}

function isAppleMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }

  const userAgent = navigator.userAgent || ''
  const platform = navigator.platform || ''
  const maxTouchPoints = navigator.maxTouchPoints || 0
  const isAppleMobileUserAgent = /iPhone|iPad|iPod/i.test(userAgent)
  const isTouchMac = /Mac/i.test(platform) && maxTouchPoints > 1

  return isAppleMobileUserAgent || isTouchMac
}

function isAndroidChromeBrowser(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }

  const userAgent = navigator.userAgent || ''
  return /Android/i.test(userAgent)
    && /(Chrome|CriOS)/i.test(userAgent)
    && !/(EdgA|OPR|SamsungBrowser)/i.test(userAgent)
}

function resolveMediaSourceConstructor(): {
  ctor: MediaSourceLikeConstructor | null
  usesManagedMediaSource: boolean
} {
  if (typeof window === 'undefined') {
    return {
      ctor: null,
      usesManagedMediaSource: false,
    }
  }

  const mediaSourceWindow = window as MediaSourceWindow
  if (typeof mediaSourceWindow.ManagedMediaSource === 'function') {
    return {
      ctor: mediaSourceWindow.ManagedMediaSource,
      usesManagedMediaSource: true,
    }
  }

  if (typeof mediaSourceWindow.MediaSource === 'function') {
    return {
      ctor: mediaSourceWindow.MediaSource,
      usesManagedMediaSource: false,
    }
  }

  return {
    ctor: null,
    usesManagedMediaSource: false,
  }
}

/**
 * Live playback and archive operations for one page's rollout stream. Archived chunks remain until a `take*` call
 * removes them or `reset()` discards all received media; `stopPlayback()` releases playback resources and keeps them.
 */
export interface AvPipeline {
  ensurePipeline(mime: string, isPlaybackCurrent: () => boolean): Promise<void>
  enqueueChunk(chunk: ArrayBuffer | ArrayBufferView): void
  noteSegmentInit(meta?: {
    segmentIdx?: number | null
    streamId?: string
    mime?: string
  }): void
  noteSegmentComplete(meta?: {
    segmentIdx?: number | null
    streamId?: string
  }): void
  maybeStartPlayback(): void
  tryEndStream(): void
  setStreamCompleted(value: boolean): void
  hasArchivedChunks(): boolean
  buildArchivedStreamChunks(): ArrayBuffer[]
  buildArchivedSegmentSnapshots(options?: {
    includeInProgress?: boolean
  }): ArchivedAvSegment[]
  buildArchivedStreamBlob(): Blob | null
  takeArchivedStreamChunks(): ArrayBuffer[]
  takeArchivedSegmentSnapshots(options?: {
    includeInProgress?: boolean
  }): ArchivedAvSegment[]
  usesNativePlaybackFallback(): boolean
  stopPlayback(): void
  reset(): void
}

/** Received fragmented MP4 bytes for one stream segment. */
export interface ArchivedAvSegment {
  /** Archive key built from `segmentIdx` and `streamId`. */
  key: string
  /** Server segment index, or null when the stream did not report one. */
  segmentIdx: number | null
  /** Server stream ID, or a generated `stream-N` or `implicit-N` ID. */
  streamId: string
  /** MIME type of the segment's bytes. */
  mime: string
  /** Whether the segment's completion event arrived. */
  completed: boolean
  /** Chunks in arrival order. */
  chunks: ArrayBuffer[]
}

/** Browser element access and page callbacks for `createAvPipeline`. */
interface CreateAvPipelineParams {
  /** Current video element; null before it mounts. */
  getVideoEl: () => HTMLVideoElement | null
  /** Clock in milliseconds for the initial playback delay; defaults to `performance.now()`. */
  getNow?: () => number
  /** Reports a failed append or a SourceBuffer error event. */
  onAppendError?: (message: string, error?: unknown) => void
  /** Runs each time a playback operation starts its initial playback. */
  onPlaybackStarted?: () => void
}

interface PlaybackOperation {
  videoEl: HTMLVideoElement
  isPlaybackCurrent: () => boolean
  rejectPending: ((reason: unknown) => void) | null
}

/**
 * Own received rollout media and the browser resources that play it.
 * @param params - Video element access and page callbacks.
 * @returns the pipeline for one page's rollout stream.
 */
export function createAvPipeline(params: CreateAvPipelineParams): AvPipeline {
  const {
    getVideoEl,
    getNow = () => performance.now(),
    onAppendError = () => {},
    onPlaybackStarted = () => {},
  } = params
  const {
    ctor: mediaSourceCtor,
    usesManagedMediaSource,
  } = resolveMediaSourceConstructor()
  // Only force native fallback when the browser lacks a usable media
  // source implementation. Android Chrome should stay on the faster
  // live playback path when MediaSource is available.
  const useNativePlaybackFallback = (
    (isAppleMobileBrowser() && !mediaSourceCtor)
    || (isAndroidChromeBrowser() && !mediaSourceCtor)
  )
  let sourceBuffer: SourceBuffer | null = null
  let mediaSource: MediaSource | null = null
  let mediaObjectUrl: string | null = null
  let mediaSourceOpen = false
  let sourceBufferMime = ''
  let mediaChunkQueue: ArrayBuffer[] = []
  let sourceBufferUpdateEndHandler: (() => void) | null = null
  let sourceBufferErrorHandler: ((event: Event) => void) | null = null
  let mediaSourceOpenHandler: (() => void) | null = null
  let mediaSourceStartStreamingHandler: (() => void) | null = null
  let mediaSourceEndStreamingHandler: (() => void) | null = null
  let pendingMediaEndOfStream = false
  let managedStreamingActive = !usesManagedMediaSource
  let firstChunkAtMs: number | null = null
  let streamCompleted = false
  let initialPlaybackStarted = false
  let playbackResumePending = false
  let archivedChunks: ArrayBuffer[] = []
  let archivedSegments: ArchivedAvSegment[] = []
  let activeArchivedSegmentKey: string | null = null
  let archivedSegmentCounter = 0
  let boundVideoEl: HTMLVideoElement | null = null
  let videoWaitingHandler: (() => void) | null = null
  let videoStalledHandler: (() => void) | null = null
  let videoPlayingHandler: (() => void) | null = null
  let videoPauseHandler: (() => void) | null = null
  let videoPlayHandler: (() => void) | null = null
  let userPaused = false
  let stallRecoveryTimerId: ReturnType<typeof setInterval> | null = null
  let activePlayback: PlaybackOperation | null = null

  function isActivePlayback(operation: PlaybackOperation | null): operation is PlaybackOperation {
    return operation !== null && activePlayback === operation && operation.isPlaybackCurrent()
  }

  function uniqValues(values: readonly string[]): string[] {
    const result: string[] = []
    for (const value of values) {
      const trimmed = value.trim()
      if (!trimmed || result.includes(trimmed)) {
        continue
      }
      result.push(trimmed)
    }
    return result
  }

  function isMimeTypeSupported(mime: string): boolean {
    if (!mediaSourceCtor) {
      return false
    }

    try {
      return mediaSourceCtor.isTypeSupported(mime)
    } catch {
      // Treat an isTypeSupported exception as an unsupported MIME type.
      return false
    }
  }

  function resolveSupportedAvMime(mime: string): string | null {
    const candidates = uniqValues([
      mime,
      DEFAULT_AV_MIME,
      ...AV_MIME_FALLBACKS,
    ])
    for (const candidate of candidates) {
      if (isMimeTypeSupported(candidate)) {
        return candidate
      }
    }
    return null
  }

  function listAvMimeCandidates(mime: string): string[] {
    return uniqValues([
      mime,
      DEFAULT_AV_MIME,
      ...AV_MIME_FALLBACKS,
    ])
  }

  /** Release video listeners and recovery owned by playback initialization. */
  function cleanupVideoBindings(): void {
    clearStallRecovery()
    if (!boundVideoEl) {
      return
    }

    if (videoWaitingHandler) {
      boundVideoEl.removeEventListener('waiting', videoWaitingHandler)
    }
    if (videoStalledHandler) {
      boundVideoEl.removeEventListener('stalled', videoStalledHandler)
    }
    if (videoPlayingHandler) {
      boundVideoEl.removeEventListener('playing', videoPlayingHandler)
    }
    if (videoPauseHandler) {
      boundVideoEl.removeEventListener('pause', videoPauseHandler)
    }
    if (videoPlayHandler) {
      boundVideoEl.removeEventListener('play', videoPlayHandler)
    }

    boundVideoEl = null
    videoWaitingHandler = null
    videoStalledHandler = null
    videoPlayingHandler = null
    videoPauseHandler = null
    videoPlayHandler = null
  }

  function clearStallRecovery(): void {
    if (stallRecoveryTimerId !== null) {
      clearInterval(stallRecoveryTimerId)
      stallRecoveryTimerId = null
    }
  }

  /** Retry buffering only while the attached playback operation remains active. */
  function startStallRecovery(): void {
    const operation = activePlayback
    if (!isActivePlayback(operation) || stallRecoveryTimerId !== null) {
      return
    }
    stallRecoveryTimerId = setInterval(() => {
      if (!isActivePlayback(operation)) return
      // Stop polling once playback is running normally.
      if (initialPlaybackStarted && !playbackResumePending) {
        clearStallRecovery()
        return
      }
      // On iOS Safari, ManagedMediaSource's startstreaming event can be
      // missed or delayed. Poll the streaming property directly to detect
      // when appending is allowed again.
      if (usesManagedMediaSource && !managedStreamingActive && mediaSource) {
        const managed = mediaSource as ManagedMediaSourceLike
        if (managed.streaming !== false) {
          managedStreamingActive = true
          flushQueue()
        }
      }
      maybeStartPlayback()
    }, 250)
  }

  /** Bind playback events to the operation that attached this video element. */
  function ensureVideoBindings(videoEl: HTMLVideoElement): void {
    if (boundVideoEl === videoEl) {
      return
    }

    cleanupVideoBindings()
    boundVideoEl = videoEl
    const operation = activePlayback
    videoWaitingHandler = () => {
      if (isActivePlayback(operation) && initialPlaybackStarted) {
        playbackResumePending = true
        startStallRecovery()
      }
    }
    videoStalledHandler = () => {
      if (isActivePlayback(operation) && initialPlaybackStarted) {
        playbackResumePending = true
        startStallRecovery()
      }
    }
    videoPlayingHandler = () => {
      if (!isActivePlayback(operation)) return
      playbackResumePending = false
      clearStallRecovery()
    }
    videoPauseHandler = () => {
      if (isActivePlayback(operation) && initialPlaybackStarted) {
        userPaused = true
      }
    }
    videoPlayHandler = () => {
      if (!isActivePlayback(operation)) return
      userPaused = false
    }

    videoEl.addEventListener('waiting', videoWaitingHandler)
    videoEl.addEventListener('stalled', videoStalledHandler)
    videoEl.addEventListener('playing', videoPlayingHandler)
    videoEl.addEventListener('pause', videoPauseHandler)
    videoEl.addEventListener('play', videoPlayHandler)
  }

  function cloneChunk(chunk: ArrayBuffer | ArrayBufferView): ArrayBuffer {
    if (chunk instanceof ArrayBuffer) {
      return chunk.slice(0)
    }
    if (ArrayBuffer.isView(chunk)) {
      return new Uint8Array(
        chunk.buffer,
        chunk.byteOffset,
        chunk.byteLength,
      ).slice().buffer
    }
    return new Uint8Array(chunk).slice().buffer
  }

  function resetArchivedSegments(): void {
    archivedSegments = []
    activeArchivedSegmentKey = null
    archivedSegmentCounter = 0
  }

  function cloneArchivedSegment(segment: ArchivedAvSegment): ArchivedAvSegment {
    return {
      ...segment,
      chunks: segment.chunks.map(chunk => cloneChunk(chunk)),
    }
  }

  function buildArchivedSegmentKey(
    segmentIdx: number | null,
    streamId: string,
  ): string {
    return `${segmentIdx !== null ? segmentIdx : 'na'}:${streamId || 'na'}`
  }

  function normalizeSegmentMeta({
    segmentIdx = null,
    streamId = '',
    mime = '',
  }: {
    segmentIdx?: number | null
    streamId?: string
    mime?: string
  }): {
    segmentIdx: number | null
    streamId: string
    mime: string
  } {
    const normalizedSegmentIdx =
      Number.isInteger(segmentIdx) ? Number(segmentIdx) : null
    const normalizedStreamId = typeof streamId === 'string'
      && streamId.trim()
      ? streamId.trim()
      : ''
    const normalizedMime = typeof mime === 'string' && mime.trim()
      ? mime.trim()
      : sourceBufferMime || DEFAULT_AV_MIME
    return {
      segmentIdx: normalizedSegmentIdx,
      streamId: normalizedStreamId,
      mime: normalizedMime,
    }
  }

  function getOrCreateActiveSegment(): ArchivedAvSegment {
    if (activeArchivedSegmentKey) {
      const existing = archivedSegments.find(
        segment => segment.key === activeArchivedSegmentKey,
      )
      if (existing) {
        return existing
      }
    }

    archivedSegmentCounter += 1
    const streamId = `implicit-${archivedSegmentCounter}`
    const key = buildArchivedSegmentKey(null, streamId)
    const nextSegment: ArchivedAvSegment = {
      key,
      segmentIdx: null,
      streamId,
      mime: sourceBufferMime || DEFAULT_AV_MIME,
      completed: false,
      chunks: [],
    }
    archivedSegments.push(nextSegment)
    activeArchivedSegmentKey = key
    return nextSegment
  }

  /** Settle pending initialization and release playback while retaining received media. */
  function stopPlayback(): void {
    const operation = activePlayback
    activePlayback = null
    operation?.rejectPending?.(new DOMException('Playback initialization cancelled.', 'AbortError'))
    if (operation) operation.rejectPending = null
    mediaSourceOpen = false
    sourceBufferMime = ''
    pendingMediaEndOfStream = false
    managedStreamingActive = !usesManagedMediaSource
    initialPlaybackStarted = false
    playbackResumePending = false
    userPaused = false

    if (sourceBuffer && sourceBufferUpdateEndHandler) {
      sourceBuffer.removeEventListener('updateend', sourceBufferUpdateEndHandler)
    }
    if (sourceBuffer && sourceBufferErrorHandler) {
      sourceBuffer.removeEventListener('error', sourceBufferErrorHandler)
    }
    sourceBuffer = null
    sourceBufferUpdateEndHandler = null
    sourceBufferErrorHandler = null

    if (mediaSource && mediaSourceOpenHandler) {
      mediaSource.removeEventListener('sourceopen', mediaSourceOpenHandler)
    }
    if (mediaSource && mediaSourceStartStreamingHandler) {
      mediaSource.removeEventListener(
        'startstreaming',
        mediaSourceStartStreamingHandler,
      )
    }
    if (mediaSource && mediaSourceEndStreamingHandler) {
      mediaSource.removeEventListener(
        'endstreaming',
        mediaSourceEndStreamingHandler,
      )
    }
    if (mediaSource && mediaSource.readyState === 'open') {
      try {
        mediaSource.endOfStream()
      } catch {
        // endOfStream throws InvalidStateError while a SourceBuffer is updating; teardown releases the source anyway.
      }
    }
    mediaSource = null
    mediaSourceOpenHandler = null
    mediaSourceStartStreamingHandler = null
    mediaSourceEndStreamingHandler = null

    const videoEl = operation?.videoEl
    cleanupVideoBindings()
    if (videoEl) {
      try {
        videoEl.pause()
      } catch {
        // A pause() exception must not stop the element from detaching its source below.
      }
      if (videoEl.srcObject) {
        videoEl.srcObject = null
      } else {
        videoEl.removeAttribute('src')
      }
      videoEl.load()
    }

    if (mediaObjectUrl) {
      URL.revokeObjectURL(mediaObjectUrl)
      mediaObjectUrl = null
    }
  }

  /** Append retained bytes only to the active playback operation. */
  function flushQueue(): void {
    if (!isActivePlayback(activePlayback)) return
    if (!sourceBuffer || !mediaSourceOpen || !mediaSource) return
    if (mediaSource.readyState !== 'open') return
    if (usesManagedMediaSource && !managedStreamingActive) return
    if (sourceBuffer.updating) return

    const nextChunk = mediaChunkQueue.shift()
    if (nextChunk === undefined) return
    try {
      sourceBuffer.appendBuffer(nextChunk)
    } catch (error) {
      if (
        usesManagedMediaSource
        && error instanceof DOMException
        && error.name === 'InvalidStateError'
      ) {
        const managedMediaSource = mediaSource as ManagedMediaSourceLike
        if (managedMediaSource.streaming === false) {
          managedStreamingActive = false
          mediaChunkQueue = [nextChunk, ...mediaChunkQueue]
          return
        }
      }
      mediaChunkQueue = []
      onAppendError('Unable to append media chunk.', error)
    }
  }

  /** Retain received bytes even when their live playback has stopped. */
  function enqueueChunk(chunk: ArrayBuffer | ArrayBufferView): void {
    if (firstChunkAtMs === null) {
      firstChunkAtMs = getNow()
    }
    const clonedChunk = cloneChunk(chunk)
    archivedChunks.push(clonedChunk)
    const archivedSegment = getOrCreateActiveSegment()
    archivedSegment.chunks.push(clonedChunk)
    mediaChunkQueue.push(clonedChunk)
    flushQueue()
    // If chunks couldn't be flushed (e.g. ManagedMediaSource streaming
    // is not yet active), start the recovery poll so we don't deadlock
    // waiting for a startstreaming event that may be delayed.
    if (mediaChunkQueue.length > 0 && usesManagedMediaSource) {
      startStallRecovery()
    }
  }

  function noteSegmentInit({
    segmentIdx = null,
    streamId = '',
    mime = '',
  }: {
    segmentIdx?: number | null
    streamId?: string
    mime?: string
  } = {}): void {
    const normalized = normalizeSegmentMeta({
      segmentIdx,
      streamId,
      mime,
    })

    let normalizedStreamId = normalized.streamId
    if (!normalizedStreamId) {
      archivedSegmentCounter += 1
      normalizedStreamId = `stream-${archivedSegmentCounter}`
    }

    const key = buildArchivedSegmentKey(
      normalized.segmentIdx,
      normalizedStreamId,
    )
    let segment = archivedSegments.find(entry => entry.key === key)
    if (!segment) {
      segment = {
        key,
        segmentIdx: normalized.segmentIdx,
        streamId: normalizedStreamId,
        mime: normalized.mime,
        completed: false,
        chunks: [],
      }
      archivedSegments.push(segment)
    } else {
      segment.segmentIdx = normalized.segmentIdx
      segment.streamId = normalizedStreamId
      segment.mime = normalized.mime
      segment.completed = false
    }

    activeArchivedSegmentKey = key
  }

  function noteSegmentComplete({
    segmentIdx = null,
    streamId = '',
  }: {
    segmentIdx?: number | null
    streamId?: string
  } = {}): void {
    const normalizedSegmentIdx =
      Number.isInteger(segmentIdx) ? Number(segmentIdx) : null
    const normalizedStreamId = typeof streamId === 'string'
      && streamId.trim()
      ? streamId.trim()
      : ''

    let targetSegment: ArchivedAvSegment | undefined

    if (normalizedStreamId) {
      targetSegment = archivedSegments.find(
        segment =>
          segment.streamId === normalizedStreamId
          && (
            normalizedSegmentIdx === null
            || segment.segmentIdx === normalizedSegmentIdx
          ),
      )
    }

    if (!targetSegment && normalizedSegmentIdx !== null) {
      const matchingSegments = archivedSegments.filter(
        segment =>
          segment.segmentIdx === normalizedSegmentIdx && !segment.completed,
      )
      targetSegment = matchingSegments[matchingSegments.length - 1]
    }

    if (!targetSegment && activeArchivedSegmentKey) {
      targetSegment = archivedSegments.find(
        segment => segment.key === activeArchivedSegmentKey,
      )
    }

    if (!targetSegment) {
      return
    }

    targetSegment.completed = true
    if (targetSegment.key === activeArchivedSegmentKey) {
      activeArchivedSegmentKey = null
    }
  }

  /** Measure playable media after the attached video's playback position. */
  function getBufferedAheadSeconds(videoEl: HTMLVideoElement): number {
    let buffered = 0
    try {
      const ranges = videoEl.buffered
      if (ranges.length === 0) return 0
      const t = Math.max(videoEl.currentTime || 0, 0)

      for (let i = 0; i < ranges.length; i++) {
        const start = ranges.start(i)
        const end = ranges.end(i)
        if (t >= start && t <= end) {
          buffered = Math.max(0, end - t)
          break
        }
        if (t < start) {
          buffered = Math.max(0, end - start)
          break
        }
      }
    } catch {
      // Treat an unreadable buffered range list as no buffered media.
      buffered = 0
    }

    return buffered
  }

  /** Start buffered media or resume a stall within the active playback operation. */
  function maybeStartPlayback(): void {
    const operation = activePlayback
    if (!isActivePlayback(operation)) return
    const videoEl = operation.videoEl
    ensureVideoBindings(videoEl)

    const bufferedAhead = getBufferedAheadSeconds(videoEl)
    if (bufferedAhead <= 0) return

    if (initialPlaybackStarted) {
      if (!playbackResumePending || userPaused) {
        return
      }

      playbackResumePending = false
      const resumePromise = videoEl.play()
      resumePromise.catch((err: unknown) => {
        if (!isActivePlayback(operation)) return
        console.warn('av resume play() rejected:', err)
        playbackResumePending = true
      })
      return
    }

    if (firstChunkAtMs === null) return

    const waitedMs = getNow() - firstChunkAtMs
    const delayElapsed = waitedMs >= AV_INITIAL_MIN_START_DELAY_MS
    const enoughBuffer = bufferedAhead >= AV_INITIAL_PREBUFFER_SECONDS
    const maxWaitReached = waitedMs >= AV_INITIAL_MAX_START_WAIT_MS

    if (!streamCompleted && (!delayElapsed || (!enoughBuffer && !maxWaitReached))) {
      return
    }

    initialPlaybackStarted = true
    playbackResumePending = false
    onPlaybackStarted()

    const playPromise = videoEl.play()
    playPromise.catch((err: unknown) => {
      if (!isActivePlayback(operation)) return
      console.warn('av initial play() rejected:', err)
      playbackResumePending = true
    })
  }

  /** Finish the active media source after all queued bytes have appended. */
  function tryEndStream(): void {
    if (!isActivePlayback(activePlayback) || !mediaSource || !mediaSourceOpen) return

    if (sourceBuffer?.updating) {
      pendingMediaEndOfStream = true
      return
    }

    if (mediaChunkQueue.length > 0) {
      pendingMediaEndOfStream = true
      return
    }

    try {
      mediaSource.endOfStream()
    } catch {
      // endOfStream throws InvalidStateError after the browser closes or ends the source; the stream is over either way.
    }
    mediaSourceOpen = false
    pendingMediaEndOfStream = false
  }

  /** Initialize playback only while its project socket still owns the operation. */
  async function ensurePipeline(
    mime: string,
    isPlaybackCurrent: () => boolean,
  ): Promise<void> {
    if (!isPlaybackCurrent()) {
      throw new DOMException('Playback initialization cancelled.', 'AbortError')
    }
    const requestedMime = mime || DEFAULT_AV_MIME
    const selectedMime = resolveSupportedAvMime(requestedMime)
    const candidateMimes = listAvMimeCandidates(requestedMime)

    if (isActivePlayback(activePlayback)
      && sourceBuffer
      && mediaSourceOpen
      && sourceBufferMime === selectedMime) {
      return
    }

    const videoEl = getVideoEl()
    if (!videoEl) {
      throw new Error('Video element is not ready.')
    }

    stopPlayback()
    const operation: PlaybackOperation = { videoEl, isPlaybackCurrent, rejectPending: null }
    activePlayback = operation
    try {
      if (useNativePlaybackFallback) {
        sourceBufferMime = requestedMime
        return
      }
      if (!mediaSourceCtor) {
        throw new Error(
          'ManagedMediaSource/MediaSource APIs are not available in this browser.',
        )
      }
      if (!selectedMime) {
        throw new Error(
          `No supported AV MIME type found for requested "${requestedMime}".`,
        )
      }

      const initializingSource = new mediaSourceCtor()
      mediaSource = initializingSource
      if (usesManagedMediaSource) {
        videoEl.disableRemotePlayback = true
        videoEl.srcObject = initializingSource
      } else {
        mediaObjectUrl = URL.createObjectURL(initializingSource)
        videoEl.src = mediaObjectUrl
      }

      await new Promise<void>((resolve, reject) => {
        operation.rejectPending = reject
        mediaSourceOpenHandler = () => {
          if (!isActivePlayback(operation)) {
            if (activePlayback === operation) stopPlayback()
            return
          }
          try {
            let initializedSourceBuffer: SourceBuffer | null = null
            const sourceBufferErrors: string[] = []
            for (const candidateMime of candidateMimes) {
              if (!isMimeTypeSupported(candidateMime)) {
                continue
              }
              try {
                initializedSourceBuffer = initializingSource.addSourceBuffer(candidateMime)
                sourceBuffer = initializedSourceBuffer
                sourceBufferMime = candidateMime
                break
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : ''
                sourceBufferErrors.push(
                  `${candidateMime}: ${errorMessage || String(error)}`,
                )
              }
            }

            if (!initializedSourceBuffer) {
              throw new Error(
                'Unable to initialize SourceBuffer. Candidates: '
                + candidateMimes.join(', ')
                + (
                  sourceBufferErrors.length
                    ? ` Errors: ${sourceBufferErrors.join('; ')}`
                    : ''
                ),
              )
            }

            ensureVideoBindings(videoEl)
            initializedSourceBuffer.mode = 'sequence'
            mediaSourceOpen = true
            if (usesManagedMediaSource) {
              const managedMediaSource = initializingSource as ManagedMediaSourceLike
              managedStreamingActive = managedMediaSource.streaming !== false
              mediaSourceStartStreamingHandler = () => {
                if (!isActivePlayback(operation)) return
                managedStreamingActive = true
                flushQueue()
              }
              mediaSourceEndStreamingHandler = () => {
                if (!isActivePlayback(operation)) return
                managedStreamingActive = false
              }
              initializingSource.addEventListener('startstreaming', mediaSourceStartStreamingHandler)
              initializingSource.addEventListener('endstreaming', mediaSourceEndStreamingHandler)
            }

            sourceBufferUpdateEndHandler = () => {
              if (!isActivePlayback(operation)) return
              flushQueue()
              maybeStartPlayback()
              if (pendingMediaEndOfStream) {
                tryEndStream()
              }
            }

            sourceBufferErrorHandler = (event: Event) => {
              if (!isActivePlayback(operation)) return
              onAppendError('SourceBuffer reported a media error.', event)
            }

            initializedSourceBuffer.addEventListener('updateend', sourceBufferUpdateEndHandler)
            initializedSourceBuffer.addEventListener('error', sourceBufferErrorHandler)

            flushQueue()
            if (mediaChunkQueue.length > 0 && usesManagedMediaSource) {
              startStallRecovery()
            }
            operation.rejectPending = null
            resolve()
          } catch (error) {
            operation.rejectPending = null
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        }

        initializingSource.addEventListener('sourceopen', mediaSourceOpenHandler, { once: true })
      })
    } catch (error) {
      if (activePlayback === operation) stopPlayback()
      throw error
    }
  }

  function setStreamCompleted(value: boolean): void {
    streamCompleted = value
  }

  function hasArchivedChunks(): boolean {
    return archivedChunks.length > 0
  }

  function buildArchivedStreamChunks(): ArrayBuffer[] {
    if (!hasArchivedChunks()) {
      return []
    }
    return archivedChunks.map(chunk => cloneChunk(chunk))
  }

  function buildArchivedSegmentSnapshots({
    includeInProgress = true,
  }: {
    includeInProgress?: boolean
  } = {}): ArchivedAvSegment[] {
    return archivedSegments
      .filter(
        segment =>
          segment.chunks.length > 0
          && (includeInProgress || segment.completed),
      )
      .map(segment => cloneArchivedSegment(segment))
  }

  function buildArchivedStreamBlob(): Blob | null {
    const chunks = buildArchivedStreamChunks()
    if (chunks.length === 0) {
      return null
    }
    return new Blob(chunks, {
      type: sourceBufferMime || DEFAULT_AV_MIME,
    })
  }

  function takeArchivedStreamChunks(): ArrayBuffer[] {
    const chunks = buildArchivedStreamChunks()
    archivedChunks = []
    resetArchivedSegments()
    return chunks
  }

  function takeArchivedSegmentSnapshots({
    includeInProgress = true,
  }: {
    includeInProgress?: boolean
  } = {}): ArchivedAvSegment[] {
    const snapshots = buildArchivedSegmentSnapshots({ includeInProgress })
    if (includeInProgress) {
      resetArchivedSegments()
      return snapshots
    }

    archivedSegments = archivedSegments.filter(segment => !segment.completed)
    if (
      activeArchivedSegmentKey
      && !archivedSegments.some(segment => segment.key === activeArchivedSegmentKey)
    ) {
      activeArchivedSegmentKey = null
    }
    return snapshots
  }

  /** Discard received rollout media and release its playback resources. */
  function reset(): void {
    mediaChunkQueue = []
    archivedChunks = []
    resetArchivedSegments()
    firstChunkAtMs = null
    streamCompleted = false
    stopPlayback()
  }

  return {
    ensurePipeline,
    enqueueChunk,
    noteSegmentInit,
    noteSegmentComplete,
    maybeStartPlayback,
    tryEndStream,
    setStreamCompleted,
    hasArchivedChunks,
    buildArchivedStreamChunks,
    buildArchivedSegmentSnapshots,
    buildArchivedStreamBlob,
    takeArchivedStreamChunks,
    takeArchivedSegmentSnapshots,
    usesNativePlaybackFallback() {
      return useNativePlaybackFallback
    },
    stopPlayback,
    reset,
  }
}
