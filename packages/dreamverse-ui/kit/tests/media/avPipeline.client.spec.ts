/** @vitest-environment jsdom */
import '../support/setup.client.ts'
import { describe, expect, it, vi, type Mock } from 'vitest'

import { brandString } from '@deepseek-ai/dsh-brand'
import type { PromptId } from '@dreamverse/project-controller/client/ids.ts'
import { createProjectControlsStore } from '@dreamverse/project-controller/client/stores/projectControls.ts'
import { createPromptWindowStore } from '@dreamverse/project-controller/client/stores/promptWindow.ts'
import { createRewriteStore } from '@dreamverse/project-controller/client/stores/rewrite.ts'
import { createStreamStore } from '@dreamverse/project-controller/client/stores/stream.ts'
import { normalizeSocketMessage } from '@dreamverse/project-controller/client/ws/protocol.ts'
import { applyNormalizedSocketEvent, type SocketEventContext } from '@dreamverse/project-controller/client/ws/reducer.ts'
import { createAvPipeline, DEFAULT_AV_MIME } from '../../src/client/media/avPipeline.ts'

/** Partial MediaSource constructor; each fake defines only the members that its test drives. */
type MockMediaSourceCtor = {
  new (): object
  isTypeSupported: (mime: string) => boolean
}

type MockMediaSourceReadyState = 'closed' | 'open' | 'ended'

/** jsdom video element whose playback state and media methods are writable test controls. */
type FakeVideo = HTMLVideoElement & {
  paused: boolean
  buffered: TimeRanges
  play: Mock<() => Promise<void>>
  pause: Mock<() => void>
  load: Mock<() => void>
  removeAttribute: Mock<(name: string) => void>
  /** Deliver a media event to the pipeline's video listeners. */
  dispatch: (type: string) => void
}

/** Return an entry that the test requires to exist, failing the test when it is missing. */
function entryAt<T>(entries: readonly T[], index: number): T {
  const entry = entries[index]
  if (entry === undefined) throw new Error(`Expected an entry at index ${index}.`)
  return entry
}

function createBufferedRange(start: number, end: number): TimeRanges {
  return {
    length: 1,
    start(index: number): number {
      if (index !== 0) {
        throw new RangeError('invalid buffered range index')
      }
      return start
    },
    end(index: number): number {
      if (index !== 0) {
        throw new RangeError('invalid buffered range index')
      }
      return end
    },
  }
}

function createFakeVideo(): FakeVideo {
  const element = document.createElement('video')
  // Own data properties replace jsdom's read-only media state and its attribute-reflected `src`.
  Object.defineProperties(element, {
    currentTime: { value: 0, writable: true, configurable: true },
    buffered: { value: createBufferedRange(0, 0), writable: true, configurable: true },
    paused: { value: true, writable: true, configurable: true },
    disableRemotePlayback: { value: false, writable: true, configurable: true },
    src: { value: undefined, writable: true, configurable: true },
  })
  const video: FakeVideo = Object.assign(element, {
    dispatch(type: string): void {
      element.dispatchEvent(new Event(type))
    },
    play: vi.fn(() => {
      video.paused = false
      return Promise.resolve()
    }),
    pause: vi.fn(() => {
      video.paused = true
    }),
    load: vi.fn(() => {}),
    removeAttribute: vi.fn<(name: string) => void>(),
  })

  return video
}

const fakeVideo = createFakeVideo()

function setAppleMobileNavigator(): void {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
  )
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('iPhone')
  vi.spyOn(window.navigator, 'maxTouchPoints', 'get').mockReturnValue(5)
}

function setNonAppleNavigator(): void {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (X11; Linux x86_64)',
  )
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Linux x86_64')
  vi.spyOn(window.navigator, 'maxTouchPoints', 'get').mockReturnValue(0)
}

function setAndroidChromeNavigator(): void {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36',
  )
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Linux armv8l')
  vi.spyOn(window.navigator, 'maxTouchPoints', 'get').mockReturnValue(5)
}

/** ManagedMediaSource stand-in that opens on the next task after playback registers `sourceopen`. */
class AutoOpeningMediaSource {
  readyState: MockMediaSourceReadyState = 'closed'

  sourceBuffers: SourceBufferList = {} as SourceBufferList

  activeSourceBuffers: SourceBufferList = {} as SourceBufferList

  duration = 0

  onsourceopen: ((this: MediaSource, ev: Event) => unknown) | null = null

  onsourceended: ((this: MediaSource, ev: Event) => unknown) | null = null

  onsourceclose: ((this: MediaSource, ev: Event) => unknown) | null = null

  removeSourceBuffer = vi.fn()

  endOfStream = vi.fn(() => {
    this.readyState = 'ended'
  })

  setLiveSeekableRange = vi.fn()

  clearLiveSeekableRange = vi.fn()

  private readonly listeners = new Map<string, Array<() => void>>()

  addEventListener(type: string, listener: () => void): void {
    const next = this.listeners.get(type) || []
    next.push(listener)
    this.listeners.set(type, next)

    if (type === 'sourceopen') {
      setTimeout(() => {
        this.readyState = 'open'
        listener()
      }, 0)
    }
  }

  removeEventListener(type: string, listener: () => void): void {
    const next = (this.listeners.get(type) || []).filter(
      item => item !== listener,
    )
    this.listeners.set(type, next)
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) || []) {
      listener()
    }
  }

  dispatchEvent(): boolean {
    return true
  }
}

/** Window fields from which the pipeline selects its MediaSource constructor. */
interface MediaSourceGlobals {
  MediaSource?: MockMediaSourceCtor
  ManagedMediaSource?: MockMediaSourceCtor
}

function overrideMediaSourceApis({
  mediaSourceCtor,
  managedMediaSourceCtor,
}: {
  mediaSourceCtor?: MockMediaSourceCtor
  managedMediaSourceCtor?: MockMediaSourceCtor
}): () => void {
  const mediaSourceWindow: MediaSourceGlobals = window
  const originalMediaSource = mediaSourceWindow.MediaSource
  const originalManagedMediaSource = mediaSourceWindow.ManagedMediaSource

  if (mediaSourceCtor) {
    mediaSourceWindow.MediaSource = mediaSourceCtor
  } else {
    delete mediaSourceWindow.MediaSource
  }

  if (managedMediaSourceCtor) {
    mediaSourceWindow.ManagedMediaSource = managedMediaSourceCtor
  } else {
    delete mediaSourceWindow.ManagedMediaSource
  }

  return () => {
    if (typeof originalMediaSource === 'undefined') {
      delete mediaSourceWindow.MediaSource
    } else {
      mediaSourceWindow.MediaSource = originalMediaSource
    }

    if (typeof originalManagedMediaSource === 'undefined') {
      delete mediaSourceWindow.ManagedMediaSource
    } else {
      mediaSourceWindow.ManagedMediaSource = originalManagedMediaSource
    }
  }
}

describe('createAvPipeline', () => {
  /** Native fallback admits playback without MediaSource and retains its received bytes when stopped. */
  it('uses native playback fallback on Apple mobile when MMS/MSE are unavailable', async () => {
    setAppleMobileNavigator()
    const restoreMediaSourceApis = overrideMediaSourceApis({})
    const pipeline = createAvPipeline({ getVideoEl: () => fakeVideo })

    try {
      expect(pipeline.usesNativePlaybackFallback()).toBe(true)
      await pipeline.ensurePipeline('video/mp4', () => true)
      pipeline.enqueueChunk(new Uint8Array([1, 2]).buffer)
      pipeline.stopPlayback()
      expect(pipeline.buildArchivedStreamChunks()).toEqual([new Uint8Array([1, 2]).buffer])
    } finally {
      pipeline.reset()
      restoreMediaSourceApis()
    }
  })

  it('does not use native playback fallback on Apple mobile when MMS is available', () => {
    setAppleMobileNavigator()

    class FakeManagedMediaSource extends EventTarget {
      static isTypeSupported(): boolean {
        return true
      }
    }

    const restoreMediaSourceApis = overrideMediaSourceApis({
      managedMediaSourceCtor: FakeManagedMediaSource,
    })

    try {
      const pipeline = createAvPipeline({
        getVideoEl: () => fakeVideo,
      })

      expect(pipeline.usesNativePlaybackFallback()).toBe(false)
    } finally {
      restoreMediaSourceApis()
    }
  })

  it('throws when neither ManagedMediaSource nor MediaSource exists on non-Apple browsers', async () => {
    setNonAppleNavigator()
    const restoreMediaSourceApis = overrideMediaSourceApis({})

    try {
      const pipeline = createAvPipeline({
        getVideoEl: () => fakeVideo,
      })

      await expect(
        pipeline.ensurePipeline('video/mp4', () => true),
      ).rejects.toThrow(
        'ManagedMediaSource/MediaSource APIs are not available in this browser.',
      )
    } finally {
      restoreMediaSourceApis()
    }
  })

  it('keeps live playback enabled on Android Chrome when MediaSource is available', () => {
    setAndroidChromeNavigator()

    class FakeMediaSource extends EventTarget {
      static isTypeSupported(): boolean {
        return true
      }
    }

    const restoreMediaSourceApis = overrideMediaSourceApis({
      mediaSourceCtor: FakeMediaSource,
    })

    try {
      const pipeline = createAvPipeline({
        getVideoEl: () => fakeVideo,
      })

      expect(pipeline.usesNativePlaybackFallback()).toBe(false)
    } finally {
      restoreMediaSourceApis()
    }
  })

  /** Initialize managed playback and release the resources created by this case. */
  it('initializes playback with ManagedMediaSource when available', async () => {
    setAppleMobileNavigator()
    fakeVideo.disableRemotePlayback = false

    class FakeSourceBuffer {
      mode: AppendMode = 'segments'

      updating = false

      addEventListener(): void {
        // noop for test
      }

      removeEventListener(): void {
        // noop for test
      }

      appendBuffer(): void {
        // noop for test
      }
    }

    class FakeManagedMediaSource extends AutoOpeningMediaSource {
      static instances: FakeManagedMediaSource[] = []

      static isTypeSupported(_mime: string): boolean {
        return true
      }

      lastSourceBuffer: FakeSourceBuffer | null = null

      addSourceBuffer = vi.fn((_mime: string) => {
        const sourceBuffer = new FakeSourceBuffer()
        this.lastSourceBuffer = sourceBuffer
        return sourceBuffer
      })

      constructor() {
        super()
        FakeManagedMediaSource.instances.push(this)
      }
    }

    const restoreMediaSourceApis = overrideMediaSourceApis({
      managedMediaSourceCtor: FakeManagedMediaSource,
    })

    const pipeline = createAvPipeline({
      getVideoEl: () => fakeVideo,
    })

    try {
      await pipeline.ensurePipeline('video/mp4', () => true)

      const managedInstance = FakeManagedMediaSource.instances[0]
      expect(managedInstance).toBeTruthy()
      expect(managedInstance?.addSourceBuffer).toHaveBeenCalledTimes(1)
      expect(managedInstance?.addSourceBuffer).toHaveBeenCalledWith('video/mp4')
      expect(managedInstance?.lastSourceBuffer?.mode).toBe('sequence')
      expect(fakeVideo.disableRemotePlayback).toBe(true)
    } finally {
      pipeline.reset()
      restoreMediaSourceApis()
    }
  })

  /** Retain managed streaming admission while settling its recovery and browser resources. */
  it('waits for ManagedMediaSource startstreaming before appending queued chunks', async () => {
    setAppleMobileNavigator()
    const onAppendError = vi.fn()

    class FakeSourceBuffer {
      mode: AppendMode = 'segments'

      updating = false

      appendBuffer = vi.fn()

      addEventListener(): void {
        // noop for test
      }

      removeEventListener(): void {
        // noop for test
      }
    }

    class FakeManagedMediaSource extends AutoOpeningMediaSource {
      static instances: FakeManagedMediaSource[] = []

      static isTypeSupported(): boolean {
        return true
      }

      streaming = false

      lastSourceBuffer: FakeSourceBuffer | null = null

      addSourceBuffer = vi.fn(() => {
        const sourceBuffer = new FakeSourceBuffer()
        this.lastSourceBuffer = sourceBuffer
        return sourceBuffer
      })

      constructor() {
        super()
        FakeManagedMediaSource.instances.push(this)
      }
    }

    const restoreMediaSourceApis = overrideMediaSourceApis({
      managedMediaSourceCtor: FakeManagedMediaSource,
    })

    const pipeline = createAvPipeline({
      getVideoEl: () => fakeVideo,
      onAppendError,
    })

    try {
      await pipeline.ensurePipeline('video/mp4', () => true)
      const managedInstance = FakeManagedMediaSource.instances[0]
      expect(managedInstance).toBeTruthy()
      expect(managedInstance?.streaming).toBe(false)

      pipeline.enqueueChunk(new Uint8Array([9, 8, 7]).buffer)
      expect(managedInstance?.lastSourceBuffer?.appendBuffer).not.toHaveBeenCalled()

      if (!managedInstance) throw new Error('Expected a ManagedMediaSource instance.')
      managedInstance.streaming = true
      managedInstance.dispatch('startstreaming')
      expect(managedInstance?.lastSourceBuffer?.appendBuffer).toHaveBeenCalledTimes(1)
      expect(onAppendError).not.toHaveBeenCalled()
    } finally {
      pipeline.reset()
      restoreMediaSourceApis()
    }
  })

  /** Keep the startup buffering threshold and release its video bindings. */
  it('waits for the startup buffer before first playback', async () => {
    const fixture = createReceivedMediaFixture()
    const { pipeline, video: fakeVideo, onPlaybackStarted } = fixture
    fixture.setNow(0)
    fakeVideo.currentTime = 0
    fakeVideo.buffered = createBufferedRange(0, 0.2)
    fakeVideo.paused = true
    fakeVideo.play.mockClear()

    try {
      pipeline.reset()
      const initialization = pipeline.ensurePipeline(DEFAULT_AV_MIME, () => true)
      fixture.initializations.push(initialization)
      entryAt(fixture.sources, 0).open()
      await initialization
      pipeline.enqueueChunk(new Uint8Array([1, 2, 3]).buffer)
      entryAt(fixture.sources, 0).buffer.finishAppend()
      await vi.advanceTimersByTimeAsync(0)

      fixture.setNow(400)
      pipeline.maybeStartPlayback()
      expect(onPlaybackStarted).not.toHaveBeenCalled()
      expect(fakeVideo.play).not.toHaveBeenCalled()

      fixture.setNow(500)
      pipeline.maybeStartPlayback()
      expect(onPlaybackStarted).toHaveBeenCalledTimes(1)
      expect(fakeVideo.play).toHaveBeenCalledTimes(1)
    } finally {
      await fixture.cleanup()
    }
  })

  /** Keep immediate stall recovery and stop its recovery timer before this case exits. */
  it('resumes immediately after a later buffering stall once data is available', async () => {
    const fixture = createReceivedMediaFixture()
    const { pipeline, video: fakeVideo, onPlaybackStarted } = fixture
    fixture.setNow(0)
    fakeVideo.currentTime = 0
    fakeVideo.buffered = createBufferedRange(0, 0.2)
    fakeVideo.paused = true
    fakeVideo.play.mockClear()

    try {
      pipeline.reset()
      const initialization = pipeline.ensurePipeline(DEFAULT_AV_MIME, () => true)
      fixture.initializations.push(initialization)
      entryAt(fixture.sources, 0).open()
      await initialization
      pipeline.enqueueChunk(new Uint8Array([1, 2, 3]).buffer)
      entryAt(fixture.sources, 0).buffer.finishAppend()
      await vi.advanceTimersByTimeAsync(0)

      fixture.setNow(500)
      pipeline.maybeStartPlayback()
      expect(onPlaybackStarted).toHaveBeenCalledTimes(1)
      expect(fakeVideo.play).toHaveBeenCalledTimes(1)

      fakeVideo.paused = true
      fakeVideo.currentTime = 0.2
      fakeVideo.buffered = createBufferedRange(0.2, 0.35)
      fakeVideo.dispatch('waiting')

      fixture.setNow(510)
      pipeline.maybeStartPlayback()
      expect(onPlaybackStarted).toHaveBeenCalledTimes(1)
      expect(fakeVideo.play).toHaveBeenCalledTimes(2)
    } finally {
      await fixture.cleanup()
    }
  })

  /** Archive consumption returns owned bytes and clears the rollout archive. */
  it('returns archived chunks and clears them when taken', () => {
    const pipeline = createAvPipeline({
      getVideoEl: () => fakeVideo,
    })

    const originalChunk = new Uint8Array([7, 8, 9]).buffer
    pipeline.reset()
    pipeline.enqueueChunk(originalChunk)

    const archivedChunks = pipeline.takeArchivedStreamChunks()

    expect(archivedChunks).toHaveLength(1)
    expect(archivedChunks[0]).not.toBe(originalChunk)
    expect(Array.from(new Uint8Array(entryAt(archivedChunks, 0)))).toEqual([7, 8, 9])
    expect(pipeline.hasArchivedChunks()).toBe(false)
  })

  /** Completed-only consumption preserves a segment that is still receiving bytes. */
  it('tracks archived segments by lifecycle and supports completed-only snapshots', () => {
    const pipeline = createAvPipeline({
      getVideoEl: () => fakeVideo,
    })

    pipeline.reset()
    pipeline.noteSegmentInit({
      segmentIdx: 1,
      streamId: 'seg-1',
      mime: 'video/mp4',
    })
    pipeline.enqueueChunk(new Uint8Array([1, 2]).buffer)
    pipeline.noteSegmentComplete({
      segmentIdx: 1,
      streamId: 'seg-1',
    })

    pipeline.noteSegmentInit({
      segmentIdx: 2,
      streamId: 'seg-2',
      mime: 'video/mp4',
    })
    pipeline.enqueueChunk(new Uint8Array([3, 4]).buffer)

    const allSegments = pipeline.buildArchivedSegmentSnapshots({
      includeInProgress: true,
    })
    expect(allSegments).toHaveLength(2)
    expect(allSegments[0]?.completed).toBe(true)
    expect(allSegments[1]?.completed).toBe(false)
    expect(pipeline.buildArchivedSegmentSnapshots({ includeInProgress: false })
      .map(segment => segment.streamId)).toEqual(['seg-1'])

    const completedOnly = pipeline.takeArchivedSegmentSnapshots({
      includeInProgress: false,
    })
    expect(completedOnly).toHaveLength(1)
    expect(completedOnly[0]?.streamId).toBe('seg-1')

    const remaining = pipeline.buildArchivedSegmentSnapshots({
      includeInProgress: true,
    })
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.streamId).toBe('seg-2')
    expect(remaining[0]?.completed).toBe(false)
  })
})

/** Control browser event boundaries while retaining the real pipeline's received media. */
function createReceivedMediaFixture(useManagedSource = false) {
  vi.useFakeTimers()
  setNonAppleNavigator()
  const video = createFakeVideo()
  video.removeAttribute.mockImplementation((name: string) => {
    // Restore the unset own `src` so that reads report no source instead of jsdom's reflected empty attribute.
    if (name === 'src') Object.defineProperty(video, 'src', { value: undefined, writable: true, configurable: true })
  })
  const videoAddListener = vi.spyOn(video, 'addEventListener')
  const videoRemoveListener = vi.spyOn(video, 'removeEventListener')
  const sources: ControlledMediaSource[] = []
  const initializations: Promise<void>[] = []
  const urls = new Set<string>()
  let nowMs = 100

  class ControlledSourceBuffer extends EventTarget {
    mode: AppendMode = 'segments'
    updating = false
    appended: number[][] = []
    addListener = vi.spyOn(this as EventTarget, 'addEventListener')
    removeListener = vi.spyOn(this as EventTarget, 'removeEventListener')

    appendBuffer(chunk: ArrayBuffer): void {
      if (this.updating) throw new DOMException('Append is pending.', 'InvalidStateError')
      this.updating = true
      this.appended.push(Array.from(new Uint8Array(chunk)))
    }

    finishAppend(): void {
      setTimeout(() => {
        this.updating = false
        this.dispatchEvent(new Event('updateend'))
      }, 0)
    }
  }

  class ControlledMediaSource extends EventTarget {
    static isTypeSupported(mime: string): boolean {
      return mime === DEFAULT_AV_MIME
    }

    readyState: MockMediaSourceReadyState = 'closed'
    streaming = false
    buffer = new ControlledSourceBuffer()
    addListener = vi.spyOn(this as EventTarget, 'addEventListener')
    removeListener = vi.spyOn(this as EventTarget, 'removeEventListener')

    constructor() {
      super()
      sources.push(this)
    }

    addSourceBuffer(): ControlledSourceBuffer {
      return this.buffer
    }

    open(): void {
      this.readyState = 'open'
      this.dispatchEvent(new Event('sourceopen'))
    }

    endOfStream(): void {
      if (this.buffer.updating) throw new DOMException('Append is pending.', 'InvalidStateError')
      this.readyState = 'ended'
    }
  }

  const sourceCtor: MockMediaSourceCtor = ControlledMediaSource
  const restoreApis = overrideMediaSourceApis(useManagedSource
    ? { managedMediaSourceCtor: sourceCtor }
    : { mediaSourceCtor: sourceCtor })
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:received-media-${sources.length}`
    urls.add(url)
    return url
  })
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { urls.delete(url) })
  const onAppendError = vi.fn()
  const onPlaybackStarted = vi.fn()
  const pipeline = createAvPipeline({ getVideoEl: () => video, getNow: () => nowMs, onAppendError, onPlaybackStarted })

  /** Settle initialization and observe reset cleanup before restoring the browser fixture. */
  async function cleanup(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0)
    // A stopped source can stay closed after its initialization listener has been removed.
    const heldSources = sources.filter(source => source.readyState === 'closed'
      && source.addListener.mock.calls.some(([type, listener]) => type === 'sourceopen'
        && !source.removeListener.mock.calls.some(([removedType, removedListener]) => (
          removedType === type && removedListener === listener
        ))))
    for (const source of heldSources) source.open()
    const settled = await Promise.allSettled(initializations)
    pipeline.reset()
    const appendsBeforeDisposedEvents = sources.map(source => source.buffer.appended.length)
    for (const source of sources) {
      source.buffer.dispatchEvent(new Event('updateend'))
      source.buffer.dispatchEvent(new Event('error'))
    }
    const missingListenerRemovals: string[] = []
    const listenerPairs = [
      [videoAddListener, videoRemoveListener] as const,
      ...sources.flatMap(source => [
        [source.addListener, source.removeListener] as const,
        [source.buffer.addListener, source.buffer.removeListener] as const,
      ]),
    ]
    for (const [added, removed] of listenerPairs) {
      for (const [type, listener] of added.mock.calls) {
        if (!removed.mock.calls.some(([removedType, removedListener]) => (
          removedType === type && removedListener === listener
        ))) missingListenerRemovals.push(type)
      }
    }
    const observed = {
      heldSourcesOpenedForRescue: heldSources.length,
      initializationOutcomes: settled.map(entry => entry.status),
      remainingUrls: urls.size,
      videoBound: Boolean(video.src || video.srcObject),
      missingListenerRemovals,
      remainingTimers: vi.getTimerCount(),
      disposedEventsAppended: sources.some((source, index) => (
        source.buffer.appended.length !== appendsBeforeDisposedEvents[index]
      )),
      appendErrors: onAppendError.mock.calls.length,
    }
    try {
      expect.soft(observed).toEqual({
        heldSourcesOpenedForRescue: 0,
        initializationOutcomes: initializations.map(() => 'fulfilled'),
        remainingUrls: 0,
        videoBound: false,
        missingListenerRemovals: [],
        remainingTimers: 0,
        disposedEventsAppended: false,
        appendErrors: 0,
      })
    } finally {
      for (const url of urls) URL.revokeObjectURL(url)
      vi.clearAllTimers()
      restoreApis()
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  }

  return {
    pipeline, video, sources, initializations, onAppendError, onPlaybackStarted, createObjectURL, revokeObjectURL,
    setNow: (value: number) => { nowMs = value },
    cleanup,
  }
}

/** Expose archive identity and bytes together so completion alone cannot hide lost metadata. */
function observeReceivedMedia(pipeline: ReturnType<typeof createAvPipeline>) {
  return {
    segments: pipeline.buildArchivedSegmentSnapshots().map(({ chunks, ...metadata }) => ({
      ...metadata,
      bytes: chunks.map(chunk => Array.from(new Uint8Array(chunk))),
    })),
    bytes: pipeline.buildArchivedStreamChunks().map(chunk => Array.from(new Uint8Array(chunk))),
  }
}

/** Reducer context members outside media playback, set to inert values that media events leave unchanged. */
function createInertSocketEventMembers() {
  return {
    promptWindowStore: createPromptWindowStore(),
    rewriteStore: createRewriteStore(),
    fixedRewriteModel: '',
    parseLatencyMs: () => null,
    formatPromptWindowEventText: () => '',
    makePromptId: () => brandString<PromptId>(''),
    buildStreamClip: vi.fn(),
    resetTtffTimer: vi.fn(),
    startTtffTimer: vi.fn(),
    preserveArchivedPlaybackSelection: false,
    finalizeStreamCompletion: vi.fn(),
    noticeText: notice => notice,
  } satisfies Partial<SocketEventContext>
}

describe('received media lifetime', () => {
  /** Cancellation settles initialization; stop retains received media and reset ends that rollout. */
  it.each(['stop', 'reset'] as const)('settles pending initialization on %s', async (action) => {
    const fixture = createReceivedMediaFixture(true)
    try {
      fixture.pipeline.noteSegmentInit({ segmentIdx: 1, streamId: 'held-1', mime: DEFAULT_AV_MIME })
      fixture.pipeline.enqueueChunk(new Uint8Array([1, 2]).buffer)
      const pending = fixture.pipeline.ensurePipeline(DEFAULT_AV_MIME, () => true)
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      // Track the expected rejection assertion so fixture cleanup still requires fulfilled owned checks.
      fixture.initializations.push(rejected)
      const source = entryAt(fixture.sources, 0)
      if (action === 'stop') fixture.pipeline.stopPlayback()
      else fixture.pipeline.reset()
      await rejected
      expect(fixture.video.srcObject).toBeNull()
      expect(source.removeListener).toHaveBeenCalledWith('sourceopen', expect.any(Function))
      expect(vi.getTimerCount()).toBe(0)
      if (action === 'stop') {
        fixture.pipeline.enqueueChunk(new Uint8Array([3, 4]).buffer)
        fixture.pipeline.noteSegmentComplete({ segmentIdx: 1, streamId: 'held-1' })
        fixture.pipeline.setStreamCompleted(true)
        fixture.pipeline.maybeStartPlayback()
        fixture.pipeline.tryEndStream()
        expect(observeReceivedMedia(fixture.pipeline)).toEqual({
          segments: [{ key: '1:held-1', segmentIdx: 1, streamId: 'held-1', mime: DEFAULT_AV_MIME,
            completed: true, bytes: [[1, 2], [3, 4]] }],
          bytes: [[1, 2], [3, 4]],
        })
      } else {
        expect(observeReceivedMedia(fixture.pipeline)).toEqual({ segments: [], bytes: [] })
      }
      source.open()
      source.dispatchEvent(new Event('startstreaming'))
      source.buffer.dispatchEvent(new Event('updateend'))
      expect(source.buffer.appended).toEqual([])
      expect(fixture.video.play).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await fixture.cleanup()
    }
  })

  /** Admission can expire before creation or while the browser has not opened its source. */
  it('rejects obsolete admission without losing received media', async () => {
    const fixture = createReceivedMediaFixture()
    let current = false
    try {
      fixture.pipeline.enqueueChunk(new Uint8Array([7, 8]).buffer)
      await expect(fixture.pipeline.ensurePipeline(DEFAULT_AV_MIME, () => current))
        .rejects.toMatchObject({ name: 'AbortError' })
      expect(fixture.sources).toHaveLength(0)
      current = true
      const pending = fixture.pipeline.ensurePipeline(DEFAULT_AV_MIME, () => current)
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      fixture.initializations.push(rejected)
      const source = entryAt(fixture.sources, 0)
      const url = fixture.video.src
      current = false
      source.open()
      await rejected
      expect(fixture.video.src).toBeUndefined()
      expect(fixture.revokeObjectURL).toHaveBeenCalledWith(url)
      expect(source.buffer.appended).toEqual([])
      expect(observeReceivedMedia(fixture.pipeline).bytes).toEqual([[7, 8]])
      expect(fixture.video.play).not.toHaveBeenCalled()
    } finally {
      await fixture.cleanup()
    }
  })

  /** A superseded pending initialization cannot tear down replacement playback when its rejection settles. */
  it('keeps replacement playback through late source events and reuses its valid source', async () => {
    const fixture = createReceivedMediaFixture()
    try {
      fixture.pipeline.enqueueChunk(new Uint8Array([1, 2]).buffer)
      const first = fixture.pipeline.ensurePipeline(DEFAULT_AV_MIME, () => true)
      const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
      fixture.initializations.push(rejected)
      const priorSource = entryAt(fixture.sources, 0)
      const priorUrl = fixture.video.src
      const replacement = fixture.pipeline.ensurePipeline(DEFAULT_AV_MIME, () => true)
      fixture.initializations.push(replacement)
      const source = entryAt(fixture.sources, 1)
      const replacementUrl = fixture.video.src
      priorSource.open()
      await rejected
      expect(fixture.video.src).toBe(replacementUrl)
      expect(fixture.revokeObjectURL).toHaveBeenCalledWith(priorUrl)
      expect(fixture.revokeObjectURL).not.toHaveBeenCalledWith(replacementUrl)
      source.open()
      await replacement
      source.buffer.finishAppend()
      await vi.advanceTimersByTimeAsync(0)
      priorSource.buffer.dispatchEvent(new Event('updateend'))
      priorSource.buffer.dispatchEvent(new Event('error'))
      expect(priorSource.buffer.appended).toEqual([])
      expect(source.buffer.appended).toEqual([[1, 2]])
      expect(fixture.onAppendError).not.toHaveBeenCalled()
      await fixture.pipeline.ensurePipeline(DEFAULT_AV_MIME, () => true)
      expect(fixture.sources).toHaveLength(2)
      expect(fixture.video.src).toBe(replacementUrl)
      expect(observeReceivedMedia(fixture.pipeline).bytes).toEqual([[1, 2]])
    } finally {
      await fixture.cleanup()
    }
  })

  /** Setup failures release their own browser resources while retaining bytes for archive or a later attempt. */
  it.each(['object URL', 'SourceBuffer'] as const)('releases playback after %s setup failure', async (failureAt) => {
    const fixture = createReceivedMediaFixture()
    const cause = new Error('Browser allocation failed')
    try {
      fixture.pipeline.enqueueChunk(new Uint8Array([3, 4]).buffer)
      if (failureAt === 'object URL') {
        fixture.createObjectURL.mockImplementationOnce(() => { throw cause })
      }
      const pending = fixture.pipeline.ensurePipeline(DEFAULT_AV_MIME, () => true)
      const rejected = expect(pending).rejects.toThrow('Browser allocation failed')
      fixture.initializations.push(rejected)
      const source = entryAt(fixture.sources, 0)
      const url = fixture.video.src
      if (failureAt === 'SourceBuffer') {
        vi.spyOn(source, 'addSourceBuffer').mockImplementation(() => { throw cause })
        source.open()
      }
      await rejected
      expect(fixture.video.src).toBeUndefined()
      if (url) expect(fixture.revokeObjectURL).toHaveBeenCalledWith(url)
      expect(source.buffer.appended).toEqual([])
      expect(fixture.video.play).not.toHaveBeenCalled()
      expect(observeReceivedMedia(fixture.pipeline).bytes).toEqual([[3, 4]])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await fixture.cleanup()
    }
  })

  /** Browser play promises can reject after their operation has been replaced. */
  it.each(['initial', 'resume'] as const)('ignores a late %s play rejection after replacement', async (stage) => {
    const fixture = createReceivedMediaFixture()
    let rejectPlay: ((reason: Error) => void) | undefined
    const holdPlay = () => new Promise<void>((_resolve, reject) => { rejectPlay = reject })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const initialization = fixture.pipeline.ensurePipeline(DEFAULT_AV_MIME, () => true)
      fixture.initializations.push(initialization)
      entryAt(fixture.sources, 0).open()
      await initialization
      fixture.video.buffered = createBufferedRange(0, 2)
      if (stage === 'initial') fixture.video.play.mockImplementationOnce(holdPlay)
      fixture.pipeline.enqueueChunk(new Uint8Array([1, 2]).buffer)
      entryAt(fixture.sources, 0).buffer.finishAppend()
      await vi.advanceTimersByTimeAsync(0)
      if (stage === 'resume') {
        fixture.video.play.mockImplementationOnce(holdPlay)
        fixture.video.dispatch('waiting')
        fixture.pipeline.maybeStartPlayback()
      }
      expect(rejectPlay).toBeTypeOf('function')
      fixture.pipeline.stopPlayback()
      const replacement = fixture.pipeline.ensurePipeline(DEFAULT_AV_MIME, () => true)
      fixture.initializations.push(replacement)
      entryAt(fixture.sources, 1).open()
      await replacement
      fixture.pipeline.enqueueChunk(new Uint8Array([3, 4]).buffer)
      entryAt(fixture.sources, 1).buffer.finishAppend()
      await vi.advanceTimersByTimeAsync(0)
      const expectedCalls = stage === 'initial' ? 2 : 3
      expect(fixture.video.play).toHaveBeenCalledTimes(expectedCalls)
      if (!rejectPlay) throw new Error('Expected a pending play promise.')
      rejectPlay(new Error('Superseded browser play rejected'))
      await Promise.resolve()
      fixture.pipeline.maybeStartPlayback()
      expect(fixture.video.play).toHaveBeenCalledTimes(expectedCalls)
      expect(warning).not.toHaveBeenCalled()
    } finally {
      rejectPlay?.(new Error('Fixture releases pending play'))
      await Promise.resolve()
      await fixture.cleanup()
    }
  })

  /** Exercise the reducer's actual registration-before-initialization order. */
  it('preserves the first segment identity through the reducer and playback creation', async () => {
    const fixture = createReceivedMediaFixture()
    const mime = 'video/mp4; codecs="avc1.640028,mp4a.40.2"'
    const projectControlsStore = createProjectControlsStore()
    const streamStore = createStreamStore()
    const context: SocketEventContext = {
      ...createInertSocketEventMembers(),
      projectControlsStore,
      streamStore,
      avPipeline: fixture.pipeline,
      defaultAvMime: DEFAULT_AV_MIME,
      tick: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
      isPlaybackCurrent: () => true,
    }
    try {
      const initialization = applyNormalizedSocketEvent(normalizeSocketMessage({
        type: 'media_init', segment_idx: 7, stream_id: 'segment-7', mime,
      }), context)
      fixture.initializations.push(initialization)
      await vi.advanceTimersByTimeAsync(0)
      expect(fixture.sources).toHaveLength(1)
      const source = entryAt(fixture.sources, 0)
      source.open()
      await initialization
      fixture.pipeline.enqueueChunk(new Uint8Array([1, 2]).buffer)
      fixture.pipeline.enqueueChunk(new Uint8Array([3, 4]).buffer)
      source.buffer.finishAppend()
      await vi.advanceTimersByTimeAsync(0)
      source.buffer.finishAppend()
      await vi.advanceTimersByTimeAsync(0)
      await applyNormalizedSocketEvent(normalizeSocketMessage({
        type: 'media_segment_complete', segment_idx: 7, stream_id: 'segment-7',
      }), context)
      const observed = {
        ...observeReceivedMedia(fixture.pipeline),
        appended: source.buffer.appended,
        initializationError: streamStore.get().mediaAppendError,
      }
      expect(observed).toEqual({
        segments: [{
          key: '7:segment-7', segmentIdx: 7, streamId: 'segment-7', mime, completed: true,
          bytes: [[1, 2], [3, 4]],
        }],
        bytes: [[1, 2], [3, 4]],
        appended: [[1, 2], [3, 4]],
        initializationError: null,
      })
    } finally {
      await fixture.cleanup()
    }
  })

  /** Public callers can queue before initialization; Page's socket queue serializes that ordering. */
  it.each([false, true])('preserves queued bytes and receipt timing when completed=%s', async (completed) => {
    const fixture = createReceivedMediaFixture()
    try {
      fixture.pipeline.noteSegmentInit({ segmentIdx: 3, streamId: 'queued-3', mime: DEFAULT_AV_MIME })
      const first = new Uint8Array([99, 1, 2, 99])
      const second = new Uint8Array([3, 4])
      fixture.pipeline.enqueueChunk(first.subarray(1, 3))
      fixture.pipeline.enqueueChunk(second.buffer)
      first[1] = 88
      second[0] = 77
      if (completed) fixture.pipeline.noteSegmentComplete({ segmentIdx: 3, streamId: 'queued-3' })
      fixture.pipeline.setStreamCompleted(completed)
      const initialization = fixture.pipeline.ensurePipeline(DEFAULT_AV_MIME, () => true)
      fixture.initializations.push(initialization)
      fixture.setNow(110)
      const source = entryAt(fixture.sources, 0)
      source.open()
      await initialization
      fixture.video.buffered = createBufferedRange(0, 0.2)
      source.buffer.finishAppend()
      await vi.advanceTimersByTimeAsync(0)
      source.buffer.finishAppend()
      await vi.advanceTimersByTimeAsync(0)
      const playedAt110 = fixture.video.play.mock.calls.length
      fixture.setNow(599)
      fixture.pipeline.maybeStartPlayback()
      const playedAt599 = fixture.video.play.mock.calls.length
      fixture.setNow(600)
      fixture.pipeline.maybeStartPlayback()
      const observed = {
        ...observeReceivedMedia(fixture.pipeline),
        appended: source.buffer.appended,
        playCalls: { at110: playedAt110, at599: playedAt599, at600: fixture.video.play.mock.calls.length },
      }
      expect(observed).toEqual({
        segments: [{
          key: '3:queued-3', segmentIdx: 3, streamId: 'queued-3', mime: DEFAULT_AV_MIME, completed,
          bytes: [[1, 2], [3, 4]],
        }],
        bytes: [[1, 2], [3, 4]],
        appended: [[1, 2], [3, 4]],
        playCalls: { at110: completed ? 1 : 0, at599: completed ? 1 : 0, at600: 1 },
      })
    } finally {
      await fixture.cleanup()
    }
  })

  /** Public enqueue retains bytes while stopped without creating playback recovery. */
  it('retains queued ManagedMediaSource bytes without recovery before playback admission', () => {
    vi.useFakeTimers()
    class UninitializedManagedMediaSource extends EventTarget {
      static isTypeSupported(): boolean { return true }
    }
    const restoreApis = overrideMediaSourceApis({ managedMediaSourceCtor: UninitializedManagedMediaSource })
    const pipeline = createAvPipeline({ getVideoEl: () => null })
    try {
      pipeline.enqueueChunk(new Uint8Array([1, 2]).buffer)
      const timersBeforeReset = vi.getTimerCount()
      expect(pipeline.buildArchivedStreamChunks()).toEqual([new Uint8Array([1, 2]).buffer])
      pipeline.reset()
      const observed = {
        timersBeforeReset, timersAfterReset: vi.getTimerCount(), archived: pipeline.hasArchivedChunks(),
      }
      expect(observed).toEqual({ timersBeforeReset: 0, timersAfterReset: 0, archived: false })
    } finally {
      vi.clearAllTimers()
      expect.soft(vi.getTimerCount()).toBe(0)
      restoreApis()
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })

  /** Replacing playback resources preserves both reducer-registered segments and their received bytes. */
  it('retains subsequent segments when stopped playback is initialized again', async () => {
    const fixture = createReceivedMediaFixture()
    const context: SocketEventContext = {
      ...createInertSocketEventMembers(),
      projectControlsStore: createProjectControlsStore(), streamStore: createStreamStore(),
      avPipeline: fixture.pipeline, defaultAvMime: DEFAULT_AV_MIME,
      tick: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
      isPlaybackCurrent: () => true,
    }
    try {
      for (const segmentIdx of [1, 2]) {
        const streamId = `segment-${segmentIdx}`
        const initialization = applyNormalizedSocketEvent(normalizeSocketMessage({
          type: 'media_init', segment_idx: segmentIdx, stream_id: streamId, mime: DEFAULT_AV_MIME,
        }), context)
        fixture.initializations.push(initialization)
        await vi.advanceTimersByTimeAsync(0)
        expect(fixture.sources).toHaveLength(1)
        const source = entryAt(fixture.sources, 0)
        if (source.readyState === 'closed') source.open()
        await initialization
        fixture.pipeline.enqueueChunk(new Uint8Array(segmentIdx === 1 ? [1, 2] : [3, 4]).buffer)
        source.buffer.finishAppend()
        await vi.advanceTimersByTimeAsync(0)
        await applyNormalizedSocketEvent(normalizeSocketMessage({
          type: 'media_segment_complete', segment_idx: segmentIdx, stream_id: streamId,
        }), context)
      }
      const expected = {
        segments: [
          { key: '1:segment-1', segmentIdx: 1, streamId: 'segment-1', mime: DEFAULT_AV_MIME,
            completed: true, bytes: [[1, 2]] },
          { key: '2:segment-2', segmentIdx: 2, streamId: 'segment-2', mime: DEFAULT_AV_MIME,
            completed: true, bytes: [[3, 4]] },
        ],
        bytes: [[1, 2], [3, 4]],
      }
      expect(observeReceivedMedia(fixture.pipeline)).toEqual(expected)
      const priorSource = entryAt(fixture.sources, 0)
      const priorUrl = fixture.video.src
      fixture.pipeline.stopPlayback()
      const recreation = fixture.pipeline.ensurePipeline(DEFAULT_AV_MIME, () => true)
      fixture.initializations.push(recreation)
      expect(fixture.sources).toHaveLength(2)
      expect(priorSource.readyState).toBe('ended')
      expect(fixture.revokeObjectURL).toHaveBeenCalledWith(priorUrl)
      expect(fixture.video.src).not.toBe(priorUrl)
      entryAt(fixture.sources, 1).open()
      await recreation
      priorSource.buffer.dispatchEvent(new Event('error'))
      expect(fixture.onAppendError).not.toHaveBeenCalled()
      expect(entryAt(fixture.sources, 1).buffer.appended).toEqual([])
      expect(observeReceivedMedia(fixture.pipeline)).toEqual(expected)
    } finally {
      await fixture.cleanup()
    }
  })

  /** Reset ends the received rollout, including bytes that have not reached a playback source. */
  it('discards queued media, timing, and completion on explicit reset', async () => {
    const fixture = createReceivedMediaFixture()
    try {
      fixture.pipeline.noteSegmentInit({ segmentIdx: 5, streamId: 'discarded-5', mime: DEFAULT_AV_MIME })
      fixture.pipeline.enqueueChunk(new Uint8Array([8, 9]).buffer)
      fixture.pipeline.noteSegmentComplete({ segmentIdx: 5, streamId: 'discarded-5' })
      fixture.pipeline.setStreamCompleted(true)
      fixture.pipeline.reset()
      expect(observeReceivedMedia(fixture.pipeline)).toEqual({ segments: [], bytes: [] })
      expect(fixture.pipeline.hasArchivedChunks()).toBe(false)
      fixture.setNow(1000)
      const initialization = fixture.pipeline.ensurePipeline(DEFAULT_AV_MIME, () => true)
      fixture.initializations.push(initialization)
      const source = entryAt(fixture.sources, 0)
      source.open()
      await initialization
      fixture.video.buffered = createBufferedRange(0, 0.2)
      fixture.pipeline.maybeStartPlayback()
      expect(source.buffer.appended).toEqual([])
      expect(fixture.video.play).not.toHaveBeenCalled()
      fixture.pipeline.noteSegmentInit({ segmentIdx: 1, streamId: 'fresh-1', mime: DEFAULT_AV_MIME })
      fixture.pipeline.enqueueChunk(new Uint8Array([5, 6]).buffer)
      source.buffer.finishAppend()
      await vi.advanceTimersByTimeAsync(0)
      expect(fixture.video.play).not.toHaveBeenCalled()
      fixture.setNow(1499)
      fixture.pipeline.maybeStartPlayback()
      expect(fixture.video.play).not.toHaveBeenCalled()
      fixture.setNow(1500)
      fixture.pipeline.maybeStartPlayback()
      expect(fixture.video.play).toHaveBeenCalledTimes(1)
      expect(source.buffer.appended).toEqual([[5, 6]])
      expect(observeReceivedMedia(fixture.pipeline)).toEqual({
        segments: [{ key: '1:fresh-1', segmentIdx: 1, streamId: 'fresh-1', mime: DEFAULT_AV_MIME,
          completed: false, bytes: [[5, 6]] }],
        bytes: [[5, 6]],
      })
    } finally {
      await fixture.cleanup()
    }
  })

  /** Page consumes segment snapshots before raw chunks; each returned representation owns its bytes. */
  it('retains owned archive content through preview, segment, and raw-byte consumption', async () => {
    const fixture = createReceivedMediaFixture()
    let preview: Blob | null = null
    try {
      const initialization = fixture.pipeline.ensurePipeline(DEFAULT_AV_MIME, () => true)
      fixture.initializations.push(initialization)
      const source = entryAt(fixture.sources, 0)
      source.open()
      await initialization
      fixture.pipeline.noteSegmentInit({ segmentIdx: 1, streamId: 'segment-1', mime: DEFAULT_AV_MIME })
      fixture.pipeline.enqueueChunk(new Uint8Array([1, 2]).buffer)
      source.buffer.finishAppend()
      await vi.advanceTimersByTimeAsync(0)
      fixture.pipeline.noteSegmentComplete({ segmentIdx: 1, streamId: 'segment-1' })
      fixture.pipeline.noteSegmentInit({ segmentIdx: 2, streamId: 'segment-2', mime: DEFAULT_AV_MIME })
      fixture.pipeline.enqueueChunk(new Uint8Array([3, 4]).buffer)
      source.buffer.finishAppend()
      await vi.advanceTimersByTimeAsync(0)
      const snapshots = fixture.pipeline.buildArchivedSegmentSnapshots()
      const completed = fixture.pipeline.buildArchivedSegmentSnapshots({ includeInProgress: false })
      expect(completed.map(segment => segment.streamId)).toEqual(['segment-1'])
      new Uint8Array(entryAt(entryAt(snapshots, 0).chunks, 0))[0] = 99
      entryAt(snapshots, 0).streamId = 'external-edit'
      expect(completed[0]?.streamId).toBe('segment-1')
      expect(Array.from(new Uint8Array(entryAt(entryAt(completed, 0).chunks, 0)))).toEqual([1, 2])
      preview = fixture.pipeline.buildArchivedStreamBlob()
      const takenSegments = fixture.pipeline.takeArchivedSegmentSnapshots({ includeInProgress: true })
      const rawChunks = fixture.pipeline.takeArchivedStreamChunks()
      expect(preview?.size).toBe(4)
      expect(takenSegments).toEqual([
        { key: '1:segment-1', segmentIdx: 1, streamId: 'segment-1', mime: DEFAULT_AV_MIME,
          completed: true, chunks: [new Uint8Array([1, 2]).buffer] },
        { key: '2:segment-2', segmentIdx: 2, streamId: 'segment-2', mime: DEFAULT_AV_MIME,
          completed: false, chunks: [new Uint8Array([3, 4]).buffer] },
      ])
      expect(rawChunks.map(chunk => Array.from(new Uint8Array(chunk)))).toEqual([[1, 2], [3, 4]])
      expect(observeReceivedMedia(fixture.pipeline)).toEqual({ segments: [], bytes: [] })
      expect(fixture.pipeline.hasArchivedChunks()).toBe(false)
    } finally {
      await fixture.cleanup()
    }
    // Read the owned Blob after pipeline cleanup restores the real clock used by FileReader.
    if (!preview) throw new Error('Expected an archived preview Blob.')
    const previewBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => { resolve(reader.result as ArrayBuffer) }
      reader.onerror = () => { reject(reader.error ?? new Error('FileReader failed without an error')) }
      reader.readAsArrayBuffer(preview)
    })
    expect(Array.from(new Uint8Array(previewBytes))).toEqual([1, 2, 3, 4])
  })

  /** Poll ManagedMediaSource readiness after playback admission even when no start event arrives. */
  it('polls queued ManagedMediaSource bytes without another enqueue or start event', async () => {
    const fixture = createReceivedMediaFixture(true)
    try {
      fixture.pipeline.noteSegmentInit({ segmentIdx: 1, streamId: 'managed-1', mime: DEFAULT_AV_MIME })
      fixture.pipeline.enqueueChunk(new Uint8Array([1, 2]).buffer)
      fixture.pipeline.enqueueChunk(new Uint8Array([3, 4]).buffer)
      const initialization = fixture.pipeline.ensurePipeline(DEFAULT_AV_MIME, () => true)
      fixture.initializations.push(initialization)
      const source = entryAt(fixture.sources, 0)
      source.open()
      await initialization
      expect(source.streaming).toBe(false)
      expect(source.buffer.appended).toEqual([])
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(250)
      expect(source.buffer.appended).toEqual([])
      expect(vi.getTimerCount()).toBe(1)
      source.streaming = true
      await vi.advanceTimersByTimeAsync(249)
      expect(source.buffer.appended).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(source.buffer.appended).toEqual([[1, 2]])
      fixture.video.buffered = createBufferedRange(0, 1.1)
      source.buffer.finishAppend()
      await vi.advanceTimersByTimeAsync(0)
      source.buffer.finishAppend()
      await vi.advanceTimersByTimeAsync(0)
      expect(source.buffer.appended).toEqual([[1, 2], [3, 4]])
      expect(fixture.video.play).toHaveBeenCalledTimes(1)
      expect(observeReceivedMedia(fixture.pipeline).bytes).toEqual([[1, 2], [3, 4]])
      await vi.advanceTimersByTimeAsync(250)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await fixture.cleanup()
    }
  })
})
