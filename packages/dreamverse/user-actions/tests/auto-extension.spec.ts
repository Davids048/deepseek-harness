import { afterEach, describe, expect, it } from 'vitest'
import { GenerationSegmentError, ProjectValidationError } from '@dreamverse/project'
import {
  Deferred,
  FakeAssets,
  FakeGeneration,
  FakePromptEnhancer,
  FakeSocket,
  holdPromptCall,
  promptResult,
  ref2vaFacts,
  referenceImage,
  within,
  type HeldPromptCall,
} from '../../project/tests/fakes.ts'
import type { ProjectRun, ProjectsHarness } from '../../project/tests/harness.ts'
import {
  finishRound,
  logEntry,
  openUserActions,
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

/** Prompt lifecycle events that only manual commands produce. */
const MANUAL_PROMPT_EVENTS = new Set(['prompt_received', 'prompt_enhancing', 'prompt_ready'])

/**
 * Start a project whose continuation prompts are held until `release`, like the reference `hold_continuation`.
 * @param init - `project_init_v1` fields added to the default payload.
 * @param options - the generation backend and asset library fakes, and the continuation result.
 * @returns the running project and the held continuation call.
 */
async function startWithHeldContinuation(
  init: Record<string, unknown>,
  options: { generation?: FakeGeneration; assets?: FakeAssets; fallbackUsed?: boolean } = {},
): Promise<{ run: ProjectRun; provider: HeldPromptCall; enhancer: FakePromptEnhancer }> {
  const { fallbackUsed = false, ...services } = options
  const enhancer = new FakePromptEnhancer()
  const provider = holdPromptCall(enhancer.continueVideo, () => promptResult('Prepared continuation', {
    latencyMs: 1, fallbackUsed, error: fallbackUsed ? 'Controlled failure' : null,
  }))
  harness = await openUserActions({ ...services, enhancer })
  const run = await harness.start(projectPayload(init))
  return { run, provider, enhancer }
}

describe('Auto Extension', () => {
  it('rejects a runtime toggle after a default-off round', async () => {
    harness = await openUserActions()
    const payload = projectPayload({ curated_prompts: ['A'] })
    delete payload['auto_extension_enabled']
    const run = await harness.start(payload)
    await finishRound(run, ['A'])
    expect(run.socket.events().at(-1)).toEqual(roundStatus('idle', false))
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({ type: 'set_auto_extension', enabled: true })
    expect(run.socket.events(after)).toEqual([
      { type: 'error', message: 'Unsupported project action: set_auto_extension.' },
    ])
    expect(run.project.autoContinueAfterGeneration).toBe(false)
    expect(harness.enhancer.continueVideo).not.toHaveBeenCalled()
    expect(run.project.completedSequencePrompts).toEqual(['A'])
    expect(run.generation.calls).toHaveLength(1)
  })

  it('lets stop during automatic preparation finish the admitted segment with forced enhancement', async () => {
    const { run, provider, enhancer } = await startWithHeldContinuation({ curated_prompts: ['A'], auto_extension_enabled: true })
    const first = await run.generation.nextCall()
    first.finish.resolve()
    await within(provider.entered.promise)
    await run.project.processBrowserCommand({ type: 'stop_auto_extension' })
    await run.project.processBrowserCommand({ type: 'stop_auto_extension' })
    expect(run.project.generationRoundStatus).toBe('preparing')
    expect(run.project.promptEnhancementEnabled).toBe(false)
    expect(enhancer.continueVideo.mock.calls).toEqual([[null, {
      lockedSegments: ['A'], nextSegmentIdx: 2, model: 'model-a', timeoutMs: 20000, generationMode: 't2va',
      segmentDurationSec: 5, referenceLabels: [], signal: run.project.generationSignal,
    }]])
    provider.release.resolve()
    const following = await run.generation.nextCall()
    following.finish.resolve()
    await run.socket.waitForStatus('idle')
    expect(run.socket.entries).toEqual([
      roundStatus('preparing', true), roundStatus('generating', true), streamStart(null, '', ['A']),
      ...segmentEntries(1, 'curated', 0, null), { type: 'ltx2_stream_complete' },
      roundStatus('preparing', true), roundStatus('preparing', true),
      roundStatus('preparing', false), roundStatus('preparing', false),
      roundStatus('generating', false), streamStart(null, '', ['A', 'Prepared continuation'], true),
      ...segmentEntries(2, 'auto_enhanced', null, null), { type: 'ltx2_stream_complete' },
      roundStatus('idle', false),
    ])
    const segment = run.project.completedSequenceSegments.at(-1)!
    expect([segment.source, segment.wireSource, segment.instruction]).toEqual(['automatic', 'auto_enhanced', null])
    expect(following.request.continueFrom).toBe('continuation-1')
    expect(run.generation.calls).toHaveLength(2)
    expect(harness!.logEvents('generation_round_start').map(entry => entry['action'])).toEqual(['generate_video_sequence', 'auto_extend'])
    expect(harness!.logEvents('enhance_request')).toEqual([logEntry('enhance_request', {
      prompt_id: null, raw_prompt: null, enhancement_enabled: true, rewrite_model: 'model-a',
    })])
    expect(harness!.logEvents('append_prompt')).toEqual([logEntry('append_prompt', { prompt: null, source: 'auto_enhanced' })])
  })

  it.each([
    ['preset', { curated_prompts: ['A'] }, 'A'],
    ['seed', { initial_rollout_prompt: 'A garden story', segment_count: 1 }, 'Scene 1'],
  ])('repeats one-segment rounds after an opted-in %s round until stop arrives', async (_label, init, firstPrompt) => {
    const { run, provider, enhancer } = await startWithHeldContinuation({ ...init, auto_extension_enabled: true })
    provider.release.resolve()
    const first = await run.generation.nextCall()
    expect(first.request.prompt).toBe(firstPrompt)
    const automaticStart = run.socket.entries.length
    first.finish.resolve()
    const firstAutomatic = await run.generation.nextCall()
    firstAutomatic.finish.resolve()
    const secondAutomatic = await run.generation.nextCall()
    await run.project.processBrowserCommand({ type: 'stop_auto_extension' })
    expect(run.project.generationRoundStatus).toBe('generating')
    expect(secondAutomatic.cancelled.settled).toBe(false)
    const after = run.socket.entries.length
    secondAutomatic.finish.resolve()
    await run.socket.waitForStatus('idle', after)
    expect(run.generation.calls.map(call => call.request.segmentIdx)).toEqual([1, 2, 3])
    expect(run.project.completedSequenceSegments).toHaveLength(3)
    expect(enhancer.continueVideo.mock.calls.map(call => [call[0], call[1].lockedSegments.length])).toEqual([[null, 1], [null, 2]])
    expect(run.socket.events(automaticStart).filter(event => MANUAL_PROMPT_EVENTS.has(String(event['type'])))).toEqual([])
  })

  it('rejects a mid-round opt-in without changing the admitted plan', async () => {
    const { run, enhancer } = await startWithHeldContinuation({ curated_prompts: ['A', 'B'] })
    const first = await run.generation.nextCall()
    let after = run.socket.entries.length
    await run.project.processBrowserCommand({ type: 'set_auto_extension', enabled: true })
    await run.project.processBrowserCommand({ type: 'append_prompt', prompt: 'An extra scene', auto_extension_enabled: true })
    expect(run.socket.events(after)).toEqual([
      { type: 'error', message: 'Unsupported project action: set_auto_extension.' },
      { type: 'error', prompt_id: null, message: 'Wait for this generation round to finish before changing the video.' },
    ])
    expect(run.project.autoContinueAfterGeneration).toBe(false)
    first.finish.resolve()
    const second = await run.generation.nextCall()
    expect(second.request.prompt).toBe('B')
    after = run.socket.entries.length
    second.finish.resolve()
    await run.socket.waitForStatus('idle', after)
    expect(run.generation.calls).toHaveLength(2)
    expect(enhancer.continueVideo).not.toHaveBeenCalled()
    expect(run.project.completedSequencePrompts).toEqual(['A', 'B'])
  })

  it.each(['preparing', 'generating'])('lets stop during initial %s finish the selected sequence without automatic work', async (phase) => {
    const enhancer = new FakePromptEnhancer()
    const rewrite = enhancer.rewriteRollout.getMockImplementation()!
    const entered = new Deferred()
    const release = new Deferred()
    enhancer.rewriteRollout.mockImplementationOnce(async (prompts, options) => {
      entered.resolve()
      await release.promise
      return await rewrite(prompts, options)
    })
    harness = await openUserActions({ enhancer })
    const run = await harness.start(projectPayload({
      initial_rollout_prompt: 'A two-scene story', segment_count: 2, auto_extension_enabled: true,
    }))
    await within(entered.promise)
    if (phase === 'preparing') {
      await run.project.processBrowserCommand({ type: 'stop_auto_extension' })
      expect(run.project.generationRoundStatus).toBe('preparing')
      expect(run.project.autoContinueAfterGeneration).toBe(false)
    }
    release.resolve()
    const first = await run.generation.nextCall()
    if (phase === 'generating') {
      await run.project.processBrowserCommand({ type: 'stop_auto_extension' })
      expect(run.project.generationRoundStatus).toBe('generating')
      expect(first.cancelled.settled).toBe(false)
    }
    first.finish.resolve()
    const second = await run.generation.nextCall()
    second.finish.resolve()
    expect(await run.socket.waitForStatus('idle')).toEqual(roundStatus('idle', false))
    expect(run.project.completedSequencePrompts).toEqual(['Scene 1', 'Scene 2'])
    expect(run.generation.calls).toHaveLength(2)
    expect(enhancer.continueVideo).not.toHaveBeenCalled()
    if (phase === 'preparing') {
      const events = run.socket.events().slice(0, 5)
      // The seed instruction has no browser prompt ID, so the action generated one.
      const promptId = events[3]?.['prompt_id']
      expect(promptId).toMatch(UUID_V4)
      expect(events).toEqual([
        roundStatus('preparing', true), roundStatus('preparing', false),
        { type: 'seed_prompts_updated', prompts: ['Scene 1', 'Scene 2'], model: 'model-a', latency_ms: 12.35, raw_llm_output: rolloutText(2) },
        { type: 'rewrite_seed_prompts_complete', prompt_id: promptId },
        roundStatus('generating', false),
      ])
    }
  })

  describe.each(['append_prompt', 'rewrite_seed_prompts', 'simple_generate'])('%s', (command) => {
    it.each([false, true])('consumes the Auto Extension opt-in %s with the command', async (optIn) => {
      const { run, provider, enhancer } = await startWithHeldContinuation({ curated_prompts: ['A'] })
      await finishRound(run, ['A'])
      const payload: Record<string, unknown> = { type: command, prompt: 'A new scene', rewrite_instruction: 'Change the scene' }
      if (optIn) payload['auto_extension_enabled'] = true
      await run.project.processBrowserCommand(payload)
      expect(run.project.autoContinueAfterGeneration).toBe(optIn)
      const manual = await run.generation.nextCall()
      let after = run.socket.entries.length
      manual.finish.resolve()
      if (optIn) {
        await within(provider.entered.promise)
        await run.project.processBrowserCommand({ type: 'stop_auto_extension' })
        provider.release.resolve()
        const automatic = await run.generation.nextCall()
        after = run.socket.entries.length
        automatic.finish.resolve()
      }
      await run.socket.waitForStatus('idle', after)
      expect(enhancer.continueVideo).toHaveBeenCalledTimes(Number(optIn))
      expect(run.generation.calls).toHaveLength(2 + Number(optIn))
      await run.project.processBrowserCommand({ type: command, prompt: 'Another scene', rewrite_instruction: 'Change the scene again' })
      expect(run.project.autoContinueAfterGeneration).toBe(false)
      // A rewrite keeps the length of the preceding accepted sequence, which Auto Extension grew to two segments.
      const followingCount = command === 'rewrite_seed_prompts' && optIn ? 2 : 1
      after = run.socket.entries.length
      for (let index = 0; index < followingCount; index += 1) (await run.generation.nextCall()).finish.resolve()
      await run.socket.waitForStatus('idle', after)
      expect(enhancer.continueVideo).toHaveBeenCalledTimes(Number(optIn))
    })

    it('rejects a malformed opt-in without retaining assets or changing the project', async () => {
      const { run } = await startWithHeldContinuation({ curated_prompts: ['A'] })
      await finishRound(run, ['A'])
      const sequenceIds = run.project.completedSequenceSegmentIds
      const retainRequests = harness!.assets.retainRequests.length
      const after = run.socket.entries.length
      await run.project.processBrowserCommand({
        type: command, prompt: 'A new scene', rewrite_instruction: 'Change the scene', enhancement_enabled: true,
        auto_extension_enabled: 'true', reference_asset_ids: ['unavailable'],
      })
      expect(run.socket.events(after)).toEqual([
        { type: 'error', prompt_id: null, message: 'auto_extension_enabled must be a boolean.' },
      ])
      expect(harness!.assets.retainRequests).toHaveLength(retainRequests)
      expect(run.project.generationRoundStatus).toBe('idle')
      expect(run.project.autoContinueAfterGeneration).toBe(false)
      expect(run.project.promptEnhancementEnabled).toBe(false)
      expect(run.project.completedSequenceSegmentIds).toEqual(sequenceIds)
      expect(run.generation.calls).toHaveLength(1)
    })
  })

  it.each([null, 1, 'true'])('rejects a malformed creation opt-in %j before retaining assets', async (invalid) => {
    const assets = new FakeAssets()
    assets.addImage('image')
    harness = await openUserActions({ assets })
    const creation = harness.service.createProject({
      projectId: 'project', socket: new FakeSocket(), payload: projectPayload({
        curated_prompts: ['A'], generation_mode: 'i2v', reference_asset_ids: ['image'], auto_extension_enabled: invalid,
      }),
    })
    await expect(creation).rejects.toBeInstanceOf(ProjectValidationError)
    await expect(creation).rejects.toMatchObject({
      message: 'auto_extension_enabled must be a boolean.', reason: 'Invalid Auto extension',
    })
    expect(assets.retainRequests).toEqual([])
    expect(assets.totalRetained()).toBe(0)
  })

  it('rejects a creation opt-in without a generation request', async () => {
    harness = await openUserActions()
    await expect(harness.service.createProject({
      projectId: 'project', socket: new FakeSocket(), payload: projectPayload({ curated_prompts: [], auto_extension_enabled: true }),
    })).rejects.toMatchObject({
      message: 'Auto extension must be selected with a generation request.', reason: 'Invalid Auto extension',
    })
  })

  it.each(['prompt', 'worker'])('disables Auto Extension after an automatic %s failure and keeps completed history', async (failure) => {
    const { run, provider } = await startWithHeldContinuation(
      { curated_prompts: ['A'], auto_extension_enabled: true }, { fallbackUsed: failure === 'prompt' })
    const first = await run.generation.nextCall()
    if (failure === 'worker') {
      run.generation.rejectSegments = new GenerationSegmentError('The worker rejected the automatic segment.', 'ValueError', true)
    }
    first.finish.resolve()
    await within(provider.entered.promise)
    provider.release.resolve()
    expect(await run.socket.waitForStatus('failed')).toEqual(roundStatus('failed', false))
    const message = failure === 'prompt' ? 'Prompt extension failed for this request.' : 'The worker rejected the automatic segment.'
    expect(run.socket.eventsOfType('error')).toEqual([{ type: 'error', message, prompt_id: null }])
    expect(harness!.logEvents('generation_round_failed')).toEqual([
      logEntry('generation_round_failed', { action: 'auto_extend', error: message }),
    ])
    expect(run.project.autoContinueAfterGeneration).toBe(false)
    expect(run.project.completedSequencePrompts).toEqual(['A'])
    let after = run.socket.entries.length
    await run.project.processBrowserCommand({ type: 'set_auto_extension', enabled: true })
    expect(run.socket.events(after)).toEqual([{ type: 'error', message: 'Unsupported project action: set_auto_extension.' }])
    expect(run.project.generationRoundStatus).toBe('failed')
    run.generation.rejectSegments = null
    after = run.socket.entries.length
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'A fresh scene', enhancement_enabled: false })
    const manual = await run.generation.nextCall()
    manual.finish.resolve()
    await run.socket.waitForStatus('idle', after)
    expect(run.project.completedSequencePrompts).toEqual(['A fresh scene'])
    expect(harness!.enhancer.continueVideo).toHaveBeenCalledTimes(1)
  })

  it('claims the automatic round before the success status reaches the browser', async () => {
    const { run, provider } = await startWithHeldContinuation({ curated_prompts: ['A'], auto_extension_enabled: true })
    const first = await run.generation.nextCall()
    // The next status send is the one that follows the successful round.
    const statusHold = run.socket.hold('generation_round_status')
    first.finish.resolve()
    await within(statusHold.held.promise)
    try {
      expect(run.project.generationRoundStatus).toBe('preparing')
      const after = run.socket.entries.length
      await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'Competing edit' })
      expect(run.socket.events(after)).toEqual([{
        type: 'error', prompt_id: null, message: 'Stop Auto extension and wait for this round before changing the video.',
      }])
      await run.project.processBrowserCommand({ type: 'stop_auto_extension' })
    } finally {
      statusHold.resume.resolve()
    }
    provider.release.resolve()
    const automatic = await run.generation.nextCall()
    const after = run.socket.entries.length
    automatic.finish.resolve()
    await run.socket.waitForStatus('idle', after)
    expect(run.generation.calls).toHaveLength(2)
    expect(harness!.enhancer.continueVideo).toHaveBeenCalledTimes(1)
  })

  it('abandons the accepted automatic segment on close without preparing another prompt', async () => {
    const { run, provider } = await startWithHeldContinuation({ curated_prompts: ['A'], auto_extension_enabled: true })
    provider.release.resolve()
    ;(await run.generation.nextCall()).finish.resolve()
    const automatic = await run.generation.nextCall()
    await within(run.project.closeAndWaitForGeneration())
    expect(automatic.cancelled.settled).toBe(true)
    expect(run.project.isClosed).toBe(true)
    expect(await within(run.outcome)).toBeNull()
    expect(harness!.enhancer.continueVideo).toHaveBeenCalledTimes(1)
    expect(run.generation.calls).toHaveLength(2)
  })

  it('continues a first-frame video after its initial image is deleted', async () => {
    const assets = new FakeAssets()
    assets.addImage('first')
    const { run, provider } = await startWithHeldContinuation({
      generation_mode: 'i2v', reference_asset_ids: ['first'], curated_prompts: ['A'], auto_extension_enabled: true,
    }, { assets })
    const first = await run.generation.nextCall()
    assets.deleteAsset('first')
    expect(assets.fileExists('first')).toBe(true)
    first.finish.resolve()
    await within(provider.entered.promise)
    await run.project.processBrowserCommand({ type: 'stop_auto_extension' })
    provider.release.resolve()
    const automatic = await run.generation.nextCall()
    expect([automatic.request.referenceImages, automatic.request.continueFrom]).toEqual([[], 'continuation-1'])
    expect(assets.fileExists('first')).toBe(false)
    const after = run.socket.entries.length
    automatic.finish.resolve()
    await run.socket.waitForStatus('idle', after)
    const [firstSegment, appended] = run.project.completedSequenceSegments
    expect(appended!.referenceSegmentId).toBe(firstSegment!.segmentId)
    expect(appended!.referenceAssets).toEqual([])
  })

  it('reuses the latest round\'s ordered references and stops when one is deleted', async () => {
    const assets = new FakeAssets()
    assets.addImage('initial')
    assets.addImage('side')
    assets.addImage('front')
    const { run, provider } = await startWithHeldContinuation({
      ...REF2VA, reference_asset_ids: ['initial'], curated_prompts: ['A'],
    }, { generation: new FakeGeneration(ref2vaFacts()), assets })
    await finishRound(run, ['A'])
    await run.project.processBrowserCommand({
      type: 'simple_generate', prompt: 'A different protagonist', enhancement_enabled: false,
      reference_asset_ids: ['side', 'front'], auto_extension_enabled: true,
    })
    ;(await run.generation.nextCall()).finish.resolve()
    await within(provider.entered.promise)
    expect(harness!.enhancer.continueVideo.mock.calls[0]![1].referenceLabels).toEqual(['Picture 1', 'Picture 2'])
    provider.release.resolve()
    const automatic = await run.generation.nextCall()
    expect([automatic.request.continueFrom, automatic.request.referenceImages])
      .toEqual([null, [referenceImage('side'), referenceImage('front')]])
    assets.deleteAsset('front')
    expect(assets.fileExists('front')).toBe(true)
    automatic.finish.resolve()
    expect(await run.socket.waitForStatus('failed')).toEqual(roundStatus('failed', false))
    const message = "Asset 'front' is unavailable. Select an asset from the library."
    expect(run.socket.events().slice(-3)).toEqual([
      { type: 'ltx2_stream_complete' }, { type: 'error', message }, roundStatus('failed', false),
    ])
    expect(harness!.logEvents('auto_extension_failed')).toEqual([logEntry('auto_extension_failed', { error: message })])
    expect([assets.fileExists('front'), assets.fileExists('side')]).toEqual([false, true])
    expect(run.project.completedSequencePrompts).toEqual(['A different protagonist', 'Prepared continuation'])
    expect(run.generation.calls).toHaveLength(3)
    expect(harness!.enhancer.continueVideo).toHaveBeenCalledTimes(1)
  })
})
