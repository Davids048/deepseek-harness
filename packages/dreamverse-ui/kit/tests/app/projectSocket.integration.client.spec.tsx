/** @vitest-environment jsdom */
/**
 * Ports FastVideo DreamVerse src/app/projectSocket.integration.test.tsx: served creation admission, the project WebSocket
 * lifecycle, auto extension, active composition, and active clip export.
 */
import '../support/setup.client.ts'
import { assetUploadPolicy, imageAsset, mockReferenceImageLayout } from '../support/assetFixtures.client.ts'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Server } from 'mock-socket'
import type { Client } from 'mock-socket'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import type { CreationInitPayload } from '@dreamverse/project-controller/client/creationPayload.ts'
import type { createWebSocketConnection } from '@dreamverse/project-controller/client/ws/client.ts'
import type { AvPipeline, createAvPipeline } from '../../src/client/media/avPipeline.ts'
import type { remuxArchivedFmp4Segments } from '../../src/client/media/fmp4Remux.ts'

type CreationInput = Parameters<typeof import('@dreamverse/project-controller/client/creationPayload.ts').buildCreationInitPayload>[0]

/** One project WebSocket that Page opened, with the handlers that Page passed to it. */
interface ProjectConnection {
  ws: WebSocket
  callbacks: Parameters<typeof createWebSocketConnection>[0]
}

/** Fields that these cases read from a parsed message that Page sent on a project WebSocket. */
interface OutboundMessage {
  type: string
  initial_prompt_id?: string
  initial_rollout_prompt?: string
  curated_prompts?: string[]
  prompt_id?: string
  prompt?: string
  rewrite_instruction?: string
  reference_asset_ids?: string[]
  auto_extension_enabled?: boolean
}

/** One object URL that Page allocated, with what it names and whether Page has revoked it. */
interface TrackedObjectUrl {
  url: string
  blob: Blob | MediaSource
  revoked: boolean
}

const fixtures = vi.hoisted(() => ({
  objectUrls: [] as TrackedObjectUrl[],
  connections: [] as ProjectConnection[],
  buildCreation: vi.fn<(input: CreationInput) => CreationInitPayload>(),
  remux: vi.fn<typeof remuxArchivedFmp4Segments>(),
  completeSegment: vi.fn<AvPipeline['noteSegmentComplete']>(),
}))

vi.mock('@dreamverse/project-controller/client/storyPresetsData.ts', () => ({
  default: [
    { id: 'test_preset', label: 'Test Preset', segment_prompts: ['A river', 'A waterfall'] },
    { id: 'six_shot', label: 'Six Shot Story', segment_prompts: ['River one', 'River two', 'River three', 'River four', 'River five', 'River six'] },
  ],
}))
vi.mock('@dreamverse/project-controller/client/creationPayload.ts', async importOriginal => ({
  ...await importOriginal<typeof import('@dreamverse/project-controller/client/creationPayload.ts')>(),
  buildCreationInitPayload: fixtures.buildCreation,
}))
vi.mock('@dreamverse/project-controller/client/ws/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dreamverse/project-controller/client/ws/client.ts')>()
  return {
    ...actual,
    createWebSocketConnection: (callbacks: Parameters<typeof actual.createWebSocketConnection>[0]) => {
      const ws = actual.createWebSocketConnection(callbacks)
      fixtures.connections.push({ ws, callbacks })
      return ws
    },
  }
})
vi.mock('../../src/client/media/fmp4Remux.ts', () => ({ remuxArchivedFmp4Segments: fixtures.remux }))
vi.mock('@dreamverse/project-controller/client/projects.ts', () => ({
  listProjects: async () => [],
  getProject: vi.fn(),
  deleteProject: vi.fn(),
  fetchSegmentVideo: vi.fn(),
}))
vi.mock('../../src/client/media/avPipeline.ts', () => ({
  DEFAULT_AV_MIME: 'video/mp4',
  /** Store received chunks so project tests exercise actual page archive ownership. */
  createAvPipeline: ({ onPlaybackStarted = () => {} }: Parameters<typeof createAvPipeline>[0]) => {
    let chunks: ArrayBuffer[] = []
    return {
      reset: () => { chunks = [] },
      enqueueChunk: (chunk: ArrayBuffer) => { chunks.push(chunk) },
      ensurePipeline: async () => {},
      stopPlayback: vi.fn(),
      maybeStartPlayback: onPlaybackStarted,
      tryEndStream: vi.fn(),
      setStreamCompleted: vi.fn(),
      noteSegmentInit: vi.fn(),
      noteSegmentComplete: fixtures.completeSegment,
      hasArchivedChunks: () => chunks.length > 0,
      buildArchivedStreamBlob: () => new Blob(chunks, { type: 'video/mp4' }),
      // Export reads the received media without consuming the archive buffer.
      buildArchivedSegmentSnapshots: () => chunks.length ? [{
        key: '1:stream', segmentIdx: 1, streamId: 'stream', mime: 'video/mp4', completed: true, chunks: [...chunks],
      }] : [],
      takeArchivedSegmentSnapshots: () => chunks.length ? [{
        key: '1:stream', segmentIdx: 1, streamId: 'stream', mime: 'video/mp4', completed: true, chunks: [...chunks],
      }] : [],
      takeArchivedStreamChunks: () => {
        const archived = chunks
        chunks = []
        return archived
      },
      usesNativePlaybackFallback: () => false,
    }
  },
}))

import { DreamverseApp } from '../../src/client/app/DreamverseApp.tsx'
import { renderDreamverseSlot } from '../support/renderDreamverseSlot.client.tsx'

/** Record one object URL that Page allocated; each `URL.createObjectURL` spy returns the URL through this function. */
function trackObjectUrl(blob: Blob | MediaSource, url: string): string {
  fixtures.objectUrls.push({ url, blob, revoked: false })
  return url
}

/** Mark one allocated object URL as revoked. */
function trackRevokedUrl(url: string) {
  for (const entry of fixtures.objectUrls) if (entry.url === url) entry.revoked = true
}

/**
 * The completed clips that Page holds in memory: each archived clip owns a live object URL for its video Blob, while an
 * export revokes its URL at once and a departed project's clips are revoked when Page clears them.
 */
function archivedClips(): { blob: Blob }[] {
  return fixtures.objectUrls.flatMap(entry => !entry.revoked && entry.blob instanceof Blob
    && entry.blob.type.startsWith('video/') ? [{ blob: entry.blob }] : [])
}

/** Return one project WebSocket that Page opened, failing the case when Page has not opened it. */
function projectConnection(index: number): ProjectConnection {
  const connection = fixtures.connections[index]
  if (!connection) throw new Error(`Page has not opened project connection ${index}`)
  return connection
}

/** Return one clip that Page archived in memory, failing the case when Page has not archived it. */
function archivedClip(index: number): { blob: Blob } {
  const clip = archivedClips()[index]
  if (!clip) throw new Error(`Page has not archived clip ${index}`)
  return clip
}

/** Copy every localStorage entry so a case can restore the storage that it clears. */
function snapshotLocalStorage(): [string, string][] {
  return Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)
    const value = key === null ? null : localStorage.getItem(key)
    if (key === null || value === null) throw new Error(`localStorage entry ${index} changed during the snapshot`)
    return [key, value]
  })
}

describe('Project WebSocket lifecycle', () => {
  let server: Server
  let sockets: Client[]
  let outbound: OutboundMessage[][]

  /** Provide complete served metadata and own the socket/media resources used by every lifecycle scenario. */
  beforeEach(async () => {
    fixtures.objectUrls = []
    fixtures.connections = []
    fixtures.completeSegment.mockReset()
    fixtures.buildCreation.mockReset().mockImplementation((await vi.importActual<typeof import('@dreamverse/project-controller/client/creationPayload.ts')>('@dreamverse/project-controller/client/creationPayload.ts')).buildCreationInitPayload)
    fixtures.remux.mockReset().mockImplementation(async segments =>
      new Blob(segments.flatMap(segment => segment.chunks), { type: 'video/mp4' }),
    )
    sockets = []
    outbound = []
    window.history.pushState({}, '', '/')
    server = new Server(`ws://${window.location.host}/ws`)
    server.on('connection', (socket) => {
      const messages: OutboundMessage[] = []
      sockets.push(socket)
      outbound.push(messages)
      socket.on('message', raw => messages.push(JSON.parse(raw as string) as OutboundMessage))
    })
    const modelCapabilities = {
      generation_modes: ['t2va', 'i2v'], aspect_ratios: ['16:9'], resolutions: ['720p'], min_segment_duration_sec: 5, max_segment_duration_sec: 15, segment_counts: [1, 2, 3, 4, 5, 6],
      unsupported_generation_modes: { fl2va: 'First/last frame generation is unsupported.' },
      reference_inputs: { media_types: ['image'], max_count: 1, conditioning: 'first_frame' },
      asset_upload: assetUploadPolicy,
    }
    /** Keep ordinary lifecycle cases behind complete capabilities and successful readiness. */
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/creation-capabilities')) {
        return { ok: true, status: 200, json: async () => ({
          model_ids: ['fast-h3'], models: { 'fast-h3': modelCapabilities }, ...modelCapabilities,
        }) }
      }
      if (url.endsWith('/healthz')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) }
      if (url.endsWith('/readyz')) {
        return {
          ok: true, status: 200, json: async () => ({ status: 'ready', ready_gpu_workers: 1, available_gpus: 1 }),
        }
      }
      throw new Error(`Unexpected fetch in project socket test: ${url}`)
    }))
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => trackObjectUrl(blob, `blob:project-${fixtures.objectUrls.length + 1}`))
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { trackRevokedUrl(url) })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    server.stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Return the server side of one accepted project WebSocket, failing the case when Page has not connected it. */
  function serverSocket(index: number): Client {
    const socket = sockets[index]
    if (!socket) throw new Error(`Page has not connected project socket ${index}`)
    return socket
  }

  /** Return the parsed messages that Page sent on one accepted project WebSocket. */
  function sentMessages(socketIndex: number): OutboundMessage[] {
    const messages = outbound[socketIndex]
    if (!messages) throw new Error(`Page has not connected project socket ${socketIndex}`)
    return messages
  }

  /** Return one parsed message by `Array.prototype.at` index, failing the case when Page has not sent it. */
  function sentMessage(socketIndex: number, messageIndex: number): OutboundMessage {
    const message = sentMessages(socketIndex).at(messageIndex)
    if (!message) throw new Error(`Page has not sent message ${messageIndex} on project socket ${socketIndex}`)
    return message
  }

  /** Start generation through the lobby and wait for its initial wire payload. */
  async function generate(user: ReturnType<typeof userEvent.setup>, index: number) {
    await user.type(await screen.findByLabelText('Initial prompt'), 'A river')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => { expect(outbound[index]?.[0]?.type).toBe('project_init_v1') })
    expect(sentMessage(index, 0).initial_prompt_id).toEqual(expect.any(String))
  }

  /** Emit enough media to create one archived clip in the project that the harness assigned as `project-<index>`. */
  function completeClip(index: number, bytes: number[], autoExtensionEnabled = false) {
    const socket = serverSocket(index)
    const initialRequest = sentMessage(index, 0)
    socket.send(JSON.stringify({ type: 'gpu_assigned', project_id: `project-${index}` }))
    if (initialRequest.initial_prompt_id) {
      socket.send(JSON.stringify({ type: 'rewrite_seed_prompts_complete', prompt_id: initialRequest.initial_prompt_id }))
    }
    if (!initialRequest.curated_prompts) throw new Error('project_init_v1 did not include curated_prompts')
    socket.send(JSON.stringify({
      type: 'ltx2_stream_start', origin_prompt_id: initialRequest.initial_prompt_id,
      origin_prompt: initialRequest.initial_rollout_prompt,
      prompt_window_prompts: initialRequest.curated_prompts.length ? initialRequest.curated_prompts : ['A river'],
    }))
    socket.send(JSON.stringify({ type: 'ltx2_segment_start', segment_idx: 1, seed_prompt_index: 0, source: 'curated' }))
    socket.send(new Uint8Array(bytes).buffer)
    socket.send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1 }))
    socket.send(JSON.stringify({ type: 'ltx2_stream_complete' }))
    socket.send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: autoExtensionEnabled, status: autoExtensionEnabled ? 'preparing' : 'idle' }))
  }

  describe('Served creation admission', () => {
    const modelCapabilities = {
      generation_modes: ['t2va', 'i2v'], aspect_ratios: ['16:9', '9:16', '21:9'],
      resolutions: ['720p', '480p', '1080p'], min_segment_duration_sec: 1, max_segment_duration_sec: 20, segment_counts: [1, 2, 3, 4, 5, 6],
      unsupported_generation_modes: { fl2va: 'First/last frame generation is unsupported.' },
      reference_inputs: { media_types: ['image'], max_count: 1, conditioning: 'first_frame' },
      asset_upload: assetUploadPolicy,
    }
    const capabilities = {
      model_ids: ['fast-ltx23'], models: { 'fast-ltx23': modelCapabilities }, ...modelCapabilities,
    }
    let capabilityResponse: () => Promise<Response>
    let readinessResponse: () => Promise<void>
    let uploadedNames: string[]
    let uploadResponse: (file: File) => Promise<Response>
    let requests: string[]
    let pendingResponses: (() => void)[]
    let allocatedUrls: string[]
    let revokedUrls: string[]
    let storageSnapshot: [string, string][]
    let scrollIntoViewDescriptor: PropertyDescriptor | undefined

    /** Control the two asynchronous boundaries while retaining actual creation serialization and socket delivery. */
    beforeEach(async () => {
      const payload = await vi.importActual<typeof import('@dreamverse/project-controller/client/creationPayload.ts')>('@dreamverse/project-controller/client/creationPayload.ts')
      fixtures.buildCreation.mockImplementation(payload.buildCreationInitPayload)
      storageSnapshot = snapshotLocalStorage()
      localStorage.clear()
      requests = []
      pendingResponses = []
      allocatedUrls = []
      revokedUrls = []
      vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
        const url = `blob:admitted-reference-${allocatedUrls.length + 1}`
        allocatedUrls.push(url)
        return trackObjectUrl(blob, url)
      })
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { revokedUrls.push(url); trackRevokedUrl(url) })
      vi.stubGlobal('IntersectionObserver', class {
        observe() {}
        disconnect() {}
      })
      scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
      capabilityResponse = async () => new Response(JSON.stringify(capabilities))
      readinessResponse = async () => {}
      uploadedNames = []
      uploadResponse = async file => new Response(JSON.stringify(imageAsset(file.name)))
      /** The developer workspace's metadata stays local; readiness waits only for the test's owned gate. */
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        requests.push(url)
        if (url.endsWith('/creation-capabilities')) return capabilityResponse()
        if (url.endsWith('/assets') && init?.method === 'POST') {
          const file = (init.body as FormData).get('file') as File
          uploadedNames.push(file.name)
          return uploadResponse(file)
        }
        if (url.endsWith('/assets')) return new Response(JSON.stringify({ assets: [] }))
        if (url.endsWith('/healthz')) return new Response(JSON.stringify({ status: 'ok' }))
        if (url.endsWith('/readyz')) {
          await readinessResponse()
          return new Response(JSON.stringify({ status: 'ready', ready_gpu_workers: 1 }))
        }
        if (url.endsWith('/curated-presets')) return new Response(JSON.stringify({
          presets: [{ id: 'test_preset', label: 'Test Preset', segment_prompts: ['A river', 'A waterfall'] }],
        }))
        if (url.endsWith('/lora/options')) return new Response(JSON.stringify({
          has_base_lora: true, styles: [], labels: {},
        }))
        throw new Error(`Unexpected request in creation admission test: ${url}`)
      }))
    })

    /** Join closed socket delivery and reference cleanup before restoring the surrounding browser fixture. */
    afterEach(async () => {
      try {
        cleanup()
        await act(async () => { pendingResponses.forEach((resolve) => { resolve() }) })
        await waitFor(() => {
          expect(fixtures.connections.every(({ ws }) => ws.readyState === WebSocket.CLOSED)).toBe(true)
        })
        expect(allocatedUrls.filter(url => !revokedUrls.includes(url))).toEqual([])
      } finally {
        localStorage.clear()
        storageSnapshot.forEach(([key, value]) => { localStorage.setItem(key, value) })
        if (scrollIntoViewDescriptor) {
          Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
        } else {
          Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
        }
        vi.unstubAllEnvs()
        window.history.replaceState({}, '', '/')
      }
    })

    /** Resolve an abandoned fetch only after Page unmount, so failures cannot leave fixture work pending. */
    function deferred<T>(cleanupValue: T) {
      const { promise, resolve } = Promise.withResolvers<T>()
      pendingResponses.push(() => { resolve(cleanupValue) })
      return { promise, resolve }
    }


    /** Creation captures the selected sequence length in both wire settings and the project display. */
    it.each([6, 3])('sends a custom rollout with %s segments', async (segmentCount) => {
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastLTX 2.3')
      expect(screen.getByRole('status')).toHaveTextContent('6 segments × 5s = 30s total')
      if (segmentCount !== 6) {
        screen.getByRole('button', { name: 'Segments: 6' }).focus()
        await user.keyboard('{Enter}')
        await user.click(screen.getByRole('menuitem', { name: `${segmentCount} segments` }))
      }
      expect(screen.getByRole('status')).toHaveTextContent(`${segmentCount} segments × 5s = ${segmentCount * 5}s total`)
      await generate(user, 0)
      expect(sentMessage(0, 0)).toMatchObject({
        type: 'project_init_v1', segment_count: segmentCount, segment_duration_sec: 5,
        initial_rollout_prompt: 'A river', curated_prompts: [],
      })
      expect(sentMessage(0, 0)).not.toHaveProperty('duration_sec')
      expect(screen.getByRole('button', { name: 'Segments' })).toHaveTextContent(`${segmentCount} segments`)
      expect(screen.getByRole('button', { name: 'Duration per segment' })).toHaveTextContent('5s per segment')
      expect(screen.getByRole('button', { name: 'Segments' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Duration per segment' })).toBeDisabled()
    })

    /** User-selected duration stays separate from the H3 maximum in admission and the project echo. */
    it('sends three seven-second H3 segments within its fifteen-second limit', async () => {
      capabilityResponse = async () => new Response(JSON.stringify({
        model_ids: ['fast-h3'], segment_counts: [1, 2, 3, 4, 5, 6], asset_upload: assetUploadPolicy,
        models: { 'fast-h3': { ...modelCapabilities, min_segment_duration_sec: 5, max_segment_duration_sec: 15 } },
      }))
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastH3')
      await user.click(screen.getByRole('button', { name: 'Duration per segment: 5s' }))
      screen.getByRole('slider', { name: 'Duration per segment' }).focus()
      await user.keyboard('{ArrowRight}{ArrowRight}{Escape}')
      screen.getByRole('button', { name: 'Segments: 6' }).focus()
      await user.keyboard('{Enter}')
      await user.click(screen.getByRole('menuitem', { name: '3 segments' }))
      expect(screen.getByRole('status')).toHaveTextContent('3 segments × 7s = 21s total')
      await generate(user, 0)
      expect(sentMessage(0, 0)).toMatchObject({ model_id: 'fast-h3', segment_count: 3, segment_duration_sec: 7 })
      expect(sentMessage(0, 0)).not.toHaveProperty('max_segment_duration_sec')
      await act(async () => {
        serverSocket(0).send(JSON.stringify({ type: 'gpu_assigned', creation_config: {
          model_id: 'fast-h3', generation_mode: 't2va', aspect_ratio: '16:9', resolution: '720p',
          segment_count: 3, segment_duration_sec: 7,
        } }))
      })
      expect(screen.getByRole('button', { name: 'Segments' })).toHaveTextContent('3 segments')
      expect(screen.getByRole('button', { name: 'Duration per segment' })).toHaveTextContent('7s per segment')
    })

    /** Preset submissions send only authored prompts and use the same count in the project settings. */
    it.each([
      { label: 'Six Shot Story', selected: 3, expected: ['River one', 'River two', 'River three'] },
      { label: 'Six Shot Story', selected: 1, expected: ['River one'] },
      { label: 'Test Preset', selected: 6, expected: ['A river', 'A waterfall'] },
    ])('submits $label with a requested count of $selected', async ({ label, selected, expected }) => {
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastLTX 2.3')
      if (selected !== 6) {
        screen.getByRole('button', { name: 'Segments: 6' }).focus()
        await user.keyboard('{Enter}')
        await user.click(screen.getByRole('menuitem', { name: selected === 1 ? '1 segment' : `${selected} segments` }))
      }
      await user.click(screen.getByRole('button', { name: label }))
      await waitFor(() => {
        expect(outbound[0]?.[0]).toMatchObject({
          type: 'project_init_v1', segment_count: expected.length, segment_duration_sec: 5,
          initial_rollout_prompt: '', curated_prompts: expected, auto_extension_enabled: false,
        })
      })
      expect(screen.getByRole('button', { name: 'Segments' })).toHaveTextContent(String(expected.length))
    })

    /** Hold readiness while later control edits and attachment removal leave the admitted request fixed. */
    it('keeps admitted settings and images through readiness edits', async () => {
      const readiness = deferred<undefined>(undefined)
      readinessResponse = () => readiness.promise
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastLTX 2.3')
      screen.getByRole('button', { name: 'Text to video' }).focus()
      await user.keyboard('{Enter}')
      await user.click(screen.getByRole('menuitem', { name: /Image to video/ }))
      await user.upload(screen.getByLabelText('Add reference images'), new File(['png'], 'admitted.png', { type: 'image/png' }))
      await user.type(screen.getByLabelText('Initial prompt'), 'A river at dawn')
      await user.click(screen.getByRole('checkbox', { name: 'Auto extension' }))
      await user.click(screen.getByRole('button', { name: 'Generate' }))
      await waitFor(() => { expect(requests).toContain('/readyz') })
      expect(screen.getByRole('checkbox', { name: 'Auto extension' })).toBeDisabled()
      expect(uploadedNames).toEqual([])
      await user.click(screen.getByRole('button', { name: 'Remove picture 1' }))
      await user.click(screen.getByRole('button', { name: '16:9 720P' }))
      await user.click(screen.getByRole('button', { name: '9:16' }))
      await user.keyboard('{Escape}')
      await act(async () => { readiness.resolve(undefined) })
      await waitFor(() => { expect(outbound[0]?.[0]?.type).toBe('project_init_v1') })
      expect(sentMessage(0, 0)).toMatchObject({ model_id: 'fast-ltx23', generation_mode: 'i2v', aspect_ratio: '16:9', initial_rollout_prompt: 'A river at dawn', auto_extension_enabled: true, reference_asset_ids: ['asset-admitted.png'] })
      expect(sentMessage(0, 0)).not.toHaveProperty('initial_image')
      expect(screen.queryByRole('button', { name: 'Remove picture 1' })).not.toBeInTheDocument()
      expect(uploadedNames).toEqual(['admitted.png'])
      await act(async () => { serverSocket(0).send(JSON.stringify({ type: 'gpu_assigned', creation_config: { model_id: 'fast-ltx23', generation_mode: 'i2v', aspect_ratio: '16:9', resolution: '720p', segment_duration_sec: 5, segment_count: 6 } })) })
      expect(screen.getByRole('button', { name: 'Mode' })).toHaveTextContent('Image to video')
    })

    /** An upload failure stops admission and preserves successful records for an ordered retry. */
    it('reuses partial uploads and sends ordered subject references on retry', async () => {
      mockReferenceImageLayout()
      capabilityResponse = async () => new Response(JSON.stringify({ model_ids: ['h3-ref2va'], segment_counts: [1, 2, 3, 4, 5, 6], asset_upload: assetUploadPolicy, models: { 'h3-ref2va': { ...modelCapabilities, min_segment_duration_sec: 5, max_segment_duration_sec: 15, generation_modes: ['ref2va'], reference_inputs: { media_types: ['image'], max_count: 9, conditioning: 'reference' } } } }))
      let failSide = true
      uploadResponse = async (file) => {
        if (file.name === 'side.png' && failSide) { failSide = false; return new Response(JSON.stringify({ detail: 'Side upload failed' }), { status: 503 }) }
        return new Response(JSON.stringify(imageAsset(file.name)))
      }
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('H3 Ref2AV')
      await user.upload(screen.getByLabelText('Add reference images'), ['front.png', 'side.png', 'back.png'].map(name => new File(['png'], name, { type: 'image/png' })))
      expect(uploadedNames).toEqual([])
      await user.type(screen.getByLabelText('Initial prompt'), 'Walk through a market')
      await user.click(screen.getByRole('checkbox', { name: 'Auto extension' }))
      await user.click(screen.getByRole('button', { name: 'Generate' }))
      await screen.findByText('Side upload failed')
      expect(screen.getByRole('checkbox', { name: 'Auto extension' })).toBeChecked()
      expect(outbound).toEqual([])
      expect(uploadedNames).toEqual(['front.png', 'side.png'])
      expect(screen.getByLabelText('Initial prompt')).toHaveValue('Walk through a market')
      await user.click(screen.getByRole('button', { name: 'Generate' }))
      await waitFor(() => { expect(outbound[0]?.[0]?.type).toBe('project_init_v1') })
      expect(uploadedNames).toEqual(['front.png', 'side.png', 'side.png', 'back.png'])
      expect(sentMessage(0, 0).reference_asset_ids).toEqual(['asset-front.png', 'asset-side.png', 'asset-back.png'])
      expect(sentMessage(0, 0).auto_extension_enabled).toBe(true)
      completeClip(0, [1, 2])
      await waitFor(() => expect(screen.getByLabelText('Continuation prompt')).toBeEnabled())
      screen.getByRole('button', { name: 'Preview picture 3: back.png' }).focus()
      await user.keyboard('[Space]')
      await user.keyboard('[ArrowUp]')
      await user.keyboard('[ArrowRight]')
      await user.keyboard('[Space]')
      await user.type(screen.getByLabelText('Continuation prompt'), 'Make the market rainy')
      await user.keyboard('{Enter}')
      await waitFor(() => { expect(outbound[0]).toHaveLength(2) })
      expect(sentMessage(0, 1)).toMatchObject({ type: 'rewrite_seed_prompts', reference_asset_ids: ['asset-front.png', 'asset-back.png', 'asset-side.png'] })
      expect(uploadedNames).toHaveLength(4)
      expect(sentMessage(0, 0).reference_asset_ids).toEqual(['asset-front.png', 'asset-side.png', 'asset-back.png'])
    })

    /** Continuation retains admitted picture order, and leaving prevents delayed upload delivery. */
    it.each([false, true])('guards a reference continuation while its upload is pending; leave=%s', async (leave) => {
      window.history.replaceState({}, '', '/?demo=1')
      capabilityResponse = async () => new Response(JSON.stringify({ model_ids: ['h3-ref2va'], segment_counts: [1, 2, 3, 4, 5, 6], asset_upload: assetUploadPolicy, models: { 'h3-ref2va': { ...modelCapabilities, min_segment_duration_sec: 5, max_segment_duration_sec: 15, generation_modes: ['ref2va'], reference_inputs: { media_types: ['image'], max_count: 9, conditioning: 'reference' } } } }))
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('H3 Ref2AV')
      await user.upload(screen.getByLabelText('Add reference images'), new File(['png'], 'front.png', { type: 'image/png' }))
      await generate(user, 0)
      completeClip(0, [1, 2])
      await waitFor(() => expect(screen.getByLabelText('Continuation prompt')).toBeEnabled())
      const upload = deferred<Response>(new Response(JSON.stringify(imageAsset('side.png'))))
      uploadResponse = () => upload.promise
      await user.upload(screen.getByLabelText('Add reference images'), new File(['png'], 'side.png', { type: 'image/png' }))
      await user.type(screen.getByLabelText('Continuation prompt'), '  Walk toward the camera  ')
      await user.keyboard('{Enter}')
      await waitFor(() => { expect(uploadedNames).toEqual(['front.png', 'side.png']) })
      expect(outbound[0]).toHaveLength(1)
      if (leave) {
        await user.click(screen.getByRole('button', { name: 'New project' }))
        await screen.findByLabelText('Initial prompt')
      } else {
        await user.click(screen.getByRole('button', { name: 'Remove picture 2' }))
      }
      await act(async () => { upload.resolve(new Response(JSON.stringify(imageAsset('side.png')))) })
      if (leave) {
        expect(outbound[0]).toHaveLength(1)
        expect(projectConnection(0).ws.readyState).toBe(WebSocket.CLOSED)
      } else {
        await waitFor(() => { expect(outbound[0]).toHaveLength(2) })
        expect(sentMessage(0, 1)).toMatchObject({ type: 'append_prompt', prompt: 'Walk toward the camera', reference_asset_ids: ['asset-front.png', 'asset-side.png'] })
        expect(screen.getByLabelText('Continuation prompt')).toHaveValue('')
        expect(screen.queryByRole('button', { name: 'Remove picture 2' })).not.toBeInTheDocument()
      }
    })

    /** An abandoned upload can populate the library, but cannot replace a later draft or initialize a socket. */
    it('ignores an upload that completes after New project', async () => {
      const upload = deferred<Response>(new Response(JSON.stringify(imageAsset('abandoned.png'))))
      uploadResponse = () => upload.promise
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastLTX 2.3')
      screen.getByRole('button', { name: 'Text to video' }).focus()
      await user.keyboard('{Enter}')
      await user.click(screen.getByRole('menuitem', { name: /Image to video/ }))
      await user.upload(screen.getByLabelText('Add reference images'), new File(['png'], 'abandoned.png', { type: 'image/png' }))
      await user.type(screen.getByLabelText('Initial prompt'), 'First request')
      await user.click(screen.getByRole('button', { name: 'Generate' }))
      await waitFor(() => { expect(uploadedNames).toEqual(['abandoned.png']) })
      await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
      await user.click(within(screen.getByRole('complementary', { name: 'Project history' })).getByRole('button', { name: 'New project' }))
      await waitFor(() => expect(screen.getByLabelText('Initial prompt')).toBeEnabled())
      await user.upload(screen.getByLabelText('Add reference images'), new File(['png'], 'replacement.png', { type: 'image/png' }))
      await act(async () => { upload.resolve(new Response(JSON.stringify(imageAsset('abandoned.png')))) })
      expect(fixtures.connections).toHaveLength(0)
      expect(screen.getByRole('img', { name: 'replacement.png' })).toBeVisible()
      expect(screen.queryByRole('img', { name: 'abandoned.png' })).not.toBeInTheDocument()
    })

    /** Returning from a text project must release the active mode before choosing image generation. */
    it('shows the reference picker after a text project returns to image creation', async () => {
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastLTX 2.3')
      await generate(user, 0)
      completeClip(0, [1])
      await waitFor(() => { expect(archivedClips()).toHaveLength(1) })
      await user.click(screen.getByRole('button', { name: 'New project' }))
      await screen.findByLabelText('Initial prompt')
      screen.getByRole('button', { name: 'Text to video' }).focus()
      await user.keyboard('{Enter}')
      await user.click(screen.getByRole('menuitem', { name: /Image to video/ }))
      expect(screen.getByLabelText('Add reference images')).toBeInTheDocument()
      await user.upload(screen.getByLabelText('Add reference images'), new File(['png'], 'second.png', { type: 'image/png' }))
      await generate(user, 1)
      expect(sentMessage(1, 0)).toMatchObject({ generation_mode: 'i2v', reference_asset_ids: ['asset-second.png'] })
    })

    /** A real New project action revokes a pending admission before readiness can create local or wire state. */
    it('ignores readiness after New project supersedes the admitted creation', async () => {
      const readiness = deferred<undefined>(undefined)
      readinessResponse = () => readiness.promise
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastLTX 2.3')
      await user.type(screen.getByRole('textbox', { name: 'Initial prompt' }), 'Superseded river')
      await user.click(screen.getByRole('button', { name: 'Generate' }))
      await waitFor(() => { expect(requests).toContain('/readyz') })
      await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
      const sidebar = screen.getByRole('complementary', { name: 'Project history' })
      await user.click(within(sidebar).getByRole('button', { name: 'New project' }))
      await waitFor(() => expect(within(sidebar).getByRole('button', { name: 'New project' })).toBeEnabled())
      const prompt = screen.getByRole('textbox', { name: 'Initial prompt' })
      await user.type(prompt, 'Replacement river')
      await act(async () => { readiness.resolve(undefined) })
      expect(prompt).toHaveValue('Replacement river')
      expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
      expect(screen.queryByRole('button', { name: 'Model' })).not.toBeInTheDocument()
      expect(fixtures.connections).toHaveLength(0)
      expect(outbound).toEqual([])
      expect(fixtures.buildCreation).toHaveBeenCalledTimes(1)
    })

    /** Demo continuation sends raw prompt text after ordinary custom project creation. */
    it('sends a raw continuation from a demo project', async () => {
      window.history.replaceState({}, '', '/?demo=1')
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastLTX 2.3')
      screen.getByRole('button', { name: 'Segments: 6' }).focus()
      await user.keyboard('{Enter}')
      await user.click(screen.getByRole('menuitem', { name: '3 segments' }))
      await generate(user, 0)
      const initialRequest = sentMessage(0, 0)
      expect(initialRequest).toMatchObject({
        single_clip_mode: false, segment_duration_sec: 5, segment_count: 3, initial_rollout_prompt: 'A river', curated_prompts: [],
      })
      const prompts = ['A river', 'River bend', 'River rapids', 'River bridge', 'River valley', 'River delta']
      await act(async () => {
        serverSocket(0).send(JSON.stringify({ type: 'gpu_assigned' }))
        serverSocket(0).send(JSON.stringify({
          type: 'seed_prompts_updated', prompts,
        }))
        serverSocket(0).send(JSON.stringify({
          type: 'rewrite_seed_prompts_complete', prompt_id: initialRequest.initial_prompt_id,
        }))
        serverSocket(0).send(JSON.stringify({
          type: 'ltx2_stream_start',
          origin_prompt_id: initialRequest.initial_prompt_id, origin_prompt: 'A river', prompt_window_prompts: prompts,
        }))
        serverSocket(0).send(JSON.stringify({
          type: 'ltx2_segment_start', segment_idx: 1, seed_prompt_index: 0, source: 'curated',
        }))
        serverSocket(0).send(JSON.stringify({
          type: 'media_init', segment_idx: 1, stream_id: 'demo-river-1', mime: 'video/mp4',
        }))
        serverSocket(0).send(new Uint8Array([1, 2]).buffer)
        serverSocket(0).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1, stream_id: 'demo-river-1' }))
        serverSocket(0).send(JSON.stringify({ type: 'ltx2_stream_complete' }))
        serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'idle' }))
      })
      const prompt = screen.getByRole('textbox', { name: 'Continuation prompt' })
      await waitFor(() => expect(prompt).toBeEnabled())
      const continueButton = screen.getByRole('button', { name: 'Continue video' })
      expect(continueButton).toHaveAttribute('title', 'Continue video')
      expect(prompt).toHaveAttribute('placeholder', 'Describe what happens next')
      await user.type(prompt, 'Follow the river')
      await user.click(continueButton)
      await waitFor(() => { expect(outbound[0]).toHaveLength(2) })
      expect(sentMessage(0, 1)).toEqual({
        type: 'append_prompt', prompt: 'Follow the river', prompt_id: expect.any(String) as string, reference_asset_ids: [], auto_extension_enabled: false,
      })
      expect(sentMessage(0, 1).prompt_id).not.toBe(initialRequest.initial_prompt_id)
      expect(prompt).toHaveValue('')
      expect(fixtures.connections).toHaveLength(1)
    })

    /** Continuation streams only added bytes while each completed version contains its full preceding sequence. */
    it('archives cumulative continuation video and preserves prior versions', async () => {
      window.history.replaceState({}, '', '/?demo=1')
      const user = userEvent.setup()
      const { container } = render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastLTX 2.3')
      await generate(user, 0)
      completeClip(0, [1, 2])
      await waitFor(() => { expect(archivedClips()).toHaveLength(1) })
      const original = archivedClip(0)
      const prompt = screen.getByRole('textbox', { name: 'Continuation prompt' })
      for (const [index, bytes] of [[2, [3, 4]], [3, [5, 6]]] as const) {
        if (index === 3) await new Promise(resolve => setTimeout(resolve, 1100))
        await waitFor(() => expect(prompt).toBeEnabled())
        await user.type(prompt, `Continue ${index}`)
        await user.click(screen.getByRole('button', { name: 'Continue video' }))
        await waitFor(() => { expect(outbound[0]).toHaveLength(index) })
        const request = sentMessage(0, -1)
        serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'generating' }))
        serverSocket(0).send(JSON.stringify({
          type: 'ltx2_stream_start', continuation: true,
          origin_prompt_id: request.prompt_id, origin_prompt: request.prompt,
          prompt_window_prompts: Array.from({ length: index }, (_, offset) => `River ${offset + 1}`),
        }))
        serverSocket(0).send(JSON.stringify({ type: 'ltx2_segment_start', segment_idx: index, seed_prompt_index: index - 1, source: 'user_raw', prompt_id: request.prompt_id }))
        serverSocket(0).send(new Uint8Array(bytes).buffer)
        serverSocket(0).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: index }))
        await waitFor(() => { expect(fixtures.completeSegment).toHaveBeenLastCalledWith({ segmentIdx: index, streamId: '' }) })
        expect(archivedClips()).toHaveLength(index - 1)
        serverSocket(0).send(JSON.stringify({ type: 'ltx2_stream_complete' }))
        serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'idle' }))
        await waitFor(() => { expect(archivedClips()).toHaveLength(index) })
        const composedSegments = fixtures.remux.mock.lastCall?.[0]
        expect(composedSegments?.flatMap(segment => segment.chunks.flatMap(
          (chunk: ArrayBuffer) => [...new Uint8Array(chunk)],
        ))).toEqual(index === 2 ? [1, 2, 3, 4] : [1, 2, 3, 4, 5, 6])
        expect(archivedClip(index - 1).blob.size).toBe(index * 2)
        expect(container.querySelector('video[preload="auto"]')).toHaveAttribute('src', expect.stringContaining('blob:'))
        expect(archivedClip(0).blob).toBe(original.blob)
        expect(original.blob.size).toBe(2)
      }
    })

    /** Opt-in is part of submission; stopping never unlocks an accepted round before the server settles it. */
    it('opts in before generation and stops through one command', async () => {
      window.history.replaceState({}, '', '/')
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      const optIn = await screen.findByRole('checkbox', { name: 'Auto extension' })
      expect(optIn).not.toBeChecked()
      await user.click(optIn)
      expect(optIn).toBeChecked()
      expect(outbound).toEqual([])
      await generate(user, 0)
      expect(sentMessage(0, 0).auto_extension_enabled).toBe(true)
      expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
      serverSocket(0).send(JSON.stringify({ type: 'gpu_assigned' }))
      serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', status: 'preparing', auto_extension_enabled: true }))
      const stop = await screen.findByRole('button', { name: 'Stop generation' })
      const prompt = screen.getByRole('textbox', { name: 'Continuation prompt' })
      expect(prompt).toBeDisabled()
      fireEvent.keyDown(prompt, { key: 'Enter' })
      expect(outbound[0]).toHaveLength(1)
      await user.click(stop)
      await waitFor(() => { expect(outbound[0]?.[1]).toEqual({ type: 'stop_auto_extension' }) })
      expect(stop).toBeVisible()
      serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', status: 'generating', auto_extension_enabled: false }))
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop generation' })).not.toBeInTheDocument())
      expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
      expect(prompt).toBeDisabled()
      const submit = screen.getByRole('button', { name: 'Rewrite rollout' })
      expect(submit).toBeDisabled()
      fireEvent.keyDown(prompt, { key: 'Enter' })
      expect(outbound[0]).toHaveLength(2)
      serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', status: 'idle', auto_extension_enabled: false }))
      await waitFor(() => expect(prompt).toBeEnabled())
      expect(screen.getByRole('checkbox', { name: 'Auto extension' })).not.toBeChecked()
      await user.type(prompt, 'Follow the river')
      await user.click(submit)
      await waitFor(() => {
        expect(outbound[0]?.[2]).toMatchObject({
          type: 'rewrite_seed_prompts', auto_extension_enabled: false,
        })
      })
    })

    /** Selecting auto_extension while idle changes only the next explicit generation request. */
    it.each([false, true])('keeps idle opt-in local until submission (demo=%s)', async (demo) => {
      window.history.replaceState({}, '', demo ? '/?demo=1' : '/')
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await generate(user, 0)
      expect(sentMessage(0, 0).auto_extension_enabled).toBe(false)
      completeClip(0, [1, 2])
      const optIn = await screen.findByRole('checkbox', { name: 'Auto extension' })
      await user.click(optIn)
      expect(optIn).toBeChecked()
      expect(outbound[0]).toHaveLength(1)
      expect(screen.queryByRole('button', { name: 'Stop generation' })).not.toBeInTheDocument()
      const prompt = screen.getByRole('textbox', { name: 'Continuation prompt' })
      expect(prompt).toBeEnabled()
      await user.type(prompt, 'Follow the river')
      await user.click(screen.getByRole('button', { name: demo ? 'Continue video' : 'Rewrite rollout' }))
      await waitFor(() => {
        expect(outbound[0]?.[1]).toMatchObject({
          type: demo ? 'append_prompt' : 'rewrite_seed_prompts', auto_extension_enabled: true,
        })
      })
      expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
      serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', status: 'failed', auto_extension_enabled: false }))
      await waitFor(() => expect(prompt).toBeEnabled())
      expect(screen.getByRole('checkbox', { name: 'Auto extension' })).not.toBeChecked()
      await user.type(prompt, 'Try another direction')
      await new Promise(resolve => setTimeout(resolve, 1100))
      await user.click(screen.getByRole('button', { name: demo ? 'Continue video' : 'Rewrite rollout' }))
      await waitFor(() => {
        expect(outbound[0]?.[2]).toMatchObject({
          type: demo ? 'append_prompt' : 'rewrite_seed_prompts', auto_extension_enabled: false,
        })
      })
    })

    /** Automatic streams append cumulative archives until stopped; disconnect starts the next project with opt-in off. */
    it('archives successive automatic segments and clears opt-in on disconnect', async () => {
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await user.click(await screen.findByRole('checkbox', { name: 'Auto extension' }))
      await generate(user, 0)
      completeClip(0, [1, 2], true)
      await waitFor(() => { expect(archivedClips()).toHaveLength(1) })
      const original = archivedClip(0)
      const prompt = screen.getByRole('textbox', { name: 'Continuation prompt' })
      const acceptedPrompts = ['A river']
      for (const index of [2, 3]) {
        acceptedPrompts.push(`River ${index}`)
        serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', status: 'generating', auto_extension_enabled: true }))
        serverSocket(0).send(JSON.stringify({
          type: 'ltx2_stream_start', continuation: true, origin_prompt_id: null, origin_prompt: '',
          prompt_window_prompts: [...acceptedPrompts],
        }))
        serverSocket(0).send(JSON.stringify({ type: 'ltx2_segment_start', segment_idx: index, seed_prompt_index: index - 1, source: 'auto_enhanced' }))
        serverSocket(0).send(new Uint8Array([index * 2 - 1, index * 2]).buffer)
        serverSocket(0).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: index }))
        if (index === 3) {
          await user.click(await screen.findByRole('button', { name: 'Stop generation' }))
          await waitFor(() => { expect(outbound[0]?.[1]).toEqual({ type: 'stop_auto_extension' }) })
          serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', status: 'generating', auto_extension_enabled: false }))
          expect(prompt).toBeDisabled()
        }
        serverSocket(0).send(JSON.stringify({ type: 'ltx2_stream_complete' }))
        await waitFor(() => { expect(archivedClips()).toHaveLength(index) })
        expect(prompt).toBeDisabled()
        expect(archivedClip(index - 1).blob.size).toBe(index * 2)
        if (index === 2) serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', status: 'preparing', auto_extension_enabled: true }))
      }
      expect(archivedClip(0).blob).toBe(original.blob)
      expect(sentMessages(0).map(message => message.type)).toEqual(['project_init_v1', 'stop_auto_extension'])
      serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', status: 'idle', auto_extension_enabled: false }))
      await waitFor(() => expect(prompt).toBeEnabled())
      await user.click(screen.getByRole('checkbox', { name: 'Auto extension' }))
      await user.type(prompt, 'Continue after stopping')
      await user.click(screen.getByRole('button', { name: 'Rewrite rollout' }))
      await waitFor(() => {
        expect(outbound[0]?.[2]).toMatchObject({
          type: 'rewrite_seed_prompts', prompt_window_prompts: acceptedPrompts, auto_extension_enabled: true,
        })
      })
      serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', status: 'preparing', auto_extension_enabled: true }))
      await screen.findByRole('button', { name: 'Stop generation' })
      serverSocket(0).close()
      await screen.findByText('Project disconnected')
      expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Stop generation' })).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'New Project' }))
      expect(await screen.findByRole('checkbox', { name: 'Auto extension' })).not.toBeChecked()
      await generate(user, 1)
      expect(sentMessage(1, 0).auto_extension_enabled).toBe(false)
    })
  })

  /** Exercise both lobby actions through readiness before permitting a project socket. */
  it.each(['Enter', 'Generate'])('starts one lobby project with %s after readiness', async (action) => {
    const modelCapabilities = {
      generation_modes: ['t2va'],
      aspect_ratios: ['16:9'],
      resolutions: ['720p'],
      min_segment_duration_sec: 5, max_segment_duration_sec: 15, segment_counts: [1, 2, 3, 4, 5, 6],
      unsupported_generation_modes: { fl2va: 'First/last frame generation is unsupported.' },
      reference_inputs: { media_types: ['image'], max_count: 1, conditioning: 'first_frame' },
      asset_upload: assetUploadPolicy,
    }
    const capabilities = {
      model_ids: ['fast-h3'],
      models: { 'fast-h3': modelCapabilities },
      ...modelCapabilities,
    }
    let releaseReadiness = () => {}
    const readiness = new Promise<void>((resolve) => { releaseReadiness = resolve })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/creation-capabilities')) {
        return { ok: true, status: 200, json: async () => capabilities }
      }
      if (url.endsWith('/healthz')) {
        return { ok: true, status: 200, json: async () => ({ status: 'ok' }) }
      }
      if (url.endsWith('/readyz')) {
        await readiness
        return { ok: true, status: 200, json: async () => ({ status: 'ready', ready_gpu_workers: 1 }) }
      }
      throw new Error(`Unexpected fetch in lobby submission test: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    try {
      await screen.findByText('FastH3')
      await user.type(screen.getByRole('textbox', { name: 'Initial prompt' }), 'A river at dawn')
      if (action === 'Enter') {
        await user.keyboard('{Enter}')
      } else {
        await user.click(screen.getByRole('button', { name: 'Generate' }))
      }
      await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith('/readyz', expect.any(Object)) })
      expect(sockets).toHaveLength(0)
      expect(fixtures.connections).toHaveLength(0)
      await act(async () => { releaseReadiness() })
      await waitFor(() => { expect(outbound[0]?.[0]?.type).toBe('project_init_v1') })
      expect(sockets).toHaveLength(1)
      expect(outbound[0]).toHaveLength(1)
      expect(sentMessage(0, 0)).toMatchObject({
        type: 'project_init_v1', generation_mode: 't2va', initial_rollout_prompt: 'A river at dawn',
      })
      expect(fixtures.buildCreation).toHaveBeenCalledTimes(1)
      expect(fixtures.buildCreation).toHaveBeenCalledWith(expect.objectContaining({
        modelId: 'fast-h3', modeId: 't2v', aspectRatio: '16:9', resolution: '720p', segmentDurationSec: 5, segmentCount: 6,
      }))
      expect(fetchMock.mock.calls.map(([url]) => url).filter(url => url === '/healthz' || url === '/readyz'))
        .toEqual(['/healthz', '/readyz'])
    } finally {
      await act(async () => { releaseReadiness() })
    }
  })

  /** Keep text composition intact and match each active prompt action to its outgoing command. */
  it.each([
    {
      composer: 'ChatBar', path: '/', actionLabel: 'Rewrite rollout',
      placeholder: 'What do you want to edit?', commandType: 'rewrite_seed_prompts',
    },
    {
      composer: 'ChatBar in demo mode', path: '/?demo=1', actionLabel: 'Continue video',
      placeholder: 'Describe what happens next', commandType: 'append_prompt',
    },
  ])('preserves active text composition through $composer', async ({
    path, actionLabel, placeholder, commandType,
  }) => {
    window.history.pushState({}, '', path)
    // Workspace uses visual scrolling APIs that jsdom does not provide.
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
    })
    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    const modelCapabilities = {
      generation_modes: ['t2va'],
      aspect_ratios: ['16:9'],
      resolutions: ['720p'],
      min_segment_duration_sec: 5, max_segment_duration_sec: 15, segment_counts: [1, 2, 3, 4, 5, 6],
      unsupported_generation_modes: { fl2va: 'First/last frame generation is unsupported.' },
      reference_inputs: { media_types: ['image'], max_count: 1, conditioning: 'first_frame' },
      asset_upload: assetUploadPolicy,
    }
    const capabilities = {
      model_ids: ['fast-h3'],
      models: { 'fast-h3': modelCapabilities },
      ...modelCapabilities,
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/creation-capabilities')) {
        return { ok: true, status: 200, json: async () => capabilities }
      }
      if (url.endsWith('/curated-presets')) {
        return { ok: true, status: 200, json: async () => ({
          presets: [{ id: 'test_preset', label: 'Test Preset', segment_prompts: ['A river', 'A waterfall'] }],
        }) }
      }
      if (url.endsWith('/lora/options')) {
        return { ok: true, status: 200, json: async () => ({ has_base_lora: false, styles: [], labels: {} }) }
      }
      if (url.endsWith('/healthz')) {
        return { ok: true, status: 200, json: async () => ({ status: 'ok' }) }
      }
      if (url.endsWith('/readyz')) {
        return { ok: true, status: 200, json: async () => ({ status: 'ready', ready_gpu_workers: 1 }) }
      }
      throw new Error(`Unexpected fetch in active composition test: ${url}`)
    }))
    const user = userEvent.setup()
    const { unmount } = render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    try {
      await screen.findByText('FastH3')
      await generate(user, 0)
      expect(fixtures.buildCreation).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'fast-h3' }))
      completeClip(0, [1, 2, 3])
      await waitFor(() => { expect(archivedClips()).toHaveLength(1) })
      const prompt = screen.getByRole('textbox', { name: 'Continuation prompt' }) as HTMLTextAreaElement
      expect(prompt).toBeEnabled()
      const actionButton = screen.getByRole('button', { name: actionLabel })
      expect(prompt).toHaveAttribute('placeholder', placeholder)
      expect(actionButton).toHaveAttribute('title', actionLabel)
      const draft = 'Make the river misty'
      await user.type(prompt, draft)
      expect(actionButton).toBeEnabled()
      const send = vi.spyOn(projectConnection(0).ws, 'send')
      for (const status of ['preparing', 'generating']) {
        await act(async () => {
          serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status }))
          await new Promise(resolve => setTimeout(resolve, 20))
        })
        expect(actionButton).toBeDisabled()
        fireEvent.keyDown(prompt, { key: 'Enter' })
        expect(send).not.toHaveBeenCalled()
      }
      serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'idle' }))
      await waitFor(() => expect(actionButton).toBeEnabled())
      expect(archivedClips()).toHaveLength(1)
      const composing = new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true,
      })
      fireEvent(prompt, composing)
      expect({
        defaultPrevented: composing.defaultPrevented,
        draft: prompt.value,
        messages: send.mock.calls.map(([wire]): unknown => (typeof wire === 'string' ? JSON.parse(wire) : wire)),
      }).toEqual({ defaultPrevented: false, draft, messages: [] })

      await user.keyboard('{Shift>}{Enter}{/Shift}')
      await user.type(prompt, 'Keep the reflections.')
      const multilinePrompt = `${draft}\nKeep the reflections.`
      expect(prompt).toHaveValue(multilinePrompt)
      expect(send).not.toHaveBeenCalled()
      await user.keyboard('{Enter}')
      await waitFor(() => { expect(outbound[0]).toHaveLength(2) })
      expect(send).toHaveBeenCalledTimes(1)
      expect(sentMessage(0, 1)).toMatchObject(commandType === 'append_prompt'
        ? { type: 'append_prompt', prompt: multilinePrompt, prompt_id: expect.any(String) as string }
        : { type: 'rewrite_seed_prompts', rewrite_instruction: multilinePrompt })
      expect(prompt).toHaveValue('')
    } finally {
      unmount()
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
      }
      vi.unstubAllEnvs()
      window.history.pushState({}, '', '/')
    }
  })

  it('closes the first socket before resetting and starts the next project without its clips', async () => {
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await generate(user, 0)
    let releaseRemux = (_blob: Blob) => {}
    fixtures.remux.mockImplementationOnce(() => new Promise((resolve) => { releaseRemux = resolve }))
    completeClip(0, [1, 2, 3])
    await waitFor(() => { expect(fixtures.remux).toHaveBeenCalled() })
    await user.click(screen.getByRole('button', { name: 'New project' }))
    await waitFor(() => { expect(projectConnection(0).ws.readyState).toBe(WebSocket.CLOSED) })
    expect(sockets).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Starting new project...' })).toBeDisabled()
    await act(async () => { releaseRemux(new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' })) })
    await generate(user, 1)
    expect(projectConnection(1).ws).not.toBe(projectConnection(0).ws)
    completeClip(1, [4, 5])
    await waitFor(() => { expect(archivedClips()).toHaveLength(1) })
    expect(archivedClip(0).blob.size).toBe(2)
    await user.click(screen.getByRole('button', { name: 'New project' }))
    await screen.findByLabelText('Initial prompt')
    expect(archivedClips()).toHaveLength(0)
    expect(outbound.map(messages => messages.map(message => message.type))).toEqual([
      ['project_init_v1'], ['project_init_v1'],
    ])
    expect(screen.queryByText(/Time left:/)).not.toBeInTheDocument()
  })

  it('shows an unexpected disconnect, keeps the clip, and offers Reconnect without reconnecting', async () => {
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await generate(user, 0)
    completeClip(0, [1, 2, 3])
    await waitFor(() => { expect(archivedClips()).toHaveLength(1) })
    serverSocket(0).close()
    expect(await screen.findByText('Project disconnected')).toBeInTheDocument()
    expect(screen.getByText('Reconnect to continue this project.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled()
    expect(archivedClip(0).blob.size).toBe(3)
    expect(fixtures.connections).toHaveLength(1)
    expect(screen.queryByText(/5 minutes/)).not.toBeInTheDocument()
  })

  it('ignores callbacks and delayed binary decoding from the closed project', async () => {
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await generate(user, 0)
    const previous = projectConnection(0)
    const { onOpen, onMessage, onClose } = previous.callbacks
    if (!onOpen || !onMessage || !onClose) throw new Error('Page did not pass every project socket handler')
    let releaseBinary = (_value: ArrayBuffer) => {}
    const binary = new Blob(['stale'])
    const readBinary = vi.fn(() => new Promise<ArrayBuffer>((resolve) => { releaseBinary = resolve }))
    binary.arrayBuffer = readBinary
    onMessage(new MessageEvent('message', { data: binary }))
    await waitFor(() => { expect(readBinary).toHaveBeenCalled() })
    await user.click(screen.getByRole('button', { name: 'New project' }))
    await act(async () => { releaseBinary(new Uint8Array([9, 9, 9]).buffer) })
    await generate(user, 1)
    await act(async () => {
      onOpen(new Event('open'))
      onClose(new CloseEvent('close'))
      onMessage(new MessageEvent('message', {
        data: JSON.stringify({ type: 'error', message: 'Stale project error' }),
      }))
    })
    completeClip(1, [4, 5])
    await waitFor(() => { expect(archivedClips()).toHaveLength(1) })
    expect(archivedClip(0).blob.size).toBe(2)
    expect(screen.queryByText('Stale project error')).not.toBeInTheDocument()
    expect(screen.queryByText('Project disconnected')).not.toBeInTheDocument()
    expect(projectConnection(1).ws.readyState).toBe(WebSocket.OPEN)
  })

  describe('Active clip export', () => {
    /** One object URL that Page allocated, with the Blob or MediaSource that it names. */
    interface ObjectUrlAllocation {
      blob: Blob | MediaSource
      url: string
    }

    let allocations: ObjectUrlAllocation[]
    let downloads: { url: string; filename: string }[]
    let revokeObjectURL: MockInstance<(url: string) => void>
    let localStorageSnapshot: [string, string][]
    let scrollIntoViewDescriptor: PropertyDescriptor | undefined

    /** Add export observation and browser APIs to the existing socket fixture. */
    beforeEach(() => {
      localStorageSnapshot = snapshotLocalStorage()
      localStorage.clear()
      allocations = []
      downloads = []
      vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
        const url = `blob:active-export-${allocations.length + 1}`
        allocations.push({ blob, url })
        return trackObjectUrl(blob, url)
      })
      revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { trackRevokedUrl(url) })
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push({ url: this.href, filename: this.download })
      })
      vi.stubGlobal('IntersectionObserver', class {
        observe() {}
        disconnect() {}
      })
      scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
      const modelCapabilities = {
        generation_modes: ['t2va'], aspect_ratios: ['16:9'], resolutions: ['720p'], min_segment_duration_sec: 5, max_segment_duration_sec: 15, segment_counts: [1, 2, 3, 4, 5, 6],
        unsupported_generation_modes: { fl2va: 'First/last frame generation is unsupported.' },
        reference_inputs: { media_types: ['image'], max_count: 1, conditioning: 'first_frame' },
        asset_upload: assetUploadPolicy,
      }
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/creation-capabilities')) {
          return { ok: true, status: 200, json: async () => ({
            model_ids: ['fast-h3'], models: { 'fast-h3': modelCapabilities }, ...modelCapabilities,
          }) }
        }
        if (url.endsWith('/healthz')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) }
        if (url.endsWith('/readyz')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ready', ready_gpu_workers: 1 }) }
        }
        throw new Error(`Unexpected fetch in active export test: ${url}`)
      }))
    })

    /** Restore only browser state added by these cases; Page unmount precedes this hook. */
    afterEach(() => {
      localStorage.clear()
      localStorageSnapshot.forEach(([key, value]) => { localStorage.setItem(key, value) })
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
      }
      vi.unstubAllEnvs()
    })

    /** Return the object URL allocation that matches, failing the case when Page never allocated it. */
    function findAllocation(matches: (entry: ObjectUrlAllocation) => boolean): ObjectUrlAllocation {
      const allocation = allocations.find(matches)
      if (!allocation) throw new Error('Page did not allocate the expected object URL')
      return allocation
    }

    function readBlobBytes(blob: Blob): Promise<number[]> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => { resolve([...new Uint8Array(reader.result as ArrayBuffer)]) }
        reader.onerror = () => { reject(reader.error ?? new Error('FileReader failed without an error')) }
        reader.readAsArrayBuffer(blob)
      })
    }

    /** Deliver one complete segment through Page's ordered socket consumer. */
    function sendSegment(segmentIdx: number, streamId: string, bytes: number[]) {
      const socket = serverSocket(0)
      socket.send(JSON.stringify({ type: 'ltx2_segment_start', segment_idx: segmentIdx, seed_prompt_index: segmentIdx - 1, source: 'curated' }))
      socket.send(JSON.stringify({ type: 'media_init', segment_idx: segmentIdx, stream_id: streamId, mime: 'video/mp4' }))
      socket.send(new Uint8Array(bytes).buffer)
      socket.send(JSON.stringify({ type: 'media_segment_complete', segment_idx: segmentIdx, stream_id: streamId }))
    }

    /** Generate and archive the original two-segment clip through the real lobby and socket. */
    async function completeOriginal(user: ReturnType<typeof userEvent.setup>) {
      await screen.findByText('FastH3')
      screen.getByRole('button', { name: 'Segments: 6' }).focus()
      await user.keyboard('{Enter}')
      await user.click(screen.getByRole('menuitem', { name: '2 segments' }))
      await generate(user, 0)
      expect(fixtures.buildCreation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        modelId: 'fast-h3', segmentDurationSec: 5, segmentCount: 2,
      }))
      expect(sentMessage(0, 0)).toMatchObject({ type: 'project_init_v1', initial_rollout_prompt: 'A river' })
      serverSocket(0).send(JSON.stringify({ type: 'gpu_assigned' }))
      serverSocket(0).send(JSON.stringify({ type: 'rewrite_seed_prompts_complete', prompt_id: sentMessage(0, 0).initial_prompt_id }))
      serverSocket(0).send(JSON.stringify({
        type: 'ltx2_stream_start',
        origin_prompt_id: sentMessage(0, 0).initial_prompt_id, origin_prompt: 'A river',
        prompt_window_prompts: ['A river', 'A river downstream'],
      }))
      sendSegment(1, 'A-1', [1, 2])
      sendSegment(2, 'A-2', [3, 4])
      serverSocket(0).send(JSON.stringify({ type: 'ltx2_stream_complete' }))
      serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'idle' }))
      await waitFor(() => { expect(archivedClips()).toHaveLength(1) })
      const completedBlob = archivedClip(0).blob
      const completedUrl = findAllocation(entry => entry.blob === completedBlob).url
      expect(await readBlobBytes(completedBlob)).toEqual([1, 2, 3, 4])
      return { completedBlob, completedUrl }
    }

    /** Submit an edit through the enabled composer and observe its actual wire command. */
    async function submitRewrite(user: ReturnType<typeof userEvent.setup>, instruction: string) {
      const commandIndex = sentMessages(0).length
      const prompt = screen.getByRole('textbox', { name: 'Continuation prompt' })
      await waitFor(() => expect(prompt).toBeEnabled())
      await user.type(prompt, instruction)
      await user.click(screen.getByRole('button', { name: 'Rewrite rollout' }))
      await waitFor(() => {
        expect(outbound[0]?.[commandIndex]).toMatchObject({
          type: 'rewrite_seed_prompts', rewrite_instruction: instruction,
        })
      })
    }

    /** Echo the admitted rewrite request when announcing its accepted stream. */
    function beginRewriteRollout(prefix: string) {
      const request = sentMessage(0, -1)
      const prompts = [`${prefix} segment one`, `${prefix} segment two`]
      serverSocket(0).send(JSON.stringify({
        type: 'seed_prompts_updated', prompts,
      }))
      serverSocket(0).send(JSON.stringify({ type: 'rewrite_seed_prompts_complete', prompt_id: request.prompt_id }))
      serverSocket(0).send(JSON.stringify({
        type: 'ltx2_stream_start',
        origin_prompt_id: request.prompt_id, origin_prompt: request.rewrite_instruction, prompt_window_prompts: prompts,
      }))
    }

    /** Keep one forest segment live while the worker has announced, but not delivered, the next segment. */
    async function bufferForestRewrite(user: ReturnType<typeof userEvent.setup>) {
      await submitRewrite(user, 'A forest in rain')
      beginRewriteRollout('B')
      sendSegment(1, 'B-1', [8, 9])
      serverSocket(0).send(JSON.stringify({ type: 'ltx2_segment_start', segment_idx: 2, seed_prompt_index: 1, source: 'user_rewrite' }))
      await waitFor(() => { expect(fixtures.completeSegment).toHaveBeenLastCalledWith({ segmentIdx: 1, streamId: 'B-1' }) })
    }

    /** Resolve a captured anchor URL to the exact Blob offered by Page. */
    async function downloadActiveClip(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: 'Download video' }))
      await waitFor(() => { expect(downloads).toHaveLength(1) })
      const download = downloads[0]
      if (!download) throw new Error('Page did not download a file')
      const blob = findAllocation(entry => entry.url === download.url).blob as Blob
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(download.url)
      return { ...download, blob }
    }

    /** Complete A, buffer part of B, then use Original to choose A for playback and export. */
    it('exports selected active Original before buffered live media', async () => {
      const user = userEvent.setup()
      const { container, unmount } = render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      try {
        const { completedBlob, completedUrl } = await completeOriginal(user)

        const prompt = screen.getByRole('textbox', { name: 'Continuation prompt' })
        await waitFor(() => expect(prompt).toBeEnabled())
        await user.type(prompt, 'A forest in rain')
        await user.click(screen.getByRole('button', { name: 'Rewrite rollout' }))
        await waitFor(() => {
          expect(outbound[0]?.[1]).toMatchObject({
            type: 'rewrite_seed_prompts', rewrite_instruction: 'A forest in rain',
          })
        })
        serverSocket(0).send(JSON.stringify({
          type: 'seed_prompts_updated',
          prompts: ['B segment one', 'B segment two'],
        }))
        serverSocket(0).send(JSON.stringify({ type: 'rewrite_seed_prompts_complete', prompt_id: sentMessage(0, 1).prompt_id }))
        serverSocket(0).send(JSON.stringify({
          type: 'ltx2_stream_start',
          origin_prompt_id: sentMessage(0, 1).prompt_id, origin_prompt: sentMessage(0, 1).rewrite_instruction,
          prompt_window_prompts: ['B segment one', 'B segment two'],
        }))
        sendSegment(1, 'B-1', [8, 9])
        // Metadata for segment two arrives after worker output, leaving B's first segment buffered.
        serverSocket(0).send(JSON.stringify({ type: 'ltx2_segment_start', segment_idx: 2, seed_prompt_index: 1, source: 'user_rewrite' }))
        await waitFor(() => { expect(fixtures.completeSegment).toHaveBeenLastCalledWith({ segmentIdx: 1, streamId: 'B-1' }) })

        await user.click(screen.getByText('Original'))
        const archivedVideo = container.querySelector<HTMLVideoElement>('video[preload="auto"]')
        await waitFor(() => expect(archivedVideo).toHaveAttribute('src', completedUrl))
        expect(archivedVideo).toBeVisible()
        fixtures.remux.mockClear()
        await user.click(screen.getByRole('button', { name: 'Download video' }))
        await waitFor(() => { expect(downloads).toHaveLength(1) })
        const download = downloads[0]
        if (!download) throw new Error('Page did not download a file')
        const exportedBlob = findAllocation(entry => entry.url === download.url).blob as Blob
        expect(await readBlobBytes(exportedBlob)).toEqual([1, 2, 3, 4])
        expect(exportedBlob).toBe(completedBlob)
        expect(download.filename).toBe('A_river.mp4')
        expect(fixtures.remux).not.toHaveBeenCalled()
        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(download.url)
        expect(archivedVideo).toHaveAttribute('src', completedUrl)
      } finally {
        unmount()
      }
    })

    /** History links come from Page's archive producer, and owned Blobs remain usable without another remux. */
    it('exports active history before live buffers even when remux is unavailable', async () => {
      const user = userEvent.setup()
      const { container, unmount } = render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      try {
        await completeOriginal(user)
        await submitRewrite(user, 'A meadow at dawn')
        beginRewriteRollout('Meadow')
        sendSegment(1, 'Meadow-1', [5, 6])
        sendSegment(2, 'Meadow-2', [7, 8])
        serverSocket(0).send(JSON.stringify({ type: 'ltx2_stream_complete' }))
        serverSocket(0).send(JSON.stringify({ type: 'generation_round_status', auto_extension_enabled: false, status: 'idle' }))
        await waitFor(() => { expect(archivedClips()).toHaveLength(2) })
        const historyClip = archivedClip(1)
        const playbackUrl = findAllocation(entry => entry.blob === historyClip.blob).url
        // A second user edit observes the real one-second submission cooldown.
        await new Promise(resolve => setTimeout(resolve, 1000))
        await bufferForestRewrite(user)
        await user.click(screen.getByText('A meadow at dawn'))
        const archivedVideo = container.querySelector<HTMLVideoElement>('video[preload="auto"]')
        await waitFor(() => expect(archivedVideo).toHaveAttribute('src', playbackUrl))
        expect(archivedVideo).toBeVisible()
        fixtures.remux.mockClear().mockRejectedValue(new Error('Remux unavailable'))
        const download = await downloadActiveClip(user)
        expect(download.blob).toBe(historyClip.blob)
        expect(await readBlobBytes(download.blob)).toEqual([5, 6, 7, 8])
        expect(download.filename).toBe('A_meadow_at_dawn.mp4')
        expect(fixtures.remux).not.toHaveBeenCalled()
        expect(archivedVideo).toHaveAttribute('src', playbackUrl)
      } finally {
        unmount()
      }
    })

    /** Selecting history preserves live bytes while another generation-changing action remains blocked. */
    it('exports Current live bytes while generation blocks another edit', async () => {
      const user = userEvent.setup()
      const { container, unmount } = render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      try {
        const { completedUrl } = await completeOriginal(user)
        await bufferForestRewrite(user)
        await user.click(screen.getByText('Original'))
        const archivedVideo = container.querySelector<HTMLVideoElement>('video[preload="auto"]')
        await waitFor(() => expect(archivedVideo).toHaveAttribute('src', completedUrl))
        await user.click(screen.getByText('A forest in rain'))
        expect(container.querySelector('video:not([preload])')).toBeVisible()
        expect(archivedVideo).toHaveClass('hidden')
        expect(container.querySelector('video:not([preload])')?.parentElement).toHaveClass('contents')
        const prompt = screen.getByRole('textbox', { name: 'Continuation prompt' })
        expect(prompt).toBeDisabled()
        fireEvent.change(prompt, { target: { value: 'A snowy mountain' } })
        fireEvent.keyDown(prompt, { key: 'Enter' })
        expect(outbound[0]).toHaveLength(2)
        fixtures.remux.mockClear()
        const download = await downloadActiveClip(user)
        expect(await readBlobBytes(download.blob)).toEqual([8, 9])
        expect(download.filename).toBe('A_forest_in_rain.mp4')
        expect(fixtures.remux).toHaveBeenCalledOnce()
        expect(archivedClips()).toHaveLength(1)
        expect(container.querySelector('video:not([preload])')).toBeVisible()
      } finally {
        unmount()
      }
    })

    /** Drained live buffers fall back to the completed Blob and its prompt during a pending edit. */
    it('exports the latest completed clip when a pending edit has no media', async () => {
      const user = userEvent.setup()
      const { container, unmount } = render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      try {
        const { completedBlob } = await completeOriginal(user)
        await submitRewrite(user, 'A snowy mountain')
        expect(container.querySelector('video:not([preload])')).toBeVisible()
        fixtures.remux.mockClear().mockRejectedValue(new Error('Remux unavailable'))
        const download = await downloadActiveClip(user)
        expect(download.blob).toBe(completedBlob)
        expect(await readBlobBytes(download.blob)).toEqual([1, 2, 3, 4])
        expect(download.filename).toBe('A_river.mp4')
        expect(fixtures.remux).not.toHaveBeenCalled()
        expect(archivedClips()).toHaveLength(1)
      } finally {
        unmount()
      }
    })

    /** Failed live remuxing must not silently export an older completed clip. */
    it('exports nothing when live media cannot be remuxed', async () => {
      const user = userEvent.setup()
      const { container, unmount } = render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      try {
        await completeOriginal(user)
        await bufferForestRewrite(user)
        const playbackAllocations = [...allocations]
        const failure = new Error('Remux unavailable')
        fixtures.remux.mockClear().mockRejectedValue(failure)
        await user.click(screen.getByRole('button', { name: 'Download video' }))
        await waitFor(() => {
          expect(console.warn).toHaveBeenCalledWith(
            'Unable to remux archived segments:', expect.objectContaining({ error: failure, fallbackError: failure }),
          )
        })
        expect(fixtures.remux).toHaveBeenCalledTimes(2)
        expect(downloads).toHaveLength(0)
        expect(allocations).toEqual(playbackAllocations)
        expect(revokeObjectURL).not.toHaveBeenCalled()
        expect(container.querySelector('video:not([preload])')).toBeVisible()
      } finally {
        unmount()
      }
    })

    /** One native share owns an active export until it settles, after which another click is accepted. */
    it('allows only one active share at a time and releases the guard afterward', async () => {
      const shareDescriptor = Object.getOwnPropertyDescriptor(navigator, 'share')
      const canShareDescriptor = Object.getOwnPropertyDescriptor(navigator, 'canShare')
      let finishShare = () => {}
      const sharing = new Promise<void>((resolve) => { finishShare = resolve })
      const share = vi.fn<Navigator['share']>().mockResolvedValue().mockReturnValueOnce(sharing)
      Object.defineProperty(navigator, 'share', { configurable: true, value: share })
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: vi.fn(() => true) })
      const matchMedia = window.matchMedia.bind(window)
      vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
        const list = matchMedia(query)
        return Object.assign(list, { matches: query === '(pointer: coarse)' || list.matches })
      })
      const user = userEvent.setup()
      const { unmount } = render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      try {
        await completeOriginal(user)
        fixtures.remux.mockClear()
        const playbackAllocations = [...allocations]
        await user.click(screen.getByRole('button', { name: 'Share video' }))
        await waitFor(() => { expect(share).toHaveBeenCalledOnce() })
        await user.click(screen.getByRole('button', { name: 'Share video' }))
        expect(share).toHaveBeenCalledOnce()
        const file = share.mock.calls[0]?.[0]?.files?.[0]
        if (!file) throw new Error('Page did not share a file')
        expect(file.name).toBe('A_river.mp4')
        expect(file.type).toBe('video/mp4')
        expect(await readBlobBytes(file)).toEqual([1, 2, 3, 4])
        await act(async () => { finishShare() })
        await user.click(screen.getByRole('button', { name: 'Share video' }))
        await waitFor(() => { expect(share).toHaveBeenCalledTimes(2) })
        const secondFile = share.mock.calls[1]?.[0]?.files?.[0]
        if (!secondFile) throw new Error('Page did not share a second file')
        expect(secondFile.name).toBe('A_river.mp4')
        expect(await readBlobBytes(secondFile)).toEqual([1, 2, 3, 4])
        expect(downloads).toHaveLength(0)
        expect(fixtures.remux).not.toHaveBeenCalled()
        expect(allocations).toEqual(playbackAllocations)
        expect(revokeObjectURL).not.toHaveBeenCalled()
      } finally {
        await act(async () => { finishShare() })
        unmount()
        if (shareDescriptor) Object.defineProperty(navigator, 'share', shareDescriptor)
        else Reflect.deleteProperty(navigator, 'share')
        if (canShareDescriptor) Object.defineProperty(navigator, 'canShare', canShareDescriptor)
        else Reflect.deleteProperty(navigator, 'canShare')
      }
    })
  })
})
