import { hostname } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DreamverseValueError,
  ProjectClosedError,
  ProjectValidationError,
  type ActionPayload,
  type AssetRecord,
  type UserActionHandler,
} from '../src/index.ts'
import {
  Deferred,
  FakeGeneration,
  FakeSocket,
  ref2vaFacts,
  referenceImage,
  settle,
  within,
  type BrowserEvent,
} from './fakes.ts'
import { openProjects, type ProjectsHarness } from './harness.ts'
import { actionPlugin, generatePrompts } from './test-actions.ts'

let harness: ProjectsHarness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

/** A `project_init_v1` message for the default text-to-video model. */
function projectPayload(fields: Record<string, unknown> = {}): Record<string, unknown> {
  const prompts = fields['curated_prompts']
  return {
    type: 'project_init_v1', model_id: 'fast-ltx23', generation_mode: 't2va', aspect_ratio: '16:9',
    resolution: '720p', segment_count: Array.isArray(prompts) && prompts.length > 0 ? prompts.length : 3,
    segment_duration_sec: 5, enhancement_enabled: false, auto_extension_enabled: false, ...fields,
  }
}

/** The `project_init_v1` fields that select the reference-image model. */
const REF2VA = { model_id: 'h3-ref2va', generation_mode: 'ref2va' }

function status(value: string, autoExtensionEnabled = false): BrowserEvent {
  return { type: 'generation_round_status', status: value, auto_extension_enabled: autoExtensionEnabled }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return await promise.then(() => { throw new Error('expected a rejection') }, (error: unknown) => error as Error)
}

/** Serves every generation action type with `generatePrompts`. */
function generationPlugins() {
  return [actionPlugin(['generate_video_sequence', 'simple_generate', 'append_prompt', 'rewrite_seed_prompts'], generatePrompts)]
}

/** A handler that waits for `gate` before generating, so specs can act while the round is preparing. */
function heldGeneration(gate: Deferred): UserActionHandler {
  return async (project, payload, options) => {
    await gate.promise
    await generatePrompts(project, payload, options)
  }
}

describe('Project creation', () => {
  it('resolves settings, ignores rewrite settings, validates creation, and queues the initial sequence action', async () => {
    const received: { payload: ActionPayload; referenceAssets: readonly AssetRecord[] }[] = []
    harness = await openProjects([actionPlugin(['generate_video_sequence'], async (_project, payload, options) => {
      received.push({ payload, referenceAssets: options.referenceAssets })
    })])
    const payload = projectPayload({
      preset_id: 'forest', preset_label: '  Forest ', rewrite_model: 'model-b', rewrite_temperature: 0.4,
      rewrite_window_system_prompt: ' window ', rewrite_user_system_prompt: ' user ',
      initial_rollout_prompt: ' A garden ', initial_prompt_id: 'seed', curated_prompts: [' A ', '', 3, 'B'],
      segment_count: 2,
    })
    const run = await harness.start(payload)
    const { project } = run
    expect(project.generationRoundStatus).toBe('preparing')
    expect(project.videoGenerationSettings).toEqual({
      model_id: 'fast-ltx23', generation_mode: 't2va', aspect_ratio: '16:9', resolution: '720p', segment_count: 2,
      segment_duration_sec: 5, frame_width: 1280, frame_height: 704, num_frames: 121,
    })
    expect({
      promptSequenceId: project.promptSequenceId, promptSequenceLabel: project.promptSequenceLabel,
      promptEnhancementEnabled: project.promptEnhancementEnabled, promptEnhancementModel: project.promptEnhancementModel,
      promptEnhancementTimeoutMs: project.promptEnhancementTimeoutMs,
      autoContinueAfterGeneration: project.autoContinueAfterGeneration,
    }).toEqual({
      promptSequenceId: 'forest', promptSequenceLabel: 'Forest', promptEnhancementEnabled: false,
      promptEnhancementModel: 'model-a', promptEnhancementTimeoutMs: 20000, autoContinueAfterGeneration: false,
    })
    await run.socket.waitForStatus('idle')
    expect(received).toEqual([{
      payload: { type: 'generate_video_sequence', prompt: 'A garden', prompt_id: 'seed', prompts: ['A', 'B'] },
      referenceAssets: [],
    }])
    expect(run.socket.entries).toEqual([status('preparing'), status('idle')])
    expect(harness.logEvents('generation_round_start')).toEqual([{
      event: 'generation_round_start', hostname: hostname(), project_id: 'project',
      action: 'generate_video_sequence', reference_asset_ids: [],
    }])
  })

  it.each([
    [{}, true], [{ enhancement_enabled: null }, false], [{ enhancement_enabled: [] }, false],
    [{ enhancement_enabled: 'yes' }, true],
  ])('reads enhancement_enabled from %j with Python truthiness', async (fields, expected) => {
    harness = await openProjects()
    const payload = projectPayload(fields)
    if (!('enhancement_enabled' in fields)) delete payload['enhancement_enabled']
    const run = await harness.start(payload)
    expect(run.project.promptEnhancementEnabled).toBe(expected)
  })

  it.each([null, 1, 'true'])('rejects auto_extension_enabled=%j before retaining reference assets', async (invalid) => {
    harness = await openProjects()
    harness.assets.addImage('image')
    const error = await rejection(harness.service.createProject({
      projectId: 'project', socket: new FakeSocket(),
      payload: projectPayload({ curated_prompts: ['A'], generation_mode: 'i2v', reference_asset_ids: ['image'], auto_extension_enabled: invalid }),
    }))
    expect(error).toBeInstanceOf(ProjectValidationError)
    expect([error.message, (error as ProjectValidationError).reason]).toEqual([
      'auto_extension_enabled must be a boolean.', 'Invalid Auto extension',
    ])
    expect(harness.assets.retainRequests).toEqual([])
  })

  it.each([
    [{ auto_extension_enabled: true }, 'Auto extension must be selected with a generation request.', 'Invalid Auto extension'],
    [{ curated_prompts: ['A'], loop_generation_enabled: true }, 'Sequence replay is not supported.', 'Unsupported sequence replay'],
  ])('rejects creation choices %j', async (fields, message, reason) => {
    harness = await openProjects()
    const error = await rejection(harness.service.createProject({
      projectId: 'project', socket: new FakeSocket(), payload: projectPayload(fields),
    }))
    expect(error).toBeInstanceOf(ProjectValidationError)
    expect([error.message, (error as ProjectValidationError).reason]).toEqual([message, reason])
    expect(harness.assets.retainRequests).toEqual([])
  })

  it('rejects a creation choice that the served model cannot execute before retaining assets', async () => {
    harness = await openProjects()
    harness.assets.addImage('image')
    const error = await rejection(harness.service.createProject({
      projectId: 'project', socket: new FakeSocket(),
      payload: projectPayload({ curated_prompts: ['A'], generation_mode: 'i2v', resolution: '4k', reference_asset_ids: ['image'] }),
    }))
    expect(error).toBeInstanceOf(ProjectValidationError)
    expect([error.message, (error as ProjectValidationError).reason]).toEqual([
      'Unsupported resolution: 4k', 'Invalid creation config',
    ])
    expect(harness.assets.retainRequests).toEqual([])
  })

  it('fails with the model-facts error, which is not ValueError-kind, when the generation backend is unreachable', async () => {
    const generation = new FakeGeneration()
    generation.modelError = new TypeError('fetch failed')
    harness = await openProjects([], { generation })
    const error = await rejection(harness.service.createProject({
      projectId: 'project', socket: new FakeSocket(), payload: projectPayload({ curated_prompts: ['A'] }),
    }))
    expect(error).toBe(generation.modelError)
    expect(error).not.toBeInstanceOf(DreamverseValueError)
    expect(harness.assets.retainRequests).toEqual([])
  })

  it.each([
    [{ reference_asset_ids: ['missing'] }, "Asset 'missing' is unavailable. Select an asset from the library.", [['missing']]],
    [{ reference_asset_ids: ['image'], initial_image: 'data:image/png;base64,' }, 'Upload references through /assets and supply reference_asset_ids.', []],
  ])('converts a rejected reference selection %j into a creation rejection', async (fields, message, retainRequests) => {
    harness = await openProjects()
    harness.assets.addImage('image')
    const error = await rejection(harness.service.createProject({
      projectId: 'project', socket: new FakeSocket(),
      payload: projectPayload({ curated_prompts: ['A'], generation_mode: 'i2v', preset_id: 'unused', ...fields }),
    }))
    expect(error).toBeInstanceOf(ProjectValidationError)
    expect([error.message, (error as ProjectValidationError).reason]).toEqual([message, 'Invalid reference assets'])
    expect(harness.assets.retainRequests).toEqual(retainRequests)
    expect(harness.assets.totalRetained()).toBe(0)
  })

  it('releases retained assets at once when the project has no generation request', async () => {
    harness = await openProjects()
    harness.assets.addImage('image')
    const run = await harness.start(projectPayload({ generation_mode: 'i2v', reference_asset_ids: ['image'] }))
    expect(run.project.generationRoundStatus).toBe('idle')
    expect(harness.assets.releaseRequests).toEqual([['image']])
    expect(harness.assets.totalRetained()).toBe(0)
    await run.socket.waitForStatus('idle')
    expect(run.socket.entries).toEqual([status('idle')])
  })
})

describe('Project command admission', () => {
  it.each([
    [{ type: 'set_generation_paused', paused: true }, 'set_generation_paused'],
    [{ type: 'set_loop_generation', enabled: true }, 'set_loop_generation'],
    [{ type: 'reset_to_seed_prompts' }, 'reset_to_seed_prompts'],
    [{ type: 'restart_generation' }, 'restart_generation'],
    [{ type: 'set_auto_extension', enabled: true }, 'set_auto_extension'],
    [{ type: 'set_rewrite_model', rewrite_model: 'model-b' }, 'set_rewrite_model'],
    [{ type: 'set_rewrite_temperature', rewrite_temperature: 0.9 }, 'set_rewrite_temperature'],
    [{ enabled: true }, 'None'],
  ])('rejects the unsupported command %j', async (command, label) => {
    harness = await openProjects(generationPlugins())
    const run = await harness.start(projectPayload())
    await run.socket.waitForStatus('idle')
    const after = run.socket.entries.length
    await run.project.processBrowserCommand(command)
    expect(run.socket.entries.slice(after)).toEqual([{ type: 'error', message: `Unsupported project action: ${label}.` }])
    expect(run.project.generationRoundStatus).toBe('idle')
    expect(run.generation.calls).toEqual([])
  })

  it('applies prompt settings between rounds without browser events', async () => {
    harness = await openProjects(generationPlugins())
    const run = await harness.start(projectPayload())
    await run.socket.waitForStatus('idle')
    const { project } = run
    const after = run.socket.entries.length
    await project.processBrowserCommand({ type: 'set_enhancement', enabled: true })
    expect(project.promptEnhancementEnabled).toBe(true)
    await project.processBrowserCommand({ type: 'set_enhancement' })
    expect(project.promptEnhancementEnabled).toBe(true)
    await project.processBrowserCommand({ type: 'set_enhancement', enabled: 0 })
    expect(project.promptEnhancementEnabled).toBe(false)
    expect(run.socket.entries.slice(after)).toEqual([])
  })

  it.each([
    { type: 'append_prompt', prompt: 'another direction', prompt_id: 'append' },
    { type: 'rewrite_seed_prompts', rewrite_instruction: 'another rewrite' },
    { type: 'simple_generate', prompt: 'another clip' },
    { type: 'set_enhancement', enabled: true },
  ])('rejects $type while the round prepares and keeps its settings', async (command) => {
    const gate = new Deferred()
    harness = await openProjects([actionPlugin(['generate_video_sequence'], heldGeneration(gate))])
    const run = await harness.start(projectPayload({ curated_prompts: ['A'] }))
    await run.socket.waitForStatus('preparing')
    const { project } = run
    const enhancementEnabled = project.promptEnhancementEnabled
    const after = run.socket.entries.length
    await project.processBrowserCommand(command)
    expect(run.socket.entries.slice(after)).toEqual([{
      type: 'error', prompt_id: 'prompt_id' in command ? command.prompt_id : null,
      message: 'Wait for this generation round to finish before changing the video.',
    }])
    expect(project.generationRoundStatus).toBe('preparing')
    expect(project.promptEnhancementEnabled).toBe(enhancementEnabled)
    gate.resolve()
    ;(await run.generation.nextCall()).finish.resolve()
    await run.socket.waitForStatus('idle')
    expect(run.generation.calls).toHaveLength(1)
  })

  it('rejects edits while Auto Extension is on and reports stop with the unchanged round status', async () => {
    const gate = new Deferred()
    harness = await openProjects([actionPlugin(['generate_video_sequence'], heldGeneration(gate))])
    const run = await harness.start(projectPayload({ curated_prompts: ['A'], auto_extension_enabled: true }))
    await run.socket.waitForStatus('preparing')
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'Competing edit', prompt_id: 'edit' })
    await run.project.processBrowserCommand({ type: 'stop_auto_extension' })
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'Competing edit', prompt_id: 'edit' })
    expect(run.socket.entries.slice(after)).toEqual([
      { type: 'error', prompt_id: 'edit', message: 'Stop Auto extension and wait for this round before changing the video.' },
      status('preparing'),
      { type: 'error', prompt_id: 'edit', message: 'Wait for this generation round to finish before changing the video.' },
    ])
    gate.resolve()
    ;(await run.generation.nextCall()).finish.resolve()
    const idle = await run.socket.waitForStatus('idle')
    expect(idle).toEqual(status('idle'))
    expect(run.generation.calls).toHaveLength(1)
  })

  it('rejects a malformed Auto Extension choice before retaining the command references', async () => {
    harness = await openProjects(generationPlugins())
    const run = await harness.start(projectPayload())
    await run.socket.waitForStatus('idle')
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({
      type: 'simple_generate', prompt: 'A new scene', prompt_id: 'clip', auto_extension_enabled: 'true',
      reference_asset_ids: ['unavailable'],
    })
    expect(run.socket.entries.slice(after)).toEqual([
      { type: 'error', prompt_id: 'clip', message: 'auto_extension_enabled must be a boolean.' },
    ])
    // Only the creation's empty selection was retained.
    expect(harness.assets.retainRequests).toEqual([[]])
    expect([run.project.generationRoundStatus, run.project.autoContinueAfterGeneration]).toEqual(['idle', false])
  })

  it('reports a rejected reference selection to the browser without queuing the command', async () => {
    harness = await openProjects(generationPlugins())
    const run = await harness.start(projectPayload())
    await run.socket.waitForStatus('idle')
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({
      type: 'simple_generate', prompt: 'A new scene', prompt_id: 'clip', reference_asset_ids: ['image'],
    })
    expect(run.socket.entries.slice(after)).toEqual([
      { type: 'error', prompt_id: 'clip', message: 'Text-to-video mode does not accept reference images.' },
    ])
    expect(harness.assets.retainRequests).toEqual([[]])
    await settle()
    expect([run.project.generationRoundStatus, run.generation.calls.length]).toEqual(['idle', 0])
  })

  it('admits a generation command and retains its references at receipt', async () => {
    harness = await openProjects(generationPlugins(), { generation: new FakeGeneration(ref2vaFacts()) })
    harness.assets.addImage('image')
    const run = await harness.start(projectPayload({ ...REF2VA, reference_asset_ids: ['image'] }))
    await run.socket.waitForStatus('idle')
    const after = run.socket.entries.length
    const first = run.project.processBrowserCommand({
      type: 'simple_generate', prompt: 'First', prompt_id: 'first', reference_asset_ids: ['image'],
    })
    // The command is admitted before its call returns, so the next command sees the preparing round.
    expect([run.project.generationRoundStatus, harness.assets.retainedCount('image')]).toEqual(['preparing', 1])
    const second = run.project.processBrowserCommand({ type: 'set_enhancement', enabled: true, prompt_id: 'second' })
    await within(Promise.all([first, second]))
    expect(run.socket.eventsOfType('error', after)).toEqual([
      { type: 'error', prompt_id: 'second', message: 'Wait for this generation round to finish before changing the video.' },
    ])
    expect(run.project.promptEnhancementEnabled).toBe(false)
    const call = await run.generation.nextCall()
    expect(call.request.prompt).toBe('First')
    call.finish.resolve()
    await run.socket.waitForStatus('idle', after)
  })

  it('ignores commands after closure without retaining their references', async () => {
    harness = await openProjects(generationPlugins())
    const { assets } = harness
    assets.addImage('image')
    const run = await harness.start(projectPayload({ generation_mode: 'i2v', reference_asset_ids: ['image'] }))
    await run.socket.waitForStatus('idle')
    await within(run.project.closeAndWaitForGeneration())
    const retainCount = assets.retainRequests.length
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'A', reference_asset_ids: ['image'] })
    await run.project.processBrowserCommand({ type: 'restart_generation' })
    await run.project.processBrowserCommand({ type: 'stop_auto_extension' })
    expect(run.socket.entries.slice(after)).toEqual([])
    expect(assets.retainRequests).toHaveLength(retainCount)
    expect(assets.totalRetained()).toBe(0)
    expect(run.generation.calls).toEqual([])
  })
})

describe('Project action dispatch', () => {
  it('finishes an action that generates no video', async () => {
    harness = await openProjects([actionPlugin(['simple_generate'], async (project, payload) => {
      await project.sendBrowserEvent({ type: 'action_processed', prompt_id: payload['prompt_id'] })
    })])
    const run = await harness.start(projectPayload())
    await run.socket.waitForStatus('idle')
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'A fox', prompt_id: 'clip' })
    await run.socket.waitForStatus('idle', 1)
    expect(run.socket.entries).toEqual([
      status('idle'), status('preparing'), { type: 'action_processed', prompt_id: 'clip' }, status('idle'),
    ])
    expect(run.generation.calls).toEqual([])
    expect(run.project.completedSequenceHistory).toEqual([])
    expect(run.project.activeGenerationPlan).toBeNull()
    expect(run.project.isClosed).toBe(false)
  })

  it('fails the round with the reference message when no plugin serves the action type', async () => {
    harness = await openProjects()
    const run = await harness.start(projectPayload())
    await run.socket.waitForStatus('idle')
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'A fox', prompt_id: 'clip' })
    await run.socket.waitForStatus('failed')
    expect(run.socket.entries).toEqual([
      status('idle'), status('preparing'),
      { type: 'error', message: 'Unsupported project action: simple_generate', prompt_id: 'clip' },
      status('failed'),
    ])
    expect(harness.logEvents('generation_round_failed')).toEqual([{
      event: 'generation_round_failed', hostname: hostname(), project_id: 'project',
      action: 'simple_generate', error: 'Unsupported project action: simple_generate',
    }])
    expect(run.project.isClosed).toBe(false)
  })

  it('stops serving an action type after its registration is disposed', async () => {
    harness = await openProjects()
    const fiber = harness.ctx.plugin(actionPlugin(['simple_generate'], generatePrompts))
    await fiber
    expect(() => harness!.service.registerUserAction({ actionTypes: ['simple_generate'], handler: generatePrompts }))
      .toThrow('DreamVerse user action already registered: simple_generate')
    const run = await harness.start(projectPayload())
    await run.socket.waitForStatus('idle')
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'A fox', prompt_id: 'first' })
    ;(await run.generation.nextCall()).finish.resolve()
    await run.socket.waitForStatus('idle', 1)
    await fiber.dispose()
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'A fox', prompt_id: 'second' })
    await run.socket.waitForStatus('failed', after)
    expect(run.socket.entries.slice(after)).toEqual([
      status('preparing'), { type: 'error', message: 'Unsupported project action: simple_generate', prompt_id: 'second' },
      status('failed'),
    ])
  })

  it('reports a ValueError-kind failure and accepts the next command', async () => {
    let fail = true
    harness = await openProjects([actionPlugin(['simple_generate'], async (project, payload, options) => {
      if (fail) throw new DreamverseValueError('A video clip requires a prompt.')
      await generatePrompts(project, payload, options)
    })])
    const run = await harness.start(projectPayload())
    await run.socket.waitForStatus('idle')
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: '', prompt_id: 'empty' })
    await run.socket.waitForStatus('failed')
    expect(run.socket.entries.slice(1)).toEqual([
      status('preparing'), { type: 'error', message: 'A video clip requires a prompt.', prompt_id: 'empty' }, status('failed'),
    ])
    fail = false
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'A fox' })
    ;(await run.generation.nextCall()).finish.resolve()
    await run.socket.waitForStatus('idle', 4)
    expect(run.project.completedSequencePrompts).toEqual(['A fox'])
  })

  it('ends the project after the failed status when an action fails with another error', async () => {
    const failure = new Error('socket closed')
    harness = await openProjects([actionPlugin(['generate_video_sequence'], async () => { throw failure })])
    const run = await harness.start(projectPayload({ curated_prompts: ['A'] }))
    expect(await within(run.outcome)).toBe(failure)
    expect(run.socket.entries).toEqual([status('preparing'), status('failed')])
    expect(run.project.isClosed).toBe(true)
    expect(harness.logEvents('generation_round_failed')).toEqual([{
      event: 'generation_round_failed', hostname: hostname(), project_id: 'project',
      action: 'generate_video_sequence', error: 'socket closed',
    }])
  })
})

describe('Project reference assets', () => {
  async function openRef2va(plugins = generationPlugins()): Promise<ProjectsHarness> {
    harness = await openProjects(plugins, { generation: new FakeGeneration(ref2vaFacts()) })
    harness.assets.addImage('image')
    return harness
  }

  it('sends a fresh ref2va segment its images without a continuation handle and releases a deleted reference after the round', async () => {
    const { assets } = await openRef2va()
    const run = await harness!.start(projectPayload({ ...REF2VA, reference_asset_ids: ['image'], curated_prompts: ['A wave'] }))
    const call = await run.generation.nextCall()
    expect(call.request).toEqual({
      prompt: 'A wave', frameWidth: 1344, frameHeight: 768, numFrames: 124, segmentIdx: 1, continueFrom: null,
      referenceImages: [referenceImage('image')], signal: run.project.generationSignal,
    })
    assets.deleteAsset('image')
    expect(assets.fileExists('image')).toBe(true)
    call.finish.resolve()
    await run.socket.waitForStatus('idle')
    expect(assets.fileExists('image')).toBe(false)
    expect(assets.releaseRequests).toEqual([['image']])
    expect(harness!.logEvents('segment_start')[0]).toMatchObject({ reference_asset_ids: ['image'] })
    expect(harness!.logEvents('generation_round_start')[0]).toMatchObject({ reference_asset_ids: ['image'] })
  })

  it.each([
    [{ reference_asset_ids: ['image', 'image'] }, 'reference_asset_ids must not contain duplicates.', []],
    [{ reference_asset_ids: 'image' }, 'reference_asset_ids must be a list of nonempty asset IDs.', []],
    [{ reference_asset_ids: [' '] }, 'reference_asset_ids must be a list of nonempty asset IDs.', []],
    [{ reference_asset_ids: ['image'], last_frame_image: 'data:image/png;base64,' }, 'Upload references through /assets and supply reference_asset_ids.', []],
    [{ reference_asset_ids: [] }, 'ref2va requires 1 to 9 reference images.', []],
    [{ reference_asset_ids: Array.from({ length: 10 }, (_value, index) => `image-${index}`) }, 'ref2va requires 1 to 9 reference images.', []],
    [{ reference_asset_ids: ['image', 'missing'] }, "Asset 'missing' is unavailable. Select an asset from the library.", [['image', 'missing']]],
    [{ reference_asset_ids: ['image', 'clip'] }, 'This generation workflow accepts reference images only.', [['image', 'clip']]],
    [{ reference_asset_ids: ['image', 'panorama'] }, 'Reference image aspect ratio must be between 1:4 and 4:1.', [['image', 'panorama']]],
  ])('reports the rejected selection %j to the browser and keeps nothing retained', async (fields, message, retainRequests) => {
    const { assets } = await openRef2va()
    assets.addVideo('clip')
    assets.addImage('panorama', [100, 10])
    const run = await harness!.start(projectPayload({ ...REF2VA, reference_asset_ids: ['image'] }))
    await run.socket.waitForStatus('idle')
    const creationRetainCount = assets.retainRequests.length
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'Walk', prompt_id: 'walk', ...fields })
    expect(run.socket.entries.slice(after)).toEqual([{ type: 'error', prompt_id: 'walk', message }])
    expect(assets.retainRequests.slice(creationRetainCount)).toEqual(retainRequests)
    expect(assets.totalRetained()).toBe(0)
    expect(run.project.generationRoundStatus).toBe('idle')
  })

  it('abandons the segment in progress on close and then releases its deleted reference', async () => {
    const { assets } = await openRef2va()
    const run = await harness!.start(projectPayload({ ...REF2VA, reference_asset_ids: ['image'], curated_prompts: ['A wave'] }))
    const call = await run.generation.nextCall()
    assets.deleteAsset('image')
    await within(run.project.closeAndWaitForGeneration())
    expect(call.cancelled.settled).toBe(true)
    expect(assets.fileExists('image')).toBe(false)
    expect(await within(run.outcome)).toBeNull()
  })

  it('discards the round content when its reference release fails', async () => {
    const { assets } = await openRef2va([
      actionPlugin(['generate_video_sequence'], generatePrompts),
      actionPlugin(['simple_generate'], async (project, payload, options) => {
        project.promptSequenceId = 'replacement-story'
        project.promptSequenceLabel = 'Replacement story'
        await generatePrompts(project, payload, options)
      }),
    ])
    const run = await harness!.start(projectPayload({
      ...REF2VA, reference_asset_ids: ['image'], curated_prompts: ['First shot'],
      preset_id: 'accepted-story', preset_label: 'Accepted story',
    }))
    ;(await run.generation.nextCall()).finish.resolve()
    await run.socket.waitForStatus('idle')
    const acceptedIds = run.project.completedSequenceSegmentIds
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'Replacement shot', reference_asset_ids: ['image'] })
    const replacement = await run.generation.nextCall()
    const failure = new Error('Image deletion failed')
    assets.releaseError = failure
    replacement.finish.resolve()
    expect(await within(run.outcome)).toBe(failure)
    expect(run.project.generationRoundStatus).toBe('failed')
    expect(run.project.completedSequenceHistory).toEqual([acceptedIds])
    expect([run.project.promptSequenceId, run.project.promptSequenceLabel]).toEqual(['accepted-story', 'Accepted story'])
    expect([...run.project.videoSegmentsById.values()].every(segment => segment.status === 'completed')).toBe(true)
    expect(run.socket.events().at(-1)).toEqual(status('failed'))
  })

  it('releases the accepted references when the preparation status cannot be sent', async () => {
    const dispatched = vi.fn<UserActionHandler>(async () => undefined)
    const { assets } = await openRef2va([actionPlugin(['generate_video_sequence'], dispatched)])
    const socket = new FakeSocket()
    const failure = new Error('The browser connection closed.')
    socket.failNext('generation_round_status', failure)
    const run = await harness!.start(projectPayload({ ...REF2VA, reference_asset_ids: ['image'], curated_prompts: ['A'] }), socket)
    assets.deleteAsset('image')
    expect(await within(run.outcome)).toBe(failure)
    expect(dispatched).not.toHaveBeenCalled()
    expect(run.generation.calls).toEqual([])
    expect(assets.fileExists('image')).toBe(false)
  })

  it('releases queued actions when the project closes before serving them', async () => {
    const dispatched = vi.fn<UserActionHandler>(async () => undefined)
    const { assets } = await openRef2va([actionPlugin(['generate_video_sequence'], dispatched)])
    const socket = new FakeSocket()
    const project = await harness!.service.createProject({
      projectId: 'project', socket,
      payload: projectPayload({ ...REF2VA, reference_asset_ids: ['image'], curated_prompts: ['A'] }),
    })
    expect(assets.retainedCount('image')).toBe(1)
    await within(project.closeAndWaitForGeneration())
    expect(assets.retainedCount('image')).toBe(0)
    await within(project.processQueuedGenerationActions())
    expect(dispatched).not.toHaveBeenCalled()
    expect(socket.entries).toEqual([])
  })
})

describe('Project closure', () => {
  it('stops waiting for prompt work, resolves the generation loop, and discards the late result', async () => {
    const provider = new Deferred<string>()
    const outcome = new Deferred<unknown>()
    harness = await openProjects([actionPlugin(['generate_video_sequence'], async (project, payload, options) => {
      try {
        const prompt = await project.awaitPromptWork(async () => await provider.promise)
        await generatePrompts(project, { ...payload, prompts: [prompt] }, options)
        outcome.resolve('generated')
      } catch (error) {
        outcome.resolve(error)
        throw error
      }
    })])
    const run = await harness.start(projectPayload({ curated_prompts: ['A'] }))
    await run.socket.waitForStatus('preparing')
    await within(run.project.closeAndWaitForGeneration())
    expect(await outcome.promise).toBeInstanceOf(ProjectClosedError)
    expect(await within(run.outcome)).toBeNull()
    provider.resolve('late prompt')
    await settle()
    expect(run.generation.calls).toEqual([])
    expect(run.socket.entries).toEqual([status('preparing')])
    const start = vi.fn(async () => 'not started')
    await expect(run.project.awaitPromptWork(start)).rejects.toBeInstanceOf(ProjectClosedError)
    expect(start).not.toHaveBeenCalled()
  })
})
