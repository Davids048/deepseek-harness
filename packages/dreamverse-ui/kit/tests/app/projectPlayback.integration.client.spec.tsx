/** @vitest-environment jsdom */
/**
 * Ports FastVideo DreamVerse src/app/projectPlayback.integration.test.tsx: live media playback ownership across
 * New project, close, and unmount, and the completed clips that Page archives in memory.
 */
import '../support/setup.client.ts'
import { assetUploadPolicy } from '../support/assetFixtures.client.ts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Server, type Client } from 'mock-socket'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

type Initialization = { status: 'pending' | 'fulfilled' | 'rejected'; error?: string }
type PipelineObservation = { initializations: Initialization[]; segmentInits: number }

const fixtures = vi.hoisted(() => ({
  pipelines: [] as PipelineObservation[],
  sockets: [] as WebSocket[],
  received: [] as (string | number[])[],
  remux: vi.fn<typeof import('../../src/client/media/fmp4Remux.ts').remuxArchivedFmp4Segments>(),
}))

vi.mock('@dreamverse/project-controller/client/storyPresetsData.ts', () => ({
  default: [{ id: 'river', label: 'River', segment_prompts: ['A river'] }],
}))
vi.mock('@dreamverse/project-controller/client/projects.ts', () => ({
  listProjects: async () => [],
  getProject: vi.fn(),
  deleteProject: vi.fn(),
  fetchSegmentVideo: vi.fn(),
}))
vi.mock('../../src/client/media/fmp4Remux.ts', () => ({ remuxArchivedFmp4Segments: fixtures.remux }))

/** Observe actual received messages without replacing Page's socket queue or decoder. */
vi.mock('@dreamverse/project-controller/client/ws/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dreamverse/project-controller/client/ws/client.ts')>()
  return {
    ...actual,
    /** Preserve actual socket callbacks while recording delivery before Page queues its asynchronous work. */
    createWebSocketConnection: (options: Parameters<typeof actual.createWebSocketConnection>[0]) => {
      const ws = actual.createWebSocketConnection({
        ...options,
        onMessage: (event) => {
          fixtures.received.push(typeof event.data === 'string'
            ? (JSON.parse(event.data) as { type: string }).type : [...new Uint8Array(event.data)])
          options.onMessage?.(event)
        },
      })
      fixtures.sockets.push(ws)
      return ws
    },
  }
})

/** Forward every pipeline operation while observing actual initialization settlement and reducer admission. */
vi.mock('../../src/client/media/avPipeline.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/media/avPipeline.ts')>()
  return {
    ...actual,
    /** Observe promises on the actual public methods instead of substituting completion behavior. */
    createAvPipeline: (options: Parameters<typeof actual.createAvPipeline>[0]) => {
      const pipeline = actual.createAvPipeline(options)
      const observation: PipelineObservation = { initializations: [], segmentInits: 0 }
      const ensurePipeline = pipeline.ensurePipeline.bind(pipeline)
      /** Attach settlement observations without consuming or replacing the caller's returned promise. */
      pipeline.ensurePipeline = (...args) => {
        const initialization: Initialization = { status: 'pending' }
        observation.initializations.push(initialization)
        const pending = ensurePipeline(...args)
        void pending.then(
          () => { initialization.status = 'fulfilled' },
          (error: unknown) => {
            initialization.status = 'rejected'
            initialization.error = error instanceof Error ? error.name : String(error)
          },
        )
        return pending
      }
      const noteSegmentInit = pipeline.noteSegmentInit.bind(pipeline)
      pipeline.noteSegmentInit = (meta) => {
        observation.segmentInits += 1
        noteSegmentInit(meta)
      }
      fixtures.pipelines.push(observation)
      return pipeline
    },
  }
})

import { DreamverseApp } from '../../src/client/app/DreamverseApp.tsx'
import { renderDreamverseSlot } from '../support/renderDreamverseSlot.client.tsx'

const mediaSources: ControlledMediaSource[] = []

/** Keep appendBuffer asynchronous until its queued updateend event runs. */
class ControlledSourceBuffer extends EventTarget {
  mode = 'segments'
  updating = false
  appends: number[][] = []
  completedAppends = 0
  addListener = vi.spyOn(this as EventTarget, 'addEventListener')
  removeListener = vi.spyOn(this as EventTarget, 'removeEventListener')

  /** Admit one append and expose buffered media only when the queued browser event completes. */
  appendBuffer(chunk: ArrayBuffer) {
    if (this.updating) throw new DOMException('An append is pending.', 'InvalidStateError')
    this.updating = true
    this.appends.push([...new Uint8Array(chunk)])
    setTimeout(() => {
      this.updating = false
      this.completedAppends += 1
      this.dispatchEvent(new Event('updateend'))
    }, 0)
  }
}

/** Hold sourceopen until the scenario explicitly releases browser initialization. */
class ControlledMediaSource extends EventTarget {
  static isTypeSupported = () => true
  readyState = 'closed'
  streaming = true
  buffer: ControlledSourceBuffer | null = null
  addListener = vi.spyOn(this as EventTarget, 'addEventListener')
  removeListener = vi.spyOn(this as EventTarget, 'removeEventListener')

  constructor() {
    super()
    mediaSources.push(this)
  }

  addSourceBuffer() {
    if (this.readyState !== 'open') throw new DOMException('The source is closed.', 'InvalidStateError')
    this.buffer = new ControlledSourceBuffer()
    return this.buffer
  }

  open() {
    this.readyState = 'open'
    this.dispatchEvent(new Event('sourceopen'))
  }

  endOfStream() {
    this.readyState = 'ended'
  }
}

/** Return a fixture value that the scenario requires, failing the scenario when the value is missing. */
function required<T>(value: T | null | undefined, description: string): T {
  if (value === null || value === undefined) throw new Error(`Missing ${description}`)
  return value
}

/** Return the stubbed MediaSource that Page constructed at an index. */
function mediaSourceAt(index: number): ControlledMediaSource {
  return required(mediaSources[index], `MediaSource ${index}`)
}

/** Return the index of a stubbed MediaSource attached as a video's srcObject, or -1 for any other attachment. */
function mediaSourceIndex(attachment: HTMLMediaElement['srcObject']): number {
  return attachment instanceof ControlledMediaSource ? mediaSources.indexOf(attachment) : -1
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}

function readBlobBytes(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve([...new Uint8Array(reader.result as ArrayBuffer)]) }
    reader.onerror = () => { reject(reader.error ?? new Error('FileReader failed without an error')) }
    reader.readAsArrayBuffer(blob)
  })
}

describe('Project playback ownership', () => {
  let server: Server
  let socket: Client
  let outbound: Record<string, unknown>[]
  let allocations: { value: Blob | MediaSource | ControlledMediaSource; url: string }[]
  let revoked: string[]
  let playCalls: { video: HTMLMediaElement; src: string | null }[]
  let videos: HTMLVideoElement[]
  let videoListeners: {
    added: MockInstance<EventTarget['addEventListener']>
    removed: MockInstance<EventTarget['removeEventListener']>
  }[]
  let localStorageSnapshot: [string, string][]
  let previousLocation: string
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined
  let bufferedDescriptor: PropertyDescriptor | undefined

  /** Isolate browser resources while retaining actual Page, reducer, pipeline, and DOM controls. */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
    fixtures.pipelines = []
    fixtures.sockets = []
    fixtures.received = []
    fixtures.remux.mockReset().mockImplementation(async segments =>
      new Blob(segments.flatMap(segment => segment.chunks), { type: 'video/mp4' }),
    )
    mediaSources.length = 0
    allocations = []
    revoked = []
    playCalls = []
    videos = []
    videoListeners = []
    outbound = []
    localStorageSnapshot = Array.from({ length: localStorage.length }, (_, index) => {
      const key = required(localStorage.key(index), `localStorage key ${index}`)
      return [key, required(localStorage.getItem(key), `localStorage value for ${key}`)]
    })
    localStorage.clear()
    previousLocation = window.location.pathname + window.location.search + window.location.hash
    window.history.replaceState({}, '', '/')
    vi.stubGlobal('MediaSource', ControlledMediaSource)
    vi.stubGlobal('ManagedMediaSource', undefined)
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
    })
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
      const url = `blob:playback-${allocations.length + 1}`
      allocations.push({ value, url })
      return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { revoked.push(url) })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      playCalls.push({ video: this, src: this.getAttribute('src') })
      return Promise.resolve()
    })
    bufferedDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'buffered')
    Object.defineProperty(HTMLMediaElement.prototype, 'buffered', {
      configurable: true,
      get(this: HTMLMediaElement) {
        const value = this.srcObject
          ?? allocations.find(allocation => allocation.url === this.getAttribute('src'))?.value
        const length = value instanceof ControlledMediaSource && value.buffer?.completedAppends ? 1 : 0
        return { length, start: () => 0, end: () => 2 }
      },
    })
    const capabilities = {
      generation_modes: ['t2va'], aspect_ratios: ['16:9'], resolutions: ['720p'], min_segment_duration_sec: 5, max_segment_duration_sec: 15, segment_counts: [1, 2, 3, 4, 5, 6],
      unsupported_generation_modes: { fl2va: 'First/last frame generation is unsupported.' },
      reference_inputs: { media_types: ['image'], max_count: 1, conditioning: 'first_frame' },
      asset_upload: assetUploadPolicy,
    }
    /** Fail unexpected requests instead of allowing the fixture to reach a service. */
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/creation-capabilities')) return new Response(JSON.stringify({
        model_ids: ['fast-h3'], models: { 'fast-h3': capabilities }, ...capabilities,
      }))
      if (url.endsWith('/healthz')) return new Response(JSON.stringify({ status: 'ok' }))
      if (url.endsWith('/readyz')) return new Response(JSON.stringify({ status: 'ready', ready_gpu_workers: 1 }))
      throw new Error(`Unexpected request in playback test: ${url}`)
    }))
    server = new Server(`ws://${window.location.host}/ws`)
    server.on('connection', (connection) => {
      socket = connection
      connection.on('message', wire => outbound.push(JSON.parse(wire as string) as Record<string, unknown>))
    })
  })

  /** Restore browser descriptors only after each scenario has separately settled its held media work. */
  afterEach(() => {
    server.stop()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    }
    if (bufferedDescriptor) Object.defineProperty(HTMLMediaElement.prototype, 'buffered', bufferedDescriptor)
    localStorage.clear()
    localStorageSnapshot.forEach(([key, value]) => { localStorage.setItem(key, value) })
    window.history.replaceState({}, '', previousLocation)
    vi.useRealTimers()
  })

  /** Return the Page video that startProject or a scenario recorded at an index. */
  function videoAt(index: number): HTMLVideoElement {
    return required(videos[index], `video ${index}`)
  }

  /** Return the object URL that Page allocated for a Blob or MediaSource. */
  function allocatedUrl(value: Blob | MediaSource | ControlledMediaSource | undefined): string {
    return required(allocations.find(allocation => allocation.value === value), 'object URL allocation').url
  }

  /** The video Blobs of the completed clips that Page holds in memory: each owns an object URL that Page keeps. */
  function archivedClipBlobs(): Blob[] {
    return allocations.flatMap(({ value, url }) => value instanceof Blob && value.type.startsWith('video/')
      && !revoked.includes(url) ? [value] : [])
  }

  /** Enter the project through the shipped lobby and wait only for the mock socket's queued connection events. */
  async function startProject() {
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await act(async () => {})
    expect(screen.getByText('FastH3')).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: 'Initial prompt' }), { target: { value: 'A river' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await act(async () => {})
    await advance(20)
    expect(outbound).toEqual([expect.objectContaining({ type: 'project_init_v1', initial_rollout_prompt: 'A river' })])
    videos = [...document.querySelectorAll<HTMLVideoElement>('video')]
    expect(videos).toHaveLength(2)
    videoListeners = videos.map(video => ({
      added: vi.spyOn(video as EventTarget, 'addEventListener'),
      removed: vi.spyOn(video as EventTarget, 'removeEventListener'),
    }))
  }

  /** Reach the real reducer's timer yield without advancing sourceopen or its zero-delay timer. */
  async function announceMedia() {
    await act(async () => {
      socket.send(JSON.stringify({ type: 'gpu_assigned' }))
      socket.send(JSON.stringify({ type: 'rewrite_seed_prompts_complete', prompt_id: outbound[0]?.initial_prompt_id }))
      socket.send(JSON.stringify({
        type: 'ltx2_stream_start', origin_prompt_id: outbound[0]?.initial_prompt_id,
        origin_prompt: 'A river', prompt_window_prompts: ['A river'],
      }))
      socket.send(JSON.stringify({ type: 'ltx2_segment_start', segment_idx: 1, seed_prompt_index: 0, source: 'user_enhanced', prompt_id: outbound.at(-1)?.prompt_id || outbound[0]?.initial_prompt_id }))
      socket.send(JSON.stringify({ type: 'media_init', segment_idx: 1, stream_id: 'river-1', mime: 'video/mp4' }))
    })
    expect(fixtures.pipelines.reduce((count, entry) => count + entry.segmentInits, 0)).toBe(1)
    expect(mediaSources).toHaveLength(0)
  }

  function sendCompletion() {
    socket.send(new Uint8Array([1, 2, 3, 4]).buffer)
    socket.send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1, stream_id: 'river-1' }))
    socket.send(JSON.stringify({ type: 'ltx2_stream_complete' }))
    socket.send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'idle' }))
  }

  /** Snapshot resources both at the behavior assertion and after application unmount. */
  function playbackResources() {
    return {
      initialization: fixtures.pipelines.flatMap(entry => entry.initializations.map(init => ({ ...init }))),
      sources: mediaSources.map(source => ({
        readyState: source.readyState,
        registrations: source.addListener.mock.calls.map(([type]) => type),
        removals: source.removeListener.mock.calls.map(([type]) => type),
        appends: source.buffer?.appends ?? [],
        bufferRegistrations: source.buffer?.addListener.mock.calls.map(([type]) => type) ?? [],
        bufferRemovals: source.buffer?.removeListener.mock.calls.map(([type]) => type) ?? [],
      })),
      ownedUrls: allocations.filter(({ value }) => value instanceof ControlledMediaSource)
        .map(({ url }) => ({ url, revoked: revoked.includes(url) })),
      videoSources: videos.map(video => video.getAttribute('src')),
      videoSourceObjects: videos.map(video => video.srcObject == null
        ? null : mediaSourceIndex(video.srcObject)),
      videoListeners: videoListeners.map(({ added, removed }) => ({
        registrations: added.mock.calls.map(([type]) => type), removals: removed.mock.calls.map(([type]) => type),
      })),
      timerCount: vi.getTimerCount(),
    }
  }

  /** Record observable ownership before assertions or any fixture rescue. */
  async function observe(name: string) {
    const observations = {
      name,
      socketStates: fixtures.sockets.map(ws => ws.readyState),
      received: [...fixtures.received],
      lobbyVisible: Boolean(screen.queryByRole('button', { name: 'Generate' })),
      resetPending: Boolean(screen.queryByText('Saving received clips before starting a new project.')),
      ...playbackResources(),
      playCalls: playCalls.map(({ video, src }) => ({ video: videos.indexOf(video as HTMLVideoElement), src })),
      archivedClips: await Promise.all(archivedClipBlobs().map(async blob => ({
        mime: blob.type, size: blob.size, bytes: await readBlobBytes(blob),
      }))),
      archivedSegments: fixtures.remux.mock.calls.flatMap(([segments]) => segments.map(segment => ({
        segmentIdx: segment.segmentIdx, streamId: segment.streamId, mime: segment.mime, completed: segment.completed,
        bytes: segment.chunks.flatMap(chunk => [...new Uint8Array(chunk)]),
      }))),
    }
    return observations
  }

  /** Check application cleanup before rescuing a failed case's remaining browser resources. */
  async function rescuePlayback(name: string) {
    const opened: number[] = []
    // Failed cases must release held callbacks before unmount can remove their settlement listener.
    await advance(1)
    for (const [index, source] of mediaSources.entries()) {
      const awaitingOpen = source.addListener.mock.calls.some(([type, listener]) => type === 'sourceopen'
        && !source.removeListener.mock.calls.some(([removedType, removedListener]) => (
          removedType === type && removedListener === listener
        )))
      if (source.readyState === 'closed' && awaitingOpen) {
        opened.push(index)
        await act(async () => { source.open() })
      }
    }
    await advance(20)
    const pendingBeforeUnmount = fixtures.pipelines.flatMap(entry => entry.initializations)
      .filter(initialization => initialization.status === 'pending').length
    cleanup()
    await advance(20)
    const remainingUrls = allocations.filter(({ url }) => !revoked.includes(url)).map(({ url }) => url)
    const resources = playbackResources()
    expect.soft(opened, `${name}: no source opening needed for fixture rescue`).toEqual([])
    expect.soft(pendingBeforeUnmount, `${name}: initialization settled before fixture rescue`).toBe(0)
    expect.soft(remainingUrls, `${name}: application cleanup revoked its URLs`).toEqual([])
    expect.soft(resources.videoSources.every(src => src === null)).toBe(true)
    expect.soft(resources.videoSourceObjects.every(source => source === null)).toBe(true)
    expect.soft(resources.timerCount).toBe(0)
    expect.soft(fixtures.sockets.every(ws => ws.readyState === WebSocket.CLOSED)).toBe(true)
    const listenerPairs = [
      ...videoListeners.map(({ added, removed }) => [added, removed] as const),
      ...mediaSources.flatMap(source => [
        [source.addListener, source.removeListener] as const,
        ...(source.buffer ? [[source.buffer.addListener, source.buffer.removeListener] as const] : []),
      ]),
    ]
    for (const [added, removed] of listenerPairs) {
      for (const [type, listener] of added.mock.calls) {
        expect.soft(removed).toHaveBeenCalledWith(type, listener)
      }
    }
    remainingUrls.forEach((url) => { URL.revokeObjectURL(url) })
    videos.forEach((video) => { video.pause(); video.removeAttribute('src'); video.load() })
    vi.clearAllTimers()
  }

  /** Leave invalidates received-but-unprocessed binary data and must settle held browser initialization. */
  it('returns to the lobby when New project interrupts held sourceopen', async () => {
    const name = 'held-sourceopen-leave'
    try {
      await startProject()
      await announceMedia()
      await advance(1)
      expect(mediaSources).toHaveLength(1)
      await act(async () => { socket.send(new Uint8Array([9, 8]).buffer) })
      fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
      fireEvent.click(screen.getByRole('button', { name: 'New project' }))
      await advance(20)
      const observations = await observe(name)
      expect(observations).toMatchObject({ lobbyVisible: true, resetPending: false, archivedClips: [] })
      expect(observations.initialization.every(init => init.status !== 'pending')).toBe(true)
      expect(observations.ownedUrls.every(allocation => allocation.revoked)).toBe(true)
      expect(observations.received).toContainEqual([9, 8])
      expect(observations.sources.flatMap(source => source.appends)).toEqual([])
    } finally {
      await rescuePlayback(name)
    }
  })

  /** A queued reducer timer cannot allocate playback after the real New project control invalidates its socket. */
  it('does not create media playback after New project during the reducer tick', async () => {
    const name = 'reducer-tick-leave'
    try {
      await startProject()
      await announceMedia()
      fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
      fireEvent.click(screen.getByRole('button', { name: 'New project' }))
      await advance(20)
      const observations = await observe(name)
      expect(observations).toMatchObject({ lobbyVisible: true, resetPending: false, sources: [], ownedUrls: [] })
      expect(observations.videoSources.every(src => src === null)).toBe(true)
      expect(observations.archivedClips).toEqual([])
    } finally {
      await rescuePlayback(name)
    }
  })

  /** Ordinary close retains socket ownership long enough to archive every already received media message. */
  it('archives queued media after normal close without reopening live playback', async () => {
    const name = 'normal-close-queued-media'
    try {
      await startProject()
      await announceMedia()
      await advance(1)
      expect(mediaSources).toHaveLength(1)
      await act(async () => { sendCompletion() })
      expect(fixtures.received).toEqual([
        'gpu_assigned', 'rewrite_seed_prompts_complete', 'ltx2_stream_start', 'ltx2_segment_start',
        'media_init', [1, 2, 3, 4],
        'media_segment_complete', 'ltx2_stream_complete', 'generation_round_status',
      ])
      await act(async () => { socket.close({ code: 1000, reason: 'Generation complete', wasClean: true }) })
      await advance(20)
      const observations = await observe(name)
      expect(observations.archivedClips).toEqual([expect.objectContaining({ size: 4, bytes: [1, 2, 3, 4] })])
      expect(observations.archivedSegments).toEqual([{
        segmentIdx: 1, streamId: 'river-1', mime: 'video/mp4', completed: true, bytes: [1, 2, 3, 4],
      }])
      expect(observations.initialization.every(init => init.status !== 'pending')).toBe(true)
      expect(observations.ownedUrls.every(allocation => allocation.revoked)).toBe(true)
      expect(observations.playCalls.filter(call => call.video === 1)).toEqual([])
      const clipUrl = allocatedUrl(archivedClipBlobs()[0])
      expect(videos[0]).toHaveAttribute('src', clipUrl)
      expect(revoked).not.toContain(clipUrl)
    } finally {
      await rescuePlayback(name)
    }
  })

  /** Select a real completed Blob, return to Current, then release deferred work from the superseded selection. */
  it('does not reattach Original after the user selects Current', async () => {
    const name = 'original-current-blob'
    try {
      await startProject()
      await announceMedia()
      await advance(1)
      await act(async () => { mediaSourceAt(0).open() })
      await act(async () => { sendCompletion() })
      await advance(20)
      expect(archivedClipBlobs()).toHaveLength(1)
      expect(await readBlobBytes(required(archivedClipBlobs()[0], 'archived clip 0'))).toEqual([1, 2, 3, 4])
      const clipUrl = allocatedUrl(archivedClipBlobs()[0])
      fireEvent.change(screen.getByRole('textbox', { name: 'Continuation prompt' }), {
        target: { value: 'A forest in rain' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Rewrite rollout' }))
      await advance(10)
      expect(outbound[1]).toMatchObject({ type: 'rewrite_seed_prompts', rewrite_instruction: 'A forest in rain' })
      fireEvent.click(screen.getByText('Original'))
      await act(async () => {})
      fireEvent.click(screen.getByText('A forest in rain'))
      const sourceAtCurrent = videoAt(0).getAttribute('src')
      const playsAtCurrent = playCalls.filter(call => call.video === videos[0]).length
      await advance(10)
      const observations = await observe(name)
      expect(videos[0]).toHaveClass('hidden')
      expect(videoAt(0).getAttribute('src')).toBe(sourceAtCurrent)
      expect(playCalls.filter(call => call.video === videos[0])).toHaveLength(playsAtCurrent)
      expect(observations.archivedClips[0]?.bytes).toEqual([1, 2, 3, 4])
      expect(revoked).not.toContain(clipUrl)
    } finally {
      await rescuePlayback(name)
    }
  })

  /** React clears element refs during unmount; the pipeline must still detach its captured live video. */
  it('settles held initialization and detaches playback on Page unmount', async () => {
    const name = 'pending-initialization-unmount'
    try {
      await startProject()
      await announceMedia()
      await advance(1)
      const source = mediaSourceAt(0)
      expect(videoAt(1).getAttribute('src')).toBeTruthy()
      cleanup()
      await advance(20)
      const observations = await observe(name)
      expect(observations.initialization).toEqual([expect.objectContaining({ status: 'rejected' })])
      expect(observations.videoSources).toEqual([null, null])
      expect(observations.ownedUrls.every(allocation => allocation.revoked)).toBe(true)
      expect(source.removeListener).toHaveBeenCalledWith('sourceopen', expect.any(Function))
      expect(observations.socketStates).toEqual([WebSocket.CLOSED])
      expect(observations.timerCount).toBe(0)
      await act(async () => { source.open() })
      expect(source.buffer).toBeNull()
      expect(playCalls).toEqual([])
      expect(archivedClipBlobs()).toEqual([])
    } finally {
      await rescuePlayback(name)
    }
  })

  /** A genuine initialization error leaves the reducer's registered media available for archival. */
  it('shows playback setup failure and archives subsequent received bytes', async () => {
    const name = 'source-buffer-failure'
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await startProject()
      await announceMedia()
      await advance(1)
      const source = mediaSourceAt(0)
      vi.spyOn(source, 'addSourceBuffer').mockImplementation(() => { throw new Error('Codec allocation failed') })
      await act(async () => { sendCompletion() })
      await act(async () => { source.open() })
      await advance(20)
      expect(screen.getByRole('heading', { name: 'Playback Error' })).toBeVisible()
      expect(errorLog).toHaveBeenCalledWith('media_init failed:', expect.objectContaining({
        message: expect.stringContaining('Codec allocation failed') as string,
      }))
      const observations = await observe(name)
      expect(observations.archivedClips).toEqual([expect.objectContaining({ bytes: [1, 2, 3, 4] })])
      expect(observations.archivedSegments).toEqual([{
        segmentIdx: 1, streamId: 'river-1', mime: 'video/mp4', completed: true, bytes: [1, 2, 3, 4],
      }])
      expect(observations.videoSources[1]).toBeNull()
      expect(observations.ownedUrls.every(allocation => allocation.revoked)).toBe(true)
      expect(playCalls).toEqual([])
    } finally {
      await rescuePlayback(name)
    }
  })

  /** Both selectable archives come from received rollouts; selection borrows their URLs until project cleanup. */
  it('keeps the last Original selection through an Original Current Original sequence', async () => {
    const name = 'original-current-original'
    try {
      await startProject()
      await announceMedia()
      await advance(1)
      await act(async () => { mediaSourceAt(0).open() })
      await act(async () => { sendCompletion() })
      await advance(20)
      fireEvent.change(screen.getByRole('textbox', { name: 'Continuation prompt' }), {
        target: { value: 'A forest in rain' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Rewrite rollout' }))
      await advance(10)
      expect(outbound[1]).toMatchObject({ type: 'rewrite_seed_prompts', rewrite_instruction: 'A forest in rain' })
      await act(async () => {
        socket.send(JSON.stringify({
          type: 'seed_prompts_updated', prompts: ['A forest'],
        }))
        socket.send(JSON.stringify({ type: 'rewrite_seed_prompts_complete', prompt_id: outbound.at(-1)?.prompt_id }))
        socket.send(JSON.stringify({
          type: 'ltx2_stream_start', origin_prompt_id: outbound.at(-1)?.prompt_id,
          origin_prompt: outbound.at(-1)?.rewrite_instruction, prompt_window_prompts: ['A forest'],
        }))
        socket.send(JSON.stringify({
          type: 'ltx2_segment_start', segment_idx: 1, seed_prompt_index: 0, source: 'user_enhanced',
          prompt_id: outbound.at(-1)?.prompt_id || outbound[0]?.initial_prompt_id,
        }))
        socket.send(JSON.stringify({ type: 'media_init', segment_idx: 1, stream_id: 'forest-1', mime: 'video/mp4' }))
      })
      await advance(1)
      expect(mediaSources).toHaveLength(2)
      await act(async () => { mediaSourceAt(1).open() })
      await act(async () => {
        socket.send(new Uint8Array([5, 6]).buffer)
        socket.send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1, stream_id: 'forest-1' }))
        socket.send(JSON.stringify({ type: 'ltx2_stream_complete' }))
        socket.send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'idle' }))
      })
      await advance(20)
      expect(archivedClipBlobs()).toHaveLength(2)
      await act(async () => { socket.close({ code: 1000, reason: '', wasClean: true }) })
      await advance(20)
      const urls = archivedClipBlobs().map(blob => allocatedUrl(blob))
      const playsBeforeSelection = playCalls.filter(call => call.video === videos[0]).length
      fireEvent.click(screen.getByText('Original'))
      expect(videos[0]).toHaveAttribute('src', urls[0])
      fireEvent.click(screen.getByText('A forest in rain'))
      expect(videos[0]).toHaveAttribute('src', urls[1])
      fireEvent.click(screen.getByText('Original'))
      await advance(20)
      expect(videos[0]).toHaveAttribute('src', urls[0])
      expect(playCalls.filter(call => call.video === videos[0]).slice(playsBeforeSelection).map(call => call.src))
        .toEqual([urls[0], urls[1], urls[0]])
      expect(urls.some(url => revoked.includes(url))).toBe(false)
      expect(await Promise.all(archivedClipBlobs().map(blob => readBlobBytes(blob))))
        .toEqual([[1, 2, 3, 4], [5, 6]])
    } finally {
      await rescuePlayback(name)
    }
  })
})
