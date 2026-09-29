/** @vitest-environment jsdom */
/**
 * Ports FastVideo DreamVerse src/app/projectArchive.integration.test.tsx: saved project restoration, sidebar selection,
 * deletion, URL ownership, and saved clip export.
 */
import '../support/setup.client.ts'
import { assetUploadPolicy } from '../support/assetFixtures.client.ts'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Server } from 'mock-socket'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import type { StoredClip, StoredProject } from '@dreamverse/project-controller/client/projectStorage.ts'

const storage = vi.hoisted(() => ({
  listProjects: vi.fn<() => Promise<StoredProject[]>>(),
  loadProjectClips: vi.fn<(projectId: string) => Promise<StoredClip[]>>(),
  deleteProject: vi.fn<(projectId: string) => Promise<void>>(),
  saveProject: vi.fn<() => Promise<void>>(),
  saveProjectMetadata: vi.fn<() => Promise<void>>(),
  pruneOldProjects: vi.fn<() => Promise<void>>(),
}))

vi.mock('@dreamverse/project-controller/client/projectStorage.ts', () => storage)
vi.mock('@dreamverse/project-controller/client/storyPresetsData.ts', () => ({
  default: [{ id: 'test_preset', label: 'Test Preset', segment_prompts: ['A river', 'A waterfall'] }],
}))

/** Archive viewing needs mounted video elements but no generated media or remux work. */
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
import { renderDreamverseSlot } from '../support/renderDreamverseSlot.client.tsx'

type BrowserUser = ReturnType<typeof userEvent.setup>
type StoredClipTriple = [StoredClip, StoredClip, StoredClip]
const markerKey = 'fastvideo-active-project'

/** Supply consistent stored history links without depending on the live save producer. */
function makeProject(id: string, createdAt: number): StoredProject {
  return {
    id,
    label: `Archive ${id}`,
    originalLabel: `Original ${id}`,
    presetId: 'test_preset',
    createdAt,
    lastThumbnail: null,
    promptEvents: [
      { promptId: `${id}-current`, status: 'consumed', source: 'user_rewrite', text: `Current edit ${id}`, clipId: `${id}-3` },
      { promptId: `${id}-middle`, status: 'consumed', source: 'user_rewrite', text: `Earlier edit ${id}`, clipId: `${id}-2` },
    ],
  }
}

/** Storage supplies clips in creation order, independently of project-list ordering. */
function makeClips(projectId: string): StoredClip[] {
  return [1, 2, 3].map(number => ({
    id: `${projectId}-${number}`,
    projectId,
    label: `Clip ${projectId}-${number}`,
    prompt: `Prompt ${projectId}-${number}`,
    mime: 'video/mp4',
    blob: new Blob([`video:${projectId}:${number}`], { type: 'video/mp4' }),
    createdAt: number,
  }))
}

function isStoredClipTriple(clips: StoredClip[]): clips is StoredClipTriple {
  return clips.length === 3
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('Saved project restoration and selection', () => {
  let server: Server
  let outbound: Record<string, unknown>[][]
  let projects: StoredProject[]
  let projectA: StoredProject
  let projectB: StoredProject
  let clipsByProject: Map<string, StoredClip[]>
  let allocations: { blob: Blob | MediaSource; url: string }[]
  let rescuePendingReads: (() => void)[]
  let localStorageSnapshot: [string, string][]
  let previousLocation: string
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined
  let readinessResponse: () => Promise<Response>
  let capabilityResponse: () => Promise<Response>
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
  let revokeObjectURL: MockInstance<(url: string) => void>

  /** Control a storage/readiness boundary and ensure a failed assertion cannot leave its promise pending. */
  function deferred<T>(cleanupValue: T) {
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    rescuePendingReads.push(() => { resolve(cleanupValue) })
    return { promise, resolve, reject }
  }

  function deleteStoredProject(projectId: string) {
    projects = projects.filter(project => project.id !== projectId)
    clipsByProject.delete(projectId)
  }

  /** Read the three clips that `makeClips` stored for a project, keeping the stored array identity. */
  function storedClips(projectId: string): StoredClipTriple {
    const clips = clipsByProject.get(projectId)
    if (!clips || !isStoredClipTriple(clips)) throw new Error(`Expected three stored clips for project ${projectId}`)
    return clips
  }

  /** Isolate browser persistence and provide supported creation metadata before any user action. */
  beforeEach(() => {
    localStorageSnapshot = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .flatMap((key): [string, string][] => {
        const value = key === null ? null : localStorage.getItem(key)
        return key === null || value === null ? [] : [[key, value]]
      })
    localStorage.clear()
    previousLocation = window.location.pathname + window.location.search + window.location.hash
    window.history.pushState({}, '', '/')
    projectA = makeProject('A', 10)
    projectB = makeProject('B', 20)
    projects = [projectB, projectA]
    clipsByProject = new Map([[projectA.id, makeClips(projectA.id)], [projectB.id, makeClips(projectB.id)]])
    rescuePendingReads = []
    allocations = []
    storage.listProjects.mockReset().mockImplementation(async () => [...projects])
    storage.loadProjectClips.mockReset().mockImplementation(async id => [...(clipsByProject.get(id) ?? [])])
    storage.deleteProject.mockReset().mockImplementation(async (id) => { deleteStoredProject(id) })
    storage.saveProject.mockReset().mockResolvedValue()
    storage.saveProjectMetadata.mockReset().mockResolvedValue()
    storage.pruneOldProjects.mockReset().mockResolvedValue()
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      const url = `blob:archive-test-${allocations.length + 1}`
      allocations.push({ blob, url })
      return url
    })
    revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    // Workspace's real history cards use browser APIs absent from jsdom.
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
    capabilityResponse = async () => jsonResponse({
      model_ids: ['fast-h3'], models: { 'fast-h3': modelCapabilities }, ...modelCapabilities,
    })
    readinessResponse = async () => jsonResponse({ status: 'ready', ready_gpu_workers: 1 })
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/creation-capabilities')) {
        return capabilityResponse()
      }
      if (url.endsWith('/healthz')) return jsonResponse({ status: 'ok' })
      if (url.endsWith('/readyz')) return readinessResponse()
      if (url.endsWith('/status')) return jsonResponse({ total_gpus: 1, warmup_failed_gpus: 0 })
      if (url.endsWith('/curated-presets')) {
        return jsonResponse({ presets: [{ id: 'test_preset', label: 'Test Preset', segment_prompts: ['A river'] }] })
      }
      if (url.endsWith('/lora/options')) return jsonResponse({ has_base_lora: false, styles: [], labels: {} })
      throw new Error(`Unexpected request in archive test: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    outbound = []
    server = new Server(`ws://${window.location.host}/ws`)
    server.on('connection', (socket) => {
      const messages: Record<string, unknown>[] = []
      outbound.push(messages)
      socket.on('message', wire => messages.push(JSON.parse(wire as string) as Record<string, unknown>))
    })
  })

  /** Unmount while spies still observe cleanup, then restore every browser fixture. */
  afterEach(async () => {
    cleanup()
    await act(async () => { rescuePendingReads.forEach((resolve) => { resolve() }) })
    server.stop()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    }
    localStorage.clear()
    localStorageSnapshot.forEach(([key, value]) => { localStorage.setItem(key, value) })
    window.history.pushState({}, '', previousLocation)
  })

  async function openSidebar(user: BrowserUser) {
    const sidebar = screen.getByRole('complementary', { name: 'Project history' })
    if (!sidebar.classList.contains('translate-x-0')) {
      await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    }
    return sidebar
  }

  async function selectProject(user: BrowserUser, project: StoredProject) {
    const sidebar = await openSidebar(user)
    await user.click(within(sidebar).getByRole('button', { name: new RegExp(project.originalLabel) }))
  }

  function clipUrl(clip: StoredClip) {
    const allocation = allocations.findLast(entry => entry.blob === clip.blob)
    expect(allocation).toBeDefined()
    if (!allocation) throw new Error('Expected an object URL for the stored clip')
    return allocation.url
  }

  function viewedVideoSource() {
    return document.querySelector<HTMLVideoElement>('video[autoplay]')?.getAttribute('src') ?? null
  }

  async function expectViewedClip(clip: StoredClip) {
    await screen.findByText('View-only project')
    await waitFor(() => { expect(viewedVideoSource()).toBe(clipUrl(clip)) })
  }

  /** Start a supported live project through the actual lobby and WebSocket client. */
  async function startLiveProject(user: BrowserUser) {
    await screen.findByText('FastH3')
    await user.type(screen.getByRole('textbox', { name: 'Initial prompt' }), 'A live river')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => {
      expect(outbound[0]?.[0]).toMatchObject({
        type: 'project_init_v1', model_id: 'fast-h3', initial_rollout_prompt: 'A live river',
      })
    })
  }

  /** Capability settlement preserves saved-video ownership and the lobby drafts hidden beneath that view. */
  it.each(['success', 'failure'] as const)(
    'keeps archive navigation and drafts through capability %s',
    async (outcome) => {
      const acceptedResponse = capabilityResponse
      const response = deferred<Response>(jsonResponse({}, 503))
      capabilityResponse = () => response.promise
      const aClips = storedClips(projectA.id)
      const bClips = storedClips(projectB.id)
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('Loading model capabilities…')
      const prompt = screen.getByRole('textbox', { name: 'Initial prompt' })
      await user.type(prompt, 'Retained archive-side draft')
      expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
      await selectProject(user, projectA)
      await expectViewedClip(aClips[2])
      await selectProject(user, projectB)
      await expectViewedClip(bClips[2])
      const bUrls = bClips.map(clipUrl)
      const allocatedCount = allocations.length
      await act(async () => {
        response.resolve(outcome === 'success'
          ? await acceptedResponse() : jsonResponse({}, 503))
      })
      expect(viewedVideoSource()).toBe(bUrls[2])
      expect(screen.getByText('View-only project')).toBeVisible()
      expect(allocations).toHaveLength(allocatedCount)
      for (const url of bUrls) expect(revokeObjectURL).not.toHaveBeenCalledWith(url)
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/creation-capabilities'])
      expect(outbound).toHaveLength(0)
      await selectProject(user, projectA)
      await expectViewedClip(aClips[2])
      for (const url of bUrls) expect(revokeObjectURL).toHaveBeenCalledWith(url)
      await user.click(screen.getByRole('button', { name: 'Back' }))
      expect(screen.queryByText('View-only project')).not.toBeInTheDocument()
      expect(prompt).toBeVisible()
      expect(prompt).toHaveValue('Retained archive-side draft')
      if (outcome === 'success') {
        expect(screen.getByText('FastH3')).toBeVisible()
        expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
      } else {
        expect(screen.getByText(
          'Model capabilities are unavailable. Reload the page after the backend is available.',
        )).toBeVisible()
        expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
      }
      expect(outbound).toHaveLength(0)
      expect(storage.saveProject).not.toHaveBeenCalled()
    },
  )

  /** Startup must use the fetched marked record, even when another archive is newer. */
  it('restores the marked project from the startup list', async () => {
    const listing = deferred<StoredProject[]>([])
    const loading = deferred<StoredClip[]>([])
    const clips = storedClips(projectA.id)
    storage.listProjects.mockReturnValueOnce(listing.promise)
    storage.loadProjectClips.mockReturnValueOnce(loading.promise)
    localStorage.setItem(markerKey, projectA.id)
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await waitFor(() => { expect(storage.listProjects).toHaveBeenCalledOnce() })
    await act(async () => { listing.resolve([...projects]) })
    await waitFor(() => { expect(storage.loadProjectClips).toHaveBeenCalledExactlyOnceWith(projectA.id) })
    await act(async () => { loading.resolve(clips) })
    await expectViewedClip(clips[2])
    expect(screen.getByText('Original')).toBeVisible()
    expect(screen.getByText('Earlier edit A')).toBeVisible()
    expect(screen.getByText('Current edit A')).toBeVisible()
    expect(localStorage.getItem(markerKey)).toBeNull()
    expect(allocations.map(entry => entry.blob)).toEqual(clips.map(clip => clip.blob))
    expect(outbound).toHaveLength(0)
    expect(fetchMock.mock.calls.some(([url]) => url === '/healthz')).toBe(false)
  })

  /** A superseded clip read cannot replace the chosen archive or allocate orphaned URLs. */
  it('keeps the later sidebar selection when an earlier load finishes', async () => {
    const firstLoad = deferred<StoredClip[]>([])
    const aClips = storedClips(projectA.id)
    const bClips = storedClips(projectB.id)
    storage.loadProjectClips.mockImplementation(async id => id === projectA.id ? firstLoad.promise : bClips)
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    await selectProject(user, projectA)
    expect(storage.loadProjectClips).toHaveBeenCalledWith(projectA.id)
    await selectProject(user, projectB)
    await expectViewedClip(bClips[2])
    const selectedUrl = clipUrl(bClips[2])
    await act(async () => { firstLoad.resolve(aClips) })
    expect(viewedVideoSource()).toBe(selectedUrl)
    expect(allocations.map(entry => entry.blob)).toEqual(bClips.map(clip => clip.blob))
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  /** Startup cannot consume a marker written by a subsequently accepted Generate action. */
  it('preserves the live project marker when startup listing finishes', async () => {
    const listing = deferred<StoredProject[]>([])
    storage.listProjects.mockReturnValueOnce(listing.promise)
    localStorage.setItem(markerKey, projectA.id)
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await startLiveProject(user)
    const liveProjectId = localStorage.getItem(markerKey)
    expect(liveProjectId).toBeTruthy()
    expect(liveProjectId).not.toBe(projectA.id)
    await act(async () => { listing.resolve([...projects]) })
    expect(localStorage.getItem(markerKey)).toBe(liveProjectId)
    expect(screen.queryByText('View-only project')).not.toBeInTheDocument()
    expect(allocations).toHaveLength(0)
    expect(outbound).toHaveLength(1)
    expect(outbound[0]).toHaveLength(1)
  })

  /** Successful deletion clears A immediately while retaining a pending selection of B. */
  it('removes a deleted archive before its delayed list refresh', async () => {
    const refreshing = deferred<StoredProject[]>([])
    const bLoading = deferred<StoredClip[]>([])
    const aClips = storedClips(projectA.id)
    const bClips = storedClips(projectB.id)
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    await selectProject(user, projectA)
    await expectViewedClip(aClips[2])
    const aUrls = allocations.map(entry => entry.url)
    // B can await database acquisition before its read transaction starts after deletion.
    storage.loadProjectClips.mockReturnValueOnce(bLoading.promise)
    await selectProject(user, projectB)
    expect(storage.loadProjectClips).toHaveBeenLastCalledWith(projectB.id)
    storage.listProjects.mockReturnValueOnce(refreshing.promise)
    const sidebar = await openSidebar(user)
    const aRow = within(sidebar).getByRole('button', { name: new RegExp(projectA.originalLabel) })
    await user.click(within(aRow).getByRole('button', { name: 'Delete project' }))
    await user.click(within(aRow).getByRole('button', { name: 'Confirm delete project' }))
    await waitFor(() => { expect(storage.listProjects).toHaveBeenCalledTimes(2) })
    expect(storage.deleteProject).toHaveBeenCalledExactlyOnceWith(projectA.id)
    expect(within(sidebar).queryByText(projectA.originalLabel)).not.toBeInTheDocument()
    expect(screen.queryByText('View-only project')).not.toBeInTheDocument()
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(aUrls)
    await act(async () => { bLoading.resolve(bClips) })
    await expectViewedClip(bClips[2])
    await act(async () => { refreshing.resolve([...projects]) })
    expect(viewedVideoSource()).toBe(clipUrl(bClips[2]))
    expect(within(sidebar).queryByText(projectA.originalLabel)).not.toBeInTheDocument()
  })

  /** Sidebar keyboard selection retains the manual viewing and cleanup contract. */
  it('opens a saved project through sidebar keyboard selection', async () => {
    const clips = storedClips(projectB.id)
    const user = userEvent.setup()
    const { unmount } = render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    const sidebar = await openSidebar(user)
    within(sidebar).getByRole('button', { name: new RegExp(projectB.originalLabel) }).focus()
    await user.keyboard('{Enter}')
    await expectViewedClip(clips[2])
    expect(storage.loadProjectClips).toHaveBeenCalledExactlyOnceWith(projectB.id)
    expect(outbound).toHaveLength(0)
    expect(revokeObjectURL).not.toHaveBeenCalled()
    const acceptedUrls = allocations.map(entry => entry.url)
    unmount()
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(acceptedUrls)
  })

  /** Missing records and failed reads leave the lobby usable without choosing another archive. */
  it.each(['no marker', 'unknown marker', 'empty list', 'list failure', 'clip failure'])(
    'keeps the lobby available after startup with %s', async (scenario) => {
      const listing = deferred<StoredProject[]>([])
      const failure = new Error(`Storage ${scenario}`)
      storage.listProjects.mockReturnValueOnce(listing.promise)
      if (scenario !== 'no marker') {
        localStorage.setItem(markerKey, scenario === 'unknown marker' ? 'missing-project' : projectA.id)
      }
      if (scenario === 'clip failure') storage.loadProjectClips.mockRejectedValueOnce(failure)
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastH3')
      await act(async () => {
        if (scenario === 'list failure') listing.reject(failure)
        else listing.resolve(scenario === 'empty list' ? [] : [...projects])
      })
      if (scenario === 'list failure' || scenario === 'clip failure') {
        const message = scenario === 'list failure' ? 'Failed to load saved projects:' : 'Failed to load project:'
        await waitFor(() => { expect(console.error).toHaveBeenCalledWith(message, failure) })
      }
      expect(screen.queryByText('View-only project')).not.toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: 'Initial prompt' })).toBeEnabled()
      expect(localStorage.getItem(markerKey)).toBeNull()
      expect(allocations).toHaveLength(0)
      expect(outbound).toHaveLength(0)
    },
  )

  /** A private-storage marker failure must not prevent the normal project listing. */
  it('lists saved projects when the active marker cannot be read', async () => {
    // oxlint-disable-next-line typescript/unbound-method -- The fallback calls the jsdom method with the Storage receiver.
    const getItem = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === markerKey) throw new DOMException('Storage access denied', 'SecurityError')
      return getItem.call(this, key)
    })
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    const sidebar = await openSidebar(user)
    expect(within(sidebar).getByText(projectA.originalLabel)).toBeVisible()
    expect(within(sidebar).getByText(projectB.originalLabel)).toBeVisible()
    expect(screen.queryByText('View-only project')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Initial prompt' })).toBeEnabled()
    expect(allocations).toHaveLength(0)
    expect(outbound).toHaveLength(0)
  })

  /** A surviving project can have no clips and still provide a read-only view and Back. */
  it('opens an empty saved project without allocating video URLs', async () => {
    storage.loadProjectClips.mockResolvedValueOnce([])
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    await selectProject(user, projectA)
    await screen.findByText('View-only project')
    expect(viewedVideoSource()).toBeNull()
    expect(allocations).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByText('View-only project')).not.toBeInTheDocument()
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  /** Stored Original, Edit, and Current cards select their supplied clips without new allocations. */
  it('selects original and historical clips within an accepted archive', async () => {
    const clips = storedClips(projectA.id)
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    await selectProject(user, projectA)
    await expectViewedClip(clips[2])
    const original = screen.getByText('Original').closest('[data-selected]')
    expect(original).toHaveTextContent(projectA.originalLabel)
    await user.click(screen.getByText('Original'))
    expect(original).toHaveAttribute('data-selected', 'true')
    expect(viewedVideoSource()).toBe(clipUrl(clips[0]))
    await user.click(screen.getByText('Earlier edit A'))
    expect(screen.getByText('Earlier edit A').closest('[data-selected]')).toHaveAttribute('data-selected', 'true')
    expect(viewedVideoSource()).toBe(clipUrl(clips[1]))
    await user.click(screen.getByText('Current edit A'))
    expect(screen.getByText('Current edit A').closest('[data-selected]')).toHaveAttribute('data-selected', 'true')
    expect(viewedVideoSource()).toBe(clipUrl(clips[2]))
    expect(allocations.map(entry => entry.blob)).toEqual(clips.map(clip => clip.blob))
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  /** An explicit sidebar selection takes precedence over an unfinished startup restoration. */
  it('keeps a sidebar archive when marked startup clips arrive later', async () => {
    const restoring = deferred<StoredClip[]>([])
    const aClips = storedClips(projectA.id)
    const bClips = storedClips(projectB.id)
    storage.loadProjectClips.mockReturnValueOnce(restoring.promise)
    localStorage.setItem(markerKey, projectA.id)
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await waitFor(() => { expect(storage.loadProjectClips).toHaveBeenCalledWith(projectA.id) })
    await selectProject(user, projectB)
    await expectViewedClip(bClips[2])
    await act(async () => { restoring.resolve(aClips) })
    expect(viewedVideoSource()).toBe(clipUrl(bClips[2]))
    expect(allocations.map(entry => entry.blob)).toEqual(bClips.map(clip => clip.blob))
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  /** A repeated project ID cannot authorize an earlier request after A, B, then A. */
  it('accepts only the last request when selecting A then B then A', async () => {
    const firstA = deferred<StoredClip[]>([])
    const loadingB = deferred<StoredClip[]>([])
    const lastA = deferred<StoredClip[]>([])
    const aClips = storedClips(projectA.id)
    const bClips = storedClips(projectB.id)
    storage.loadProjectClips.mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(loadingB.promise).mockReturnValueOnce(lastA.promise)
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    await selectProject(user, projectA)
    await selectProject(user, projectB)
    await selectProject(user, projectA)
    expect(storage.loadProjectClips.mock.calls).toEqual([[projectA.id], [projectB.id], [projectA.id]])
    await act(async () => { lastA.resolve(aClips) })
    await expectViewedClip(aClips[2])
    const selectedUrl = clipUrl(aClips[2])
    await act(async () => { loadingB.resolve(bClips); firstA.resolve(aClips) })
    expect(viewedVideoSource()).toBe(selectedUrl)
    expect(allocations.map(entry => entry.blob)).toEqual(aClips.map(clip => clip.blob))
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  /** Read failure retains the accepted view and its resources. */
  it('retains the displayed archive when another project cannot be read', async () => {
    const aClips = storedClips(projectA.id)
    const failure = new Error('Clip read failed')
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    await selectProject(user, projectA)
    await expectViewedClip(aClips[2])
    storage.loadProjectClips.mockRejectedValueOnce(failure)
    await selectProject(user, projectB)
    await waitFor(() => { expect(console.error).toHaveBeenCalledWith('Failed to load project:', failure) })
    expect(viewedVideoSource()).toBe(clipUrl(aClips[2]))
    expect(allocations.map(entry => entry.blob)).toEqual(aClips.map(clip => clip.blob))
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  /** Visible dismiss actions release the displayed archive and reject its pending replacement. */
  it.each(['Back', 'Current', 'New project'])('dismisses a displayed archive and pending read through %s', async (action) => {
    const loadingB = deferred<StoredClip[]>([])
    const aClips = storedClips(projectA.id)
    const bClips = storedClips(projectB.id)
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await startLiveProject(user)
    await selectProject(user, projectA)
    await expectViewedClip(aClips[2])
    const aUrls = allocations.map(entry => entry.url)
    storage.loadProjectClips.mockReturnValueOnce(loadingB.promise)
    await selectProject(user, projectB)
    if (action === 'Back') {
      await user.click(screen.getByRole('button', { name: 'Back' }))
    } else {
      const sidebar = await openSidebar(user)
      const name = action === 'Current' ? /A live river/ : 'New project'
      await user.click(within(sidebar).getByRole('button', { name }))
    }
    await waitFor(() => expect(screen.queryByText('View-only project')).not.toBeInTheDocument())
    await act(async () => { loadingB.resolve(bClips) })
    expect(screen.queryByText('View-only project')).not.toBeInTheDocument()
    expect(allocations.map(entry => entry.blob)).toEqual(aClips.map(clip => clip.blob))
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(aUrls)
  })

  /** New project is reachable from the sidebar while no archive has finished loading. */
  it.each(['startup list', 'manual clip read'])('rejects an unfinished %s after New project', async (pendingRead) => {
    const listing = deferred<StoredProject[]>([])
    const loading = deferred<StoredClip[]>([])
    const aClips = storedClips(projectA.id)
    if (pendingRead === 'startup list') {
      localStorage.setItem(markerKey, projectA.id)
      storage.listProjects.mockReturnValueOnce(listing.promise)
    } else {
      storage.loadProjectClips.mockReturnValueOnce(loading.promise)
    }
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    if (pendingRead === 'manual clip read') await selectProject(user, projectA)
    const sidebar = await openSidebar(user)
    await user.click(within(sidebar).getByRole('button', { name: 'New project' }))
    await waitFor(() => expect(within(sidebar).getByRole('button', { name: 'New project' })).toBeEnabled())
    await act(async () => { listing.resolve([...projects]); loading.resolve(aClips) })
    expect(screen.queryByText('View-only project')).not.toBeInTheDocument()
    expect(allocations).toHaveLength(0)
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(outbound).toHaveLength(0)
  })

  /** Resolve reads after unmount before fixture rescue so late URL allocation remains observable. */
  it.each(['startup list', 'manual clip read'])('allocates no archive URLs when a %s finishes after unmount', async (pendingRead) => {
    const listing = deferred<StoredProject[]>([])
    const loading = deferred<StoredClip[]>([])
    const aClips = storedClips(projectA.id)
    if (pendingRead === 'startup list') {
      localStorage.setItem(markerKey, projectA.id)
      storage.listProjects.mockReturnValueOnce(listing.promise)
    } else {
      storage.loadProjectClips.mockReturnValueOnce(loading.promise)
    }
    const user = userEvent.setup()
    const { unmount } = render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    if (pendingRead === 'manual clip read') await selectProject(user, projectA)
    unmount()
    await act(async () => { listing.resolve([...projects]); loading.resolve(aClips) })
    expect(allocations).toHaveLength(0)
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(screen.queryByText('View-only project')).not.toBeInTheDocument()
  })

  /** A later archive selection survives an accepted live start whose readiness probe is still pending. */
  it('retains a later sidebar archive when delayed readiness starts a live project', async () => {
    const restoring = deferred<StoredClip[]>([])
    const readiness = deferred<Response>(jsonResponse({ status: 'ready' }))
    const aClips = storedClips(projectA.id)
    const bClips = storedClips(projectB.id)
    localStorage.setItem(markerKey, projectA.id)
    storage.loadProjectClips.mockReturnValueOnce(restoring.promise)
    readinessResponse = () => readiness.promise
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    await waitFor(() => { expect(storage.loadProjectClips).toHaveBeenCalledWith(projectA.id) })
    await user.type(screen.getByRole('textbox', { name: 'Initial prompt' }), 'A live river')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith('/readyz', expect.any(Object)) })
    expect(outbound).toHaveLength(0)
    await selectProject(user, projectB)
    await expectViewedClip(bClips[2])
    await act(async () => { restoring.resolve(aClips) })
    expect(viewedVideoSource()).toBe(clipUrl(bClips[2]))
    await act(async () => { readiness.resolve(jsonResponse({ status: 'ready', ready_gpu_workers: 1 })) })
    await waitFor(() => { expect(outbound[0]?.[0]).toMatchObject({ type: 'project_init_v1', model_id: 'fast-h3' }) })
    expect(outbound).toHaveLength(1)
    expect(outbound[0]).toHaveLength(1)
    expect(viewedVideoSource()).toBe(clipUrl(bClips[2]))
    expect(screen.getByText('View-only project')).toBeVisible()
    expect(allocations.map(entry => entry.blob)).toEqual(bClips.map(clip => clip.blob))
  })

  /** A failed readiness probe does not reauthorize restoration superseded by valid Generate. */
  it('keeps superseded startup clips closed after readiness fails', async () => {
    const restoring = deferred<StoredClip[]>([])
    const aClips = storedClips(projectA.id)
    localStorage.setItem(markerKey, projectA.id)
    storage.loadProjectClips.mockReturnValueOnce(restoring.promise)
    readinessResponse = async () => jsonResponse({ detail: 'No ready GPU worker processes.' }, 503)
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    await waitFor(() => { expect(storage.loadProjectClips).toHaveBeenCalledWith(projectA.id) })
    await user.type(screen.getByRole('textbox', { name: 'Initial prompt' }), 'A live river')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('Dreamverse backend is running, but GPU workers are not ready yet. Wait for startup warmup to finish and retry.')
    await act(async () => { restoring.resolve(aClips) })
    expect(screen.queryByText('View-only project')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Initial prompt' })).toHaveValue('A live river')
    expect(allocations).toHaveLength(0)
    expect(outbound).toHaveLength(0)
  })

  /** A disabled lobby action cannot invalidate an otherwise valid startup restoration. */
  it('keeps startup restoration when an empty Generate action is disabled', async () => {
    const restoring = deferred<StoredClip[]>([])
    const aClips = storedClips(projectA.id)
    storage.loadProjectClips.mockReturnValueOnce(restoring.promise)
    localStorage.setItem(markerKey, projectA.id)
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    await waitFor(() => { expect(storage.loadProjectClips).toHaveBeenCalledWith(projectA.id) })
    const generate = screen.getByRole('button', { name: 'Generate' })
    expect(generate).toBeDisabled()
    await user.click(generate)
    expect(fetchMock.mock.calls.some(([url]) => url === '/healthz')).toBe(false)
    await act(async () => { restoring.resolve(aClips) })
    await expectViewedClip(aClips[2])
    expect(outbound).toHaveLength(0)
  })

  /** Replacement, Back, reopening, and unmount each release only the view they own. */
  it('releases every accepted URL exactly once across replacement and reopening', async () => {
    const aClips = storedClips(projectA.id)
    const bClips = storedClips(projectB.id)
    const user = userEvent.setup()
    const { unmount } = render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    await selectProject(user, projectA)
    await expectViewedClip(aClips[2])
    const aUrls = allocations.map(entry => entry.url)
    await selectProject(user, projectB)
    await expectViewedClip(bClips[2])
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(aUrls)
    const firstViews = allocations.map(entry => entry.url)
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(firstViews)
    await selectProject(user, projectB)
    await expectViewedClip(bClips[2])
    const allUrls = allocations.map(entry => entry.url)
    expect(allUrls).toHaveLength(aClips.length + bClips.length * 2)
    expect(new Set(allUrls).size).toBe(allUrls.length)
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(firstViews)
    unmount()
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(allUrls)
  })

  async function confirmDelete(user: BrowserUser, project: StoredProject) {
    const sidebar = await openSidebar(user)
    const row = within(sidebar).getByRole('button', { name: new RegExp(project.originalLabel) })
    await user.click(within(row).getByRole('button', { name: 'Delete project' }))
    await user.click(within(row).getByRole('button', { name: 'Confirm delete project' }))
    return sidebar
  }

  /** A failed post-delete read cannot restore A or cancel the separate selection of B. */
  it('retains another selection when the post-delete list refresh fails', async () => {
    const refreshing = deferred<StoredProject[]>([])
    const loadingB = deferred<StoredClip[]>([])
    const failure = new Error('Project refresh failed')
    const aClips = storedClips(projectA.id)
    const bClips = storedClips(projectB.id)
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    await selectProject(user, projectA)
    await expectViewedClip(aClips[2])
    const aUrls = allocations.map(entry => entry.url)
    storage.loadProjectClips.mockReturnValueOnce(loadingB.promise)
    await selectProject(user, projectB)
    storage.listProjects.mockReturnValueOnce(refreshing.promise)
    const sidebar = await confirmDelete(user, projectA)
    await waitFor(() => { expect(storage.listProjects).toHaveBeenCalledTimes(2) })
    expect(within(sidebar).queryByText(projectA.originalLabel)).not.toBeInTheDocument()
    expect(screen.queryByText('View-only project')).not.toBeInTheDocument()
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(aUrls)
    await act(async () => { refreshing.reject(failure) })
    await waitFor(() => { expect(console.error).toHaveBeenCalledWith('Failed to load saved projects:', failure) })
    await act(async () => { loadingB.resolve(bClips) })
    await expectViewedClip(bClips[2])
    expect(within(sidebar).queryByText(projectA.originalLabel)).not.toBeInTheDocument()
    expect(within(sidebar).getByRole('button', { name: new RegExp(projectB.originalLabel) })).toBeEnabled()
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(aUrls)
  })

  /** A read begun before database acquisition must not reopen a project deleted before that read completes. */
  it('rejects an empty clip response for a deleted pending selection', async () => {
    const loading = deferred<StoredClip[]>([])
    storage.loadProjectClips.mockReturnValueOnce(loading.promise)
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    await selectProject(user, projectA)
    const sidebar = await confirmDelete(user, projectA)
    await waitFor(() => expect(within(sidebar).queryByText(projectA.originalLabel)).not.toBeInTheDocument())
    expect(storage.deleteProject).toHaveBeenCalledExactlyOnceWith(projectA.id)
    await act(async () => { loading.resolve([]) })
    expect(screen.queryByText('View-only project')).not.toBeInTheDocument()
    expect(allocations).toHaveLength(0)
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  /** Failed deletion retains the stored row, view, and URL ownership. */
  it('retains the displayed archive when deletion fails', async () => {
    const failure = new Error('Delete transaction failed')
    const aClips = storedClips(projectA.id)
    storage.deleteProject.mockRejectedValueOnce(failure)
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await screen.findByText('FastH3')
    await selectProject(user, projectA)
    await expectViewedClip(aClips[2])
    const sidebar = await confirmDelete(user, projectA)
    await waitFor(() => { expect(console.error).toHaveBeenCalledWith('Failed to delete project:', failure) })
    expect(storage.deleteProject).toHaveBeenCalledExactlyOnceWith(projectA.id)
    expect(storage.listProjects).toHaveBeenCalledOnce()
    expect(within(sidebar).getByText(projectA.originalLabel)).toBeVisible()
    expect(viewedVideoSource()).toBe(clipUrl(aClips[2]))
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  /** Archive entry and exit preserve the playback state of an already mounted live video. */
  it.each([false, true])('restores the live playback state when it started paused: %s', async (initiallyPaused) => {
    const aClips = storedClips(projectA.id)
    const user = userEvent.setup()
    const { container, unmount } = render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
    await startLiveProject(user)
    const video = container.querySelector<HTMLVideoElement>('video:not([preload]):not([src])')
    expect(video).not.toBeNull()
    if (!video) throw new Error('Expected the mounted live video')
    const properties = ['paused', 'ended', 'readyState'] as const
    const descriptors = properties.map(name => Object.getOwnPropertyDescriptor(video, name))
    let paused = initiallyPaused
    Object.defineProperties(video, {
      paused: { configurable: true, get: () => paused },
      ended: { configurable: true, get: () => false },
      readyState: { configurable: true, get: () => 4 },
    })
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => { paused = true })
    const play = vi.spyOn(video, 'play').mockImplementation(async () => { paused = false })
    try {
      await selectProject(user, projectA)
      await expectViewedClip(aClips[2])
      expect(pause).toHaveBeenCalledTimes(initiallyPaused ? 0 : 1)
      expect(paused).toBe(true)
      play.mockClear()
      await user.click(screen.getByRole('button', { name: 'Back' }))
      expect(screen.queryByText('View-only project')).not.toBeInTheDocument()
      expect(container.querySelector('video:not([preload]):not([src])')).toBe(video)
      expect(play).toHaveBeenCalledTimes(initiallyPaused ? 0 : 1)
      expect(paused).toBe(initiallyPaused)
    } finally {
      unmount()
      properties.forEach((name, index) => {
        const descriptor = descriptors[index]
        if (descriptor) Object.defineProperty(video, name, descriptor)
        else Reflect.deleteProperty(video, name)
      })
    }
  })
  describe('Saved clip export', () => {
    let downloads: { url: string; filename: string }[]
    let shareDescriptor: PropertyDescriptor | undefined
    let canShareDescriptor: PropertyDescriptor | undefined

    beforeEach(() => {
      downloads = []
      shareDescriptor = Object.getOwnPropertyDescriptor(navigator, 'share')
      canShareDescriptor = Object.getOwnPropertyDescriptor(navigator, 'canShare')
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push({ url: this.href, filename: this.download })
      })
    })

    afterEach(() => {
      if (shareDescriptor) Object.defineProperty(navigator, 'share', shareDescriptor)
      else Reflect.deleteProperty(navigator, 'share')
      if (canShareDescriptor) Object.defineProperty(navigator, 'canShare', canShareDescriptor)
      else Reflect.deleteProperty(navigator, 'canShare')
    })

    /** Expose the browser's native sharing boundary while retaining real File construction. */
    function configureSharing(coarsePointer: boolean) {
      const share = vi.fn<Navigator['share']>().mockResolvedValue()
      const canShare = vi.fn<Navigator['canShare']>().mockReturnValue(true)
      Object.defineProperty(navigator, 'share', { configurable: true, value: share })
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare })
      const matchMedia = window.matchMedia.bind(window)
      vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
        const list = matchMedia(query)
        return Object.assign(list, { matches: query === '(pointer: coarse)' ? coarsePointer : list.matches })
      })
      return { share, canShare }
    }

    function readBlobText(blob: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          if (typeof reader.result === 'string') resolve(reader.result)
          else reject(new Error('FileReader did not return text'))
        }
        reader.onerror = () => { reject(reader.error ?? new Error('FileReader failed without an error')) }
        reader.readAsText(blob)
      })
    }

    /** Capture the real saved video's download without relying on its accessible name. */
    async function exportViewedClip(user: BrowserUser) {
      const video = document.querySelector<HTMLVideoElement>('video[autoplay]')
      expect(video).not.toBeNull()
      if (!video?.parentElement) throw new Error('Expected the saved video inside its player')
      await user.click(within(video.parentElement).getByRole('button'))
      await waitFor(() => { expect(downloads).toHaveLength(1) })
      const [download] = downloads
      if (!download) throw new Error('Expected one saved clip download')
      const allocation = allocations.find(entry => entry.url === download.url)
      expect(allocation?.blob).toBeInstanceOf(Blob)
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(download.url)
      const blob = allocation?.blob
      if (!(blob instanceof Blob)) throw new Error('Expected the download URL to reference a Blob')
      return { ...download, blob }
    }

    /** The final clip remains the default saved playback and byte source. */
    it('exports the default saved clip bytes', async () => {
      const clips = storedClips(projectA.id)
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastH3')
      await selectProject(user, projectA)
      await expectViewedClip(clips[2])
      const playbackUrl = viewedVideoSource()
      const download = await exportViewedClip(user)
      expect(await readBlobText(download.blob)).toBe('video:A:3')
      expect(download.blob).toBe(clips[2].blob)
      expect(download.filename).toBe('Prompt_A-3.mp4')
      expect(viewedVideoSource()).toBe(playbackUrl)
    })

    /** Stored history selection must determine the downloaded bytes as well as visible playback. */
    it.each([
      { selection: 'Original', text: 'Original', clipIndex: 0 },
      { selection: 'history', text: 'Earlier edit A', clipIndex: 1 },
    ] as const)('exports the displayed saved $selection clip', async ({ text, clipIndex }) => {
      const clips = storedClips(projectA.id)
      const selectedClip = clips[clipIndex]
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastH3')
      await selectProject(user, projectA)
      await expectViewedClip(clips[2])
      await user.click(screen.getByText(text))
      await expectViewedClip(selectedClip)
      const playbackUrl = viewedVideoSource()
      const download = await exportViewedClip(user)
      expect(await readBlobText(download.blob)).toBe(`video:A:${clipIndex + 1}`)
      expect(download.blob).toBe(selectedClip.blob)
      expect(download.filename).toBe(clipIndex === 0 ? 'Prompt_A-1.mp4' : 'Prompt_A-2.mp4')
      expect(viewedVideoSource()).toBe(playbackUrl)
    })

    /** A saved clip's prompt supplies its filename even when the lobby has unrelated text. */
    it('names the saved export from its own prompt', async () => {
      const clips = storedClips(projectA.id)
      clips[2].prompt = 'Sunrise over icy water'
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastH3')
      await user.type(screen.getByRole('textbox', { name: 'Initial prompt' }), 'A different live idea')
      await selectProject(user, projectA)
      await expectViewedClip(clips[2])
      const download = await exportViewedClip(user)
      expect(await readBlobText(download.blob)).toBe('video:A:3')
      expect(download.filename).toBe('Sunrise_over_icy_water.mp4')
      expect(outbound).toHaveLength(0)
    })

    /** Returning to Current chooses the final clip and preserves its playback URL until unmount. */
    it('exports saved Current after another clip was selected', async () => {
      const clips = storedClips(projectA.id)
      const user = userEvent.setup()
      const { unmount } = render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastH3')
      await selectProject(user, projectA)
      await expectViewedClip(clips[2])
      await user.click(screen.getByText('Original'))
      await expectViewedClip(clips[0])
      await user.click(screen.getByText('Current edit A'))
      await expectViewedClip(clips[2])
      const playbackUrl = viewedVideoSource()
      expect(screen.getByRole('button', { name: 'Download video' })).toBeVisible()
      const download = await exportViewedClip(user)
      expect(download.blob).toBe(clips[2].blob)
      expect(await readBlobText(download.blob)).toBe('video:A:3')
      expect(download.filename).toBe('Prompt_A-3.mp4')
      expect(viewedVideoSource()).toBe(playbackUrl)
      unmount()
      expect(revokeObjectURL.mock.calls.map(([url]) => url).sort())
        .toEqual(allocations.map(entry => entry.url).sort())
    })

    /** A saved project without clips has no exportable video action. */
    it('offers no export action for an empty saved project', async () => {
      clipsByProject.set(projectA.id, [])
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastH3')
      await selectProject(user, projectA)
      await screen.findByText('View-only project')
      expect(viewedVideoSource()).toBeNull()
      expect(screen.queryByRole('button', { name: /^(Download|Share) video$/ })).not.toBeInTheDocument()
      expect(downloads).toHaveLength(0)
      expect(allocations).toHaveLength(0)
    })

    /** Filename examples pin the public format independently of the implementation's regex. */
    it.each([
      {
        name: 'punctuation and spaces', prompt: '  Snow!  & Ice / River_2-test  ', mime: 'video/mp4',
        filename: 'Snow_Ice_River_2-test.mp4',
      },
      {
        name: 'sixty-character limit', prompt: '0123456789'.repeat(7), mime: 'video/mp4',
        filename: '012345678901234567890123456789012345678901234567890123456789.mp4',
      },
      { name: 'blank prompt', prompt: '   ', mime: 'video/mp4', filename: 'video.mp4' },
      { name: 'filtered prompt', prompt: '🌧️☁️!?', mime: 'video/mp4', filename: 'video.mp4' },
      { name: 'WebM MIME', prompt: 'A gentle breeze', mime: 'video/webm', filename: 'A_gentle_breeze.webm' },
      { name: 'empty MIME', prompt: 'Quiet lake', mime: '', filename: 'Quiet_lake.mp4' },
    ])('retains saved filename formatting for $name', async ({ prompt, mime, filename }) => {
      const clip = storedClips(projectA.id)[2]
      clip.prompt = prompt
      clip.mime = mime
      clip.blob = new Blob(['formatted video'], { type: mime })
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastH3')
      await selectProject(user, projectA)
      await expectViewedClip(clip)
      const playbackUrl = viewedVideoSource()
      const download = await exportViewedClip(user)
      expect(download.filename).toBe(filename)
      expect(download.blob).toBe(clip.blob)
      expect(download.blob.type).toBe(mime)
      expect(await readBlobText(download.blob)).toBe('formatted video')
      expect(viewedVideoSource()).toBe(playbackUrl)
    })

    /** Native sharing remains limited to touch-first devices, with the retained download fallback. */
    it.each([
      { name: 'desktop download', coarse: false, supported: true, error: null, shared: false, downloaded: true },
      { name: 'mobile share', coarse: true, supported: true, error: null, shared: true, downloaded: false },
      { name: 'unsupported mobile share', coarse: true, supported: false, error: null, shared: false, downloaded: true },
      { name: 'failed mobile share', coarse: true, supported: true, error: 'NotAllowedError', shared: true, downloaded: true },
      { name: 'canceled mobile share', coarse: true, supported: true, error: 'AbortError', shared: true, downloaded: false },
    ])('retains delivery behavior for $name', async ({ name, coarse, supported, error, shared, downloaded }) => {
      const { share, canShare } = configureSharing(coarse)
      canShare.mockReturnValue(supported)
      if (error) share.mockRejectedValue(new DOMException('Share declined', error))
      const clip = storedClips(projectA.id)[2]
      // A successful share supplies an MP4 File type when the stored Blob has none.
      if (name === 'mobile share') clip.blob = new Blob(['video:A:3'])
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastH3')
      await selectProject(user, projectA)
      await expectViewedClip(clip)
      const playbackUrl = viewedVideoSource()
      const playbackAllocations = [...allocations]
      await user.click(screen.getByRole('button', { name: coarse ? 'Share video' : 'Download video' }))
      expect(canShare).toHaveBeenCalledTimes(coarse ? 1 : 0)
      expect(share).toHaveBeenCalledTimes(shared ? 1 : 0)
      if (coarse) {
        const file = canShare.mock.calls[0]?.[0]?.files?.[0]
        expect(file).toBeInstanceOf(File)
        if (!file) throw new Error('Expected canShare to receive the saved clip File')
        expect(file.name).toBe('Prompt_A-3.mp4')
        expect(file.type).toBe('video/mp4')
        expect(await readBlobText(file)).toBe('video:A:3')
        if (shared) expect(share).toHaveBeenCalledExactlyOnceWith({ files: [file] })
      }
      if (downloaded) {
        await waitFor(() => { expect(downloads).toHaveLength(1) })
        expect(downloads[0]?.filename).toBe('Prompt_A-3.mp4')
        expect(allocations.find(entry => entry.url === downloads[0]?.url)?.blob).toBe(clip.blob)
        expect(await readBlobText(clip.blob)).toBe('video:A:3')
        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(downloads[0]?.url)
        expect(allocations).toHaveLength(playbackAllocations.length + 1)
      } else {
        expect(downloads).toHaveLength(0)
        expect(allocations).toEqual(playbackAllocations)
        expect(revokeObjectURL).not.toHaveBeenCalled()
      }
      expect(viewedVideoSource()).toBe(playbackUrl)
    })

    /** A pending native share keeps the accepted clip even after another history card is selected. */
    it.each(['success', 'failure'])('retains the accepted saved clip through pending share %s', async (outcome) => {
      const { share } = configureSharing(true)
      const sharing = deferred<undefined>(undefined)
      share.mockReturnValue(sharing.promise)
      const clips = storedClips(projectA.id)
      const user = userEvent.setup()
      render(<DreamverseApp renderSlot={renderDreamverseSlot} />)
      await screen.findByText('FastH3')
      await selectProject(user, projectA)
      await expectViewedClip(clips[2])
      await user.click(screen.getByText('Original'))
      await expectViewedClip(clips[0])
      await user.click(screen.getByRole('button', { name: 'Share video' }))
      expect(share).toHaveBeenCalledOnce()
      const file = share.mock.calls[0]?.[0]?.files?.[0]
      if (!file) throw new Error('Expected share to receive the saved clip File')
      expect(file.name).toBe('Prompt_A-1.mp4')
      expect(file.type).toBe('video/mp4')
      expect(await readBlobText(file)).toBe('video:A:1')
      await user.click(screen.getByText('Current edit A'))
      await expectViewedClip(clips[2])
      const currentPlaybackUrl = viewedVideoSource()
      expect(downloads).toHaveLength(0)
      await act(async () => {
        if (outcome === 'success') sharing.resolve(undefined)
        else sharing.reject(new Error('Native share failed'))
      })
      expect(share).toHaveBeenCalledExactlyOnceWith({ files: [file] })
      if (outcome === 'failure') {
        await waitFor(() => { expect(downloads).toHaveLength(1) })
        expect(downloads[0]?.filename).toBe('Prompt_A-1.mp4')
        expect(allocations.find(entry => entry.url === downloads[0]?.url)?.blob).toBe(clips[0].blob)
        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(downloads[0]?.url)
      } else {
        expect(downloads).toHaveLength(0)
        expect(revokeObjectURL).not.toHaveBeenCalled()
      }
      expect(viewedVideoSource()).toBe(currentPlaybackUrl)
    })
  })
})
