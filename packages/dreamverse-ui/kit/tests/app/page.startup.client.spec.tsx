/** @vitest-environment jsdom */
/**
 * Ports FastVideo DreamVerse src/app/page.startup.test.tsx: capability loading and failure gates and backend readiness
 * notices before any project socket opens.
 */
import '../support/setup.client.ts'
import { assetUploadPolicy } from '../support/assetFixtures.client.ts'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Server } from 'mock-socket'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

const projectsMockState = vi.hoisted(() => ({
  listProjects: vi.fn(async () => []),
  getProject: vi.fn(),
  deleteProject: vi.fn(async () => {}),
  fetchSegmentVideo: vi.fn(),
  reset() {
    this.listProjects.mockClear()
    this.getProject.mockReset()
    this.deleteProject.mockClear()
    this.fetchSegmentVideo.mockReset()
  },
}))

vi.mock('@dreamverse/project-controller/client/storyPresetsData.ts', () => ({
  default: [
    {
      id: 'test_preset',
      label: 'Test Preset',
      segment_prompts: ['segment one', 'segment two'],
    },
  ],
}))

vi.mock('@dreamverse/project-controller/client/projects.ts', async importOriginal => ({
  ProjectRequestError: (await importOriginal<typeof import('@dreamverse/project-controller/client/projects.ts')>()).ProjectRequestError,
  listProjects: projectsMockState.listProjects,
  getProject: projectsMockState.getProject,
  deleteProject: projectsMockState.deleteProject,
  fetchSegmentVideo: projectsMockState.fetchSegmentVideo,
}))

vi.mock('../../src/client/media/avPipeline.ts', () => ({
  DEFAULT_AV_MIME: 'video/mp4',
  createAvPipeline: vi.fn(() => ({
    reset() {},
    enqueueChunk() {},
    ensurePipeline: async () => {},
    stopPlayback: vi.fn(),
    maybeStartPlayback() {},
    tryEndStream() {},
    setStreamCompleted() {},
    noteSegmentInit() {},
    noteSegmentComplete() {},
    hasArchivedChunks() {
      return false
    },
    buildArchivedStreamChunks() {
      return []
    },
    buildArchivedSegmentSnapshots() {
      return []
    },
    buildArchivedStreamBlob() {
      return new Blob([], { type: 'video/mp4' })
    },
    takeArchivedStreamChunks() {
      return []
    },
    takeArchivedSegmentSnapshots() {
      return []
    },
    usesNativePlaybackFallback() {
      return false
    },
  })),
}))

import { DreamverseApp } from '../../src/client/app/DreamverseApp.tsx'
import { englishKitT, renderDreamverseSlot } from '../support/renderDreamverseSlot.client.tsx'

const modelCapabilities = {
  generation_modes: ['t2va', 'i2v'], aspect_ratios: ['16:9'], resolutions: ['720p'], min_segment_duration_sec: 5, max_segment_duration_sec: 15, segment_counts: [1, 2, 3, 4, 5, 6],
  unsupported_generation_modes: { fl2va: 'First/last frame generation is unsupported.' },
  reference_inputs: { media_types: ['image'], max_count: 1, conditioning: 'first_frame' },
  asset_upload: assetUploadPolicy,
}
const capabilities = { model_ids: ['fast-h3'], models: { 'fast-h3': modelCapabilities }, ...modelCapabilities }
const unavailableNotice = 'Model capabilities are unavailable. Reload the page after the backend is available.'

describe('Page startup readiness UX', () => {
  let fetchMock: Mock<(input: RequestInfo | URL) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>>
  let capabilityResponse: () => Promise<Response>
  let server: Server
  let outbound: unknown[][]
  let pendingResponses: (() => void)[]
  let storageSnapshot: [string, string][]
  let previousLocation: string

  /** Own browser persistence, response gates, and a complete in-process socket if admission unexpectedly occurs. */
  beforeEach(() => {
    projectsMockState.reset()
    storageSnapshot = Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index)
      const value = key === null ? null : localStorage.getItem(key)
      if (key === null || value === null) throw new Error(`localStorage entry ${index} changed during the snapshot`)
      return [key, value]
    })
    localStorage.clear()
    previousLocation = window.location.pathname + window.location.search + window.location.hash
    window.history.pushState({}, '', '/')
    pendingResponses = []
    outbound = []
    server = new Server(`ws://${window.location.host}/ws`)
    server.on('connection', (socket) => {
      const messages: unknown[] = []
      outbound.push(messages)
      socket.on('message', raw => messages.push(JSON.parse(raw as string)))
    })
    capabilityResponse = async () => new Response(JSON.stringify(capabilities))
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/creation-capabilities')) return capabilityResponse()
      if (url.endsWith('/healthz')) return new Response(JSON.stringify({ status: 'ok' }))
      if (url.endsWith('/readyz')) return new Response(JSON.stringify({ status: 'ready', ready_gpu_workers: 1 }))
      throw new Error(`Unexpected startup request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  /** Unmount consumers before settling abandoned fetches, then restore every browser fixture. */
  afterEach(async () => {
    cleanup()
    await act(async () => { pendingResponses.forEach((resolve) => { resolve() }) })
    server.stop()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    localStorage.clear()
    storageSnapshot.forEach(([key, value]) => { localStorage.setItem(key, value) })
    window.history.replaceState({}, '', previousLocation)
  })

  /** Delay the actual fetch promise and settle it after unmount if an assertion exits early. */
  function holdCapabilities() {
    const { promise, resolve, reject } = Promise.withResolvers<Response>()
    pendingResponses.push(() => { resolve(new Response(JSON.stringify(capabilities))) })
    capabilityResponse = () => promise
    return { resolve, reject }
  }

  /** Accept capabilities before exercising an unreachable health endpoint. */
  it('shows a clear notice when the backend is not reachable before project start', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (input === '/creation-capabilities') return capabilityResponse()
      throw new Error('connect ECONNREFUSED')
    })

    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)
    await screen.findByText('FastH3')

    const promptInput = screen.getByRole('textbox', { name: 'Initial prompt' })
    await user.type(promptInput, 'A fox surfing through neon rain')
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    expect(
      await screen.findByText(
        'Dreamverse backend is not reachable. From the checkout root, run PYTHONPATH="$(pwd)/apps/dreamverse:$(pwd)${PYTHONPATH:+:$PYTHONPATH}" python -m dreamverse.server_entry --preset fast-ltx23 and wait for /readyz to return 200 before retrying.',
      ),
    ).toBeInTheDocument()
    expect(promptInput).toHaveValue('A fox surfing through neon rain')
  })

  /** Worker warmup failure retains the draft and blocks socket creation after capabilities are accepted. */
  it('shows a readiness notice when GPU workers are not ready yet', async () => {
    const webSocketConstructor = vi.fn()
    vi.stubGlobal('WebSocket', webSocketConstructor)
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

      if (url.endsWith('/creation-capabilities')) return capabilityResponse()

      if (url.endsWith('/healthz')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok', service: 'ltx2-streaming-backend' }),
        }
      }

      if (url.endsWith('/readyz')) {
        return {
          ok: false,
          status: 503,
          json: async () => ({
            detail: 'No ready GPU worker processes.',
          }),
        }
      }

      if (url.endsWith('/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_gpus: 1,
            available_gpus: 0,
            queue_size: 0,
            warmup_enabled: true,
            warmup_successful_gpus: 0,
            warmup_failed_gpus: 0,
          }),
        }
      }

      throw new Error(`Unhandled fetch request in test: ${url}`)
    })

    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)
    await screen.findByText('FastH3')

    const promptInput = screen.getByRole('textbox', { name: 'Initial prompt' })
    await user.type(promptInput, 'A fox surfing through neon rain')
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    expect(
      await screen.findByText(
        'Dreamverse backend is running, but GPU workers are not ready yet. Wait for startup warmup to finish and retry.',
      ),
    ).toBeInTheDocument()
    expect(promptInput).toHaveValue('A fox surfing through neon rain')
    expect(webSocketConstructor).not.toHaveBeenCalled()
  })

  /** Loading preserves prompt edits but blocks every lobby generation producer. */
  it('preserves editable drafts while capability loading blocks Generate, Enter, and presets', async () => {
    const response = holdCapabilities()
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)
    expect(await screen.findByText('Loading model capabilities…')).toBeVisible()
    const prompt = screen.getByRole('textbox', { name: 'Initial prompt' })
    await user.type(prompt, 'A retained river')
    expect(screen.queryByLabelText('Add reference images')).not.toBeInTheDocument()
    expect(screen.queryByText('FastH3')).not.toBeInTheDocument()
    expect(screen.queryByText('FastLTX 2.3')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Test Preset/ })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await user.click(prompt)
    await user.keyboard('{Enter}')
    await user.click(screen.getByRole('button', { name: /Test Preset/ }))
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/creation-capabilities'])
    expect(outbound).toEqual([])
    expect(prompt).toHaveValue('A retained river')
    await act(async () => { response.resolve(new Response(JSON.stringify(capabilities))) })
    expect(screen.getByText('FastH3')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'FastH3' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
    expect(prompt).toHaveValue('A retained river')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(outbound).toEqual([])
  })

  /** Each failure boundary retains user drafts and never delegates admission to readiness or WebSocket code. */
  it.each(['HTTP', 'network', 'JSON', 'record'] as const)(
    'blocks admission after capability %s failure', async (failure) => {
      capabilityResponse = async () => {
        if (failure === 'network') throw new Error('Capability connection failed')
        if (failure === 'HTTP') return new Response('{}', { status: 503 })
        if (failure === 'JSON') return new Response('{')
        return new Response(JSON.stringify({ status: 'ready' }))
      }
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)
      expect(await screen.findByText(unavailableNotice)).toBeVisible()
      const prompt = screen.getByRole('textbox', { name: 'Initial prompt' })
      await user.type(prompt, 'Keep this draft')
      expect(screen.queryByLabelText('Add reference images')).not.toBeInTheDocument()
      expect(prompt).toBeEnabled()
      expect(screen.queryByText('FastH3')).not.toBeInTheDocument()
      expect(screen.queryByText('FastLTX 2.3')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
      expect(screen.getByRole('button', { name: /Test Preset/ })).toBeDisabled()
      await user.click(screen.getByRole('button', { name: 'Generate' }))
      await user.click(prompt)
      await user.keyboard('{Enter}')
      await user.click(screen.getByRole('button', { name: /Test Preset/ }))
      expect(prompt).toHaveValue('Keep this draft')
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/creation-capabilities'])
      expect(outbound).toEqual([])
    },
  )

  /** A departed Page observes either fetch outcome while the independently mounted Page keeps its own draft. */
  it.each(['success', 'failure'] as const)('settles late capability %s after unmount', async (outcome) => {
    const response = holdCapabilities()
    const first = render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)
    await screen.findByText('Loading model capabilities…')
    first.unmount()
    capabilityResponse = async () => new Response(JSON.stringify(capabilities))
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)
    await screen.findByText('FastH3')
    const prompt = screen.getByRole('textbox', { name: 'Initial prompt' })
    await user.type(prompt, 'Replacement draft')
    await act(async () => {
      if (outcome === 'success') response.resolve(new Response(JSON.stringify({
        model_ids: ['fast-ltx23'], models: { 'fast-ltx23': modelCapabilities }, ...modelCapabilities,
      })))
      else response.reject(new Error('Departed capability request failed'))
    })
    expect(screen.getByText('FastH3')).toBeVisible()
    expect(screen.queryByText('FastLTX 2.3')).not.toBeInTheDocument()
    expect(screen.queryByText(unavailableNotice)).not.toBeInTheDocument()
    expect(prompt).toHaveValue('Replacement draft')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/creation-capabilities', '/creation-capabilities'])
    expect(outbound).toEqual([])
  })

  /** Reload recovery consists of a fresh mount and one request, with no implicit retry on a failed mount. */
  it('loads capabilities on a fresh mount after failure', async () => {
    capabilityResponse = async () => new Response('{}', { status: 503 })
    const first = render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)
    await screen.findByText(unavailableNotice)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    first.unmount()
    capabilityResponse = async () => new Response(JSON.stringify(capabilities))
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)
    await waitFor(() => expect(screen.getByText('FastH3')).toBeVisible())
    expect(screen.queryByText(unavailableNotice)).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/creation-capabilities', '/creation-capabilities'])
    expect(outbound).toEqual([])
  })
})
