/** @vitest-environment jsdom */
/**
 * Ports FastVideo DreamVerse src/app/projectPlayback.integration.test.tsx: live media playback ownership across
 * New project, close, unmount, and saved viewing, plus project save snapshots and thumbnails.
 */
import '../support/setup.client.ts'
import { assetUploadPolicy } from '../support/assetFixtures.client.ts'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Server, type Client } from 'mock-socket'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance, type MockResult } from 'vitest'
import type { StoredClip, StoredProject } from '@dreamverse/project-controller/client/projectStorage.ts'

type Initialization = { status: 'pending' | 'fulfilled' | 'rejected'; error?: string }
type PipelineObservation = { initializations: Initialization[]; segmentInits: number }

const fixtures = vi.hoisted(() => ({
  pipelines: [] as PipelineObservation[],
  sockets: [] as WebSocket[],
  received: [] as (string | number[])[],
  projects: [] as StoredProject[],
  clips: [] as StoredClip[],
  save: vi.fn<typeof import('@dreamverse/project-controller/client/projectStorage.ts').saveProject>(),
  remux: vi.fn<typeof import('../../src/client/media/fmp4Remux.ts').remuxArchivedFmp4Segments>(),
}))

vi.mock('@dreamverse/project-controller/client/storyPresetsData.ts', () => ({
  default: [{ id: 'river', label: 'River', segment_prompts: ['A river'] }],
}))
vi.mock('@dreamverse/project-controller/client/projectStorage.ts', () => ({
  saveProject: fixtures.save,
  saveProjectMetadata: vi.fn(),
  listProjects: async () => [...fixtures.projects],
  loadProjectClips: async (id: string) => fixtures.clips.filter(clip => clip.projectId === id),
  deleteProject: vi.fn(),
  pruneOldProjects: vi.fn(),
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

/** Return the value that a spied call returned, failing the case when the call threw or has not returned. */
function returnedValue<T>(result: MockResult<T> | undefined, description: string): T {
  if (result?.type !== 'return') throw new Error(`Missing ${description}`)
  return result.value
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
    fixtures.projects = []
    fixtures.clips = []
    fixtures.save.mockReset().mockImplementation(async (project, clips) => {
      fixtures.projects = [project, ...fixtures.projects.filter(saved => saved.id !== project.id)]
      fixtures.clips = [...fixtures.clips.filter(clip => clip.projectId !== project.id), ...clips]
    })
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
      savedClips: await Promise.all(fixtures.clips.map(async clip => ({
        id: clip.id, mime: clip.mime, size: clip.blob.size, bytes: await readBlobBytes(clip.blob),
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
      expect(observations).toMatchObject({ lobbyVisible: true, resetPending: false, savedClips: [] })
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
      expect(observations.savedClips).toEqual([])
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
      expect(observations.savedClips).toEqual([expect.objectContaining({ size: 4, bytes: [1, 2, 3, 4] })])
      expect(observations.archivedSegments).toEqual([{
        segmentIdx: 1, streamId: 'river-1', mime: 'video/mp4', completed: true, bytes: [1, 2, 3, 4],
      }])
      expect(observations.initialization.every(init => init.status !== 'pending')).toBe(true)
      expect(observations.ownedUrls.every(allocation => allocation.revoked)).toBe(true)
      expect(observations.playCalls.filter(call => call.video === 1)).toEqual([])
      const clipUrl = allocatedUrl(fixtures.clips[0]?.blob)
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
      expect(fixtures.clips).toHaveLength(1)
      expect(await readBlobBytes(required(fixtures.clips[0], 'saved clip 0').blob)).toEqual([1, 2, 3, 4])
      const clipUrl = allocatedUrl(fixtures.clips[0]?.blob)
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
      expect(observations.savedClips[0]?.bytes).toEqual([1, 2, 3, 4])
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
      expect(fixtures.clips).toEqual([])
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
      expect(observations.savedClips).toEqual([expect.objectContaining({ bytes: [1, 2, 3, 4] })])
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

  /** Closing a live project can select its final clip while a saved project owns the visible player. */
  it('attaches a closed project archive without autoplay behind saved viewing', async () => {
    const name = 'close-behind-saved-view'
    const savedProject: StoredProject = {
      id: 'saved', label: 'Saved coast', originalLabel: 'Saved coast', presetId: 'river', createdAt: 1,
      lastThumbnail: null, promptEvents: [],
    }
    const savedClip: StoredClip = {
      id: 'saved-clip', projectId: savedProject.id, label: 'Coast', prompt: 'A coast', mime: 'video/mp4',
      blob: new Blob([new Uint8Array([8, 9])], { type: 'video/mp4' }), createdAt: 1,
    }
    fixtures.projects = [savedProject]
    fixtures.clips = [savedClip]
    try {
      await startProject()
      await announceMedia()
      await advance(1)
      fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
      const sidebar = screen.getByRole('complementary', { name: 'Project history' })
      fireEvent.click(within(sidebar).getByRole('button', { name: /Saved coast/ }))
      await act(async () => {})
      expect(screen.getByText('View-only project')).toBeVisible()
      expect(videoAt(0).closest('div.hidden')).not.toBeNull()
      await act(async () => { sendCompletion() })
      await act(async () => { socket.close({ code: 1000, reason: '', wasClean: true }) })
      await advance(20)
      const generated = fixtures.clips.find(clip => clip.projectId !== savedProject.id)
      expect(generated).toBeDefined()
      if (!generated) throw new Error('Missing generated clip')
      expect(await readBlobBytes(generated.blob)).toEqual([1, 2, 3, 4])
      const generatedUrl = allocatedUrl(generated.blob)
      expect(videos[0]).toHaveAttribute('src', generatedUrl)
      expect(videoAt(0).closest('div.hidden')).not.toBeNull()
      expect(playCalls.filter(call => videos.includes(call.video as HTMLVideoElement))).toEqual([])
      expect(revoked).not.toContain(generatedUrl)
      expect(fixtures.clips.find(clip => clip.id === savedClip.id)).toBe(savedClip)
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
      expect(fixtures.clips).toHaveLength(2)
      await act(async () => { socket.close({ code: 1000, reason: '', wasClean: true }) })
      await advance(20)
      const urls = fixtures.clips.map(clip => allocatedUrl(clip.blob))
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
      expect(await Promise.all(fixtures.clips.map(clip => readBlobBytes(clip.blob))))
        .toEqual([[1, 2, 3, 4], [5, 6]])
    } finally {
      await rescuePlayback(name)
    }
  })

  describe('Project save snapshots', () => {
    const thumbnail = 'data:image/jpeg;base64,Y29udHJvbGxlZC1saXZlLWZyYW1l'
    const replacementThumbnail = 'data:image/jpeg;base64,cmVwbGFjZW1lbnQtZnJhbWU='
    let sampledThumbnail: string
    let canvasSamples: { video: number; src: string | null; managedSource: number }[]
    let visibilityDescriptor: PropertyDescriptor | undefined

    /** Supply drawable frames while recording which actual Page video and attachment the canvas samples. */
    beforeEach(() => {
      canvasSamples = []
      sampledThumbnail = thumbnail
      visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
      vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640)
      vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(360)
      const drawImage = vi.fn((image: CanvasImageSource) => {
        const video = image as HTMLVideoElement
        canvasSamples.push({
          video: videos.indexOf(video),
          src: video.getAttribute('src'),
          managedSource: mediaSourceIndex(video.srcObject),
        })
      })
      const canvasContext: Pick<CanvasRenderingContext2D, 'drawImage'> = { drawImage }
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue(canvasContext as CanvasRenderingContext2D)
      vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => sampledThumbnail)
      const playing = new WeakSet<HTMLMediaElement>()
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
        playing.add(this)
        playCalls.push({ video: this, src: this.getAttribute('src') })
        return Promise.resolve()
      })
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
        playing.delete(this)
      })
      vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) {
        return !playing.has(this)
      })
      vi.spyOn(HTMLMediaElement.prototype, 'ended', 'get').mockReturnValue(false)
      vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2)
    })

    afterEach(() => {
      if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor)
      else Reflect.deleteProperty(document, 'visibilityState')
    })

    /** Finish the ordinary received-media path before isolating a particular save producer. */
    async function startCompletedProject(attachment: 'url' | 'managed' = 'url') {
      if (attachment === 'managed') vi.stubGlobal('ManagedMediaSource', ControlledMediaSource)
      await startProject()
      await announceMedia()
      await advance(1)
      await act(async () => { mediaSourceAt(0).open() })
      await act(async () => { sendCompletion() })
      await advance(100)
      expect(fixtures.clips).toHaveLength(1)
      expect(await readBlobBytes(required(fixtures.clips[0], 'saved clip 0').blob)).toEqual([1, 2, 3, 4])
      if (attachment === 'managed') expect(videoAt(1).srcObject).toBe(mediaSources[0])
      else expect(videos[1]).toHaveAttribute('src', allocatedUrl(mediaSources[0]))
    }

    /** Submit through the composer and observe its actual socket request before supplying any provider reply. */
    async function submitRewrite(prompt = 'A forest in rain') {
      fireEvent.change(screen.getByRole('textbox', { name: 'Continuation prompt' }), { target: { value: prompt } })
      fireEvent.click(screen.getByRole('button', { name: 'Rewrite rollout' }))
      await advance(10)
      expect(outbound.at(-1)).toMatchObject({ type: 'rewrite_seed_prompts', rewrite_instruction: prompt })
    }

    /** Deliver a completed replacement through the real reducer, media initialization, and archive producer. */
    async function receiveForestRollout() {
      const sourceIndex = mediaSources.length
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
      await act(async () => { mediaSourceAt(sourceIndex).open() })
      await act(async () => {
        socket.send(new Uint8Array([5, 6]).buffer)
        socket.send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1, stream_id: 'forest-1' }))
        socket.send(JSON.stringify({ type: 'ltx2_stream_complete' }))
        socket.send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'idle' }))
      })
      await advance(100)
    }

    function currentCardThumbnail() {
      const card = screen.getAllByText('Current')
        .map(element => element.closest('[data-selected]')).find(Boolean)
      return card?.querySelector('img')?.getAttribute('src') ?? null
    }

    /** Describe actual storage arguments, including asynchronously read Blob bytes, before a behavior assertion. */
    async function saveRecords(firstCall: number) {
      return Promise.all(fixtures.save.mock.calls.slice(firstCall).map(async ([project, clips]) => ({
        project,
        clips: await Promise.all(clips.map(async clip => ({
          id: clip.id, projectId: clip.projectId, label: clip.label, prompt: clip.prompt,
          mime: clip.mime, createdAt: clip.createdAt, bytes: await readBlobBytes(clip.blob),
        }))),
      })))
    }

    describe('Clip origin', () => {
      const riverPrompts = ['A river', 'River bend', 'River rapids', 'River bridge', 'River valley', 'River delta']
      const forestPrompts = ['A forest', 'Forest rain', 'Forest path', 'Forest clearing', 'Forest lake', 'Forest dawn']

      /** Finish A's finite round and capture its preview before accepting a rewrite. */
      async function startCompletedRiver() {
        await startProject()
        const initialPromptId = outbound[0]?.initial_prompt_id
        await act(async () => {
          socket.send(JSON.stringify({ type: 'gpu_assigned' }))
          socket.send(JSON.stringify({
            type: 'seed_prompts_updated', prompts: riverPrompts,
          }))
          socket.send(JSON.stringify({ type: 'rewrite_seed_prompts_complete', prompt_id: initialPromptId }))
          socket.send(JSON.stringify({
            type: 'ltx2_stream_start',
            origin_prompt_id: initialPromptId, origin_prompt: 'A river', prompt_window_prompts: riverPrompts,
          }))
          socket.send(JSON.stringify({
            type: 'ltx2_segment_start', segment_idx: 1, seed_prompt_index: 0, source: 'user_enhanced',
            prompt_id: outbound.at(-1)?.prompt_id || outbound[0]?.initial_prompt_id,
          }))
          socket.send(JSON.stringify({ type: 'media_init', segment_idx: 1, stream_id: 'river-1', mime: 'video/mp4' }))
        })
        await advance(1)
        await act(async () => { mediaSourceAt(0).open() })
        await act(async () => { socket.send(new Uint8Array([1, 2]).buffer) })
        await advance(20)
        fireEvent.playing(videoAt(1))
        await advance(500)
        await act(async () => {
          socket.send(new Uint8Array([3, 4]).buffer)
          socket.send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1, stream_id: 'river-1' }))
          socket.send(JSON.stringify({ type: 'ltx2_stream_complete' }))
          socket.send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'idle' }))
        })
        await advance(100)
        expect(screen.getByRole('textbox', { name: 'Continuation prompt' })).toBeEnabled()
      }

      /** Accept a complete prompt window or report a failed preparation without replacing accepted prompts. */
      async function receiveRewriteResult(request: Record<string, unknown>, prompts: string[], error?: string) {
        await act(async () => {
          if (!error) {
            socket.send(JSON.stringify({ type: 'seed_prompts_updated', prompts }))
          }
          socket.send(JSON.stringify({
            type: 'rewrite_seed_prompts_complete', prompt_id: request.prompt_id, error,
          }))
          if (error) {
            socket.send(JSON.stringify({ type: 'error', prompt_id: request.prompt_id, message: error }))
            socket.send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'failed' }))
          } else {
            socket.send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'generating' }))
          }
        })
        await advance(10)
      }

      /** Record actual saved links, request IDs, selected media, and resources before fixture cleanup. */
      async function recordClipOrigin(name: string) {
        const selectedUrl = videos[0]?.getAttribute('src') ?? null
        const selectedBlob = allocations.find(({ url }) => url === selectedUrl)?.value
        const observation = {
          ...await observe(name),
          outbound: outbound.map(request => ({ ...request })),
          projects: fixtures.projects.map(project => ({
            ...project, promptEvents: project.promptEvents.map(event => ({ ...event })),
          })),
          clips: await Promise.all(fixtures.clips.map(async clip => ({
            id: clip.id, prompt: clip.prompt, label: clip.label, bytes: await readBlobBytes(clip.blob),
          }))),
          selectedUrl,
          selectedBytes: selectedBlob instanceof Blob ? await readBlobBytes(selectedBlob) : null,
          currentCardImages: screen.queryAllByText('Current')
            .map(label => label.closest('[data-selected]'))
            .filter((card): card is Element => card !== null)
            .map(card => card.querySelector('img')?.getAttribute('src') ?? null),
        }
        console.info('clip-origin-observation', JSON.stringify(observation))
        return observation
      }

      /** A remains archived while B prepares; selecting archived B supplies B's complete rewrite window. */
      it('keeps a completed clip linked to its request while the next rewrite waits', async () => {
        const name = 'clip-origin-completion-before-rewrite'
        try {
          await startCompletedRiver()
          await submitRewrite('A forest in rain')
          const rewriteB = required(outbound.at(-1), 'rewrite request')
          await advance(100)
          const completedA = await recordClipOrigin(`${name}:A-completed-B-pending`)
          expect(completedA.clips).toHaveLength(1)
          expect(completedA.clips[0]?.bytes).toEqual([1, 2, 3, 4])
          expect.soft(completedA.projects[0]?.promptEvents.find(event => event.text === 'A forest in rain')?.clipId)
            .toBeUndefined()
          expect.soft(completedA.projects[0]?.promptEvents.find(event => event.text === 'A river')?.clipId)
            .toBe(completedA.clips[0]?.id)
          await receiveRewriteResult(rewriteB, forestPrompts)
          await act(async () => {
            socket.send(JSON.stringify({
              type: 'ltx2_stream_start',
              origin_prompt_id: rewriteB.prompt_id, origin_prompt: 'A forest in rain',
              prompt_window_prompts: forestPrompts,
            }))
            socket.send(JSON.stringify({
              type: 'ltx2_segment_start', segment_idx: 1, seed_prompt_index: 0, source: 'user_enhanced',
              prompt_id: outbound.at(-1)?.prompt_id || outbound[0]?.initial_prompt_id,
            }))
            socket.send(JSON.stringify({ type: 'media_init', segment_idx: 1, stream_id: 'forest-1', mime: 'video/mp4' }))
          })
          await advance(1)
          await act(async () => { mediaSourceAt(1).open() })
          await act(async () => {
            socket.send(new Uint8Array([5, 6]).buffer)
            socket.send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1, stream_id: 'forest-1' }))
            socket.send(JSON.stringify({ type: 'ltx2_stream_complete' }))
            socket.send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'idle' }))
          })
          await advance(1100)
          await submitRewrite('A coast at dusk')
          const rewriteC = required(outbound.at(-1), 'rewrite request')
          await receiveRewriteResult(rewriteC, forestPrompts, 'Controlled provider failure')
          fireEvent.click(screen.getByText('A forest in rain'))
          await advance(20)
          const historicalB = await recordClipOrigin(`${name}:B-selected-after-C`)
          expect(historicalB.clips).toHaveLength(2)
          expect(historicalB.clips.map(clip => clip.bytes)).toEqual([[1, 2, 3, 4], [5, 6]])
          expect.soft(historicalB.selectedBytes).toEqual([5, 6])
          expect.soft(historicalB.clips[1]?.prompt).toBe('A forest in rain')
          expect.soft(historicalB.projects[0]?.promptEvents.find(event => event.text === 'A forest in rain')?.clipId)
            .toBe(historicalB.clips[1]?.id)
          await advance(1100)
          await submitRewrite('Keep this forest')
          expect.soft(outbound.at(-1)?.prompt_window_prompts).toEqual(forestPrompts)
          expect.soft(outbound[0]?.initial_prompt_id).toBeTypeOf('string')
          expect.soft(rewriteB.prompt_id).toBeTypeOf('string')
          expect.soft(rewriteC.prompt_id).toBeTypeOf('string')
          expect.soft(rewriteC.prompt_id).not.toBe(rewriteB.prompt_id)
        } finally {
          await recordClipOrigin(`${name}:before-cleanup`)
          await rescuePlayback(name)
        }
      })

      /** Accepted B owns its clip while both preparation and generation reject another edit. */
      it('keeps the accepted rewrite origin while later editing waits for round completion', async () => {
        const name = 'clip-origin-busy-round'
        try {
          await startCompletedRiver()
          await submitRewrite('A forest in rain')
          const rewriteB = required(outbound.at(-1), 'rewrite request')
          const composer = screen.getByRole('textbox', { name: 'Continuation prompt' })
          expect(composer).toBeDisabled()
          await receiveRewriteResult(rewriteB, forestPrompts)
          expect(composer).toBeDisabled()
          fireEvent.change(composer, { target: { value: 'A coast at dusk' } })
          fireEvent.keyDown(composer, { key: 'Enter' })
          fireEvent.click(screen.getByRole('button', { name: 'Rewrite rollout' }))
          await advance(10)
          expect(outbound).toHaveLength(2)
          await receiveForestRollout()
          const completedB = await recordClipOrigin(`${name}:B-completed`)
          expect(composer).toBeEnabled()
          expect(completedB.clips).toHaveLength(2)
          expect(completedB.clips[1]?.bytes).toEqual([5, 6])
          expect(completedB.clips[1]?.prompt).toBe('A forest in rain')
          expect(completedB.projects[0]?.promptEvents.find(event => event.promptId === rewriteB.prompt_id)?.clipId)
            .toBe(completedB.clips[1]?.id)
          expect(completedB.projects[0]?.promptEvents.some(event => event.text === 'A coast at dusk')).toBe(false)
        } finally {
          await recordClipOrigin(`${name}:before-cleanup`)
          await rescuePlayback(name)
        }
      })

      /** Resuming completed A updates its result preview while pending B keeps its captured source image. */
      it('keeps resumed playback thumbnails on the stream origin while a rewrite waits', async () => {
        const name = 'clip-origin-resumed-A-thumbnail'
        try {
          await startCompletedRiver()
          await submitRewrite('A forest in rain')
          const rewriteB = required(outbound.at(-1), 'rewrite request')
          sampledThumbnail = replacementThumbnail
          fireEvent.playing(videoAt(1))
          await advance(500)
          const observation = await recordClipOrigin(`${name}:A-captured-B-pending`)
          const initialEvent = observation.projects[0]?.promptEvents.find(event => event.text === 'A river')
          const pendingEvent = observation.projects[0]?.promptEvents.find(event => event.text === 'A forest in rain')
          expect(observation.projects[0]?.lastThumbnail).toBe(replacementThumbnail)
          expect(pendingEvent?.thumbnail).toBe(thumbnail)
          expect.soft(initialEvent?.resultThumbnail).toBe(replacementThumbnail)
          expect.soft(pendingEvent?.resultThumbnail).toBeUndefined()
          expect.soft(observation.currentCardImages).toEqual([null])
          expect.soft(outbound[0]?.initial_prompt_id).toBeTypeOf('string')
          expect.soft(rewriteB.prompt_id).toBeTypeOf('string')
        } finally {
          await recordClipOrigin(`${name}:before-cleanup`)
          await rescuePlayback(name)
        }
      })

      /** Repeating an instruction creates a distinct request and preserves the preceding archive link and image. */
      it('preserves the first archived request link and image when its instruction is repeated', async () => {
        const name = 'clip-origin-repeated-instruction'
        try {
          await startCompletedRiver()
          await advance(20)
          expect(fixtures.clips).toHaveLength(1)
          const firstClipId = required(fixtures.clips[0], 'saved clip 0').id
          const requestId = outbound[0]?.initial_prompt_id
          expect(fixtures.projects[0]?.promptEvents.find(event => event.promptId === requestId))
            .toMatchObject({ clipId: firstClipId, resultThumbnail: thumbnail })
          await submitRewrite('A river')
          const repeatedRequest = required(outbound.at(-1), 'rewrite request')
          await receiveRewriteResult(repeatedRequest, riverPrompts)
          await act(async () => {
            socket.send(JSON.stringify({
              type: 'ltx2_stream_start',
              origin_prompt_id: repeatedRequest.prompt_id, origin_prompt: 'A river', prompt_window_prompts: riverPrompts,
            }))
            socket.send(JSON.stringify({ type: 'ltx2_segment_start', segment_idx: 1, seed_prompt_index: 0, source: 'user_enhanced', prompt_id: outbound.at(-1)?.prompt_id || outbound[0]?.initial_prompt_id }))
            socket.send(JSON.stringify({ type: 'media_init', segment_idx: 1, stream_id: 'river-repeat', mime: 'video/mp4' }))
          })
          await advance(1)
          await act(async () => { mediaSourceAt(1).open() })
          await act(async () => { socket.send(new Uint8Array([5, 6]).buffer) })
          await advance(20)
          sampledThumbnail = replacementThumbnail
          fireEvent.playing(videoAt(1))
          await advance(500)
          await act(async () => {
            socket.send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1, stream_id: 'river-repeat' }))
            socket.send(JSON.stringify({ type: 'ltx2_stream_complete' }))
            socket.send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'idle' }))
          })
          await advance(20)
          expect(fixtures.clips).toHaveLength(2)
          expect(fixtures.clips[1]?.id).not.toBe(firstClipId)
          expect(fixtures.clips.map(clip => clip.prompt)).toEqual(['A river', 'A river'])
          expect(await Promise.all(fixtures.clips.map(clip => readBlobBytes(clip.blob))))
            .toEqual([[1, 2, 3, 4], [5, 6]])
          expect(fixtures.projects[0]?.promptEvents.find(event => event.promptId === requestId))
            .toMatchObject({ clipId: firstClipId, resultThumbnail: thumbnail })
          expect(fixtures.projects[0]?.lastThumbnail).toBe(replacementThumbnail)
          await act(async () => {
            socket.send(JSON.stringify({ type: 'ltx2_stream_complete' }))
            socket.send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'idle' }))
            socket.close({ code: 1000, reason: '', wasClean: true })
          })
          await advance(20)
          expect(fixtures.clips).toHaveLength(2)
        } finally {
          await recordClipOrigin(`${name}:before-cleanup`)
          await rescuePlayback(name)
        }
      })

      /** Rejected edits populate bounded history without replacing A's accepted prompts or archived media. */
      it('retains archived media after its origin event is evicted without linking another request', async () => {
        const name = 'clip-origin-history-eviction'
        try {
          await startCompletedRiver()
          for (let index = 0; index < 13; index += 1) {
            await advance(1100)
            await submitRewrite(`Rejected edit ${index}`)
            const request = required(outbound.at(-1), 'rewrite request')
            await receiveRewriteResult(request, riverPrompts, 'Prompt safety filter blocked rewritten prompt 1.')
          }
          await advance(20)
          await act(async () => { window.dispatchEvent(new Event('beforeunload')) })
          const project = required(fixtures.projects[0], 'saved project')
          expect(project.promptEvents).toHaveLength(24)
          expect(project.promptEvents.some(event => event.promptId === outbound[0]?.initial_prompt_id)).toBe(false)
          expect(project.promptEvents.every(event => !event.clipId)).toBe(true)
          expect(fixtures.clips).toHaveLength(1)
          expect(fixtures.clips[0]?.prompt).toBe('A river')
          expect(project.label).toBe(fixtures.clips[0]?.label)
          expect(await readBlobBytes(required(fixtures.clips[0], 'saved clip 0').blob)).toEqual([1, 2, 3, 4])
          await advance(1100)
          await submitRewrite('Continue this river')
          expect(outbound.at(-1)?.prompt_window_prompts).toEqual(riverPrompts)
        } finally {
          await recordClipOrigin(`${name}:before-cleanup`)
          await rescuePlayback(name)
        }
      })
    })

    /** All mount-installed save producers must read the selected clip and the image displayed after capture. */
    it('captures live metadata for background saves', async () => {
      const name = 'project-save-background'
      try {
        await startCompletedProject()
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
        await act(async () => { mediaSourceAt(1).open() })
        await act(async () => {
          socket.send(new Uint8Array([5, 6]).buffer)
          socket.send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1, stream_id: 'forest-1' }))
          socket.send(JSON.stringify({ type: 'ltx2_stream_complete' }))
          socket.send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'idle' }))
        })
        await advance(100)
        expect(fixtures.clips).toHaveLength(2)
        fireEvent.playing(videoAt(1))
        await advance(500)
        expect(currentCardThumbnail()).toBe(thumbnail)
        fireEvent.click(screen.getByText('Original'))
        await act(async () => {})
        const original = required(fixtures.clips[0], 'saved clip 0')
        const expectedProject = { ...fixtures.projects[0], label: original.label, lastThumbnail: thumbnail }
        const backgroundSaves: { producer: string; records: Awaited<ReturnType<typeof saveRecords>> }[] = []
        let firstCall = fixtures.save.mock.calls.length
        await advance(30_000)
        backgroundSaves.push({ producer: 'interval', records: await saveRecords(firstCall) })
        firstCall = fixtures.save.mock.calls.length
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        backgroundSaves.push({ producer: 'hidden', records: await saveRecords(firstCall) })
        firstCall = fixtures.save.mock.calls.length
        await act(async () => { window.dispatchEvent(new Event('beforeunload')) })
        backgroundSaves.push({ producer: 'unload', records: await saveRecords(firstCall) })
        expect(backgroundSaves).toHaveLength(3)
        for (const { records } of backgroundSaves) {
          expect(records).toHaveLength(1)
          expect(records[0]?.project).toEqual(expectedProject)
          expect(records[0]?.clips.map(clip => clip.bytes)).toEqual([[1, 2, 3, 4], [5, 6]])
          expect(records[0]?.clips.every(clip => clip.projectId === expectedProject.id)).toBe(true)
        }
      } finally {
        await rescuePlayback(name)
      }
    })

    /** Save the exact image sampled from the live video. */
    it('persists the image captured by live playback', async () => {
      const name = 'project-save-captured-image'
      try {
        await startCompletedProject()
        const firstCall = fixtures.save.mock.calls.length
        const sourceAtPlaying = videoAt(1).getAttribute('src')
        fireEvent.playing(videoAt(1))
        await advance(499)
        expect(canvasSamples).toEqual([])
        expect(fixtures.save).toHaveBeenCalledTimes(firstCall)
        await advance(1)
        const records = await saveRecords(firstCall)
        expect(canvasSamples).toEqual([{ video: 1, src: sourceAtPlaying, managedSource: -1 }])
        expect(records).toHaveLength(1)
        expect(records[0]?.project).toMatchObject({
          id: fixtures.clips[0]?.projectId, label: fixtures.clips[0]?.label, lastThumbnail: thumbnail,
          originalLabel: 'A river',
        })
        expect(records[0]?.project.promptEvents).toEqual(expect.arrayContaining([
          expect.objectContaining({ source: 'user_rewrite', text: 'A river' }),
        ]))
        expect(records[0]?.clips.map(clip => clip.bytes)).toEqual([[1, 2, 3, 4]])
      } finally {
        await rescuePlayback(name)
      }
    })

    /** Departure owns capture cancellation even while the same project's persistence queue cannot settle. */
    it('cancels thumbnail capture before New project waits for saves', async () => {
      const name = 'project-save-departure'
      let releaseSave: (() => void) | undefined
      let writeSettled = false
      try {
        await startCompletedProject()
        const projectId = required(fixtures.projects[0], 'saved project').id
        const firstCall = fixtures.save.mock.calls.length
        const gate = new Promise<void>((resolve) => { releaseSave = resolve })
        const commit = required(fixtures.save.getMockImplementation(), 'saveProject implementation')
        fixtures.save.mockImplementationOnce(async (project, clips) => {
          await gate
          await commit(project, clips)
          writeSettled = true
        })
        const scheduled = vi.spyOn(globalThis, 'setTimeout')
        const cancelled = vi.spyOn(globalThis, 'clearTimeout')
        fireEvent.playing(videoAt(1))
        const timerIndex = scheduled.mock.calls.findLastIndex(([, delay]) => delay === 500)
        expect(timerIndex).toBeGreaterThanOrEqual(0)
        const captureTimer = returnedValue(scheduled.mock.results[timerIndex], 'capture timer result')
        fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
        fireEvent.click(screen.getByRole('button', { name: 'New project' }))
        await advance(20)
        const beforeDeadline = {
          captureCancelled: cancelled.mock.calls.some(([timer]) => timer === captureTimer),
          canvasSamples: [...canvasSamples],
          writeSettled,
          projectId: localStorage.getItem('fastvideo-active-project'),
          savingNotice: Boolean(screen.queryByText('Saving received clips before starting a new project.')),
          lobbyVisible: Boolean(screen.queryByRole('button', { name: 'Generate' })),
          socketStates: fixtures.sockets.map(ws => ws.readyState),
          resources: playbackResources(),
        }
        await advance(500)
        const heldRecords = await saveRecords(firstCall)
        expect(beforeDeadline).toMatchObject({
          captureCancelled: true, canvasSamples: [], writeSettled: false, projectId,
          savingNotice: true, lobbyVisible: false, socketStates: [WebSocket.CLOSED],
        })
        expect(canvasSamples).toEqual([])
        expect(writeSettled).toBe(false)
        expect(heldRecords).toHaveLength(1)
        expect(heldRecords[0]?.project.id).toBe(projectId)
        expect(heldRecords[0]?.clips.map(clip => clip.bytes)).toEqual([[1, 2, 3, 4]])
      } finally {
        releaseSave?.()
        await advance(20)
        await rescuePlayback(name)
      }
    })

    /** A second playing event replaces the pending capture instead of saving two frames. */
    it('samples once at the replacement capture deadline', async () => {
      const name = 'capture-replacement-deadline'
      try {
        await startCompletedProject()
        const firstCall = fixtures.save.mock.calls.length
        fireEvent.playing(videoAt(1))
        await advance(200)
        sampledThumbnail = replacementThumbnail
        fireEvent.playing(videoAt(1))
        await advance(300)
        expect(canvasSamples).toEqual([])
        await advance(199)
        expect(canvasSamples).toEqual([])
        expect(fixtures.save).toHaveBeenCalledTimes(firstCall)
        await advance(1)
        expect(canvasSamples).toEqual([{ video: 1, src: videoAt(1).getAttribute('src'), managedSource: -1 }])
        const records = await saveRecords(firstCall)
        expect(records).toHaveLength(1)
        expect(records[0]?.project.lastThumbnail).toBe(replacementThumbnail)
        expect(records[0]?.clips.map(clip => clip.bytes)).toEqual([[1, 2, 3, 4]])
      } finally {
        await rescuePlayback(name)
      }
    })

    /** Playback can resume while a rewrite is pending; its capture must keep the admitted attachment identity. */
    it.each(['url', 'managed'] as const)('rejects capture after its %s attachment is replaced', async (attachment) => {
      const name = `capture-attachment-${attachment}`
      try {
        await startCompletedProject(attachment)
        await submitRewrite()
        const screenshotCount = canvasSamples.length
        expect(screenshotCount).toBe(1)
        const originalAttachment = attachment === 'managed' ? videoAt(1).srcObject : videoAt(1).src
        videoAt(1).pause()
        await act(async () => { await videoAt(1).play() })
        fireEvent.playing(videoAt(1))
        await receiveForestRollout()
        const replacementAttachment = attachment === 'managed' ? videoAt(1).srcObject : videoAt(1).src
        expect(replacementAttachment).not.toBe(originalAttachment)
        await advance(500)
        expect(canvasSamples).toHaveLength(screenshotCount)
        expect(currentCardThumbnail()).toBeNull()
        const firstCall = fixtures.save.mock.calls.length
        sampledThumbnail = replacementThumbnail
        fireEvent.playing(videoAt(1))
        await advance(500)
        expect(canvasSamples.slice(screenshotCount)).toEqual([{
          video: 1, src: videoAt(1).getAttribute('src'), managedSource: attachment === 'managed' ? 1 : -1,
        }])
        expect(currentCardThumbnail()).toBe(replacementThumbnail)
        const records = await saveRecords(firstCall)
        expect(records).toHaveLength(1)
        expect(records[0]?.project.lastThumbnail).toBe(replacementThumbnail)
        expect(records[0]?.clips.map(clip => clip.bytes)).toEqual([[1, 2, 3, 4], [5, 6]])
      } finally {
        await rescuePlayback(name)
      }
    })

    /** Historical selection excludes delayed live capture while still supplying the synchronous rewrite screenshot. */
    it('captures the displayed archive for a rewrite while retaining the last live thumbnail', async () => {
      const name = 'capture-selected-archive'
      try {
        await startCompletedProject()
        await submitRewrite()
        await receiveForestRollout()
        fireEvent.playing(videoAt(1))
        await advance(500)
        expect(currentCardThumbnail()).toBe(thumbnail)
        const sampleCount = canvasSamples.length
        fireEvent.playing(videoAt(1))
        fireEvent.click(screen.getByText('Original'))
        await advance(500)
        expect(canvasSamples).toHaveLength(sampleCount)
        expect(currentCardThumbnail()).toBe(thumbnail)
        const originalUrl = allocatedUrl(fixtures.clips[0]?.blob)
        expect(videos[0]).toHaveAttribute('src', originalUrl)
        sampledThumbnail = replacementThumbnail
        await submitRewrite('A coast at dusk')
        expect(canvasSamples.slice(sampleCount)).toEqual([{ video: 0, src: originalUrl, managedSource: -1 }])
        expect(currentCardThumbnail()).toBeNull()
        const firstCall = fixtures.save.mock.calls.length
        await act(async () => { window.dispatchEvent(new Event('beforeunload')) })
        const records = await saveRecords(firstCall)
        expect(records).toHaveLength(1)
        expect(records[0]?.project.lastThumbnail).toBe(thumbnail)
        expect(records[0]?.project.promptEvents).toEqual(expect.arrayContaining([
          expect.objectContaining({ source: 'user_rewrite', text: 'A coast at dusk', thumbnail: replacementThumbnail }),
        ]))
        expect(records[0]?.clips.map(clip => clip.bytes)).toEqual([[1, 2, 3, 4], [5, 6]])
      } finally {
        await rescuePlayback(name)
      }
    })

    /** A saved-project view pauses the hidden live player and prevents its pending capture from publishing. */
    it('suppresses capture during saved viewing and resumes the previously playing live video', async () => {
      const name = 'capture-saved-view'
      const savedProject: StoredProject = {
        id: 'saved-coast', label: 'Saved coast', originalLabel: 'Saved coast', presetId: 'river', createdAt: 1,
        lastThumbnail: replacementThumbnail, promptEvents: [],
      }
      const savedClip: StoredClip = {
        id: 'coast-clip', projectId: savedProject.id, label: 'Coast', prompt: 'A coast', mime: 'video/mp4',
        blob: new Blob([new Uint8Array([8, 9])], { type: 'video/mp4' }), createdAt: 1,
      }
      fixtures.projects = [savedProject]
      fixtures.clips = [savedClip]
      try {
        await startProject()
        await announceMedia()
        await advance(1)
        await act(async () => { mediaSourceAt(0).open() })
        await act(async () => { sendCompletion() })
        await advance(100)
        const activeId = required(fixtures.clips.find(clip => clip.projectId !== savedProject.id), 'generated clip').projectId
        expect(videoAt(1).paused).toBe(false)
        fireEvent.playing(videoAt(1))
        fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
        fireEvent.click(within(screen.getByRole('complementary', { name: 'Project history' }))
          .getByRole('button', { name: /Saved coast/ }))
        await act(async () => {})
        expect(screen.getByText('View-only project')).toBeVisible()
        expect(videoAt(1).paused).toBe(true)
        await advance(500)
        expect(canvasSamples).toEqual([])
        expect(fixtures.projects.find(project => project.id === activeId)?.lastThumbnail).toBeNull()
        expect(fixtures.projects.find(project => project.id === savedProject.id)).toBe(savedProject)
        fireEvent.click(screen.getByRole('button', { name: 'Back' }))
        await act(async () => {})
        expect(screen.queryByText('View-only project')).not.toBeInTheDocument()
        expect(videoAt(1).paused).toBe(false)
        const firstCall = fixtures.save.mock.calls.length
        fireEvent.playing(videoAt(1))
        await advance(500)
        const records = await saveRecords(firstCall)
        expect(records).toHaveLength(1)
        expect(records[0]?.project).toMatchObject({ id: activeId, lastThumbnail: thumbnail })
        expect(records[0]?.clips.map(clip => clip.bytes)).toEqual([[1, 2, 3, 4]])
        expect(fixtures.projects.find(project => project.id === savedProject.id)).toBe(savedProject)
        expect(await readBlobBytes(savedClip.blob)).toEqual([8, 9])
      } finally {
        await rescuePlayback(name)
      }
    })

    /** Socket cleanup and component cleanup release the pending timeout before its sampling deadline. */
    it.each(['close', 'unmount'] as const)('cancels pending capture on %s', async (exit) => {
      const name = `capture-${exit}`
      try {
        await startCompletedProject()
        const scheduled = vi.spyOn(globalThis, 'setTimeout')
        const cancelled = vi.spyOn(globalThis, 'clearTimeout')
        fireEvent.playing(videoAt(1))
        const timerIndex = scheduled.mock.calls.findLastIndex(([, delay]) => delay === 500)
        expect(timerIndex).toBeGreaterThanOrEqual(0)
        const captureTimer = returnedValue(scheduled.mock.results[timerIndex], 'capture timer result')
        if (exit === 'close') {
          await act(async () => { socket.close({ code: 1000, reason: '', wasClean: true }) })
        } else {
          cleanup()
        }
        await advance(20)
        expect(cancelled).toHaveBeenCalledWith(captureTimer)
        expect(fixtures.sockets.map(ws => ws.readyState)).toEqual([WebSocket.CLOSED])
        const writesAfterExit = fixtures.save.mock.calls.length
        await advance(500)
        expect(canvasSamples).toEqual([])
        expect(fixtures.save).toHaveBeenCalledTimes(writesAfterExit)
      } finally {
        await rescuePlayback(name)
      }
    })

    /** Completed departure resets thumbnail ownership before another project can receive and save its own frame. */
    it('starts the next project without a prior thumbnail or pending capture', async () => {
      const name = 'capture-next-project'
      try {
        await startCompletedProject()
        fireEvent.playing(videoAt(1))
        await advance(500)
        const originalProject = required(fixtures.projects[0], 'saved project')
        expect(originalProject.lastThumbnail).toBe(thumbnail)
        fireEvent.playing(videoAt(1))
        fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
        fireEvent.click(screen.getByRole('button', { name: 'New project' }))
        await advance(20)
        expect(screen.getByRole('button', { name: 'Generate' })).toBeVisible()
        expect(fixtures.sockets[0]?.readyState).toBe(WebSocket.CLOSED)
        fireEvent.change(screen.getByRole('textbox', { name: 'Initial prompt' }), {
          target: { value: 'A mountain' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
        await advance(20)
        expect(outbound.at(-1)).toMatchObject({ type: 'project_init_v1', initial_rollout_prompt: 'A mountain' })
        const nextVideos = [...document.querySelectorAll<HTMLVideoElement>('video')]
        expect(nextVideos).toHaveLength(2)
        for (const video of nextVideos) {
          if (videos.includes(video)) continue
          videos.push(video)
          videoListeners.push({
            added: vi.spyOn(video as EventTarget, 'addEventListener'),
            removed: vi.spyOn(video as EventTarget, 'removeEventListener'),
          })
        }
        const firstCall = fixtures.save.mock.calls.length
        await act(async () => { window.dispatchEvent(new Event('beforeunload')) })
        const initialRecords = await saveRecords(firstCall)
        expect(initialRecords).toHaveLength(1)
        const nextId = required(initialRecords[0], 'initial save record').project.id
        expect(nextId).not.toBe(originalProject.id)
        expect(initialRecords[0]?.project.lastThumbnail).toBeNull()
        expect(initialRecords[0]?.clips).toEqual([])
        await act(async () => {
          socket.send(JSON.stringify({ type: 'gpu_assigned' }))
          socket.send(JSON.stringify({
            type: 'rewrite_seed_prompts_complete', prompt_id: outbound.at(-1)?.initial_prompt_id,
          }))
          socket.send(JSON.stringify({
            type: 'ltx2_stream_start', origin_prompt_id: outbound.at(-1)?.initial_prompt_id,
            origin_prompt: 'A mountain', prompt_window_prompts: ['A mountain'],
          }))
          socket.send(JSON.stringify({ type: 'ltx2_segment_start', segment_idx: 1, seed_prompt_index: 0, source: 'user_enhanced', prompt_id: outbound.at(-1)?.prompt_id || outbound[0]?.initial_prompt_id }))
          socket.send(JSON.stringify({
            type: 'media_init', segment_idx: 1, stream_id: 'mountain-1', mime: 'video/mp4',
          }))
        })
        await advance(1)
        await act(async () => { mediaSourceAt(1).open() })
        await act(async () => {
          socket.send(new Uint8Array([7, 8]).buffer)
          socket.send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1, stream_id: 'mountain-1' }))
          socket.send(JSON.stringify({ type: 'ltx2_stream_complete' }))
          socket.send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'idle' }))
        })
        await advance(500)
        expect(canvasSamples).toHaveLength(1)
        sampledThumbnail = replacementThumbnail
        fireEvent.playing(required(nextVideos[1], 'next project video 1'))
        await advance(500)
        expect(canvasSamples).toHaveLength(2)
        expect(fixtures.projects.find(project => project.id === nextId)?.lastThumbnail).toBe(replacementThumbnail)
        expect(fixtures.projects.find(project => project.id === originalProject.id)?.lastThumbnail).toBe(thumbnail)
        expect(await readBlobBytes(required(fixtures.clips.find(clip => clip.projectId === nextId), 'next project clip').blob))
          .toEqual([7, 8])
      } finally {
        await rescuePlayback(name)
      }
    })

    /** Queued saves keep their accepted metadata and media while the same project continues changing. */
    it('serializes immutable snapshots while an earlier save is held', async () => {
      const name = 'project-save-queue'
      let releaseSave: (() => void) | undefined
      try {
        await startCompletedProject()
        fireEvent.playing(videoAt(1))
        await advance(500)
        const initialProject = required(fixtures.projects[0], 'saved project')
        const originalBlob = required(fixtures.clips[0], 'saved clip 0').blob
        const firstCall = fixtures.save.mock.calls.length
        const gate = new Promise<void>((resolve) => { releaseSave = resolve })
        const commit = required(fixtures.save.getMockImplementation(), 'saveProject implementation')
        fixtures.save.mockImplementationOnce(async (project, clips) => {
          await gate
          await commit(project, clips)
        })
        await act(async () => { window.dispatchEvent(new Event('beforeunload')) })
        await submitRewrite()
        await act(async () => { window.dispatchEvent(new Event('beforeunload')) })
        await receiveForestRollout()
        const forestBlob = required(allocations.map(({ value }) => value).filter(value => value instanceof Blob).at(-1), 'forest Blob')
        expect(await readBlobBytes(forestBlob)).toEqual([5, 6])
        sampledThumbnail = replacementThumbnail
        fireEvent.playing(videoAt(1))
        await advance(500)
        expect(currentCardThumbnail()).toBe(replacementThumbnail)
        await advance(1000)
        fireEvent.click(screen.getByText('Original'))
        await submitRewrite('A coast at dusk')
        expect(currentCardThumbnail()).toBeNull()
        expect(fixtures.save).toHaveBeenCalledTimes(firstCall + 1)
        expect(fixtures.projects).toEqual([initialProject])
        expect(fixtures.clips.map(clip => clip.blob)).toEqual([originalBlob])
        releaseSave?.()
        await advance(20)
        const records = await saveRecords(firstCall)
        expect(records).toHaveLength(5)
        const held = required(records[0], 'held save record')
        const pending = required(records[1], 'pending save record')
        const captured = required(records.at(-1), 'captured save record')
        expect(held.project).toEqual(initialProject)
        expect(pending.project).toMatchObject({
          id: initialProject.id, label: initialProject.label, lastThumbnail: thumbnail, createdAt: initialProject.createdAt,
        })
        const pendingRewrite = pending.project.promptEvents.find(event => event.text === 'A forest in rain')
        expect(pendingRewrite).toMatchObject({ source: 'user_rewrite', thumbnail })
        expect(pendingRewrite).not.toHaveProperty('clipId')
        expect(pendingRewrite).not.toHaveProperty('resultThumbnail')
        expect(captured.project).toMatchObject({
          id: initialProject.id, label: 'Cuts 2', lastThumbnail: replacementThumbnail,
          createdAt: initialProject.createdAt,
        })
        expect(captured.project.promptEvents).toEqual(expect.arrayContaining([
          expect.objectContaining({ text: 'A forest in rain', resultThumbnail: replacementThumbnail }),
        ]))
        expect(records.every(({ project }) => project.id === initialProject.id)).toBe(true)
        expect(records.every(({ project }) => !project.promptEvents.some(event => event.text === 'A coast at dusk')))
          .toBe(true)
        expect(held.clips.map(clip => clip.bytes)).toEqual([[1, 2, 3, 4]])
        expect(pending.clips).toEqual(held.clips)
        expect(captured.clips.map(clip => clip.bytes)).toEqual([[1, 2, 3, 4], [5, 6]])
        expect(fixtures.save.mock.calls[firstCall + 1]?.[1][0]?.blob).toBe(originalBlob)
        expect(fixtures.save.mock.calls.at(-1)?.[1][0]?.blob).toBe(originalBlob)
        expect(fixtures.save.mock.calls.at(-1)?.[1][1]?.blob).toBe(forestBlob)
        expect(fixtures.projects).toEqual([captured.project])
      } finally {
        releaseSave?.()
        await advance(20)
        await rescuePlayback(name)
      }
    })

    /** Storage-pressure recovery retries the accepted record and leaves later saves able to run. */
    it('retries the same snapshot after storage pressure and continues saving', async () => {
      const name = 'project-save-storage-pressure'
      try {
        await startCompletedProject()
        fireEvent.playing(videoAt(1))
        await advance(500)
        const acceptedProject = required(fixtures.projects[0], 'saved project')
        const originalBlob = required(fixtures.clips[0], 'saved clip 0').blob
        const firstCall = fixtures.save.mock.calls.length
        const warning = vi.spyOn(console, 'warn')
        fixtures.save.mockRejectedValueOnce(new DOMException('Storage quota reached', 'QuotaExceededError'))
        await act(async () => { window.dispatchEvent(new Event('beforeunload')) })
        const retries = await saveRecords(firstCall)
        expect(retries).toHaveLength(2)
        expect(retries[0]).toEqual(retries[1])
        expect(retries[1]?.project).toEqual(acceptedProject)
        expect(retries[1]?.clips.map(clip => clip.bytes)).toEqual([[1, 2, 3, 4]])
        expect(fixtures.save.mock.calls[firstCall]?.[1][0]?.blob).toBe(originalBlob)
        expect(fixtures.save.mock.calls[firstCall + 1]?.[1][0]?.blob).toBe(originalBlob)
        expect(warning).toHaveBeenCalledExactlyOnceWith('Recovered project save after pruning older archives.', {
          projectId: acceptedProject.id, deletedCount: 0, retainPreviousCount: 0,
        })
        sampledThumbnail = replacementThumbnail
        fireEvent.playing(videoAt(1))
        await advance(500)
        const records = await saveRecords(firstCall)
        expect(records).toHaveLength(3)
        expect(records[2]?.project).toMatchObject({ id: acceptedProject.id, lastThumbnail: replacementThumbnail })
        expect(records[2]?.clips).toEqual(retries[1]?.clips)
        expect(fixtures.projects).toEqual([records[2]?.project])
      } finally {
        await rescuePlayback(name)
      }
    })

    /** Native Blob playback remains excluded from delayed live capture but supplies a rewrite screenshot. */
    it('preserves archived capture behavior when native Blob playback is required', async () => {
      const name = 'capture-native-fallback'
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
      vi.stubGlobal('MediaSource', undefined)
      vi.stubGlobal('ManagedMediaSource', undefined)
      try {
        await startProject()
        await announceMedia()
        await advance(1)
        expect(mediaSources).toEqual([])
        await act(async () => { sendCompletion() })
        await advance(100)
        expect(fixtures.clips).toHaveLength(1)
        const original = required(fixtures.clips[0], 'saved clip 0')
        const originalUrl = allocatedUrl(original.blob)
        expect(videos[0]).toHaveAttribute('src', originalUrl)
        expect(videos[1]).not.toHaveAttribute('src')
        const writesBeforePlaying = fixtures.save.mock.calls.length
        fireEvent.playing(videoAt(0))
        await advance(500)
        expect(canvasSamples).toEqual([])
        expect(fixtures.save).toHaveBeenCalledTimes(writesBeforePlaying)
        await submitRewrite()
        expect(canvasSamples).toEqual([{ video: 0, src: originalUrl, managedSource: -1 }])
        expect(currentCardThumbnail()).toBeNull()
        const firstCall = fixtures.save.mock.calls.length
        await act(async () => { window.dispatchEvent(new Event('beforeunload')) })
        const records = await saveRecords(firstCall)
        expect(records).toHaveLength(1)
        expect(records[0]?.project).toMatchObject({
          id: original.projectId, label: original.label, lastThumbnail: null,
        })
        expect(records[0]?.project.promptEvents).toEqual(expect.arrayContaining([
          expect.objectContaining({ source: 'user_rewrite', text: 'A forest in rain', thumbnail }),
        ]))
        expect(records[0]?.clips.map(clip => clip.bytes)).toEqual([[1, 2, 3, 4]])
      } finally {
        await rescuePlayback(name)
      }
    })
  })
})
