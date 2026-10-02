import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { resolveReferenceAssetIds, type AssetRecord, type ReferenceDraft } from '@dreamverse/assets-manager/client/assets.ts'
import { buildMentionOptions } from '@dreamverse/project-controller/client/creationConfig.ts'
import { toGenerationMode } from '@dreamverse/project-controller/client/generationMode.ts'
import Header from '../components/Header.tsx'
import { deleteProject, fetchSegmentVideo, getProject, listProjects, type ProjectRound, type ProjectSummary } from '@dreamverse/project-controller/client/projects.ts'
import { useStore } from '../hooks/useStore.ts'
import { createAvPipeline, DEFAULT_AV_MIME } from '../media/avPipeline.ts'
import { remuxArchivedFmp4Segments } from '../media/fmp4Remux.ts'
import { DEFAULT_CUSTOM_PRESET_ID, parseStoryPresets, sanitizePresetId } from '@dreamverse/project-controller/client/presets.ts'
import {
  normalizePromptWindowSnapshot,
} from '@dreamverse/project-controller/client/prompts/promptWindowSnapshot.ts'
import {
  clampLobbySelectionToCapabilities,
  parseLobbyCapabilities,
  validateLobbyCreationSelection,
  validateReferenceSelection,
  type LobbyCreationCapabilities,
  type LobbySelection,
} from '@dreamverse/project-controller/client/creationCapabilities.ts'
import {
  buildCreationInitPayload,
  parseEchoedCreationConfig,
} from '@dreamverse/project-controller/client/creationPayload.ts'
import rawPresets from '@dreamverse/project-controller/client/storyPresetsData.ts'
import { cn } from '../utils.ts'
import { createWebSocketConnection, detachAndCloseWebSocket } from '@dreamverse/project-controller/client/ws/client.ts'
import { decodeWebSocketEvent } from '@dreamverse/project-controller/client/ws/handlers.ts'
import { normalizeSocketMessage } from '@dreamverse/project-controller/client/ws/protocol.ts'
import { applyNormalizedSocketEvent } from '@dreamverse/project-controller/client/ws/reducer.ts'
import { createPromptWindowStore } from '@dreamverse/project-controller/client/stores/promptWindow.ts'
import { createRewriteStore } from '@dreamverse/project-controller/client/stores/rewrite.ts'
import { createProjectControlsStore } from '@dreamverse/project-controller/client/stores/projectControls.ts'
import { createStreamStore, type ArchivedSegment, type CompletedClip, type LiveClip } from '@dreamverse/project-controller/client/stores/stream.ts'
import { isJsonObject, type JsonObject } from '@dreamverse/project-controller/client/json.ts'
import type { PromptEvent } from '@dreamverse/project-controller/client/promptEvents.ts'
import { createUiStore } from '@dreamverse/project-controller/client/stores/ui.ts'
import type { DreamverseSlotRenderer, ProjectCreationConfig, ReferencePickerProps } from '../contracts.ts'

const FIXED_REWRITE_MODEL = 'gpt-oss-120b'
const DEFAULT_CURATED_PROMPT_LIMIT = 2
const BACKEND_PROBE_TIMEOUT_MS = 4000

interface PageStores {
  projectControlsStore: ReturnType<typeof createProjectControlsStore>
  promptWindowStore: ReturnType<typeof createPromptWindowStore>
  rewriteStore: ReturnType<typeof createRewriteStore>
  streamStore: ReturnType<typeof createStreamStore>
  uiStore: ReturnType<typeof createUiStore>
}

interface BackendProbeResponse {
  ok: boolean
  status: number
  /** The decoded JSON body, or `null` when the body is not JSON. */
  payload: unknown
  errorMessage: string
}

interface BackendReadinessProbe {
  ok: boolean
  notice: string
}

/** The first socket message that opens a stored harness project. */
interface ProjectOpenMessage {
  type: 'project_open_v1'
  project_id: string
}

type LobbyCreationState = { selection: LobbySelection } & (
	| { status: 'loading' }
	| { status: 'failed'; message: string }
	| { status: 'available'; capabilities: LobbyCreationCapabilities }
)

function yieldToEventLoop(): Promise<void> {
  return new Promise(r => setTimeout(r, 0))
}

/** Whether a prompt event is a user rewrite instruction with text. */
function isUserRewriteWithText(event: PromptEvent): boolean {
  return event.source === 'user_rewrite' && Boolean(event.text?.trim())
}

/** Autoplay and resume can be refused by the browser; the user then starts playback with the controls. */
function ignoreRefusedPlayback(): void {}

/** Whether the socket is open; read at call time because an awaited step can close it. */
function isSocketOpen(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.OPEN
}

/** A thrown value's `name` or `message`, or `undefined` when the value is not an object. */
function errorProperty(error: unknown, key: 'name' | 'message'): unknown {
  return isJsonObject(error) ? error[key] : undefined
}

/** Inputs of the DreamVerse page. */
export interface DreamverseAppProps {
  /** Renders the child slots whose occupants draw the page regions. */
  renderSlot: DreamverseSlotRenderer
}

/** Render project creation, live directing, and the playback of projects that the harness stores. */
export function DreamverseApp({ renderSlot }: DreamverseAppProps) {
  const storesRef = useRef<PageStores | null>(null)
  if (!storesRef.current) {
    const nextDemoMode = resolveDemoModeFromRuntime()

    const projectControlsStore = createProjectControlsStore({
      enhancementEnabled: true,
      livePromptRewriteMode: !nextDemoMode,
    })
    const nextPromptWindowStore = createPromptWindowStore({
      curatedPromptLimit: DEFAULT_CURATED_PROMPT_LIMIT,
      storyPresets: parseStoryPresets(rawPresets),
    })
    const nextRewriteStore = createRewriteStore()
    const nextStreamStore = createStreamStore()
    const nextUiStore = createUiStore({ demoMode: nextDemoMode })

    storesRef.current = {
      projectControlsStore,
      promptWindowStore: nextPromptWindowStore,
      rewriteStore: nextRewriteStore,
      streamStore: nextStreamStore,
      uiStore: nextUiStore,
    }
  }

  const { projectControlsStore, promptWindowStore, rewriteStore, streamStore, uiStore } = storesRef.current

  const projectControls = useStore(projectControlsStore)
  const promptWindowState = useStore(promptWindowStore)
  const rewriteState = useStore(rewriteStore)
  const streamState = useStore(streamStore)
  // The page re-renders when a page mode changes, although it reads the UI store only through `uiStore.get()`.
  useStore(uiStore)

  const {
    connected,
    connecting,
    projectStarted,
    queuePosition,
    gpuAssigned,
    generationRoundStatus,
    autoExtensionEnabled,
    autoExtensionRequested,
    livePromptDraft,
    projectNotice,
    connectionClosed,
    projectResetPending,
  } = projectControls

  const {
    storyPresets,
    selectedPreset,
    initialPromptSelectionReady,
  } = promptWindowState

  const { promptEvents } = rewriteState

  const {
    completedClips,
    activeClipId,
    activeClip,
    activePlaybackStartTime,
    loadingAnimation,
    avPlaybackStarted,
    mediaAppendError,
  } = streamState

  const wsRef = useRef<WebSocket | null>(null)
  const connectionAttemptRef = useRef(0)
  const [runtimeReady, setRuntimeReady] = useState(false)
  const ttffStartAtMsRef = useRef<number | null>(null)
  const [, setTtffValueMs] = useState<number | null>(null)
  const ttffIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const initialPromptRef = useRef<{ promptId: string | null; rawPrompt: string }>({ promptId: null, rawPrompt: '' })
  // Request order belongs to the attachment draft; library sorting never changes that order.
  const [referenceDraft, setReferenceDraft] = useState<ReferenceDraft[]>([])
  const [assets, setAssets] = useState<AssetRecord[]>([])
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [lobbyCreation, setLobbyCreation] = useState<LobbyCreationState>({
    status: 'loading',
    selection: { modeId: 't2v', aspectRatio: '16:9', resolution: '720p', segmentCount: 6, segmentDurationSec: 5 },
  })
  const lobbyCapabilities = lobbyCreation.status === 'available' ? lobbyCreation.capabilities : null
  const capabilityNotice = lobbyCreation.status === 'failed'
    ? lobbyCreation.message
    : lobbyCreation.status === 'loading' ? 'Loading model capabilities…' : null
  const [projectCreationConfig, setProjectCreationConfig] = useState<ProjectCreationConfig | null>(null)
  const referenceMode = projectCreationConfig?.modeId ?? lobbyCreation.selection.modeId
  const selectedReferences = referenceMode === 't2v' ? [] : referenceDraft
  const referencePicker: ReferencePickerProps | undefined = lobbyCapabilities && referenceMode !== 't2v' ? {
    references: referenceDraft,
    onReferencesChange: setReferenceDraft,
    onOpenAssets: () => { setAssetsOpen(true) },
    accept: lobbyCapabilities.asset_upload.image.mime_types.join(','),
    maxCount: referenceMode === 'i2v' ? 1 : lobbyCapabilities.reference_inputs.max_count,
    maxBytes: lobbyCapabilities.asset_upload.image.max_bytes,
  } : undefined

  /** Reuse successful uploads only where the original local attachment still owns its draft position. */
  function rememberUploadedReference(reference: Extract<ReferenceDraft, { kind: 'localFile' }>, asset: AssetRecord) {
    setAssets(stored => [asset, ...stored.filter(entry => entry.asset_id !== asset.asset_id)])
    setReferenceDraft(draft => draft.map(entry => entry.draftId === reference.draftId
			&& entry.kind === 'localFile' && entry.file === reference.file
      ? { draftId: entry.draftId, kind: 'savedAsset', asset } : entry))
  }

  /** Append saved images without inheriting the library's display order. */
  function selectAsset(asset: AssetRecord) {
    if (!referencePicker || asset.media_type !== 'image') return
    setReferenceDraft(draft => draft.length >= referencePicker.maxCount
			|| draft.some(entry => entry.kind === 'savedAsset' && entry.asset.asset_id === asset.asset_id)
      ? draft : [...draft, { draftId: randomUUID(), kind: 'savedAsset', asset }])
    setAssetsOpen(false)
  }
  const assetLibrary = renderSlot('dreamverse.asset-library', {
    open: assetsOpen,
    assets: assets,
    onAssetsChange: setAssets,
    uploadPolicy: lobbyCapabilities?.asset_upload ?? null,
    onClose: () => { setAssetsOpen(false) },
    onSelect: selectAsset,
    canSelect: Boolean(referencePicker) && referenceDraft.length < (referencePicker?.maxCount ?? 0),
    onDeleted: (assetId) => { setReferenceDraft(draft => draft.filter(entry => entry.kind !== 'savedAsset' || entry.asset.asset_id !== assetId)) },
  })

  const thumbnailCaptureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** A fresh token per project socket session; asynchronous media work compares it to drop results of an ended session. */
  const currentProjectIdRef = useRef('')
  /** The harness project ID of the current project, from `gpu_assigned` or from the opened project. */
  const harnessProjectIdRef = useRef('')
  /** The harness title of an opened project; a project created on this page derives its title from its preset. */
  const [openedProjectTitle, setOpenedProjectTitle] = useState<string | null>(null)
  const [projectSummaries, setProjectSummaries] = useState<ProjectSummary[]>([])
  const [projectListNotice, setProjectListNotice] = useState('')
  const downloadInFlightRef = useRef(false)
  const wsMessageQueueRef = useRef<Promise<void>>(Promise.resolve())
  const clipArchiveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const [videoMuted, setVideoMuted] = useState(true)

  const mentionOptions = useMemo(() => buildMentionOptions(storyPresets), [storyPresets])

  const lobbyStoryPresets = useMemo(
    () => storyPresets.map(preset => ({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      segmentCount: preset.segment_prompts.length,
    })),
    [storyPresets],
  )

  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const archivedPlaybackElRef = useRef<HTMLVideoElement | null>(null)

  const avPipelineRef = useRef(
    createAvPipeline({
      getVideoEl: () => videoElRef.current,
      onAppendError: (message: string, error: unknown) => {
        streamStore.patch({ mediaAppendError: message })
        console.error('media append failed:', error)
      },
      onPlaybackStarted: () => {
        streamStore.patch({ avPlaybackStarted: true, loadingAnimation: false })
      },
    }),
  )

  const avPipeline = avPipelineRef.current

  const videoRefCallback = useCallback((el: HTMLVideoElement | null) => {
    videoElRef.current = el
  }, [])

  const archivedPlaybackRefCallback = useCallback((el: HTMLVideoElement | null) => {
    archivedPlaybackElRef.current = el
  }, [])

  // --- Derived values ---

  const canStartProject = lobbyCreation.status === 'available' && !projectResetPending
		&& (initialPromptSelectionReady || Boolean(normalizeInitialPrompt(livePromptDraft)))

  const currentClipLabel = getCurrentClipLabel()

  const currentProjectTitle = useMemo(() => {
    if (openedProjectTitle) return openedProjectTitle
    const presetLabel = selectedPreset?.label
    if (presetLabel) return presetLabel
    const lastEdit = promptEvents.findLast(event => isUserRewriteWithText(event))
    return lastEdit?.text?.trim() || 'Untitled project'
  }, [openedProjectTitle, selectedPreset, promptEvents])

  const generationRoundBusy = generationRoundStatus === 'preparing' || generationRoundStatus === 'generating'
  const canSubmitContinuation = projectStarted && connected && gpuAssigned && !projectResetPending
		&& !generationRoundBusy && !autoExtensionEnabled && Boolean((livePromptDraft).trim())
  const canChooseAutoExtension = !generationRoundBusy && !autoExtensionEnabled && !connecting
		&& !projectResetPending && (!projectStarted || (connected && gpuAssigned))

  const showLivePlayback = !activeClip
  const canDownloadVideo = useMemo(() => {
    if (activeClip?.blob instanceof Blob) return true
    return completedClips.some(clip => clip.blob instanceof Blob)
  }, [activeClip, completedClips])

  const hasEdits = useMemo(
    () => projectStarted && promptEvents.some(event => isUserRewriteWithText(event)),
    [projectStarted, promptEvents],
  )

  /** Attach the selected completed clip; archive storage owns the borrowed URL. */
  useEffect(() => {
    const videoEl = archivedPlaybackElRef.current
    const objectUrl = activeClip?.objectUrl
    if (projectResetPending || !videoEl || typeof objectUrl !== 'string' || !objectUrl) return
    videoEl.src = objectUrl
    videoEl.load()
    try {
      if (Number.isFinite(activePlaybackStartTime) && activePlaybackStartTime > 0) {
        videoEl.currentTime = activePlaybackStartTime
      }
    } catch (_) {
      /* The browser can reject seeking before metadata is available. */
    }
    videoEl.play().catch(ignoreRefusedPlayback)
    return () => {
      videoEl.pause()
      videoEl.removeAttribute('src')
      videoEl.load()
    }
  }, [activeClip, activePlaybackStartTime, projectResetPending])

  // --- Initialization ---

  const initializedRef = useRef(false)
  useEffect(() => {
    setRuntimeReady(true)
  }, [])

  /** Apply each control's edit to the stored preferences for the served model. */
  function handleLobbySelectionChange(changes: Partial<LobbySelection>) {
    setLobbyCreation((current) => {
      if (current.status !== 'available') return current
      return {
        ...current,
        selection: clampLobbySelectionToCapabilities({
          ...current.selection, ...changes, capabilities: current.capabilities,
        }),
      }
    })
  }

  // Capabilities establish model identity; loading never supplies a local model fallback.
  useEffect(() => {
    if (!runtimeReady) return
    let cancelled = false
    void fetch('/creation-capabilities', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load model capabilities.')
        const capabilities = parseLobbyCapabilities(await response.json())
        if (!capabilities) throw new Error('Invalid model capabilities.')
        return capabilities
      })
      .then((capabilities) => {
        if (cancelled) return
        setLobbyCreation(current => ({
          status: 'available',
          capabilities,
          selection: clampLobbySelectionToCapabilities({ ...current.selection, capabilities }),
        }))
      })
      .catch(() => {
        if (cancelled) return
        setLobbyCreation(current => ({
          status: 'failed',
          message: 'Model capabilities are unavailable. Reload the page after the backend is available.',
          selection: current.selection,
        }))
      })
    return () => {
      cancelled = true
    }
  }, [runtimeReady])

  useEffect(() => {
    if (!runtimeReady || initializedRef.current) return
    initializedRef.current = true

    void refreshProjectList()
  }, [runtimeReady, uiStore])

  // The harness list changes while the sidebar is closed; opening it shows the current list.
  useEffect(() => {
    if (sidebarOpen) void refreshProjectList()
  }, [sidebarOpen])

  // --- Resume playback when the page becomes visible ---

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') return
      // Mobile browsers pause <video> when the page is backgrounded.
      // Resume playback on the active video element when returning.
      const hasActiveClip = Boolean(streamStore.get().activeClipId)
      const activeEl = hasActiveClip ? archivedPlaybackElRef.current : videoElRef.current
      if (activeEl && activeEl.paused && activeEl.readyState >= 2) {
        activeEl.play().catch(ignoreRefusedPlayback)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  // --- Cleanup on unmount ---

  useEffect(() => {
    return () => {

      clearTtffInterval()
      connectionAttemptRef.current += 1
      if (wsRef.current) {
        detachAndCloseWebSocket(wsRef.current)
        wsRef.current = null
      }
      resetPlaybackState()
      revokeCompletedClipUrls()
    }
  }, [])

  function resolveDemoModeFromRuntime() {
    const search = typeof window === 'undefined' ? '' : window.location.search
    const params = new URLSearchParams(search || '')
    if (!params.has('demo')) return false
    const value = (params.get('demo') ?? '')
      .trim()
      .toLowerCase()
    return value === '' || value === '1' || value === 'true' || value === 'yes' || value === 'on'
  }

  async function fetchBackendProbe(path: string): Promise<BackendProbeResponse> {
    const controller = typeof AbortController !== 'undefined'
      ? new AbortController()
      : null
    const timeoutId = controller
      ? window.setTimeout(() => { controller.abort() }, BACKEND_PROBE_TIMEOUT_MS)
      : null

    try {
      const response = await fetch(path, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller?.signal ?? null,
      })
      let payload: unknown = null
      try {
        payload = await response.json()
      } catch {
        // A body that is not JSON leaves the payload empty; the status code still reports the result.
        payload = null
      }
      const fallbackMessage = isJsonObject(payload) && typeof payload.detail === 'string'
        ? payload.detail
        : `Request failed with status ${response.status}.`
      return {
        ok: response.ok,
        status: response.status,
        payload,
        errorMessage: fallbackMessage,
      }
    } catch (error) {
      const message = errorProperty(error, 'name') === 'AbortError'
        ? 'Backend probe timed out.'
        : String(errorProperty(error, 'message') || error)
      return {
        ok: false,
        status: 0,
        payload: null,
        errorMessage: message,
      }
    } finally {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
    }
  }

  function resolveBackendUnavailableNotice(): string {
    return 'Dreamverse backend is not reachable. From the checkout root, run PYTHONPATH="$(pwd)/apps/dreamverse:$(pwd)${PYTHONPATH:+:$PYTHONPATH}" python -m dreamverse.server_entry --preset fast-ltx23 and wait for /readyz to return 200 before retrying.'
  }

  function resolveBackendNotReadyNotice(detail: string, statusPayload: unknown): string {
    const status = isJsonObject(statusPayload) ? statusPayload : {}
    const totalGpus = Number(status.total_gpus)
    const warmupFailures = Number(status.warmup_failed_gpus)
    if (Number.isFinite(totalGpus) && totalGpus <= 0) {
      return 'Dreamverse backend is running, but no GPUs were detected. Confirm that your local GPU is visible to FastVideo, then retry.'
    }
    if (Number.isFinite(warmupFailures) && warmupFailures > 0) {
      return `Dreamverse backend is running, but GPU warmup failed on ${warmupFailures} worker${warmupFailures === 1 ? '' : 's'}. Check the backend logs and FastVideo/model runtime setup, then retry.`
    }
    if (detail === 'Prompt enhancer not initialized.') {
      return 'Dreamverse backend is still initializing prompt services. Wait for /readyz to return 200 and retry.'
    }
    if (detail === 'No ready GPU worker processes.') {
      return 'Dreamverse backend is running, but GPU workers are not ready yet. Wait for startup warmup to finish and retry.'
    }
    return `Dreamverse backend is not ready yet: ${detail}`
  }

  async function probeBackendReadiness(): Promise<BackendReadinessProbe> {
    const health = await fetchBackendProbe('/healthz')
    if (!health.ok) {
      return {
        ok: false,
        notice: resolveBackendUnavailableNotice(),
      }
    }

    const ready = await fetchBackendProbe('/readyz')
    if (ready.ok) {
      return {
        ok: true,
        notice: '',
      }
    }

    const status = await fetchBackendProbe('/status')
    const readyDetail = isJsonObject(ready.payload) && typeof ready.payload.detail === 'string'
      ? ready.payload.detail.trim() : ''
    const detail = readyDetail || ready.errorMessage
    return {
      ok: false,
      notice: resolveBackendNotReadyNotice(detail, status.payload),
    }
  }

  function clearPendingProjectPointers() {
    clearProjectArchivedClips()
    currentProjectIdRef.current = ''
    harnessProjectIdRef.current = ''
    setOpenedProjectTitle(null)
    streamStore.patch({ currentThumbnail: null })
  }

  function showProjectStartNotice(notice: string) {
    projectControlsStore.patch({
      connected: false,
      connecting: false,
      gpuAssigned: false,
      projectNotice: notice,
      connectionClosed: false,
    })
  }

  /** Release a failed project socket and restore the editable lobby prompt. */
  function recoverFailedProjectStart(notice: string) {
    const ws = wsRef.current
    wsRef.current = null
    detachAndCloseWebSocket(ws)
    const restoredDraft = normalizeInitialPrompt(initialPromptRef.current.rawPrompt)
    const autoExtensionRequested = projectControlsStore.get().autoExtensionRequested
    resetToLobbyState()
    clearPendingProjectPointers()
    initialPromptRef.current = { promptId: null, rawPrompt: '' }
    projectControlsStore.patch({
      connected: false,
      connecting: false,
      gpuAssigned: false,
      livePromptDraft: restoredDraft,
      autoExtensionRequested,
      projectNotice: notice,
      connectionClosed: false,
    })
  }

  function handlePresetGenerate(presetId: string) {
    if (projectControlsStore.get().projectStarted || projectControlsStore.get().projectResetPending) return
    promptWindowStore.setSelectedPresetId(presetId)
    void startProject({ force: true })
  }

  function normalizeInitialPrompt(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
  }

  function shouldStartFromCustomPrompt(prompt?: string): boolean {
    const p = prompt ?? (initialPromptRef.current.rawPrompt || (projectControlsStore.get().livePromptDraft))
    const normalizedPrompt = normalizeInitialPrompt(p)
    return Boolean(normalizeInitialPrompt(initialPromptRef.current.rawPrompt)
      || (!projectControlsStore.get().projectStarted && normalizedPrompt))
  }

  function getInitialPresetId(prompt?: string): string {
    if (shouldStartFromCustomPrompt(prompt)) {
      return sanitizePresetId(promptWindowStore.get().customPresetId) || DEFAULT_CUSTOM_PRESET_ID
    }
    return (promptWindowStore.get().selectedPresetId) || sanitizePresetId(promptWindowStore.get().customPresetId)
  }

  function getInitialPresetLabel(prompt?: string): string {
    if (shouldStartFromCustomPrompt(prompt)) {
      return promptWindowStore.get().customPresetLabel.trim() || 'Custom rollout'
    }
    const selectedPresetLabel = promptWindowStore.get().selectedPreset?.label
    return selectedPresetLabel || promptWindowStore.get().customPresetLabel.trim() || 'Current rollout'
  }

  /** Resolve the displayed clip label from the selected, pending, and live clips, then from the creation preset. */
  function getCurrentClipLabel(): string {
    const stream = streamStore.get()
    if (stream.activeClip?.label) return stream.activeClip.label
    if (stream.pendingInitialClip?.label) return stream.pendingInitialClip.label
    if (stream.liveClip?.label) return stream.liveClip.label
    const initialLabel = getInitialPresetLabel(initialPromptRef.current.rawPrompt || projectControlsStore.get().livePromptDraft)
    if (initialLabel) return initialLabel
    return promptWindowStore.get().selectedPreset?.label || 'Video player'
  }

  /** Use authored preset prompts in creation and retain the developer-selected prompt subset. */
  function getProjectInitialPrompts(): string[] {
    if (shouldStartFromCustomPrompt()) return []
    const prompts = promptWindowStore.get()
    return uiStore.get().devtoolsMode ? prompts.initialPrompts : prompts.previewSegments
  }

  // --- Playback & clip management ---

  function makePromptId(): string {
    return randomUUID()
  }

  function resetPlaybackState() {
    clearThumbnailCaptureTimer()
    avPipeline.reset()
    streamStore.patch({
      loadingAnimation: false,
      mediaAppendError: null,
      avPlaybackStarted: false,
    })
  }

  function clearTtffInterval() {
    if (ttffIntervalRef.current) {
      clearInterval(ttffIntervalRef.current)
      ttffIntervalRef.current = null
    }
  }

  function resetTtffTimer() {
    clearTtffInterval()
    ttffStartAtMsRef.current = null
    setTtffValueMs(null)
  }

  function startTtffTimer() {
    clearTtffInterval()
    ttffStartAtMsRef.current = performance.now()
    setTtffValueMs(0)
    ttffIntervalRef.current = setInterval(() => {
      if (ttffStartAtMsRef.current !== null) {
        setTtffValueMs(performance.now() - ttffStartAtMsRef.current)
      }
    }, 16)
  }

  function clearThumbnailCaptureTimer() {
    if (thumbnailCaptureTimerRef.current !== null) {
      clearTimeout(thumbnailCaptureTimerRef.current)
      thumbnailCaptureTimerRef.current = null
    }
  }

  /** Capture the active clip's frame and attach it to that clip's originating prompt. */
  function markFirstFrameRendered() {
    const now = performance.now()
    if (ttffStartAtMsRef.current !== null && ttffIntervalRef.current) {
      setTtffValueMs(now - ttffStartAtMsRef.current)
      clearTtffInterval()
    }
    if (streamStore.get().lastVideoCompletedAtMs !== null) {
      streamStore.patch({
        timeBetweenVideosMs: now - (streamStore.get().lastVideoCompletedAtMs as number),
        lastVideoCompletedAtMs: null,
      })
    }
    clearThumbnailCaptureTimer()
    const projectId = currentProjectIdRef.current
    const video = videoElRef.current
    const liveClip = streamStore.get().liveClip
    if (!projectId || !video || !liveClip || streamStore.get().activeClip
			|| projectControlsStore.get().projectResetPending) return
    const sourceUrl = video.src
    const sourceObject = video.srcObject
    thumbnailCaptureTimerRef.current = setTimeout(() => {
      thumbnailCaptureTimerRef.current = null
      if (currentProjectIdRef.current !== projectId || videoElRef.current !== video
				|| streamStore.get().liveClip?.id !== liveClip.id
				|| video.src !== sourceUrl || video.srcObject !== sourceObject
				|| streamStore.get().activeClip
				|| projectControlsStore.get().projectResetPending) return
      const thumb = captureVideoThumbnail(video)
      if (thumb) {
        streamStore.patch({ currentThumbnail: thumb })
        const originEvent = rewriteStore.get().promptEvents.find(event => event.promptId === liveClip.originPromptId)
        if (originEvent && (!originEvent.clipId || originEvent.clipId === liveClip.id)) {
          rewriteStore.trackPromptEvent(originEvent.promptId, { resultThumbnail: thumb })
        }
      }
    }, 500)
  }

  function shouldUseArchivedPlaybackFallback(): boolean {
    return typeof avPipeline.usesNativePlaybackFallback === 'function' && avPipeline.usesNativePlaybackFallback()
  }

  /** Copy an archived chunk's bytes into a new `ArrayBuffer`; other values have no bytes to keep. */
  function cloneArchivedChunk(chunk: unknown): ArrayBuffer | null {
    if (chunk instanceof ArrayBuffer) return chunk.slice(0)
    if (ArrayBuffer.isView(chunk)) {
      return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice().buffer
    }
    return null
  }

  /** Copy the archived segments that hold bytes, filling missing stream IDs, keys, and MIME types. */
  function normalizeArchivedSegments(rawSegments: readonly ArchivedSegment[]): ArchivedSegment[] {
    const normalized: ArchivedSegment[] = []
    rawSegments.forEach((segment, index) => {
      const chunks = segment.chunks
        .map(chunk => cloneArchivedChunk(chunk))
        .filter((chunk): chunk is ArrayBuffer => chunk instanceof ArrayBuffer)
      if (chunks.length === 0) return
      const streamId = segment.streamId.trim() || `segment-${index + 1}`
      const segmentIdx = segment.segmentIdx !== null && Number.isInteger(segment.segmentIdx) ? segment.segmentIdx : null
      normalized.push({
        key: segment.key.trim() || `${segmentIdx ?? 'na'}:${streamId}`,
        segmentIdx,
        streamId,
        mime: segment.mime.trim() || DEFAULT_AV_MIME,
        completed: segment.completed,
        chunks,
      })
    })
    return normalized
  }

  async function remuxArchivedSegmentsBestEffort(segments: ArchivedSegment[], label: string): Promise<Blob | null> {
    const normalizedSegments = normalizeArchivedSegments(segments)
    if (normalizedSegments.length === 0) return null

    try {
      return await remuxArchivedFmp4Segments(normalizedSegments, {
        includeInProgress: true,
        mimeType: 'video/mp4',
      })
    } catch (error) {
      try {
        return await remuxArchivedFmp4Segments(normalizedSegments, {
          includeInProgress: false,
          mimeType: 'video/mp4',
        })
      } catch (fallbackError) {
        console.warn('Unable to remux archived segments:', {
          error,
          fallbackError,
          label,
        })
        return null
      }
    }
  }

  /** Archive captured clip metadata and bytes, then link its originating prompt once. */
  async function archiveCompletedClip() {
    const projectId = currentProjectIdRef.current
    const liveClip = streamStore.get().liveClip
    const precedingArchive = clipArchiveQueueRef.current
    const thumbnail = streamStore.get().currentThumbnail
    if (!liveClip || !avPipeline.hasArchivedChunks()) return null
    const previewBlob = avPipeline.buildArchivedStreamBlob()
    let archivedSegments = normalizeArchivedSegments(typeof avPipeline.takeArchivedSegmentSnapshots === 'function' ? avPipeline.takeArchivedSegmentSnapshots({ includeInProgress: true }) : [])
    let chunks = avPipeline.takeArchivedStreamChunks()
    if (liveClip.continuationClipId) {
      // Capture incoming bytes first; archive composition must not delay WebSocket media delivery.
      await precedingArchive
      if (currentProjectIdRef.current !== projectId) return null
      const precedingClip = streamStore.get().completedClips.find(clip => clip.id === liveClip.continuationClipId)
      if (!precedingClip) {
        projectControlsStore.patch({ projectNotice: 'The preceding video is unavailable for continuation playback.' })
        return null
      }
      archivedSegments = [...normalizeArchivedSegments(precedingClip.archivedSegments), ...archivedSegments]
      chunks = [...precedingClip.chunks, ...chunks]
    }
    const rawBlob =
      previewBlob instanceof Blob && previewBlob.size > 0
        ? new Blob(chunks, {
          type: previewBlob.type || DEFAULT_AV_MIME,
        })
        : null
    if (!(rawBlob instanceof Blob) || rawBlob.size === 0) return null

    let blob = rawBlob
    let remuxed = false
    if (archivedSegments.length > 0) {
      const remuxedBlob = await remuxArchivedSegmentsBestEffort(archivedSegments, liveClip.label || 'Generated clip')
      if (remuxedBlob instanceof Blob && remuxedBlob.size > 0) {
        blob = remuxedBlob
        remuxed = true
      }
    }
    if (currentProjectIdRef.current !== projectId) return null
    const objectUrl = URL.createObjectURL(blob)
    const archivedClip = {
      id: liveClip.id,
      originPromptId: liveClip.originPromptId,
      label: liveClip.label || 'Generated clip',
      prompt: liveClip.prompt,
      promptWindowPrompts: clonePromptWindowPrompts(liveClip.promptWindowPrompts),
      mime: blob.type || DEFAULT_AV_MIME,
      blob,
      objectUrl,
      chunks: chunks.map(chunk => chunk.slice(0)),
      archivedSegments,
      remuxed,
      createdAt: Date.now(),
    }
    streamStore.addCompletedClip(archivedClip)
    if (liveClip.continuationClipId && streamStore.get().liveClip?.id === liveClip.id && !streamStore.get().activeClipId) {
      streamStore.selectClip(archivedClip.id, 0)
    }

    // Replays retain the first archived clip's event link and thumbnail.
    const originEvent = rewriteStore.get().promptEvents.find(event => event.promptId === liveClip.originPromptId)
    if (originEvent && !originEvent.clipId) {
      rewriteStore.trackPromptEvent(originEvent.promptId, { clipId: archivedClip.id, resultThumbnail: thumbnail })
    }

    return archivedClip
  }

  function revokeCompletedClipUrls() {
    streamStore.get().completedClips.forEach((clip) => {
      if (clip.objectUrl) URL.revokeObjectURL(clip.objectUrl)
    })
  }

  function clearProjectArchivedClips() {
    revokeCompletedClipUrls()
    streamStore.patch({
      completedClips: [],
    })
  }

  function selectClip(clipId: string, playbackStartTime = 0) {
    const clip = streamStore.get().completedClips.find(item => item.id === clipId) || null
    if (!clip) return
    streamStore.selectClip(clip.id, playbackStartTime)
  }

  /** Finish playback and track clip archiving so project teardown can await it. */
  async function finalizeStreamCompletion() {
    const projectId = currentProjectIdRef.current
    avPipeline.setStreamCompleted(true)
    avPipeline.maybeStartPlayback()
    avPipeline.tryEndStream()
    streamStore.patch({
      loadingAnimation: false,
      avPlaybackStarted: false,
      generatingSeedPromptIndex: null,
      lastVideoCompletedAtMs: performance.now(),
    })
    if (shouldUseArchivedPlaybackFallback()) {
      // Native fallback path: must await archive because the blob
      // is the only way to display the video.
      const archivedClip = await archiveCompletedClip()
      if (currentProjectIdRef.current !== projectId) return
      if (archivedClip) {
        streamStore.selectClip(archivedClip.id, 0)
        streamStore.patch({
          avPlaybackStarted: true,
          loadingAnimation: false,
        })
      } else {
        streamStore.patch({
          activeClipId: '',
          activePlaybackStartTime: 0,
        })
      }
    } else {
      // Capture archive bytes before awaiting remux so a later reset cannot discard them.
      // Let media messages continue while the captured clip is remuxed.
      streamStore.patch({
        activeClipId: '',
        activePlaybackStartTime: 0,
      })
      const archive = archiveCompletedClip()
      clipArchiveQueueRef.current = Promise.all([clipArchiveQueueRef.current, archive]).then(() => {})
    }
    console.log('Received stream media finalized')
  }

  function setSeedPrompts(nextPrompts: string[]) {
    promptWindowStore.setSeedPrompts(nextPrompts)
  }

  // --- Live prompt ---

  function formatPromptWindowEventText(prompts: readonly string[]): string {
    const normalized = prompts.map(prompt => prompt.trim()).filter(prompt => prompt.length > 0)
    return normalized.map((prompt, index) => `[${index + 1}] ${prompt}`).join('\n')
  }

  function parseLatencyMs(value: unknown): number | null {
    const numericValue = Number(value)
    return Number.isFinite(numericValue) ? numericValue : null
  }

  function addPromptEvent(event: PromptEvent) {
    rewriteStore.addPromptEvent(event)
  }

  /** Capture the supplied video's frame for a project or rewrite preview. */
  function captureVideoThumbnail(video: HTMLVideoElement | null): string | null {
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return null
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 160
      canvas.height = Math.round(160 * (video.videoHeight / video.videoWidth))
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/jpeg', 0.7)
    } catch {
      return null
    }
  }

  function summarizePresetPrompt(prompts: readonly string[]): string {
    return prompts
      .map(prompt => prompt.trim())
      .filter(prompt => prompt.length > 0)
      .slice(0, 2)
      .join('\n\n')
  }

  function clonePromptWindowPrompts(prompts: unknown): string[] {
    return normalizePromptWindowSnapshot(prompts)
  }

  function getSelectedEventPromptWindowPrompts(selectedClipId: string): string[] {
    if (!selectedClipId) return []
    const selectedEvent = rewriteStore.get().promptEvents.find(event => event.clipId === selectedClipId)
    return clonePromptWindowPrompts(selectedEvent?.sourcePromptWindowPrompts)
  }

  function getSelectedClipPromptWindowPrompts(): string[] {
    const selectedClipId = streamStore.get().activeClipId.trim()
    if (!selectedClipId) return []
    const selectedClip = streamStore.get().completedClips.find(clip => clip.id === selectedClipId) || null
    const clipPromptWindowPrompts = clonePromptWindowPrompts(selectedClip?.promptWindowPrompts)
    if (clipPromptWindowPrompts.length > 0) {
      return clipPromptWindowPrompts
    }
    return getSelectedEventPromptWindowPrompts(selectedClipId)
  }

  function getActivePromptWindowPrompts(): string[] {
    const selectedClipPrompts = getSelectedClipPromptWindowPrompts()
    if (selectedClipPrompts.length > 0) {
      return selectedClipPrompts
    }
    return clonePromptWindowPrompts(promptWindowStore.get().currentPromptWindowPrompts)
  }

  /** Start one clip from Project's committed origin and prompt window, retaining only a matching label. */
  function buildStreamClip(payload: JsonObject): LiveClip {
    const originPromptId = typeof payload.origin_prompt_id === 'string' ? payload.origin_prompt_id : null
    const stream = streamStore.get()
    const matchingClip = [stream.pendingInitialClip, stream.liveClip].find(clip => clip?.originPromptId === originPromptId)
    const promptWindowPrompts = clonePromptWindowPrompts(payload.prompt_window_prompts)
    return {
      id: makePromptId(),
      originPromptId,
      label: matchingClip?.label || `Cuts ${stream.completedClips.length + 1}`,
      prompt: typeof payload.origin_prompt === 'string' && payload.origin_prompt.trim()
        ? payload.origin_prompt.trim() : summarizePresetPrompt(promptWindowPrompts),
      promptWindowPrompts,
      continuationClipId: payload.continuation === true ? stream.liveClip?.id ?? null : null,
    }
  }

  /** Resolve the live prompt operation: demo mode always continues; otherwise the composer's selection decides. */
  function shouldRewriteLivePrompt(): boolean {
    return !uiStore.get().demoMode && projectControlsStore.get().livePromptRewriteMode
  }

  /** Choose auto_extension for the next submitted request without sending a command. */
  function setAutoExtensionRequested(enabled: boolean) {
    if (canChooseAutoExtension) projectControlsStore.patch({ autoExtensionRequested: enabled })
  }

  /** Stop scheduling auto_extension rounds; the server completes the accepted round before allowing edits. */
  function stopGeneration() {
    const ws = wsRef.current
    const controls = projectControlsStore.get()
    if (!ws || ws.readyState !== WebSocket.OPEN || !controls.autoExtensionEnabled
			|| controls.projectResetPending) return
    ws.send(JSON.stringify({ type: 'stop_auto_extension' }))
  }

  /** Submit the draft as a rollout rewrite or a continuation prompt. */
  async function submitLivePrompt() {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const controls = projectControlsStore.get()
    if (controls.projectResetPending || controls.autoExtensionEnabled || controls.generationRoundStatus === 'preparing'
			|| controls.generationRoundStatus === 'generating') return
    const now = Date.now()
    if (now - lastSubmitTimeRef.current < SUBMIT_COOLDOWN_MS) return
    const submittedDraft = controls.livePromptDraft
    const prompt = submittedDraft.trim()
    if (!prompt) return
    const rewrite = shouldRewriteLivePrompt()
    if (rewrite && rewriteStore.get().rewritingSeedPrompts) return
    if (!lobbyCapabilities) return
    const references = [...selectedReferences]
    const validationError = validateReferenceSelection(referenceMode, references, lobbyCapabilities)
    if (validationError) { projectControlsStore.patch({ projectNotice: validationError }); return }
    const rewriteSourcePromptWindowPrompts = getActivePromptWindowPrompts()
    lastSubmitTimeRef.current = now
    projectControlsStore.patch({ generationRoundStatus: 'preparing', projectNotice: '' })
    let referenceAssetIds: string[]
    try {
      referenceAssetIds = await resolveReferenceAssetIds(references, rememberUploadedReference)
    } catch (error) {
      if (wsRef.current === ws) {
        lastSubmitTimeRef.current = 0
        projectControlsStore.patch({ generationRoundStatus: 'failed', projectNotice: error instanceof Error ? error.message : 'Reference upload failed.' })
      }
      return
    }
    // The socket can close while reference uploads are awaited.
    if (wsRef.current !== ws || !isSocketOpen(ws)) return
    if (rewrite) {
      if (rewriteStore.get().rewritingSeedPrompts) return
      projectControlsStore.patch({ generationRoundStatus: 'preparing' })
      const promptId = makePromptId()
      rewriteStore.patch({ activeRewritePromptId: promptId })
      addPromptEvent({
        promptId,
        status: 'rewrite_requested',
        source: 'user_rewrite',
        text: prompt,
        thumbnail: captureVideoThumbnail(showLivePlayback ? videoElRef.current : (archivedPlaybackElRef.current || videoElRef.current)),
        sourcePromptWindowPrompts: rewriteSourcePromptWindowPrompts,
      })
      ws.send(
        JSON.stringify({
          type: 'rewrite_seed_prompts',
          auto_extension_enabled: controls.autoExtensionRequested,
          reference_asset_ids: referenceAssetIds,
          prompt_id: promptId,
          rewrite_instruction: prompt,
          prompt_window_prompts: normalizePromptWindowSnapshot(
            rewriteSourcePromptWindowPrompts,
          ),
        }),
      )
      projectControlsStore.patch({ autoExtensionRequested: false })
      streamStore.patch({
        activeClipId: shouldUseArchivedPlaybackFallback() ? streamStore.get().activeClipId : '',
        activePlaybackStartTime: shouldUseArchivedPlaybackFallback() ? streamStore.get().activePlaybackStartTime : 0,
      })
      if (projectControlsStore.get().livePromptDraft === submittedDraft) projectControlsStore.patch({ livePromptDraft: '' })
      return
    }
    projectControlsStore.patch({ generationRoundStatus: 'preparing' })
    const promptId = makePromptId()
    addPromptEvent({
      promptId,
      status: 'submitted',
      source: 'user_raw',
      text: prompt,
    })
    ws.send(
      JSON.stringify({
        type: 'append_prompt',
        auto_extension_enabled: controls.autoExtensionRequested,
        reference_asset_ids: referenceAssetIds,
        prompt_id: promptId,
        prompt,
      }),
    )
    projectControlsStore.patch({ autoExtensionRequested: false })
    streamStore.patch({
      activeClipId: shouldUseArchivedPlaybackFallback() ? streamStore.get().activeClipId : '',
      activePlaybackStartTime: shouldUseArchivedPlaybackFallback() ? streamStore.get().activePlaybackStartTime : 0,
    })
    if (projectControlsStore.get().livePromptDraft === submittedDraft) projectControlsStore.patch({ livePromptDraft: '' })
  }

  const PROMPT_MAX_LENGTH = 500

  function handleLivePromptInput(value: string) {
    projectControlsStore.patch({ livePromptDraft: value.slice(0, PROMPT_MAX_LENGTH) })
  }

  const lastSubmitTimeRef = useRef(0)
  const SUBMIT_COOLDOWN_MS = 1000

  function handleLivePromptKeydown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    if (event.shiftKey) return
    event.preventDefault()
    void submitLivePrompt()
  }

  // --- Project lifecycle ---

  /**
	 * Reset project controls after connection and media cleanup, retaining prompt selections and lobby preferences.
	 * Enhancement and rewrite choices remain; the next start derives rewrite mode again.
	 */
  function resetToLobbyState() {
    setProjectCreationConfig(null)
    setVideoMuted(true)
    initialPromptRef.current = { promptId: null, rawPrompt: '' }
    projectControlsStore.patch({
      projectStarted: false,
      connected: false,
      connecting: false,
      gpuAssigned: false,
      queuePosition: 0,
      livePromptDraft: '',
      generationRoundStatus: 'idle',
      autoExtensionEnabled: false, autoExtensionRequested: false,
      enhancementEnabled: projectControlsStore.get().enhancementEnabled,
      promptExtensionError: '',
      projectNotice: '',
      connectionClosed: false,
      projectResetPending: false,
    })
    rewriteStore.resetProjectActivity()
    streamStore.resetPlaybackState()
    promptWindowStore.resetProjectPromptState()
    uiStore.resetPromptEditorState()
    resetTtffTimer()
    resetPlaybackState()
  }

  /** Freeze prompts, settings, and request identity before readiness checks or media uploads. */
  function buildProjectInitPayload(creationConfig: ProjectCreationConfig) {
    const prompt = normalizeInitialPrompt(projectControlsStore.get().livePromptDraft)
    return {
      type: 'project_init_v1',
      generation_mode: toGenerationMode(creationConfig.modeId),
      preset_id: getInitialPresetId(),
      preset_label: getInitialPresetLabel(),
      curated_prompts: getProjectInitialPrompts().slice(0, creationConfig.segmentCount),
      initial_prompt_id: prompt ? makePromptId() : null,
      initial_rollout_prompt: prompt,
      single_clip_mode: false,
      enhancement_enabled: projectControlsStore.get().enhancementEnabled,
      auto_extension_enabled: projectControlsStore.get().autoExtensionRequested,
      loop_generation_enabled: false,
      ...buildCreationInitPayload({ ...creationConfig, referenceAssetIds: [] }),
    }
  }

  /** Reduce messages only for the project that received them. */
  async function handleSocketMessage(ws: WebSocket, event: MessageEvent) {
    if (wsRef.current !== ws) return
    const decoded = await decodeWebSocketEvent(event)
    if (wsRef.current !== ws) return
    if (decoded.kind === 'binary') {
      avPipeline.enqueueChunk(decoded.data)
      return
    }
    if (decoded.kind !== 'json') return
    const normalizedEvent = normalizeSocketMessage(decoded.data)
    if (normalizedEvent.type === 'session/gpu_assigned') {
      applyEchoedCreationConfig(normalizedEvent.payload)
      if (typeof normalizedEvent.payload.project_id === 'string') harnessProjectIdRef.current = normalizedEvent.payload.project_id
    }
    await applyNormalizedSocketEvent(normalizedEvent, {
      projectControlsStore,
      promptWindowStore,
      rewriteStore,
      streamStore,
      avPipeline,
      tick: yieldToEventLoop,
      isPlaybackCurrent: () => wsRef.current === ws && ws.readyState === WebSocket.OPEN,
      defaultAvMime: DEFAULT_AV_MIME,
      fixedRewriteModel: FIXED_REWRITE_MODEL,
      parseLatencyMs,
      formatPromptWindowEventText,
      makePromptId,
      buildStreamClip,
      resetTtffTimer,
      startTtffTimer,
      preserveArchivedPlaybackSelection: shouldUseArchivedPlaybackFallback(),
      finalizeStreamCompletion,
    })
  }

  /**
	 * Open the project's socket with its first message: `project_init_v1` creates a project, `project_open_v1` opens a
	 * stored one. A closed socket keeps the received media; the user reopens the project to continue.
	 */
  function connectWebSocket(payload: ReturnType<typeof buildProjectInitPayload> | ProjectOpenMessage) {
    wsMessageQueueRef.current = Promise.resolve()
    projectControlsStore.patch({ connecting: true, connected: false })
    try {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      let opened = false
      const ws = createWebSocketConnection({
        url: `${wsProtocol}//${window.location.host}/ws`,
        binaryType: 'arraybuffer',
        onOpen: () => {
          if (wsRef.current !== ws) return
          opened = true
          projectControlsStore.patch({ connected: true, connecting: false })
          ws.send(JSON.stringify(payload))
          projectControlsStore.patch({ autoExtensionRequested: false })
        },
        onMessage: (event: MessageEvent) => {
          if (wsRef.current !== ws) return
          wsMessageQueueRef.current = wsMessageQueueRef.current
            .then(() => handleSocketMessage(ws, event))
            .catch((error: unknown) => {
              console.error('Failed to handle websocket message:', error)
            })
        },
        onClose: () => {
          if (wsRef.current !== ws) return
          clearThumbnailCaptureTimer()
          avPipeline.stopPlayback()
          projectControlsStore.patch({
            connected: false, connecting: false, gpuAssigned: false, autoExtensionEnabled: false,
            autoExtensionRequested: opened ? false : projectControlsStore.get().autoExtensionRequested,
            connectionClosed: opened,
          })
          rewriteStore.patch({ activeRewritePromptId: null })
          streamStore.patch({ loadingAnimation: false, generatingSeedPromptIndex: null })
          resetTtffTimer()
          // Complete pending media work before a project reset can release its local state.
          wsMessageQueueRef.current = wsMessageQueueRef.current.then(async () => {
            if (wsRef.current !== ws) return
            if (!opened) {
              const probe = await probeBackendReadiness()
              if (wsRef.current !== ws) return
              recoverFailedProjectStart(projectControlsStore.get().projectNotice || (probe.ok
                ? 'Dreamverse backend closed the connection before the project started. Click Generate to retry.'
                : probe.notice))
              return
            }
            await finalizeStreamCompletion()
            await clipArchiveQueueRef.current
            if (wsRef.current !== ws) return
            const lastClip = streamStore.get().completedClips.at(-1)
            if (lastClip) streamStore.selectClip(lastClip.id, 0)
            projectControlsStore.patch({
              connected: false,
              connecting: false,
              gpuAssigned: false,
              connectionClosed: true,
              autoExtensionEnabled: false, autoExtensionRequested: false,
            })
          })
        },
      })
      wsRef.current = ws
    } catch (error) {
      recoverFailedProjectStart(error instanceof Error ? error.message : 'Failed to connect to Dreamverse.')
    }
  }

  function applyEchoedCreationConfig(data: unknown) {
    const echoed = parseEchoedCreationConfig(data)
    if (!echoed) {
      return
    }
    setProjectCreationConfig(echoed)
  }

  /** Allocate local project state and its initial request identity before connecting. */
  function beginProjectLocally(
    creationConfig: ProjectCreationConfig,
    payload: ReturnType<typeof buildProjectInitPayload>,
    { force = false } = {},
  ) {
    if (!force && !canStartProject) return
    if (projectControlsStore.get().projectStarted || projectControlsStore.get().projectResetPending) return false
    setProjectCreationConfig(creationConfig)
    // Unmute during the user gesture so iOS Safari permits audio playback.
    setVideoMuted(false)
    clearProjectArchivedClips()
    currentProjectIdRef.current = makePromptId()
    harnessProjectIdRef.current = ''
    setOpenedProjectTitle(null)
    streamStore.patch({ currentThumbnail: null })
    const initialPrompt = payload.initial_rollout_prompt
    initialPromptRef.current = { promptId: payload.initial_prompt_id, rawPrompt: initialPrompt }
    const rCAR = !uiStore.get().devtoolsMode && !uiStore.get().demoMode
    projectControlsStore.patch({
      projectNotice: '',
      connectionClosed: false,
      promptExtensionError: '',
      projectStarted: true,
      livePromptDraft: '',
      livePromptRewriteMode: rCAR || Boolean(initialPrompt),
      generationRoundStatus: 'preparing',
      projectResetPending: false,
    })
    resetPlaybackState()
    streamStore.patch({
      loadingAnimation: true,
      playingSeedPromptIndex: null,
      generatingSeedPromptIndex: null,
      seedPromptIndexBySegment: {},
    })
    rewriteStore.resetProjectActivity()
    const initialPromptId = initialPromptRef.current.promptId
    if (initialPrompt && initialPromptId) {
      rewriteStore.patch({ activeRewritePromptId: initialPromptId })
      addPromptEvent({
        promptId: initialPromptId,
        status: 'rewrite_requested',
        source: 'user_rewrite',
        text: initialPrompt,
      })
    }
    setSeedPrompts(payload.curated_prompts)
    streamStore.patch({
      pendingInitialClip: {
        originPromptId: initialPromptRef.current.promptId,
        label: payload.preset_label || 'Preset story',
      },
      liveClip: null,
      activeClipId: '',
      activePlaybackStartTime: 0,
    })
    return true
  }

  /** Admit one creation snapshot before readiness and retain it through local and socket initialization. */
  async function startProject({ force = false } = {}) {
    const controls = projectControlsStore.get()
    if (controls.connecting || controls.projectStarted || controls.projectResetPending) return
    if (lobbyCreation.status !== 'available') return
    const connectionAttempt = ++connectionAttemptRef.current
    const references = lobbyCreation.selection.modeId === 't2v' ? [] : [...referenceDraft]
    const validationError = validateLobbyCreationSelection({
      capabilities: lobbyCreation.capabilities,
      ...lobbyCreation.selection,
      references,
    })
    if (validationError) {
      showProjectStartNotice(validationError)
      return
    }

    const creationConfig: ProjectCreationConfig = {
      modelId: lobbyCreation.capabilities.model_id,
      ...lobbyCreation.selection,
    }
    const authoredPrompts = getProjectInitialPrompts()
    if (authoredPrompts.length > 0 && authoredPrompts.length < creationConfig.segmentCount) {
      creationConfig.segmentCount = authoredPrompts.length
      handleLobbySelectionChange({ segmentCount: creationConfig.segmentCount })
    }
    const payload = buildProjectInitPayload(creationConfig)
    showProjectStartNotice('')
    streamStore.patch({ loadingAnimation: true })
    projectControlsStore.patch({ connecting: true })
    const probe = await probeBackendReadiness()
    if (connectionAttemptRef.current !== connectionAttempt) return
    if (!probe.ok) {
      streamStore.patch({ loadingAnimation: false })
      showProjectStartNotice(probe.notice)
      return
    }
    try {
      payload.reference_asset_ids = await resolveReferenceAssetIds(references, rememberUploadedReference)
    } catch (error) {
      if (connectionAttemptRef.current !== connectionAttempt) return
      streamStore.patch({ loadingAnimation: false })
      showProjectStartNotice(error instanceof Error ? error.message : 'Reference upload failed.')
      return
    }
    if (connectionAttemptRef.current !== connectionAttempt) return
    if (!beginProjectLocally(creationConfig, payload, { force })) {
      streamStore.patch({ loadingAnimation: false })
      projectControlsStore.patch({ connecting: false })
      return
    }
    connectWebSocket(payload)
  }

  /** Replace the sidebar's project list with the harness list; a failed read keeps the shown list. */
  async function refreshProjectList() {
    try {
      setProjectSummaries(await listProjects())
    } catch (error) {
      console.error('Failed to load projects:', error)
    }
  }

  /** Delete a harness project, showing the harness's reason in the sidebar when it refuses. */
  async function handleDeleteProject(projectId: string) {
    try {
      await deleteProject(projectId)
      setProjectListNotice('')
    } catch (error) {
      setProjectListNotice(error instanceof Error ? error.message : 'Failed to delete the project.')
    }
    await refreshProjectList()
  }

  /**
   * Build one completed clip from a stored round: download its segment videos in order and remux them into one MP4,
   * keeping the concatenated fMP4 when remuxing fails. The clip lives only in page memory.
   */
  async function buildStoredRoundClip(round: ProjectRound, label: string): Promise<CompletedClip | null> {
    const segmentBytes = await Promise.all(round.segments.map(segment => fetchSegmentVideo(segment.video_url)))
    const archivedSegments: ArchivedSegment[] = round.segments.map((segment, index) => ({
      key: `${index + 1}:${segment.segment_id}`,
      segmentIdx: index + 1,
      streamId: segment.segment_id,
      mime: segment.mime || DEFAULT_AV_MIME,
      completed: true,
      chunks: [segmentBytes[index] ?? new ArrayBuffer(0)],
    }))
    const chunks = archivedSegments.flatMap(segment => segment.chunks)
    if (chunks.length === 0) return null
    const remuxedBlob = await remuxArchivedSegmentsBestEffort(archivedSegments, label)
    const remuxed = remuxedBlob instanceof Blob && remuxedBlob.size > 0
    const blob = remuxed ? remuxedBlob : new Blob(chunks, { type: archivedSegments[0]?.mime ?? DEFAULT_AV_MIME })
    const prompts = round.segments.map(segment => segment.prompt)
    return {
      id: makePromptId(),
      originPromptId: null,
      label,
      prompt: round.instruction?.trim() || summarizePresetPrompt(prompts),
      promptWindowPrompts: prompts,
      mime: blob.type || DEFAULT_AV_MIME,
      blob,
      objectUrl: URL.createObjectURL(blob),
      chunks: chunks.map(chunk => chunk.slice(0)),
      archivedSegments,
      remuxed,
      createdAt: Date.now(),
    }
  }

  /**
   * Open a harness project: leave the current project, rebuild the stored rounds as completed clips, fill the prompt
   * window with the last round's prompts, then attach a socket with `project_open_v1`. The project becomes active when
   * `gpu_assigned` arrives. A later open, leave, or start supersedes an unfinished open.
   * @param projectId - the harness project ID.
   */
  async function openProject(projectId: string) {
    const controls = projectControlsStore.get()
    if (controls.connecting || controls.projectResetPending) return
    setSidebarOpen(false)
    if (controls.projectStarted || controls.connectionClosed) await leaveProject()
    const connectionAttempt = ++connectionAttemptRef.current
    projectControlsStore.patch({ projectStarted: true, connecting: true, projectNotice: '', generationRoundStatus: 'idle' })
    streamStore.patch({ loadingAnimation: true })
    const clips: CompletedClip[] = []
    let title: string
    let creationConfig: ProjectCreationConfig | null
    let lastRoundPrompts: string[]
    try {
      const project = await getProject(projectId)
      title = project.title
      creationConfig = parseEchoedCreationConfig({ creation_config: project.creation_config })
      lastRoundPrompts = project.rounds.at(-1)?.segments.map(segment => segment.prompt) ?? []
      for (const round of project.rounds) {
        // The first round carries the project's title, as a live first round carries its preset label.
        const clip = await buildStoredRoundClip(round, clips.length === 0 ? project.title : `Cuts ${clips.length + 1}`)
        if (clip) clips.push(clip)
        if (connectionAttemptRef.current !== connectionAttempt) break
      }
    } catch (error) {
      clips.forEach((clip) => { URL.revokeObjectURL(clip.objectUrl) })
      if (connectionAttemptRef.current !== connectionAttempt) return
      resetToLobbyState()
      showProjectStartNotice(error instanceof Error ? error.message : 'Failed to open the project.')
      return
    }
    if (connectionAttemptRef.current !== connectionAttempt) {
      clips.forEach((clip) => { URL.revokeObjectURL(clip.objectUrl) })
      return
    }
    currentProjectIdRef.current = makePromptId()
    harnessProjectIdRef.current = projectId
    setOpenedProjectTitle(title)
    setProjectCreationConfig(creationConfig)
    rewriteStore.resetProjectActivity()
    setSeedPrompts(lastRoundPrompts)
    const lastClip = clips.at(-1) ?? null
    // The last clip stays the live clip, as after a live round, so a continuation round prepends its media.
    streamStore.patch({
      completedClips: clips,
      liveClip: lastClip ? {
        id: lastClip.id,
        originPromptId: null,
        label: lastClip.label,
        prompt: lastClip.prompt,
        promptWindowPrompts: [...lastClip.promptWindowPrompts],
        continuationClipId: null,
      } : null,
      pendingInitialClip: null,
      loadingAnimation: false,
    })
    if (lastClip) streamStore.selectClip(lastClip.id, 0)
    connectWebSocket({ type: 'project_open_v1', project_id: projectId })
  }

  /** Reopen the disconnected project by its harness ID. */
  function reconnectProject() {
    const projectId = harnessProjectIdRef.current
    if (projectId) void openProject(projectId)
  }

  /** Close the project's connection and finish archiving received media before returning to the lobby. */
  async function leaveProject() {
    if (projectControlsStore.get().projectResetPending) return
    clearThumbnailCaptureTimer()
    connectionAttemptRef.current += 1
    projectControlsStore.patch({ projectResetPending: true, connected: false, connecting: false, gpuAssigned: false })
    const ws = wsRef.current
    wsRef.current = null
    detachAndCloseWebSocket(ws)
    avPipeline.stopPlayback()
    await wsMessageQueueRef.current
    await finalizeStreamCompletion()
    await clipArchiveQueueRef.current
    clearPendingProjectPointers()
    // Explicit departure clears references; failed-start recovery keeps them for retry.
    setReferenceDraft([])
    resetToLobbyState()
  }

  async function handleStartNewProject() {
    setSidebarOpen(false)
    await leaveProject()
  }

  /** Share or download supplied video bytes using their prompt as the filename. */
  async function triggerBlobDownload(blob: Blob, prompt: string) {
    const ext = blob.type.includes('webm') ? 'webm' : 'mp4'
    const sanitizedPrompt = prompt
      .replace(/[^a-zA-Z0-9 _-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .substring(0, 60)
    const safeName = sanitizedPrompt || 'video'
    const fileName = `${safeName}.${ext}`
    const mimeType = blob.type || `video/${ext}`

    // Use Web Share API on touch-first devices (phones/tablets) for camera-roll access.
    // "pointer: coarse" excludes desktops where canShare exists but a share dialog is unwanted.
    if (typeof navigator.canShare === 'function' && window.matchMedia('(pointer: coarse)').matches) {
      try {
        const file = new File([blob], fileName, { type: mimeType })
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] })
          return
        }
      } catch (error) {
        // The user dismissed the share sheet; any other share failure falls back to a download.
        if (errorProperty(error, 'name') === 'AbortError') return
      }
    }

    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  /** Export selected completed media, or live media with its own prompt. */
  async function handleDownloadVideo() {
    if (downloadInFlightRef.current) return
    downloadInFlightRef.current = true
    try {
      const stream = streamStore.get()
      const selectedClip = stream.activeClip
      if (selectedClip?.blob instanceof Blob) {
        await triggerBlobDownload(selectedClip.blob, selectedClip.prompt || '')
        return
      }

      const liveSegments = normalizeArchivedSegments(typeof avPipeline.buildArchivedSegmentSnapshots === 'function' ? avPipeline.buildArchivedSegmentSnapshots({ includeInProgress: true }) : [])
      if (liveSegments.length > 0) {
        const livePrompt = stream.liveClip?.prompt || ''
        const remuxedBlob = await remuxArchivedSegmentsBestEffort(liveSegments, currentClipLabel)
        if (remuxedBlob instanceof Blob && remuxedBlob.size > 0) {
          await triggerBlobDownload(remuxedBlob, livePrompt)
        }
        return
      }

      const latestCompletedClip = stream.completedClips.at(-1) || null
      if (latestCompletedClip?.blob instanceof Blob) {
        await triggerBlobDownload(latestCompletedClip.blob, latestCompletedClip.prompt || '')
      }
    } finally {
      downloadInFlightRef.current = false
    }
  }

  // --- Render ---

  if (!runtimeReady) {
    return null
  }

  const showActiveProject = (projectStarted) || (connectionClosed)

  return (
    <main className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
      {assetLibrary}
      {renderSlot('dreamverse.sidebar', {
        onOpenAssets: () => { setSidebarOpen(false); setAssetsOpen(true) },
        open: sidebarOpen,
        currentProjectId: harnessProjectIdRef.current,
        currentProjectLabel: currentProjectTitle,
        hasCurrentProject: showActiveProject,
        connectionClosed: connectionClosed,
        projectResetPending: projectResetPending,
        projects: projectSummaries,
        notice: projectListNotice,
        onClose: () => { setSidebarOpen(false) },
        onSelectProject: (projectId) => { void openProject(projectId) },
        onDeleteProject: (projectId) => { void handleDeleteProject(projectId) },
        onNewProject: () => {
          setSidebarOpen(false)
          void handleStartNewProject()
        },
      })}
      <Header onToggleSidebar={() => { setSidebarOpen(prev => !prev) }} />

      <div className={cn('relative flex flex-1 min-h-0 flex-col', showActiveProject ? 'justify-center px-4 pb-2 sm:px-6 sm:pb-12' : 'overflow-hidden')}>
        <div className="contents">
          <AnimatePresence>
            {showActiveProject && (
              <motion.div
                key="video-player"
                layout="position"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{
                  layout: { type: 'spring', stiffness: 200, damping: 25 },
                  opacity: { duration: 0.4, ease: 'easeOut' },
                  scale: { duration: 0.4, ease: 'easeOut' },
                }}
                className="relative z-30 w-full shrink-0"
              >
                {renderSlot('dreamverse.player', {
                  videoRef: videoRefCallback,
                  archivedPlaybackRef: archivedPlaybackRefCallback,
                  activeClip: activeClip
                    ? {
                      ...activeClip,
                      playbackStartTime: activePlaybackStartTime,
                    }
                    : null,
                  projectStarted: projectStarted,
                  avPlaybackStarted: avPlaybackStarted,
                  mediaAppendError: mediaAppendError,
                  gpuAssigned: gpuAssigned,
                  connected: connected,
                  queuePosition: queuePosition,
                  loadingAnimation: loadingAnimation,
                  showLivePlayback: showLivePlayback,
                  defaultMuted: videoMuted,
                  canDownload: canDownloadVideo,
                  onPlaying: markFirstFrameRendered,
                  onDownload: () => { void handleDownloadVideo() },
                })}
              </motion.div>
            )}
          </AnimatePresence>

          <section className={cn('mx-auto w-full max-w-2xl', hasEdits && 'flex-1 min-h-0 overflow-y-auto')}>
            {renderSlot('dreamverse.workspace', {
              promptEvents,
              originalLabel: openedProjectTitle || initialPromptRef.current.rawPrompt || selectedPreset?.label || '',
              projectStarted,
              originalClipId: completedClips[0]?.id || '',
              selectedClipId: activeClipId || '',
              onSelectOriginal: () => {
                const firstClip = completedClips[0]
                if (firstClip) selectClip(firstClip.id, 0)
              },
              onSelectEvent: (event) => {
                if (event.clipId) selectClip(event.clipId, 0)
              },
              onSelectCurrent: () => {
                const lastClip = completedClips.at(-1)
                if (projectStarted && !connectionClosed) {
                  // Return to live playback
                  streamStore.patch({ activeClipId: '', activePlaybackStartTime: 0 })
                } else if (lastClip) {
                  selectClip(lastClip.id, 0)
                }
              },
            })}
          </section>

          {!showActiveProject ? (
            renderSlot('dreamverse.creation-studio', {
              value: livePromptDraft,
              disabled: projectResetPending,
              isGenerating: loadingAnimation,
              canSubmit: canStartProject,
              autoExtensionRequested: autoExtensionRequested,
              onAutoExtensionRequestChange: setAutoExtensionRequested,
              selection: lobbyCreation.selection,
              referencePicker: referencePicker,
              mentionOptions: mentionOptions,
              storyPresets: lobbyStoryPresets,
              capabilities: lobbyCapabilities,
              capabilityNotice: capabilityNotice,
              onValueChange: value => projectControlsStore.patch({ livePromptDraft: value }),
              onSubmit: () => void startProject(),
              onSelectionChange: handleLobbySelectionChange,
              onPresetGenerate: handlePresetGenerate,
              onOpenAssets: () => { setAssetsOpen(true) },
            })
          ) : (
            <motion.div layout="position" className="mx-auto w-full max-w-2xl shrink-0" transition={{ type: 'spring', stiffness: 200, damping: 25 }}>
              {renderSlot('dreamverse.chatbar', {
                referencePicker: referencePicker,
                projectStarted: projectStarted,
                generationRoundBusy: generationRoundBusy,
                autoExtensionEnabled: autoExtensionEnabled,
                autoExtensionRequested: autoExtensionRequested,
                canChooseAutoExtension: canChooseAutoExtension,
                onAutoExtensionRequestChange: setAutoExtensionRequested,
                onStopGeneration: stopGeneration,
                rewriteMode: shouldRewriteLivePrompt(),
                onRewriteModeChange: uiStore.get().demoMode
                  ? undefined
                  : (rewrite: boolean) => { projectControlsStore.patch({ livePromptRewriteMode: rewrite }) },
                isGenerating: loadingAnimation,
                storyPresets,
                continuationDraft: livePromptDraft,
                canStartProject: canStartProject,
                canSubmitContinuation: canSubmitContinuation,
                connectionClosed: connectionClosed,
                projectNotice: projectNotice,
                projectResetPending: projectResetPending,
                projectCreationConfig: projectCreationConfig,
                configPillsReadOnly: true,
                onPresetGenerate: handlePresetGenerate,
                onContinuationInput: handleLivePromptInput,
                onContinuationKeydown: handleLivePromptKeydown,
                onGenerate: () => { void startProject() },
                onSubmitContinuation: () => { void submitLivePrompt() },
                onLeave: () => { void leaveProject() },
                onStartNewProject: () => { void handleStartNewProject() },
                onReconnect: harnessProjectIdRef.current ? reconnectProject : undefined,
              })}
            </motion.div>
          )}

          {projectNotice && !showActiveProject && (
            <div className="mx-auto mt-2 w-full max-w-3xl px-4">
              <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-2.5 text-center text-xs text-rose-700 dark:text-rose-300">
                {projectNotice}
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
