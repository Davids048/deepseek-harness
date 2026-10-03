/** @vitest-environment jsdom */
/**
 * Harness-owned projects in the page: the project history lists `GET /projects`, selecting a project rebuilds its
 * stored rounds and attaches it with `project_open_v1`, Reconnect reopens a disconnected project by its harness ID,
 * and deletion shows the harness's refusal.
 */
import '../support/setup.client.ts'
import { assetUploadPolicy } from '../support/assetFixtures.client.ts'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Server, type Client } from 'mock-socket'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectId, SegmentId } from '@dreamverse/project-controller/client/ids.ts'
import type { ProjectDetail, ProjectSummary } from '@dreamverse/project-controller/client/projects.ts'
import type { remuxArchivedFmp4Segments } from '../../src/client/media/fmp4Remux.ts'

const fixtures = vi.hoisted(() => ({
  summaries: [] as ProjectSummary[],
  details: new Map<string, ProjectDetail>(),
  videos: new Map<string, number[]>(),
  getProject: vi.fn<(projectId: string) => Promise<ProjectDetail>>(),
  deleteProject: vi.fn<(projectId: string) => Promise<void>>(),
  remux: vi.fn<typeof remuxArchivedFmp4Segments>(),
}))

vi.mock('@dreamverse/project-controller/client/storyPresetsData.ts', () => ({
  default: [{ id: 'test_preset', label: 'Test Preset', segment_prompts: ['A river', 'A waterfall'] }],
}))
vi.mock('@dreamverse/project-controller/client/projects.ts', async importOriginal => ({
  ProjectRequestError: (await importOriginal<typeof import('@dreamverse/project-controller/client/projects.ts')>()).ProjectRequestError,
  listProjects: async () => [...fixtures.summaries],
  getProject: fixtures.getProject,
  deleteProject: fixtures.deleteProject,
  fetchSegmentVideo: async (videoUrl: string) => {
    const bytes = fixtures.videos.get(videoUrl)
    if (!bytes) throw new Error(`No stored video at ${videoUrl}`)
    return new Uint8Array(bytes).buffer
  },
}))
vi.mock('../../src/client/media/fmp4Remux.ts', () => ({ remuxArchivedFmp4Segments: fixtures.remux }))
/** The page's live pipeline needs no browser media support for these cases. */
vi.mock('../../src/client/media/avPipeline.ts', () => ({
  DEFAULT_AV_MIME: 'video/mp4',
  createAvPipeline: () => ({
    reset() {},
    enqueueChunk() {},
    ensurePipeline: async () => {},
    stopPlayback: vi.fn(),
    maybeStartPlayback() {},
    tryEndStream() {},
    setStreamCompleted() {},
    noteSegmentInit() {},
    noteSegmentComplete() {},
    hasArchivedChunks: () => false,
    takeArchivedStreamChunks: () => [],
    takeArchivedSegmentSnapshots: () => [],
    usesNativePlaybackFallback: () => false,
  }),
}))

import { DreamverseApp } from '../../src/client/app/DreamverseApp.tsx'
import { englishKitT, renderDreamverseSlot } from '../support/renderDreamverseSlot.client.tsx'

const creationConfig = {
  model_id: 'fast-h3', generation_mode: 't2va', aspect_ratio: '16:9', resolution: '720p', segment_count: 2, segment_duration_sec: 5,
}

/** A stored project with one completed two-segment round whose videos hold the given bytes. */
function storeProject(id: string, title: string, bytes: [number[], number[]]): ProjectSummary {
  const projectId = brandString<ProjectId>(id)
  const segments = bytes.map((segmentBytes, index) => {
    const segmentId = brandString<SegmentId>(`${projectId}-s${index + 1}`)
    const videoUrl = `/projects/${projectId}/segments/${segmentId}/video`
    fixtures.videos.set(videoUrl, segmentBytes)
    return {
      segment_id: segmentId, prompt: index === 0 ? 'A river' : 'A waterfall', mime: 'video/mp4',
      video_url: videoUrl, frame_url: `/projects/${projectId}/segments/${segmentId}/frame`,
    }
  })
  fixtures.details.set(projectId, {
    project_id: projectId, title, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:05:00Z', open: false,
    creation_config: creationConfig, rounds: [{ round_index: 0, instruction: null, segments }],
  })
  return {
    project_id: projectId, title, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:05:00Z',
    thumbnail_url: segments[1]?.frame_url ?? null,
  }
}

function readBlobBytes(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve([...new Uint8Array(reader.result as ArrayBuffer)]) }
    reader.onerror = () => { reject(reader.error ?? new Error('FileReader failed without an error')) }
    reader.readAsArrayBuffer(blob)
  })
}

describe('Harness-owned projects', () => {
  let server: Server
  let sockets: Client[]
  let outbound: Record<string, unknown>[][]
  let allocations: { blob: Blob | MediaSource; url: string }[]

  /** Serve capabilities and readiness, record socket traffic, and name each object URL that Page allocates. */
  beforeEach(() => {
    fixtures.summaries = []
    fixtures.details.clear()
    fixtures.videos.clear()
    fixtures.getProject.mockReset().mockImplementation(async (projectId) => {
      const project = fixtures.details.get(projectId)
      if (!project) throw new Error('Project not found.')
      return project
    })
    fixtures.deleteProject.mockReset().mockImplementation(async (projectId) => {
      fixtures.summaries = fixtures.summaries.filter(project => project.project_id !== projectId)
    })
    fixtures.remux.mockReset().mockImplementation(async segments =>
      new Blob(segments.flatMap(segment => segment.chunks), { type: 'video/mp4' }),
    )
    sockets = []
    outbound = []
    allocations = []
    window.history.pushState({}, '', '/')
    server = new Server(`ws://${window.location.host}/ws`)
    server.on('connection', (socket) => {
      const messages: Record<string, unknown>[] = []
      sockets.push(socket)
      outbound.push(messages)
      socket.on('message', raw => messages.push(JSON.parse(raw as string) as Record<string, unknown>))
    })
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      const url = `blob:project-open-${allocations.length + 1}`
      allocations.push({ blob, url })
      return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
    })
    const modelCapabilities = {
      generation_modes: ['t2va'], aspect_ratios: ['16:9'], resolutions: ['720p'], min_segment_duration_sec: 5, max_segment_duration_sec: 15, segment_counts: [1, 2, 3, 4, 5, 6],
      unsupported_generation_modes: { fl2va: 'First/last frame generation is unsupported.' },
      reference_inputs: { media_types: ['image'], max_count: 1, conditioning: 'first_frame' },
      asset_upload: assetUploadPolicy,
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/creation-capabilities')) {
        return new Response(JSON.stringify({ model_ids: ['fast-h3'], models: { 'fast-h3': modelCapabilities }, ...modelCapabilities }))
      }
      if (url.endsWith('/healthz')) return new Response(JSON.stringify({ status: 'ok' }))
      if (url.endsWith('/readyz')) return new Response(JSON.stringify({ status: 'ready', ready_gpu_workers: 1 }))
      throw new Error(`Unexpected request in project open test: ${url}`)
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    server.stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Return the parsed messages that Page sent on one accepted project WebSocket. */
  function sentMessages(index: number): Record<string, unknown>[] {
    const messages = outbound[index]
    if (!messages) throw new Error(`Page has not connected project socket ${index}`)
    return messages
  }

  /** Return the server side of one accepted project WebSocket. */
  function serverSocket(index: number): Client {
    const socket = sockets[index]
    if (!socket) throw new Error(`Page has not connected project socket ${index}`)
    return socket
  }

  /** Open the project history and select one listed project. */
  async function selectListedProject(user: ReturnType<typeof userEvent.setup>, title: RegExp) {
    await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    const sidebar = screen.getByRole('complementary', { name: 'Project history' })
    await user.click(await within(sidebar).findByRole('button', { name: title }))
  }

  /** Accept an open the way the harness does: assign the project, then report an idle round. */
  function acceptOpen(index: number, projectId: string) {
    serverSocket(index).send(JSON.stringify({ type: 'gpu_assigned', project_id: projectId, creation_config: creationConfig }))
    serverSocket(index).send(JSON.stringify({ type: 'generation_round_status', status: 'idle', auto_extension_enabled: false }))
  }

  it('rebuilds a listed project from its stored segments and attaches it with project_open_v1', async () => {
    fixtures.summaries = [storeProject('p-river', 'River story', [[1, 2], [3, 4]])]
    const user = userEvent.setup()
    const { container } = render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)
    await screen.findByText('FastH3')
    await selectListedProject(user, /River story/)
    await waitFor(() => { expect(sentMessages(0)).toEqual([{ type: 'project_open_v1', project_id: 'p-river' }]) })
    expect(fixtures.getProject).toHaveBeenCalledExactlyOnceWith('p-river')
    expect(fixtures.remux.mock.calls[0]?.[0].map(segment => ({
      streamId: segment.streamId, bytes: segment.chunks.flatMap(chunk => [...new Uint8Array(chunk)]),
    }))).toEqual([{ streamId: 'p-river-s1', bytes: [1, 2] }, { streamId: 'p-river-s2', bytes: [3, 4] }])
    const clip = allocations.find(({ blob }) => blob instanceof Blob && blob.type === 'video/mp4')
    if (!clip || !(clip.blob instanceof Blob)) throw new Error('Page did not archive the stored round')
    expect(await readBlobBytes(clip.blob)).toEqual([1, 2, 3, 4])
    expect(container.querySelector('video[preload="auto"]')).toHaveAttribute('src', clip.url)
    acceptOpen(0, 'p-river')
    const prompt = screen.getByRole('textbox', { name: 'Continuation prompt' })
    await waitFor(() => expect(prompt).toBeEnabled())
    await user.type(prompt, 'The river freezes')
    await user.click(screen.getByRole('button', { name: 'Rewrite rollout' }))
    await waitFor(() => {
      expect(sentMessages(0)[1]).toMatchObject({
        type: 'rewrite_seed_prompts', rewrite_instruction: 'The river freezes', prompt_window_prompts: ['A river', 'A waterfall'],
      })
    })
    await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    const sidebar = screen.getByRole('complementary', { name: 'Project history' })
    expect(within(sidebar).getByText('Current').parentElement).toHaveTextContent('River story')
    expect(within(sidebar).queryByText('Previous')).not.toBeInTheDocument()
  })

  it('reopens a disconnected project by the harness ID that gpu_assigned gave it', async () => {
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)
    await user.type(await screen.findByLabelText('Initial prompt'), 'A river')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => { expect(sentMessages(0)[0]).toMatchObject({ type: 'project_init_v1' }) })
    serverSocket(0).send(JSON.stringify({ type: 'gpu_assigned', project_id: 'p-new', creation_config: creationConfig }))
    storeProject('p-new', 'A river', [[5], [6]])
    await act(async () => {
      serverSocket(0).send(JSON.stringify({ type: 'error', message: 'This project was opened in another window.' }))
      serverSocket(0).close()
    })
    expect(await screen.findByText('Project disconnected')).toBeVisible()
    expect(screen.getByText('This project was opened in another window.')).toBeVisible()
    expect(sockets).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => { expect(sentMessages(1)).toEqual([{ type: 'project_open_v1', project_id: 'p-new' }]) })
    expect(fixtures.getProject).toHaveBeenCalledExactlyOnceWith('p-new')
    acceptOpen(1, 'p-new')
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Continuation prompt' })).toBeEnabled())
    expect(screen.queryByText('Project disconnected')).not.toBeInTheDocument()
  })

  it('shows the harness reason for a refused deletion and returns to the lobby when an open fails', async () => {
    const openStory = storeProject('p-open', 'Open story', [[1], [2]])
    fixtures.summaries = [openStory, { ...openStory, project_id: brandString<ProjectId>('p-missing'), title: 'Missing story' }]
    fixtures.deleteProject.mockRejectedValueOnce(new Error('This project is open. Close it before deleting.'))
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)
    await screen.findByText('FastH3')
    await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    const sidebar = screen.getByRole('complementary', { name: 'Project history' })
    const openRow = await within(sidebar).findByRole('button', { name: /Open story/ })
    await user.click(within(openRow).getByRole('button', { name: 'Delete project' }))
    await user.click(within(openRow).getByRole('button', { name: 'Confirm delete project' }))
    expect(await within(sidebar).findByRole('alert')).toHaveTextContent('This project is open. Close it before deleting.')
    expect(fixtures.deleteProject).toHaveBeenCalledExactlyOnceWith('p-open')
    expect(within(sidebar).getByRole('button', { name: /Open story/ })).toBeVisible()
    await user.click(within(sidebar).getByRole('button', { name: /Missing story/ }))
    expect(await screen.findByText('Project not found.')).toBeVisible()
    expect(screen.getByLabelText('Initial prompt')).toBeEnabled()
    expect(sockets).toHaveLength(0)
  })
})
