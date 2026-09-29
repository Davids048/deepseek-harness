import { Buffer } from 'node:buffer'
import { hostname } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { GenerationSegmentError } from '../src/index.ts'
import { STALE_CONTINUATION_MESSAGE, settle, within, type BrowserEvent } from './fakes.ts'
import { MEASURED_LATENCY, openProjects, type ProjectsHarness } from './harness.ts'
import { actionPlugin, appendPrompt, generatePrompts } from './test-actions.ts'

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

async function open(): Promise<ProjectsHarness> {
  harness = await openProjects([
    actionPlugin(['generate_video_sequence', 'simple_generate', 'rewrite_seed_prompts'], generatePrompts),
    actionPlugin(['append_prompt'], appendPrompt),
  ])
  return harness
}

function status(value: string): BrowserEvent {
  return { type: 'generation_round_status', status: value, auto_extension_enabled: false }
}

/** The browser events of one successfully streamed segment. */
function segmentEvents(segmentIdx: number, fields: { source: string; seedPromptIndex: number | null; promptId: string | null }): unknown[] {
  return [
    { type: 'ltx2_segment_start', segment_idx: segmentIdx, source: fields.source, seed_prompt_index: fields.seedPromptIndex, prompt_id: fields.promptId },
    { type: 'media_init', segment_idx: segmentIdx, mime: 'video/mp4', stream_id: `stream-${segmentIdx}` },
    Buffer.from('segment!'),
    { type: 'media_segment_complete', segment_idx: segmentIdx, stream_id: `stream-${segmentIdx}` },
  ]
}

describe('GenerationPlanController', () => {
  it('streams each segment before the round completes and keeps one record per segment', async () => {
    const run = await (await open()).start(projectPayload({ curated_prompts: ['A', 'B', 'C'] }))
    const { project, socket, generation } = run
    const first = await generation.nextCall()
    // Let the project forward the outputs that precede the held worker reply.
    await settle()
    const plan = project.activeGenerationPlan!
    const firstRecord = project.videoSegmentsById.get(plan.segmentIds[0]!)!
    expect(firstRecord.status).toBe('generating')
    expect(socket.entries).toContainEqual(Buffer.from('segment!'))
    expect(socket.eventsOfType('ltx2_stream_complete')).toEqual([])
    expect(first.request).toEqual({
      prompt: 'A', frameWidth: 1280, frameHeight: 704, numFrames: 121, segmentIdx: 1, continueFrom: null,
      referenceImages: [], signal: project.generationSignal,
    })
    first.finish.resolve()
    const second = await generation.nextCall()
    expect(project.videoSegmentsById.get(plan.segmentIds[0]!)).toBe(firstRecord)
    expect(firstRecord.status).toBe('completed')
    expect(firstRecord.deliveryStats).toEqual({ timings: { e2e_latency_ms: 1 }, chunkCount: 1, byteCount: 8 })
    expect(firstRecord.continuationHandle).toBe('continuation-1')
    // Each chained segment continues from its predecessor's handle.
    expect(second.request.continueFrom).toBe('continuation-1')
    expect(project.completedSequenceHistory).toEqual([])
    second.finish.resolve()
    const third = await generation.nextCall()
    expect(third.request.continueFrom).toBe('continuation-2')
    expect(project.completedSequenceHistory).toEqual([])
    third.finish.resolve()
    await socket.waitForStatus('idle')
    expect(project.completedSequenceSegments.map(segment => segment.status)).toEqual(['completed', 'completed', 'completed'])
    expect(project.completedSequenceSegments.map(segment => segment.continuationHandle)).toEqual([
      'continuation-1', 'continuation-2', 'continuation-3',
    ])
    expect(project.completedSequenceHistory).toEqual([plan.sequenceIds])
    expect(generation.calls).toHaveLength(3)
    expect(project.generationRoundStatus).toBe('idle')
    expect(project.activeGenerationPlan).toBeNull()
    expect(socket.entries).toEqual([
      status('preparing'), status('generating'),
      { type: 'ltx2_stream_start', origin_prompt_id: null, origin_prompt: '', prompt_window_prompts: ['A', 'B', 'C'], continuation: false },
      ...segmentEvents(1, { source: 'curated', seedPromptIndex: 0, promptId: null }),
      ...segmentEvents(2, { source: 'curated', seedPromptIndex: 1, promptId: null }),
      ...segmentEvents(3, { source: 'curated', seedPromptIndex: 2, promptId: null }),
      { type: 'ltx2_stream_complete' }, status('idle'),
    ])
    const header = { hostname: hostname(), project_id: 'project' }
    const latency = MEASURED_LATENCY
    expect(harness!.logEntries().map(({ ts: _ts, ...entry }) => entry)).toEqual([
      { event: 'generation_round_start', ...header, action: 'generate_video_sequence', reference_asset_ids: [] },
      ...plan.segmentIds.flatMap((segmentId, index) => [
        { event: 'segment_start', ...header, segment_idx: index + 1, segment_id: segmentId, reference_asset_ids: [] },
        { event: 'segment_complete', ...header, segment_idx: index + 1, latency_ms: latency, data_size_bytes: 8 },
      ]),
      { event: 'ws_stream_complete', ...header },
    ])
  })

  it('settles every planned segment as failed when the worker fails and ends the project', async () => {
    const h = await open()
    const run = await h.start(projectPayload({ curated_prompts: ['A', 'B'] }))
    const { socket } = run
    run.generation.rejectSegments = new GenerationSegmentError('worker failed', 'RuntimeError', false)
    const error = await run.outcome
    expect(error).toEqual(new Error('worker failed'))
    expect(run.project.generationRoundStatus).toBe('failed')
    expect(run.project.activeGenerationPlan).toBeNull()
    expect(run.project.isClosed).toBe(true)
    expect([...run.project.videoSegmentsById.values()].map(segment => [segment.status, segment.error])).toEqual([
      ['failed', 'worker failed'], ['failed', 'worker failed'],
    ])
    expect(run.project.completedSequenceSegments).toEqual([])
    expect(socket.entries).toEqual([
      status('preparing'), status('generating'),
      { type: 'ltx2_stream_start', origin_prompt_id: null, origin_prompt: '', prompt_window_prompts: ['A', 'B'], continuation: false },
      { type: 'ltx2_segment_start', segment_idx: 1, source: 'curated', seed_prompt_index: 0, prompt_id: null },
      status('failed'),
    ])
    expect(h.logEvents('generation_round_failed')).toEqual([
      { event: 'generation_round_failed', hostname: hostname(), project_id: 'project', action: 'generate_video_sequence', error: 'worker failed' },
    ])
  })

  it('reports a worker ValueError, resets continuation state, and keeps the project editable', async () => {
    const run = await (await open()).start(projectPayload({ curated_prompts: ['A'] }))
    ;(await run.generation.nextCall()).finish.resolve()
    await run.socket.waitForStatus('idle')
    const acceptedIds = run.project.completedSequenceSegmentIds
    expect(run.project.generationPlanController.lastCompletedSegmentId).toBe(acceptedIds[0])
    run.generation.rejectSegments = new GenerationSegmentError('The worker rejected this shot.', 'ValueError', true)
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({ type: 'simple_generate', prompt: 'Rejected', prompt_id: 'clip' })
    await run.socket.waitForStatus('failed', after)
    expect(run.socket.events(after).slice(-2)).toEqual([
      { type: 'error', message: 'The worker rejected this shot.', prompt_id: 'clip' }, status('failed'),
    ])
    expect(run.project.generationPlanController.lastCompletedSegmentId).toBeNull()
    expect(run.project.completedSequenceSegmentIds).toBe(acceptedIds)
    expect(run.project.isClosed).toBe(false)

    // The backend no longer holds the accepted segment's conditioning, so it refuses the accepted segment's handle.
    run.generation.rejectSegments = null
    const retry = run.socket.entries.length
    await run.project.processBrowserCommand({ type: 'append_prompt', prompt: 'Next', prompt_id: 'append' })
    await run.socket.waitForStatus('failed', retry)
    expect(run.generation.requests.at(-1)!.continueFrom).toBe('continuation-1')
    expect(run.socket.eventsOfType('error', retry)).toEqual([
      { type: 'error', message: STALE_CONTINUATION_MESSAGE, prompt_id: 'append' },
    ])
    expect(run.generation.calls).toHaveLength(1)
  })

  it('appends a continuation that references the completed segment', async () => {
    const run = await (await open()).start(projectPayload({ curated_prompts: ['A'] }))
    ;(await run.generation.nextCall()).finish.resolve()
    await run.socket.waitForStatus('idle')
    const preceding = run.project.completedSequenceSegments[0]!
    const after = run.socket.entries.length
    await run.project.processBrowserCommand({ type: 'append_prompt', prompt: 'B', prompt_id: 'continue' })
    const following = await run.generation.nextCall()
    expect([following.request.continueFrom, following.request.referenceImages]).toEqual([preceding.continuationHandle, []])
    expect(following.request.segmentIdx).toBe(2)
    following.finish.resolve()
    await run.socket.waitForStatus('idle', after)
    expect(run.project.completedSequencePrompts).toEqual(['A', 'B'])
    expect(run.project.completedSequenceSegments[1]!.referenceSegmentId).toBe(preceding.segmentId)
    expect(run.project.completedSequenceHistory[0]).toEqual([preceding.segmentId])
    expect(run.socket.entries.slice(after)).toEqual([
      status('preparing'), status('generating'),
      { type: 'ltx2_stream_start', origin_prompt_id: 'continue', origin_prompt: 'B', prompt_window_prompts: ['A', 'B'], continuation: true },
      ...segmentEvents(2, { source: 'user_raw', seedPromptIndex: null, promptId: 'continue' }),
      { type: 'ltx2_stream_complete' }, status('idle'),
    ])
  })

  it.each([
    { type: 'append_prompt', prompt: 'continue' },
    { type: 'rewrite_seed_prompts', rewrite_instruction: 'change' },
    { type: 'simple_generate', prompt: 'clip', prompt_id: 'clip' },
  ])('rejects $type at receipt while the round generates and never defers it', async (command) => {
    const run = await (await open()).start(projectPayload({ curated_prompts: ['A', 'B'] }))
    const first = await run.generation.nextCall()
    const after = run.socket.entries.length
    await run.project.processBrowserCommand(command)
    expect(run.socket.events(after)).toEqual([{
      type: 'error', prompt_id: command.prompt_id ?? null,
      message: 'Wait for this generation round to finish before changing the video.',
    }])
    first.finish.resolve()
    const second = await run.generation.nextCall()
    expect(second.request.prompt).toBe('B')
    second.finish.resolve()
    await run.socket.waitForStatus('idle')
    await settle()
    expect(run.generation.calls).toHaveLength(2)
    expect(run.project.generationRoundStatus).toBe('idle')
  })

  it('abandons the submitted segment on close and cancels the rest of the plan', async () => {
    const run = await (await open()).start(projectPayload({ curated_prompts: ['A', 'B', 'C'] }))
    const submitted = await run.generation.nextCall()
    const plan = run.project.activeGenerationPlan!
    // Closure does not wait for the backend to finish the abandoned segment.
    await within(run.project.closeAndWaitForGeneration())
    expect(submitted.cancelled.settled).toBe(true)
    expect(plan.segmentIds.map(segmentId => run.project.videoSegmentsById.get(segmentId)!.status)).toEqual([
      'cancelled', 'cancelled', 'cancelled',
    ])
    expect(run.project.videoSegmentsById.get(plan.segmentIds[0]!)!.error).toBe('Project disconnected.')
    expect(run.generation.calls).toHaveLength(1)
    expect(await run.outcome).toBeNull()
    expect(run.socket.eventsOfType('ltx2_stream_complete')).toEqual([])
    expect(run.socket.eventsOfType('media_segment_complete')).toEqual([])
  })
})
