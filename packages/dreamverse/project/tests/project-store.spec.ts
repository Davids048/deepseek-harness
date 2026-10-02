/**
 * Projects outlive their browser sockets: `dreamverseProjects` stores each project under `projectRoot`, reopens it for
 * a later socket, continues its last completed sequence from the stored last frame, and deletes it with its files and
 * asset references.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectValidationError } from '../src/index.ts'
import { FakeGeneration, FakeSocket, lastFrameBytes, ltxFacts, ref2vaFacts, referenceImage } from './fakes.ts'
import { openProjects, type ProjectRun, type ProjectsHarness } from './harness.ts'
import { actionPlugin, appendPrompt, generatePrompts } from './test-actions.ts'

let harness: ProjectsHarness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

/** A `project_init_v1` message for the reference-image model with one library image. */
function ref2vaPayload(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'project_init_v1', model_id: 'h3-ref2va', generation_mode: 'ref2va', aspect_ratio: '16:9', resolution: '720p',
    segment_count: 1, segment_duration_sec: 5, enhancement_enabled: false, auto_extension_enabled: false,
    reference_asset_ids: ['image'], ...fields,
  }
}

/** Mount the project service on the reference-image model with sequence generation and append actions. */
async function openRef2va(): Promise<ProjectsHarness> {
  harness = await openProjects([
    actionPlugin(['generate_video_sequence'], generatePrompts),
    actionPlugin(['append_prompt'], appendPrompt),
  ], { generation: new FakeGeneration(ref2vaFacts()) })
  harness.assets.addImage('image')
  return harness
}

/** Close a running project the way its socket's connection does and wait for the generation loop. */
async function closeRun(run: ProjectRun): Promise<void> {
  await run.project.closeAndWaitForGeneration()
  await run.outcome
}

describe('stored projects', () => {
  it('stores a created project and reopens it to continue the last completed sequence from its stored last frame', async () => {
    const { service, assets } = await openRef2va()
    const created = await harness!.start(ref2vaPayload({ preset_label: 'Ocean', curated_prompts: ['A wave'] }), new FakeSocket(), 'p1')
    ;(await created.generation.nextCall()).finish.resolve()
    await created.socket.waitForStatus('idle', 1)
    const [firstId] = created.project.completedSequenceSegmentIds
    expect(service.readProject('p1')).toMatchObject({
      schema_version: 1, project_id: 'p1', title: 'Ocean', prompt_sequence_label: 'Ocean',
      creation_config: { model_id: 'h3-ref2va', frame_width: 1344, num_frames: 124 },
      segments: [{ segment_id: firstId, prompt: 'A wave', status: 'completed', mime: 'video/mp4', reference_asset_ids: ['image'] }],
      completed_sequences: [[firstId]],
    })
    expect(readFileSync(service.segmentFile('p1', firstId!, 'video')!, 'utf8')).toBe('segment!')
    expect(readFileSync(service.segmentFile('p1', firstId!, 'frame')!)).toEqual(lastFrameBytes(1))
    expect(assets.projectReferences.get('p1')).toEqual(new Set(['image']))
    await closeRun(created)

    const reopened = await harness!.open('p1')
    await reopened.socket.waitForStatus('idle')
    expect([reopened.project.title, reopened.project.completedSequencePrompts]).toEqual(['Ocean', ['A wave']])
    expect(reopened.project.generationPlanController.lastCompletedSegmentId).toBe(firstId)
    await reopened.project.processBrowserCommand({
      type: 'append_prompt', prompt: 'A shore', prompt_id: 'request-2', reference_asset_ids: ['image'],
    })
    const continuation = await reopened.generation.nextCall()
    expect(continuation.request.referenceImages).toEqual([referenceImage('image'), lastFrameBytes(1)])
    continuation.finish.resolve()
    await reopened.socket.waitForStatus('idle', 1)
    const [, secondId] = reopened.project.completedSequenceSegmentIds
    expect(service.readProject('p1')?.completed_sequences).toEqual([[firstId], [firstId, secondId]])
    expect(service.readProject('p1')?.segments[1]).toMatchObject({
      segment_id: secondId, instruction: { request_id: 'request-2', text: 'A shore' }, reference_segment_id: firstId,
    })
  })

  it('stores the segment in progress as cancelled without a video file when the socket closes', async () => {
    const { service } = await openRef2va()
    const run = await harness!.start(ref2vaPayload({ curated_prompts: ['A wave'] }), new FakeSocket(), 'p1')
    await run.generation.nextCall()
    await closeRun(run)
    const [segment] = service.readProject('p1')!.segments
    expect(segment).toMatchObject({ status: 'cancelled', error: 'Project disconnected.', mime: null })
    expect(readdirSync(join(harness!.projectRoot, 'p1', 'segments'))).toEqual([])

    const reopened = await harness!.open('p1')
    await reopened.socket.waitForStatus('idle')
    expect(reopened.project.videoSegmentsById.get(segment!.segment_id)?.status).toBe('cancelled')
    expect(reopened.project.completedSequenceHistory).toEqual([])
  })

  it('lists stored projects most recently updated first and deletes one with its files and asset references', async () => {
    const { service, assets } = await openRef2va()
    const first = await harness!.start(ref2vaPayload({ curated_prompts: ['A wave'] }), new FakeSocket(), 'p1')
    ;(await first.generation.nextCall()).finish.resolve()
    await first.socket.waitForStatus('idle', 1)
    await closeRun(first)
    await closeRun(await harness!.start(ref2vaPayload({ initial_rollout_prompt: '' }), new FakeSocket(), 'p2'))
    expect(service.listProjects().map(record => [record.project_id, record.title])).toEqual([
      ['p2', 'Untitled project'], ['p1', 'A wave'],
    ])
    expect(service.deleteProject('p1')).toBe(true)
    expect(existsSync(join(harness!.projectRoot, 'p1'))).toBe(false)
    expect([service.readProject('p1'), assets.projectReferences.has('p1')]).toEqual([undefined, false])
    expect(service.deleteProject('p1')).toBe(false)
  })

  it('refuses to open a project that is not stored or that another model created', async () => {
    const { service, generation } = await openRef2va()
    for (const projectId of ['missing', '../p1']) {
      await expect(service.openProject({ projectId, socket: new FakeSocket() }))
        .rejects.toEqual(new ProjectValidationError('Project not found.', 'Project not found'))
    }
    await closeRun(await harness!.start(ref2vaPayload(), new FakeSocket(), 'p1'))
    generation.facts = ltxFacts()
    const error = await service.openProject({ projectId: 'p1', socket: new FakeSocket() }).catch((reason: unknown) => reason)
    expect(error).toEqual(new ProjectValidationError('This project was created with h3-ref2va; this server serves fast-ltx23.', 'Model unavailable'))
    expect((error as ProjectValidationError).reason).toBe('Model unavailable')
  })
})
