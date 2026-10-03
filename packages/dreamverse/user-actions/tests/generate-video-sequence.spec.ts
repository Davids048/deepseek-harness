import { afterEach, describe, expect, it } from 'vitest'
import { DreamverseValueError, GenerationSegmentError } from '@dreamverse/project'
import {
  Deferred,
  FakeAssets,
  FakeGeneration,
  FakePromptEnhancer,
  lastFrameBytes,
  ref2vaFacts,
  referenceImage,
  within,
} from '../../project/tests/fakes.ts'
import type { ProjectsHarness } from '../../project/tests/harness.ts'
import { generateVideoSequence } from '../src/generate-video-sequence.ts'
import {
  finishRound,
  logEntry,
  openUserActions,
  projectCopies,
  projectPayload,
  REF2VA,
  rolloutText,
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

describe('generate_video_sequence', () => {
  it.each([
    [[' First ', 'Second'], 2, ['First', 'Second']],
    [['One', 'Two', 'Three', 'Four'], 3, ['One', 'Two', 'Three']],
  ])('generates the selected count of prepared prompts %j without enhancement', async (prompts, count, expected) => {
    harness = await openUserActions()
    const run = await harness.start(projectPayload({ curated_prompts: prompts, segment_count: count }))
    await finishRound(run, expected)
    const segments = run.project.completedSequenceSegments
    expect(segments.map(segment => [segment.prompt, segment.sequenceIndex, segment.source, segment.instruction]))
      .toEqual(expected.map((prompt, index) => [prompt, index, 'preset', null]))
    expect(new Set(segments.map(segment => segment.segmentId)).size).toBe(expected.length)
    expect(harness.enhancer.rewriteRollout).not.toHaveBeenCalled()
    // On a first-frame model, each later prepared segment starts from its predecessor's last frame.
    expect(run.generation.calls.map(call => call.request.referenceImages))
      .toEqual(expected.map((_prompt, index) => index === 0 ? [] : [lastFrameBytes(index)]))
    expect(run.socket.entries).toEqual([
      roundStatus('preparing'), roundStatus('generating'), streamStart(null, '', expected),
      ...expected.flatMap((_prompt, index) => segmentEntries(index + 1, 'curated', index, null)),
      { type: 'ltx2_stream_complete' }, roundStatus('idle'),
    ])
  })

  it.each(['t2va', 'i2v', 'ref2va'])('expands a %s seed into a fresh window that it publishes and generates', async (mode) => {
    const assets = new FakeAssets()
    const assetIds = mode === 't2va' ? [] : [assets.addImage('first').assetId]
    harness = await openUserActions({ generation: new FakeGeneration(mode === 'ref2va' ? ref2vaFacts() : undefined), assets })
    const run = await harness.start(projectPayload({
      model_id: mode === 'ref2va' ? 'h3-ref2va' : 'fast-ltx23', generation_mode: mode,
      initial_rollout_prompt: 'Explore a forest', initial_prompt_id: 'seed', segment_count: 4, reference_asset_ids: assetIds,
    }))
    const scenes = ['Scene 1', 'Scene 2', 'Scene 3', 'Scene 4']
    await finishRound(run, scenes)
    expect(harness.enhancer.rewriteRollout.mock.calls).toEqual([[[], {
      promptsToRewrite: [], presetId: null, presetLabel: '', rewriteInstruction: 'Explore a forest',
      generationMode: mode,
      // Only the reference-image model numbers its images; first-frame models have no image labels. Each later
      // ref2va segment keeps the selected image as Picture 1 and starts from its predecessor's last frame, Picture 2.
      referenceLabels: mode === 'ref2va' ? ['Picture 1'] : [], segmentCount: 4, segmentDurationSec: 5,
      continuedSegmentLabels: mode === 'ref2va' ? { referenceLabels: ['Picture 1'], firstFrameLabel: 'Picture 2' } : null,
      signal: run.project.generationSignal,
    }]])
    const segments = run.project.completedSequenceSegments
    expect(segments.map(segment => segment.prompt)).toEqual(scenes)
    expect(segments.every(segment => segment.enhanced && segment.instruction === segments[0]!.instruction)).toBe(true)
    expect(segments[0]!.instruction).toEqual({ requestId: 'seed', text: 'Explore a forest' })
    expect(run.socket.entries).toEqual([
      roundStatus('preparing'),
      { type: 'seed_prompts_updated', prompts: scenes, model: 'model-a', latency_ms: 12.35, raw_llm_output: rolloutText(4) },
      { type: 'rewrite_seed_prompts_complete', prompt_id: 'seed' },
      roundStatus('generating'),
      streamStart('seed', 'Explore a forest', scenes),
      ...scenes.flatMap((_prompt, index) => segmentEntries(index + 1, 'user_enhanced', index, 'seed')),
      { type: 'ltx2_stream_complete' },
      roundStatus('idle'),
    ])
    expect(harness.logEvents('rewrite_done')).toEqual([logEntry('rewrite_done', {
      kind: 'seed_rewrite', rewrite_instruction: 'Explore a forest', latency_ms: 12.35, response: rolloutText(4),
    })])
    expect(harness.logEvents('generation_round_start')).toEqual([
      logEntry('generation_round_start', { action: 'generate_video_sequence', reference_asset_ids: assetIds }),
    ])
  })

  it('passes the project-init preset to the initial rollout and ignores browser rewrite settings', async () => {
    harness = await openUserActions()
    const run = await harness.start(projectPayload({
      segment_count: 6, preset_id: 'custom_editable', preset_label: 'Custom rollout', curated_prompts: [],
      initial_rollout_prompt: 'A moonbase corridor thriller with flooding', rewrite_model: 'model-b',
      rewrite_temperature: 0.4, rewrite_window_system_prompt: 'Window rewrite prompt',
      rewrite_user_system_prompt: 'User rewrite prompt', enhancement_enabled: true,
    }))
    await finishRound(run, ['Scene 1', 'Scene 2', 'Scene 3', 'Scene 4', 'Scene 5', 'Scene 6'])
    expect(harness.enhancer.rewriteRollout.mock.calls[0]![1]).toEqual({
      promptsToRewrite: [], presetId: 'custom_editable', presetLabel: 'Custom rollout',
      rewriteInstruction: 'A moonbase corridor thriller with flooding', generationMode: 't2va',
      referenceLabels: [], segmentCount: 6, segmentDurationSec: 5, continuedSegmentLabels: null,
      signal: run.project.generationSignal,
    })
    expect(run.project.promptEnhancementModel).toBe('model-a')
    expect([run.project.promptSequenceId, run.project.promptSequenceLabel]).toEqual(['test-scenes', 'Test scenes'])
  })

  it('generates six seed segments when the project omits segment_count', async () => {
    harness = await openUserActions()
    const payload = projectPayload({ initial_rollout_prompt: 'Walk, stop, and speak beside a tree' })
    delete payload['segment_count']
    const run = await harness.start(payload)
    const scenes = Array.from({ length: 6 }, (_value, index) => `Scene ${index + 1}`)
    await finishRound(run, scenes)
    expect(run.generation.calls).toHaveLength(6)
    expect(harness.enhancer.rewriteRollout.mock.calls[0]![1].segmentCount).toBe(6)
  })

  it.each([[[]], [['']], [['A', 7]]])('rejects prepared prompts %j before creating a plan', async (prompts) => {
    harness = await openUserActions()
    const run = await harness.start(projectPayload({ curated_prompts: [] }))
    await expect(generateVideoSequence(run.project, { type: 'generate_video_sequence', prompt: '', prompts }, {
      referenceAssets: [],
    })).rejects.toThrow(new DreamverseValueError('A video sequence requires nonempty prompts.'))
    expect(run.project.videoSegmentsById.size).toBe(0)
    expect(harness.enhancer.rewriteRollout).not.toHaveBeenCalled()
  })

  it('rejects a preset shorter than the selected segment count', async () => {
    harness = await openUserActions()
    const run = await harness.start(projectPayload({ curated_prompts: ['A', 'B'], segment_count: 3 }))
    await run.socket.waitForStatus('failed')
    const message = 'Requested 3 segments, but the preset provides 2 prompts.'
    expect(run.socket.entries).toEqual([
      roundStatus('preparing'), { type: 'error', message, prompt_id: null }, roundStatus('failed'),
    ])
    expect(harness.logEvents('generation_round_failed')).toEqual([
      logEntry('generation_round_failed', { action: 'generate_video_sequence', error: message }),
    ])
    expect(run.generation.calls).toEqual([])
  })

  describe.each([
    ['preset', { curated_prompts: ['A', 'B', 'C'] }, ['A', 'B', 'C']],
    ['seed', { initial_rollout_prompt: 'Explore a forest' }, ['Scene 1', 'Scene 2', 'Scene 3']],
  ])('%s sequence', (_label, init, prompts) => {
    it('records the sequence only after every segment succeeds', async () => {
      harness = await openUserActions()
      const run = await harness.start(projectPayload(init))
      for (const prompt of prompts) {
        const call = await run.generation.nextCall()
        expect(call.request.prompt).toBe(prompt)
        expect(run.project.completedSequenceHistory).toEqual([])
        expect(run.project.activeGenerationPlan!.sequenceIds).toEqual(run.project.activeGenerationPlan!.segmentIds)
        call.finish.resolve()
      }
      await run.socket.waitForStatus('idle')
      expect(run.project.completedSequenceHistory).toEqual([
        run.project.completedSequenceSegments.map(segment => segment.segmentId),
      ])
      expect(run.project.activeGenerationPlan).toBeNull()
    })

    it.each([
      ['worker error', new GenerationSegmentError('Video generation failed', 'RuntimeError', false)],
      ['value error', new GenerationSegmentError('Video generation failed', 'ValueError', true)],
    ])('records nothing after a %s', async (_failureLabel, failure) => {
      harness = await openUserActions()
      const run = await harness.start(projectPayload({ ...init, preset_id: 'accepted-sequence', preset_label: 'Accepted sequence' }))
      const call = await run.generation.nextCall()
      call.failWith = failure
      call.finish.resolve()
      await run.socket.waitForStatus('failed')
      expect(run.project.completedSequenceHistory).toEqual([])
      expect([run.project.promptSequenceId, run.project.promptSequenceLabel]).toEqual(['accepted-sequence', 'Accepted sequence'])
      expect([...run.project.videoSegmentsById.values()].map(segment => segment.status)).toEqual(['failed', 'failed', 'failed'])
      expect(run.socket.eventsOfType('error')).toEqual(failure.isValueError
        ? [{ type: 'error', message: 'Video generation failed', prompt_id: null }]
        : [])
      const outcome = await (failure.isValueError ? Promise.resolve(null) : within(run.outcome))
      if (!failure.isValueError) expect((outcome as Error).message).toBe('Video generation failed')
    })
  })

  it('uses the rollout metadata during generation and restores the accepted metadata after failure', async () => {
    harness = await openUserActions()
    const run = await harness.start(projectPayload({
      initial_rollout_prompt: 'Explore a forest', segment_count: 1,
      preset_id: 'accepted-sequence', preset_label: 'Accepted sequence',
    }))
    const call = await run.generation.nextCall()
    expect([run.project.promptSequenceId, run.project.promptSequenceLabel]).toEqual(['test-scenes', 'Test scenes'])
    call.failWith = new GenerationSegmentError('Video generation failed', 'ValueError', true)
    call.finish.resolve()
    await run.socket.waitForStatus('failed')
    expect([run.project.promptSequenceId, run.project.promptSequenceLabel]).toEqual(['accepted-sequence', 'Accepted sequence'])
  })

  it('creates one UUID request ID for a seed without a prompt ID', async () => {
    harness = await openUserActions()
    const run = await harness.start(projectPayload({ initial_rollout_prompt: ' Explore a forest ', segment_count: 2 }))
    await finishRound(run, ['Scene 1', 'Scene 2'])
    const instructions = run.project.completedSequenceSegments.map(segment => segment.instruction)
    expect(instructions[1]).toBe(instructions[0])
    expect(instructions[0]!.text).toBe('Explore a forest')
    expect(instructions[0]!.requestId).toMatch(UUID_V4)
    expect(run.socket.eventsOfType('rewrite_seed_prompts_complete')).toEqual([
      { type: 'rewrite_seed_prompts_complete', prompt_id: instructions[0]!.requestId },
    ])
  })

  it.each(['seed', 'preset'])('shares ordered reference assets with every %s segment', async (kind) => {
    const assets = new FakeAssets()
    const side = assets.addImage('side')
    const front = assets.addImage('front')
    harness = await openUserActions({ generation: new FakeGeneration(ref2vaFacts()), assets })
    const run = await harness.start(projectPayload({
      ...REF2VA, reference_asset_ids: ['side', 'front'], segment_count: 2,
      ...(kind === 'seed' ? { initial_rollout_prompt: 'A protagonist walks' } : { curated_prompts: ['A lake', 'A forest'] }),
    }))
    await finishRound(run, kind === 'seed' ? ['Scene 1', 'Scene 2'] : ['A lake', 'A forest'])
    for (const segment of run.project.completedSequenceSegments) expect(segment.referenceAssets).toEqual(projectCopies(run, [side, front]))
    // The second request carries the ordered images, then the first segment's last frame that it starts from.
    const images = [referenceImage('side'), referenceImage('front')]
    expect(run.generation.calls.map(call => call.request.referenceImages)).toEqual([images, [...images, lastFrameBytes(1)]])
    if (kind === 'seed') {
      expect(harness.enhancer.rewriteRollout.mock.calls[0]![1]).toMatchObject({
        referenceLabels: ['Picture 1', 'Picture 2'],
        continuedSegmentLabels: { referenceLabels: ['Picture 1', 'Picture 2'], firstFrameLabel: 'Picture 3' },
      })
    }
  })

  it('keeps a deleted reference until the round finishes and lets later rounds select another image', async () => {
    const assets = new FakeAssets()
    assets.addImage('first-person')
    assets.addImage('second-person')
    harness = await openUserActions({ generation: new FakeGeneration(ref2vaFacts()), assets })
    const run = await harness.start(projectPayload({
      ...REF2VA, reference_asset_ids: ['first-person'], curated_prompts: ['Lake', 'Forest'],
    }))
    const first = await run.generation.nextCall()
    assets.deleteAsset('first-person')
    expect(assets.fileExists('first-person')).toBe(true)
    first.finish.resolve()
    const second = await run.generation.nextCall()
    expect(second.request.referenceImages).toEqual([referenceImage('first-person'), lastFrameBytes(1)])
    expect(assets.fileExists('first-person')).toBe(true)
    second.finish.resolve()
    await run.socket.waitForStatus('idle')
    expect(assets.fileExists('first-person')).toBe(false)
    // An appended segment starts from the accepted video's last frame; the other actions start fresh video.
    for (const [command, predecessorImages] of [
      [{ type: 'append_prompt', prompt: 'River' }, [lastFrameBytes(2)]],
      [{ type: 'simple_generate', prompt: 'Mountain', enhancement_enabled: false }, []],
      [{ type: 'rewrite_seed_prompts', rewrite_instruction: 'Add rain', prompt_window_prompts: ['Mountain'] }, []],
    ] as const) {
      const after = run.socket.entries.length
      await run.project.processBrowserCommand({ ...command, reference_asset_ids: ['second-person'] })
      const call = await run.generation.nextCall()
      expect(call.request.referenceImages).toEqual([referenceImage('second-person'), ...predecessorImages])
      call.finish.resolve()
      await run.socket.waitForStatus('idle', after)
    }
    expect(assets.fileExists('second-person')).toBe(true)
    expect(assets.totalRetained()).toBe(0)
  })

  it('abandons the segment in progress on close, cancels the rest of the plan, and releases a deleted reference', async () => {
    const assets = new FakeAssets()
    assets.addImage('image')
    harness = await openUserActions({ generation: new FakeGeneration(ref2vaFacts()), assets })
    const run = await harness.start(projectPayload({
      ...REF2VA, reference_asset_ids: ['image'], curated_prompts: ['A wave', 'A bow'],
    }))
    const call = await run.generation.nextCall()
    const plan = run.project.activeGenerationPlan!
    assets.deleteAsset('image')
    await within(run.project.closeAndWaitForGeneration())
    expect(call.cancelled.settled).toBe(true)
    expect(assets.fileExists('image')).toBe(false)
    expect(plan.segmentIds.map(id => run.project.videoSegmentsById.get(id)!.status)).toEqual(['cancelled', 'cancelled'])
    expect(run.generation.calls).toHaveLength(1)
    expect(await within(run.outcome)).toBeNull()
  })

  it('stops waiting for the seed rollout on close and logs the cancelled rewrite', async () => {
    const enhancer = new FakePromptEnhancer()
    const entered = new Deferred()
    enhancer.rewriteRollout.mockImplementationOnce(async () => {
      entered.resolve()
      return await new Promise<never>(() => {})
    })
    harness = await openUserActions({ enhancer })
    const run = await harness.start(projectPayload({ initial_rollout_prompt: 'Explore a forest', initial_prompt_id: 'seed' }))
    await within(entered.promise)
    await within(run.project.closeAndWaitForGeneration())
    expect(enhancer.rewriteRollout.mock.calls[0]![1].signal.aborted).toBe(true)
    expect(await within(run.outcome)).toBeNull()
    expect(run.generation.calls).toEqual([])
    expect(run.socket.entries).toEqual([roundStatus('preparing')])
    expect(harness.logEvents('rewrite_cancelled')).toEqual([logEntry('rewrite_cancelled', {
      kind: 'seed_rewrite', rewrite_instruction: 'Explore a forest', rewrite_model: 'model-a',
    })])
    expect(harness.logEvents('rewrite_exception')).toEqual([])
  })
})
