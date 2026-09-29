/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'

import { createProjectControlsStore } from '../../../src/client/stores/projectControls.ts'
import { createPromptWindowStore } from '../../../src/client/stores/promptWindow.ts'
import { createRewriteStore } from '../../../src/client/stores/rewrite.ts'
import { createStreamStore } from '../../../src/client/stores/stream.ts'
import { normalizeSocketMessage } from '../../../src/client/ws/protocol.ts'
import {
  applyNormalizedSocketEvent,
  resolveProjectErrorMessage,
  type SocketEventContext,
  type SocketMediaPipeline,
} from '../../../src/client/ws/reducer.ts'

describe('resolveProjectErrorMessage', () => {
  it('preserves an actionable server message', () => {
    expect(resolveProjectErrorMessage({ message: '  Prompt preparation failed. Try another prompt.  ' }))
      .toBe('Prompt preparation failed. Try another prompt.')
  })
})

/** Record media pipeline calls without a media element. */
function createMediaPipeline() {
  return {
    reset: vi.fn<SocketMediaPipeline['reset']>(),
    setStreamCompleted: vi.fn<SocketMediaPipeline['setStreamCompleted']>(),
    noteSegmentInit: vi.fn<SocketMediaPipeline['noteSegmentInit']>(),
    noteSegmentComplete: vi.fn<SocketMediaPipeline['noteSegmentComplete']>(),
    maybeStartPlayback: vi.fn<SocketMediaPipeline['maybeStartPlayback']>(),
    ensurePipeline: vi.fn<SocketMediaPipeline['ensurePipeline']>(),
    hasArchivedChunks: vi.fn<SocketMediaPipeline['hasArchivedChunks']>(),
  } satisfies SocketMediaPipeline
}

/** Use real stores to verify notification effects on prompt inspection and round admission. */
function createContext() {
  let nextPromptId = 0
  return {
    projectControlsStore: createProjectControlsStore({ generationRoundStatus: 'generating' }),
    promptWindowStore: createPromptWindowStore({ editableMode: true }),
    rewriteStore: createRewriteStore(),
    streamStore: createStreamStore(),
    avPipeline: createMediaPipeline(),
    tick: vi.fn(),
    isPlaybackCurrent: vi.fn(),
    defaultAvMime: 'video/mp4',
    fixedRewriteModel: 'gpt-oss-120b',
    parseLatencyMs: Number,
    formatPromptWindowEventText: prompts => prompts.join('\n'),
    makePromptId: () => `event-${++nextPromptId}`,
    buildStreamClip: vi.fn(),
    resetTtffTimer: vi.fn(),
    startTtffTimer: vi.fn(),
    preserveArchivedPlaybackSelection: false,
    finalizeStreamCompletion: vi.fn(),
  } satisfies SocketEventContext
}

describe('browser notification effects', () => {
  /** Stream acceptance owns the inspector's exact prompt window while editor drafts stay local. */
  it.each([
    ['capped preset', ['River source']],
    ['continuation', ['River source', 'River delta']],
  ])('shows the accepted %s window without replacing editor drafts', async (_scenario, prompts) => {
    const context = createContext()
    context.promptWindowStore.patch({ editableSegments: ['Draft one', 'Draft two'], seedPrompts: ['Previous window'] })
    await applyNormalizedSocketEvent(normalizeSocketMessage({
      type: 'ltx2_stream_start', prompt_window_prompts: prompts,
    }), {
      ...context,
      buildStreamClip: payload => ({
        id: 'live-clip', originPromptId: null, label: '', prompt: '', continuationClipId: null,
        promptWindowPrompts: Array.isArray(payload.prompt_window_prompts)
          ? payload.prompt_window_prompts.filter((prompt: unknown): prompt is string => typeof prompt === 'string')
          : [],
      }),
      avPipeline: createMediaPipeline(),
      startTtffTimer: vi.fn(),
    })
    expect(context.promptWindowStore.get()).toMatchObject({
      currentPromptWindowPrompts: prompts, editableSegments: ['Draft one', 'Draft two'],
    })
  })

  /** One segment announcement owns both prompt activity and the prompt-to-media index. */
  it('marks the matching prompt consumed and advances prompt badges on media completion', async () => {
    const context = createContext()
    context.rewriteStore.addPromptEvent({ promptId: 'continue-1', status: 'ready', text: 'Follow the river' })
    context.streamStore.patch({ playingSeedPromptIndex: 0 })
    await applyNormalizedSocketEvent(normalizeSocketMessage({
      type: 'ltx2_segment_start', segment_idx: 2, seed_prompt_index: 1,
      prompt_id: 'continue-1', source: 'user_enhanced',
    }), context)
    expect(context.rewriteStore.get().promptEvents[0]).toMatchObject({
      promptId: 'continue-1', status: 'consumed', source: 'user_enhanced', text: 'Follow the river',
    })
    expect(context.streamStore.get()).toMatchObject({ playingSeedPromptIndex: 0, generatingSeedPromptIndex: 1 })
    await applyNormalizedSocketEvent(normalizeSocketMessage({
      type: 'media_segment_complete', segment_idx: 2, stream_id: 'river-2',
    }), context)
    expect(context.streamStore.get()).toMatchObject({ playingSeedPromptIndex: 1, generatingSeedPromptIndex: null })
    expect(context.avPipeline.noteSegmentComplete).toHaveBeenCalledWith({ segmentIdx: 2, streamId: 'river-2' })
    expect(context.projectControlsStore.get().generationRoundStatus).toBe('generating')
  })

  /** Accepted prompts and diagnostics survive without preset, reason, or fallback metadata. */
  it('replaces the accepted window and preserves inspection details before ending rewrite preparation', async () => {
    const context = createContext()
    context.rewriteStore.patch({ activeRewritePromptId: 'rewrite-1' })
    context.rewriteStore.addPromptEvent({
      promptId: 'rewrite-1', status: 'rewrite_requested', source: 'user_rewrite', text: 'Move into the forest',
    })
    await applyNormalizedSocketEvent(normalizeSocketMessage({
      type: 'seed_prompts_updated', prompts: ['Forest clearing', 'Forest canopy'],
      model: 'rewrite-model', latency_ms: 451, raw_llm_output: '{"prompts":["Forest clearing","Forest canopy"]}',
    }), context)
    expect(context.promptWindowStore.get()).toMatchObject({
      currentPromptWindowPrompts: ['Forest clearing', 'Forest canopy'],
      editableSegments: ['Forest clearing', 'Forest canopy'],
    })
    expect(context.rewriteStore.get().promptEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'rewrite_ready', model: 'rewrite-model', latencyMs: 451, text: 'Forest clearing\nForest canopy' }),
      expect.objectContaining({ status: 'rewrite_raw_output', text: '{"prompts":["Forest clearing","Forest canopy"]}' }),
    ]))
    await applyNormalizedSocketEvent(normalizeSocketMessage({
      type: 'rewrite_seed_prompts_complete', prompt_id: 'rewrite-1',
    }), context)
    expect(context.rewriteStore.get().rewritingSeedPrompts).toBe(false)
    expect(context.projectControlsStore.get().generationRoundStatus).toBe('generating')
    await applyNormalizedSocketEvent(normalizeSocketMessage({
      type: 'ltx2_segment_start', segment_idx: 1, seed_prompt_index: 0,
      prompt_id: 'rewrite-1', source: 'user_enhanced',
    }), context)
    expect(context.rewriteStore.get().promptEvents.find(event => event.promptId === 'rewrite-1')).toMatchObject({
      source: 'user_rewrite', status: 'consumed', text: 'Move into the forest',
    })
  })

  /** Rejected enhancement leaves the submitted text inspectable and reports failure through the generic notice. */
  it('marks the rejected prompt failed without replacing its text or releasing an active round', async () => {
    const context = createContext()
    context.rewriteStore.addPromptEvent({ promptId: 'continue-1', status: 'enhancing', text: 'Follow the river' })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await applyNormalizedSocketEvent(normalizeSocketMessage({
        type: 'error', prompt_id: 'continue-1', message: 'Prompt enhancement failed. Try another prompt.',
      }), context)
      expect(context.rewriteStore.get().promptEvents[0]).toMatchObject({
        promptId: 'continue-1', status: 'failed', text: 'Follow the river',
      })
      expect(context.projectControlsStore.get()).toMatchObject({
        projectNotice: 'Prompt enhancement failed. Try another prompt.', generationRoundStatus: 'generating',
      })
    } finally {
      errorLog.mockRestore()
    }
  })

  /** A rewrite failure retains the model diagnostic displayed in the inspector. */
  it('keeps rewrite failure details when preparation ends', async () => {
    const context = createContext()
    context.rewriteStore.patch({ activeRewritePromptId: 'rewrite-1' })
    await applyNormalizedSocketEvent(normalizeSocketMessage({
      type: 'rewrite_seed_prompts_complete', prompt_id: 'rewrite-1', error: 'Provider timed out.',
      model: 'rewrite-model', latency_ms: 1000,
    }), context)
    expect(context.rewriteStore.get().rewritingSeedPrompts).toBe(false)
    expect(context.rewriteStore.get().promptEvents[0]).toMatchObject({
      status: 'rewrite_error', model: 'rewrite-model', latencyMs: 1000, text: 'Provider timed out.',
    })
  })
})
