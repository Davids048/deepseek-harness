import type { JsonObject } from '../json.ts'
import type { ProjectControlsStore } from '../stores/projectControls.ts'
import type { PromptWindowStore } from '../stores/promptWindow.ts'
import type { RewriteStore } from '../stores/rewrite.ts'
import type { LiveClip, StreamStore } from '../stores/stream.ts'
import type { NormalizedSocketMessage } from './protocol.ts'

/** The media pipeline operations that project-socket events drive. */
export interface SocketMediaPipeline {
  reset(): void
  setStreamCompleted(value: boolean): void
  noteSegmentInit(meta: { segmentIdx: number | null; streamId: string; mime: string }): void
  noteSegmentComplete(meta: { segmentIdx: number | null; streamId: string }): void
  maybeStartPlayback(): void
  ensurePipeline(mime: string, isPlaybackCurrent: () => boolean): Promise<void>
  hasArchivedChunks(): boolean
}

/** The page stores, media pipeline, and page callbacks that project-socket events update. */
export interface SocketEventContext {
  projectControlsStore: ProjectControlsStore
  promptWindowStore: PromptWindowStore
  rewriteStore: RewriteStore
  streamStore: StreamStore
  avPipeline: SocketMediaPipeline
  /** Yields to the event loop before media initialization. */
  tick: () => Promise<void>
  /** Whether the socket that received the event still owns playback. */
  isPlaybackCurrent: () => boolean
  defaultAvMime: string
  /** The rewrite model shown when a rewrite event names none. */
  fixedRewriteModel: string
  parseLatencyMs: (value: unknown) => number | null
  formatPromptWindowEventText: (prompts: readonly string[]) => string
  makePromptId: () => string
  buildStreamClip: (payload: JsonObject) => LiveClip
  resetTtffTimer: () => void
  startTtffTimer: () => void
  /** Keep the selected archived clip while a new stream starts (native playback fallback). */
  preserveArchivedPlaybackSelection: boolean
  finalizeStreamCompletion: () => Promise<void>
}

/** The field's value when it is a string. */
function stringField(payload: JsonObject, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' ? value : undefined
}

/** The field's value when it is an integer, otherwise `null`. */
function integerField(payload: JsonObject, key: string): number | null {
  const value = payload[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

/** The field's trimmed value when it is a string with text. */
function trimmedField(payload: JsonObject, key: string): string | undefined {
  return stringField(payload, key)?.trim() || undefined
}

/** Whether a rejection is an abort, which any error-like object can report through its `name`. */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

/**
 * Preserve the actionable server notice shown beside project controls.
 * @param payload - the server `error` message.
 * @returns the trimmed server message, or a generic notice when it has none.
 */
function resolveProjectErrorMessage(payload: JsonObject): string {
  return trimmedField(payload, 'message') ?? 'An error occurred. Please start a new project.'
}

/**
 * Apply one ordered project event to its UI stores and media pipeline.
 * @param event - the reducer event of one server message.
 * @param context - the stores, media pipeline, and page callbacks to update.
 */
export async function applyNormalizedSocketEvent(
  event: NormalizedSocketMessage,
  context: SocketEventContext,
): Promise<void> {
  const {
    projectControlsStore,
    promptWindowStore,
    rewriteStore,
    streamStore,
    avPipeline,
    tick,
    isPlaybackCurrent,
    defaultAvMime,
    fixedRewriteModel,
    parseLatencyMs,
    formatPromptWindowEventText,
    makePromptId,
    buildStreamClip,
    resetTtffTimer,
    startTtffTimer,
    preserveArchivedPlaybackSelection,
    finalizeStreamCompletion,
  } = context

  const payload = event.payload
  const promptId = stringField(payload, 'prompt_id')
  projectControlsStore.applyServerUiMessage(payload)

  switch (event.type) {
    case 'prompt/received':
      if (promptId) rewriteStore.trackPromptEvent(promptId, { status: 'queued' })
      return

    case 'prompt/enhancing':
      if (promptId) rewriteStore.trackPromptEvent(promptId, { status: 'enhancing' })
      return

    case 'prompt/ready':
      if (promptId) {
        rewriteStore.trackPromptEvent(promptId, {
          status: 'ready',
          source: stringField(payload, 'source') || 'user_raw',
          text: stringField(payload, 'prompt'),
        })
      }
      return

    case 'prompt_window/updated': {
      const nextPrompts = Array.isArray(payload.prompts)
        ? payload.prompts.filter((prompt: unknown): prompt is string => typeof prompt === 'string')
        : []
      promptWindowStore.replacePromptWindow(nextPrompts, { syncEditable: true })
      const latencyMs = parseLatencyMs(payload.latency_ms)
      const rewriteModel = trimmedField(payload, 'model') ?? fixedRewriteModel
      const rawLlmOutput = stringField(payload, 'raw_llm_output')?.trim() ?? ''
      rewriteStore.addPromptEvent({
        promptId: makePromptId(),
        status: 'rewrite_ready',
        source: 'llm_rewrite',
        model: rewriteModel,
        latencyMs,
        text: formatPromptWindowEventText(nextPrompts),
      })
      if (rawLlmOutput) {
        rewriteStore.addPromptEvent({
          promptId: makePromptId(),
          status: 'rewrite_raw_output',
          source: 'llm_rewrite',
          model: rewriteModel,
          latencyMs,
          text: rawLlmOutput,
        })
      }
      return
    }

    case 'rewrite/completed': {
      rewriteStore.finishRewriteRequest(promptId)
      const error = stringField(payload, 'error')
      if (error) {
        rewriteStore.addPromptEvent({
          promptId: makePromptId(),
          status: 'rewrite_error',
          source: 'llm_rewrite',
          model: trimmedField(payload, 'model') ?? fixedRewriteModel,
          latencyMs: parseLatencyMs(payload.latency_ms),
          text: error,
        })
      }
      return
    }

    case 'session/generation_round_status':
      if (payload.status === 'idle' || payload.status === 'failed') {
        rewriteStore.patch({ activeRewritePromptId: null })
        streamStore.patch({ loadingAnimation: false, generatingSeedPromptIndex: null })
        resetTtffTimer()
      }
      if (payload.status === 'failed' && avPipeline.hasArchivedChunks()) {
        await finalizeStreamCompletion()
      }
      return

    case 'stream/started': {
      const liveClip = buildStreamClip(payload)
      promptWindowStore.setSeedPrompts(liveClip.promptWindowPrompts)
      projectControlsStore.patch({
        projectNotice: '',
        promptExtensionError: '',
      })
      streamStore.patch({
        mediaAppendError: null,
        loadingAnimation: true,
        playingSeedPromptIndex: null,
        generatingSeedPromptIndex: null,
        seedPromptIndexBySegment: {},
        liveClip,
        pendingInitialClip: null,
        currentThumbnail: null,
        activeClipId: preserveArchivedPlaybackSelection ? streamStore.get().activeClipId : '',
        activePlaybackStartTime: preserveArchivedPlaybackSelection ? streamStore.get().activePlaybackStartTime : 0,
      })
      avPipeline.reset()
      avPipeline.setStreamCompleted(false)
      startTtffTimer()
      return
    }

    case 'stream/media_init': {
      const mime = stringField(payload, 'mime') ?? ''
      streamStore.patch({
        mediaAppendError: null,
        loadingAnimation: streamStore.get().avPlaybackStarted ? streamStore.get().loadingAnimation : true,
        activeClipId: preserveArchivedPlaybackSelection ? streamStore.get().activeClipId : '',
        activePlaybackStartTime: preserveArchivedPlaybackSelection ? streamStore.get().activePlaybackStartTime : 0,
      })
      avPipeline.noteSegmentInit({
        segmentIdx: integerField(payload, 'segment_idx'),
        streamId: stringField(payload, 'stream_id') ?? '',
        mime,
      })

      try {
        await tick()
        if (!isPlaybackCurrent()) return
        await avPipeline.ensurePipeline(mime || defaultAvMime, isPlaybackCurrent)
      } catch (error) {
        if (!isPlaybackCurrent() || isAbortError(error)) return
        streamStore.patch({
          mediaAppendError: 'Unable to initialize AV streaming.',
          avPlaybackStarted: false,
        })
        console.error('media_init failed:', error)
      }
      return
    }

    case 'stream/media_segment_complete': {
      const completedSegment = integerField(payload, 'segment_idx')
      avPipeline.noteSegmentComplete({
        segmentIdx: completedSegment,
        streamId: stringField(payload, 'stream_id') ?? '',
      })
      avPipeline.maybeStartPlayback()

      if (completedSegment !== null) {
        const completedSeedIndex = streamStore.get().seedPromptIndexBySegment[completedSegment]
        if (completedSeedIndex !== undefined) {
          const generatingSeedPromptIndex = streamStore.get().generatingSeedPromptIndex
          streamStore.patch({
            playingSeedPromptIndex: completedSeedIndex,
            generatingSeedPromptIndex: generatingSeedPromptIndex === completedSeedIndex ? null : generatingSeedPromptIndex,
          })
        }
      }
      return
    }

    case 'segment/started': {
      const seedIndex = integerField(payload, 'seed_prompt_index')
      if (promptId) {
        const promptEvent = rewriteStore.get().promptEvents.find(entry => entry.promptId === promptId)
        rewriteStore.trackPromptEvent(promptId, {
          status: 'consumed',
          // Rewrite origin identifies its conversation card and remains stable after prompt enhancement.
          source: promptEvent?.source === 'user_rewrite' ? 'user_rewrite' : stringField(payload, 'source'),
        })
      }

      const segmentIdx = integerField(payload, 'segment_idx')
      const stream = streamStore.get()
      const nextSeedPromptIndexBySegment = seedIndex !== null && segmentIdx !== null
        ? { ...stream.seedPromptIndexBySegment, [segmentIdx]: seedIndex }
        : stream.seedPromptIndexBySegment

      streamStore.patch({
        generatingSeedPromptIndex: seedIndex,
        playingSeedPromptIndex: stream.playingSeedPromptIndex === null ? seedIndex : stream.playingSeedPromptIndex,
        seedPromptIndexBySegment: nextSeedPromptIndexBySegment,
      })

      return
    }

    case 'stream/completed':
      projectControlsStore.patch({
        projectNotice: '',
      })
      await finalizeStreamCompletion()
      return

    case 'session/error': {
      const errorMessage = resolveProjectErrorMessage(payload)
      projectControlsStore.patch({
        promptExtensionError: '',
        projectNotice: errorMessage,
      })
      rewriteStore.finishRewriteRequest(promptId)
      if (promptId) {
        rewriteStore.trackPromptEvent(promptId, { status: 'failed' })
      }
      console.error('[StreamingError]', stringField(payload, 'message') || payload)
      return
    }

    case 'session/queue_status':
    case 'session/gpu_assigned':
    case 'server/unhandled':
      return
  }
}

export { resolveProjectErrorMessage }
