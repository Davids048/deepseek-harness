import { afterEach, describe, expect, it } from 'vitest'
import { DreamverseValueError, GenerationSegmentError } from '@dreamverse/project'
import {
  FakeAssets,
  FakeGeneration,
  FakePromptEnhancer,
  holdPromptCall,
  promptResult,
  ref2vaFacts,
  referenceImage,
  within,
} from '../../project/tests/fakes.ts'
import { MEASURED_LATENCY, openProjects, type FakeServices, type ProjectsHarness } from '../../project/tests/harness.ts'
import * as ContinueVideo from '../src/continue-video.ts'
import * as GenerateSingleClip from '../src/generate-single-clip.ts'
import { generateSingleClip } from '../src/generate-single-clip.ts'
import * as GenerateVideoSequence from '../src/generate-video-sequence.ts'
import * as RewriteVideoSequence from '../src/rewrite-video-sequence.ts'
import {
  finishRound,
  logEntry,
  openUserActions,
  projectPayload,
  REF2VA,
  roundStatus,
  segmentEntries,
  streamStart,
  UUID_V4,
} from './helpers.ts'

let harness: ProjectsHarness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

/**
 * Fake services for a model that serves one generation mode, with the reference asset IDs that mode's actions select.
 * @param mode - `t2va`, `i2v`, or `ref2va`.
 * @returns the fake services and the selected asset IDs.
 */
function servedMode(mode: string): { services: FakeServices; assetIds: string[] } {
  const assets = new FakeAssets()
  const services = { generation: new FakeGeneration(mode === 'ref2va' ? ref2vaFacts() : undefined), assets }
  if (mode === 't2va') return { services, assetIds: [] }
  assets.addImage('first')
  return { services, assetIds: ['first'] }
}

describe('generate_single_clip', () => {
  describe.each([true, false])('with enhancement %s', (enhance) => {
    it.each([['t2va', 5], ['i2v', 15], ['ref2va', 5], ['ref2va', 15]])(
      'prepares one independent %s segment of %i seconds', async (mode, duration) => {
        const { services, assetIds } = servedMode(mode)
        harness = await openUserActions(services)
        const run = await harness.start(projectPayload({
          model_id: mode === 'ref2va' ? 'h3-ref2va' : 'fast-ltx23', generation_mode: mode, curated_prompts: [],
          segment_duration_sec: duration, reference_asset_ids: assetIds,
        }))
        const after = run.socket.entries.length
        await run.project.processBrowserCommand({
          type: 'simple_generate', prompt_id: 'clip', prompt: 'A fox', enhancement_enabled: enhance,
          reference_asset_ids: assetIds,
        })
        const call = await run.generation.nextCall()
        const prompt = enhance ? 'Expanded clip' : 'A fox'
        const settings = run.project.videoGenerationSettings
        expect(call.request).toEqual({
          prompt, frameWidth: settings.frame_width, frameHeight: settings.frame_height, numFrames: settings.num_frames,
          referenceImages: assetIds.map(id => referenceImage(id)), returnLastFrame: true, signal: run.project.generationSignal,
        })
        call.finish.resolve()
        await run.socket.waitForStatus('idle', after)
        const source = enhance ? 'user_enhanced' : 'user_raw'
        expect(run.socket.entries.slice(after)).toEqual([
          roundStatus('preparing'),
          ...(enhance
            ? [{ type: 'prompt_received', prompt_id: 'clip' }, { type: 'prompt_enhancing', prompt_id: 'clip' },
              { type: 'prompt_ready', prompt_id: 'clip', prompt, source }]
            : []),
          roundStatus('generating'),
          streamStart('clip', 'A fox', [prompt]),
          ...segmentEntries(1, source, 0, 'clip'),
          { type: 'ltx2_stream_complete' },
          roundStatus('idle'),
        ])
        const [segment] = run.project.completedSequenceSegments
        expect(segment).toMatchObject({ prompt, source: 'user', enhanced: enhance, sequenceIndex: 0 })
        expect(segment!.instruction).toEqual({ requestId: 'clip', text: 'A fox' })
        if (enhance) {
          expect(harness.enhancer.expandClip.mock.calls).toEqual([['A fox', {
            timeoutMs: 20000, generationMode: mode, segmentDurationSec: duration,
            // Only the reference-image model numbers its images; first-frame models have no image labels.
            referenceLabels: mode === 'ref2va' ? ['Picture 1'] : [], signal: run.project.generationSignal,
          }]])
        } else {
          expect(harness.enhancer.expandClip).not.toHaveBeenCalled()
        }
        expect(harness.enhancer.continueVideo).not.toHaveBeenCalled()
      })
  })

  it('writes the enhancement, command, and segment log events', async () => {
    harness = await openUserActions()
    const run = await harness.start(projectPayload({ curated_prompts: [], preset_id: 'custom' }))
    await run.project.processBrowserCommand({
      type: 'simple_generate', prompt_id: 'clip', prompt: 'A fox', enhancement_enabled: true,
    })
    await finishRound(run, ['Expanded clip'])
    const segmentId = run.project.completedSequenceSegmentIds[0]
    expect(harness.logEvents('generation_round_start')).toEqual([
      logEntry('generation_round_start', { action: 'simple_generate', reference_asset_ids: [] }),
    ])
    expect(harness.logEvents('enhance_request')).toEqual([logEntry('enhance_request', {
      prompt_id: 'clip', raw_prompt: 'A fox', enhancement_enabled: true, rewrite_model: 'model-a',
    })])
    expect(harness.logEvents('rewrite_done')).toEqual([logEntry('rewrite_done', {
      kind: 'enhance_prompt', latency_ms: 2.35, response: 'Expanded clip', error: null,
      fallback_used: false, provider: 'test', model: 'model-a',
    })])
    expect(harness.logEvents('simple_generate')).toEqual([logEntry('simple_generate', {
      prompt_id: 'clip', prompt: 'A fox', preset_id: 'custom', enhancement_enabled: true, reference_asset_ids: [],
    })])
    expect(harness.logEvents('segment_start')).toEqual([
      logEntry('segment_start', { segment_idx: 1, segment_id: segmentId, reference_asset_ids: [] }),
    ])
    expect(harness.logEvents('segment_complete')).toEqual([logEntry('segment_complete', {
      segment_idx: 1, data_size_bytes: 8,
      latency_ms: MEASURED_LATENCY,
    })])
    expect(harness.logEvents('ws_stream_complete')).toEqual([logEntry('ws_stream_complete')])
  })

  describe.each(['fallback', 'provider_exception'])('%s failure', (failure) => {
    it('rejects the prompt before registering a segment and keeps the project editable', async () => {
      const enhancer = new FakePromptEnhancer()
      if (failure === 'fallback') {
        enhancer.expandClip.mockResolvedValueOnce(promptResult('Expanded clip', { fallbackUsed: true, error: 'Provider unavailable' }))
      } else {
        enhancer.expandClip.mockRejectedValueOnce(new Error('Provider unavailable'))
      }
      harness = await openUserActions({ enhancer })
      const run = await harness.start(projectPayload({ curated_prompts: ['A'] }))
      await finishRound(run, ['A'])
      const segmentCount = run.project.videoSegmentsById.size
      const after = run.socket.entries.length
      await run.project.processBrowserCommand({
        type: 'simple_generate', prompt_id: 'prompt', prompt: 'A fox', enhancement_enabled: true,
      })
      await run.socket.waitForStatus('failed', after)
      const message = 'Prompt extension failed for this request.'
      expect(run.socket.entries.slice(after)).toEqual([
        roundStatus('preparing'),
        { type: 'prompt_received', prompt_id: 'prompt' }, { type: 'prompt_enhancing', prompt_id: 'prompt' },
        { type: 'error', message, prompt_id: 'prompt' },
        roundStatus('failed'),
      ])
      expect(run.project.videoSegmentsById.size).toBe(segmentCount)
      expect(run.project.completedSequencePrompts).toEqual(['A'])
      expect(run.generation.calls).toHaveLength(1)
      if (failure === 'fallback') {
        expect(harness.logEvents('rewrite_done')).toEqual([logEntry('rewrite_done', {
          kind: 'enhance_prompt', latency_ms: 2.35, response: 'Expanded clip', error: 'Provider unavailable',
          fallback_used: true, provider: 'test', model: 'model-a',
        })])
      } else {
        expect(harness.logEvents('rewrite_exception')).toEqual([logEntry('rewrite_exception', {
          kind: 'enhance_prompt', prompt_id: 'prompt', raw_prompt: 'A fox', rewrite_model: 'model-a',
          error: 'Provider unavailable',
        })])
      }
      expect(harness.logEvents('generation_round_failed')).toEqual([
        logEntry('generation_round_failed', { action: 'simple_generate', error: message }),
      ])
    })
  })

  it('rejects an empty prompt', async () => {
    harness = await openUserActions()
    const run = await harness.start(projectPayload({ curated_prompts: [] }))
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt_id: 'clip', prompt: '   ' })
    await run.socket.waitForStatus('failed', after)
    expect(run.socket.events(after)).toEqual([
      roundStatus('preparing'),
      { type: 'error', message: 'A video clip requires a prompt.', prompt_id: 'clip' },
      roundStatus('failed'),
    ])
  })

  it('keeps accepted video after a failed enhancement and accepts another clip', async () => {
    const enhancer = new FakePromptEnhancer()
    enhancer.expandClip.mockRejectedValueOnce(new Error('Provider unavailable'))
    harness = await openUserActions({ enhancer })
    const run = await harness.start(projectPayload({ curated_prompts: ['A'], preset_id: 'forest', preset_label: 'Forest' }))
    await finishRound(run, ['A'])
    const originalIds = run.project.completedSequenceSegmentIds
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({
      type: 'simple_generate', prompt: 'B', enhancement_enabled: true, preset_id: 'rejected-clip', preset_label: 'Rejected clip',
    })
    await run.socket.waitForStatus('failed', after)
    expect(run.project.completedSequenceSegmentIds).toEqual(originalIds)
    expect([run.project.promptSequenceId, run.project.promptSequenceLabel]).toEqual(['forest', 'Forest'])
    expect(run.project.promptEnhancementEnabled).toBe(false)
    expect(run.generation.calls).toHaveLength(1)
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'C', enhancement_enabled: false })
    await finishRound(run, ['C'])
    expect(run.project.completedSequencePrompts).toEqual(['C'])
    expect(run.project.videoSegmentsById.get(originalIds[0]!)!.status).toBe('completed')
  })

  it('uses the command enhancement choice and commits its preset metadata', async () => {
    harness = await openUserActions()
    const run = await harness.start(projectPayload({ curated_prompts: ['A'], enhancement_enabled: true }))
    await finishRound(run, ['A'])
    await run.project.processBrowserCommand({
      type: 'simple_generate', prompt: 'Raw clip', enhancement_enabled: false,
      preset_id: 'custom-clip', preset_label: 'Custom clip',
    })
    await finishRound(run, ['Raw clip'])
    expect(harness.enhancer.expandClip).not.toHaveBeenCalled()
    expect(run.project.promptEnhancementEnabled).toBe(false)
    expect([run.project.promptSequenceId, run.project.promptSequenceLabel]).toEqual(['custom-clip', 'Custom clip'])
  })

  describe.each([
    ['worker error', new GenerationSegmentError('Video generation failed', 'RuntimeError', false)],
    ['value error', new GenerationSegmentError('Video generation failed', 'ValueError', true)],
  ])('generation %s', (_label, failure) => {
    it('restores preset metadata, keeps the enhancement choice, and records no sequence', async () => {
      harness = await openUserActions()
      const run = await harness.start(projectPayload({
        curated_prompts: ['Accepted scene'], enhancement_enabled: true,
        preset_id: 'accepted-sequence', preset_label: 'Accepted sequence',
      }))
      await finishRound(run, ['Accepted scene'])
      const history = [...run.project.completedSequenceHistory]
      const after = run.socket.entries.length
      await run.project.processBrowserCommand({
        type: 'simple_generate', prompt_id: 'clip', prompt: 'A fox', enhancement_enabled: false,
        preset_id: 'clip-sequence', preset_label: 'Clip sequence',
      })
      const call = await run.generation.nextCall()
      // The clip's metadata is current while its video generates.
      expect([run.project.promptSequenceId, run.project.promptSequenceLabel]).toEqual(['clip-sequence', 'Clip sequence'])
      expect(run.project.completedSequenceHistory).toEqual(history)
      call.failWith = failure
      call.finish.resolve()
      await run.socket.waitForStatus('failed', after)
      expect([run.project.promptSequenceId, run.project.promptSequenceLabel]).toEqual(['accepted-sequence', 'Accepted sequence'])
      expect(run.project.promptEnhancementEnabled).toBe(false)
      expect(run.project.completedSequenceHistory).toEqual(history)
      const errorEvents = failure.isValueError
        ? [{ type: 'error', message: 'Video generation failed', prompt_id: 'clip' }]
        : []
      const streamId: unknown = expect.stringMatching(/^seg001-[0-9a-f]{8}$/)
      expect(run.socket.entries.slice(after)).toEqual([
        roundStatus('preparing'), roundStatus('generating'), streamStart('clip', 'A fox', ['A fox']),
        { type: 'ltx2_segment_start', segment_idx: 1, source: 'user_raw', seed_prompt_index: 0, prompt_id: 'clip' },
        { type: 'media_init', segment_idx: 1, mime: 'video/mp4', stream_id: streamId },
        Buffer.from('segment!'),
        ...errorEvents,
        roundStatus('failed'),
      ])
      const outcome = failure.isValueError ? null : await within(run.outcome)
      if (failure.isValueError) {
        expect(run.project.isClosed).toBe(false)
      } else {
        expect(outcome).toBeInstanceOf(Error)
        expect(outcome).not.toBeInstanceOf(DreamverseValueError)
        expect((outcome as Error).message).toBe('Video generation failed')
      }
    })
  })

  it('creates a UUID request ID and strips the prompt when the command has no prompt ID', async () => {
    harness = await openUserActions()
    const run = await harness.start(projectPayload({ curated_prompts: [] }))
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: ' A fox ' })
    await finishRound(run, ['A fox'])
    const [segment] = run.project.completedSequenceSegments
    expect(segment!.instruction!.text).toBe('A fox')
    expect(segment!.instruction!.requestId).toMatch(UUID_V4)
  })

  it('shares ordered reference assets with the segment and labels them for the enhancer', async () => {
    const assets = new FakeAssets()
    const side = assets.addImage('side')
    const front = assets.addImage('front')
    harness = await openUserActions({ generation: new FakeGeneration(ref2vaFacts()), assets })
    const run = await harness.start(projectPayload({ ...REF2VA, curated_prompts: [], reference_asset_ids: ['side'] }))
    await run.project.processBrowserCommand({
      type: 'simple_generate', prompt_id: 'request', prompt: 'A protagonist walks', enhancement_enabled: true,
      reference_asset_ids: ['side', 'front'],
    })
    const call = await run.generation.nextCall()
    expect(call.request.referenceImages).toEqual([referenceImage('side'), referenceImage('front')])
    call.finish.resolve()
    await run.socket.waitForStatus('idle', 1)
    expect(run.project.completedSequenceSegments[0]!.referenceAssets).toEqual([side, front])
    expect(harness.enhancer.expandClip.mock.calls[0]![1].referenceLabels).toEqual(['Picture 1', 'Picture 2'])
  })

  it('reuses the project for successive clips with independent conditioning and their own references', async () => {
    const assets = new FakeAssets()
    assets.addImage('first')
    assets.addImage('second')
    harness = await openUserActions({ assets })
    const run = await harness.start(projectPayload({
      generation_mode: 'i2v', curated_prompts: ['a selected prompt'], reference_asset_ids: ['first'], preset_id: 'simple_prompt_1',
    }))
    await finishRound(run, ['a selected prompt'])
    await run.project.processBrowserCommand({
      type: 'simple_generate', preset_id: 'simple_custom_prompt', prompt_id: 'simple_custom_prompt',
      prompt: 'a fresh custom prompt', enhancement_enabled: true, reference_asset_ids: ['second'],
    })
    await finishRound(run, ['Expanded clip'])
    expect(run.generation.calls.map(call => call.request.referenceImages))
      .toEqual([[referenceImage('first')], [referenceImage('second')]])
    expect(run.socket.eventsOfType('ltx2_stream_complete')).toHaveLength(2)
    expect(assets.totalRetained()).toBe(0)
  })

  it('keeps a deleted reference through prompt preparation and rejects a busy action without retaining', async () => {
    const assets = new FakeAssets()
    assets.addImage('image')
    const enhancer = new FakePromptEnhancer()
    const held = holdPromptCall(enhancer.expandClip, () => promptResult('The protagonist in Picture 1 waves.'))
    harness = await openUserActions({ generation: new FakeGeneration(ref2vaFacts()), assets, enhancer })
    const run = await harness.start(projectPayload({ ...REF2VA, curated_prompts: [], reference_asset_ids: ['image'] }))
    await run.project.processBrowserCommand({
      type: 'simple_generate', prompt: 'Wave', enhancement_enabled: true, reference_asset_ids: ['image'],
    })
    await within(held.entered.promise)
    assets.deleteAsset('image')
    expect(assets.fileExists('image')).toBe(true)
    const retainCount = assets.retainRequests.length
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'Rejected', reference_asset_ids: ['missing'] })
    expect(run.socket.events(after)).toEqual([{
      type: 'error', prompt_id: null, message: 'Wait for this generation round to finish before changing the video.',
    }])
    expect(assets.retainRequests).toHaveLength(retainCount)
    held.release.resolve()
    const call = await run.generation.nextCall()
    expect(call.request.referenceImages).toEqual([referenceImage('image')])
    expect(assets.fileExists('image')).toBe(true)
    call.finish.resolve()
    await run.socket.waitForStatus('idle', after)
    expect(assets.fileExists('image')).toBe(false)
  })

  it('releases every selected file when a later reference image is invalid', async () => {
    const assets = new FakeAssets()
    assets.addImage('portrait')
    assets.addImage('panorama', [100, 10])
    harness = await openUserActions({ generation: new FakeGeneration(ref2vaFacts()), assets })
    const run = await harness.start(projectPayload({ ...REF2VA, curated_prompts: [], reference_asset_ids: ['portrait'] }))
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({
      type: 'simple_generate', prompt_id: 'walk', prompt: 'Walk', reference_asset_ids: ['portrait', 'panorama'],
    })
    expect(run.socket.events(after)).toEqual([
      { type: 'error', prompt_id: 'walk', message: 'Reference image aspect ratio must be between 1:4 and 4:1.' },
    ])
    expect(run.project.generationRoundStatus).toBe('idle')
    expect(run.generation.calls).toEqual([])
    expect(assets.totalRetained()).toBe(0)
  })

  it('rejects accepting replacement content when releasing its reference files fails', async () => {
    const assets = new FakeAssets()
    assets.addImage('image')
    harness = await openUserActions({ generation: new FakeGeneration(ref2vaFacts()), assets })
    const run = await harness.start(projectPayload({
      ...REF2VA, reference_asset_ids: ['image'], curated_prompts: ['First shot'],
      preset_id: 'accepted-story', preset_label: 'Accepted story',
    }))
    await finishRound(run, ['First shot'])
    const acceptedIds = run.project.completedSequenceSegmentIds
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({
      type: 'simple_generate', prompt_id: 'replacement', prompt: 'Replacement shot', preset_id: 'replacement-story',
      preset_label: 'Replacement story', reference_asset_ids: ['image'],
    })
    const replacement = await run.generation.nextCall()
    assets.releaseError = new Error('Image deletion failed')
    replacement.finish.resolve()
    const outcome = await within(run.outcome)
    expect((outcome as Error).message).toBe('Image deletion failed')
    expect(run.project.generationRoundStatus).toBe('failed')
    expect(run.project.completedSequenceHistory).toEqual([acceptedIds])
    expect([run.project.promptSequenceId, run.project.promptSequenceLabel]).toEqual(['accepted-story', 'Accepted story'])
    expect([...run.project.videoSegmentsById.values()].every(segment => segment.status === 'completed')).toBe(true)
    expect(run.socket.entries.slice(after)).toEqual([
      roundStatus('preparing'), roundStatus('generating'),
      streamStart('replacement', 'Replacement shot', ['Replacement shot']),
      ...segmentEntries(1, 'user_raw', 0, 'replacement'),
      { type: 'ltx2_stream_complete' },
      roundStatus('failed'),
    ])
    expect(harness.logEvents('generation_round_failed')).toEqual([
      logEntry('generation_round_failed', { action: 'simple_generate', error: 'Image deletion failed' }),
    ])
  })

  it('reports the handler failure through a direct call as a value error', async () => {
    harness = await openUserActions()
    const run = await harness.start(projectPayload({ curated_prompts: [] }))
    await expect(generateSingleClip(run.project, { type: 'simple_generate', prompt: '' }, { referenceAssets: [] }))
      .rejects.toThrow(new DreamverseValueError('A video clip requires a prompt.'))
  })

  it('fails simple_generate with the unsupported-action error after its plugin unloads', async () => {
    harness = await openProjects([GenerateVideoSequence, ContinueVideo, RewriteVideoSequence])
    const fiber = harness.ctx.plugin(GenerateSingleClip)
    await fiber
    const run = await harness.start(projectPayload({ curated_prompts: [] }))
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt_id: 'first', prompt: 'A fox' })
    await finishRound(run, ['A fox'])
    await fiber.dispose()
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt_id: 'second', prompt: 'A fox' })
    await run.socket.waitForStatus('failed', after)
    expect(run.socket.events(after)).toEqual([
      roundStatus('preparing'),
      { type: 'error', message: 'Unsupported project action: simple_generate', prompt_id: 'second' },
      roundStatus('failed'),
    ])
    expect(harness.logEvents('generation_round_failed')).toEqual([logEntry('generation_round_failed', {
      action: 'simple_generate', error: 'Unsupported project action: simple_generate',
    })])
    expect(run.generation.calls).toHaveLength(1)
    expect(run.project.isClosed).toBe(false)
  })
})
