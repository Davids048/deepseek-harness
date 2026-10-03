/**
 * Projects outlive their browser sockets: `dreamverseProjects` stores each project as a `dreamverse` project in
 * `dreamverseProjectStore`, keeps its segment files and reference image copies in the file store under the project's
 * ownership, reopens it for a later socket under a new lease, and migrates the schema-1 projects of earlier versions.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { projectOwner } from '@dreamverse/assets-manager'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProjectValidationError, migrateLegacyProjects, type AssetId, type DreamverseProjectData, type ProjectId, type SegmentId,
} from '../src/index.ts'
import { FakeAssets, FakeGeneration, FakeSocket, lastFrameBytes, ltxFacts, ref2vaFacts, referenceImage } from './fakes.ts'
import { FakeHolder, openProjects, type ProjectRun, type ProjectsHarness } from './harness.ts'
import { actionPlugin, appendPrompt, generatePrompts } from './test-actions.ts'

let harness: ProjectsHarness | undefined

/** The asset ID of the library image that `openRef2va` adds. */
const IMAGE_ID = brandString<AssetId>('image')

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

/**
 * Mount the project service on the reference-image model with sequence generation and append actions.
 * @param projectRoot - a prepared project store root, such as one with schema-1 projects to migrate.
 * @returns the harness, whose library holds the image `image`.
 */
async function openRef2va(projectRoot?: string): Promise<ProjectsHarness> {
  const assets = new FakeAssets()
  assets.addImage('image')
  harness = await openProjects([
    actionPlugin(['generate_video_sequence'], generatePrompts),
    actionPlugin(['append_prompt'], appendPrompt),
  ], { generation: new FakeGeneration(ref2vaFacts()), assets, ...(projectRoot === undefined ? {} : { projectRoot }) })
  return harness
}

/** Close a running project the way its socket's connection does: close it, wait for the loop, and release the lease. */
async function closeRun(run: ProjectRun): Promise<void> {
  await run.project.closeAndWaitForGeneration()
  await run.outcome
  run.project.releaseLease()
}

/** @returns the stored DreamVerse workload data of a project. */
function storedData(projectId: ProjectId): DreamverseProjectData {
  return harness!.store.get(projectId)!.workload.data as DreamverseProjectData
}

/** @returns the content of a file store file. */
function fileContent(assetId: string): Buffer {
  return readFileSync(harness!.assets.get(assetId).filePath)
}

describe('stored projects', () => {
  it('stores a created project and reopens it to continue the last completed sequence from its stored last frame', async () => {
    const { assets } = await openRef2va()
    const created = await harness!.start(ref2vaPayload({ preset_label: 'Ocean', curated_prompts: ['A wave'] }))
    const projectId = created.project.projectId
    const owner = projectOwner(projectId)
    ;(await created.generation.nextCall()).finish.resolve()
    await created.socket.waitForStatus('idle', 1)
    const [firstId] = created.project.completedSequenceSegmentIds
    const [copy] = assets.list(owner)
    const first = storedData(projectId).segments[0]!
    expect(harness!.store.get(projectId)).toMatchObject({
      kind: 'dreamverse', title: 'Ocean', thumbnailAssetId: first.last_frame_asset_id,
      workload: { schemaVersion: 1, data: {
        prompt_sequence_label: 'Ocean', creation_config: { model_id: 'h3-ref2va', frame_width: 1344, num_frames: 124 },
        segments: [{ segment_id: firstId, prompt: 'A wave', status: 'completed', mime: 'video/mp4', reference_asset_ids: [copy!.assetId] }],
        completed_sequences: [[firstId]], reference_copies: { image: copy!.assetId },
      } },
    })
    expect([fileContent(first.video_asset_id!).toString(), fileContent(first.last_frame_asset_id!)]).toEqual(['segment!', lastFrameBytes(1)])
    await closeRun(created)

    const reopened = await harness!.open(projectId)
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
    // The library image is copied on its first use only; the second round reuses the copy.
    expect(assets.copyRequests).toEqual([['image', owner]])
    const data = storedData(projectId)
    expect(data.completed_sequences).toEqual([[firstId], [firstId, secondId]])
    expect(data.segments[1]).toMatchObject({
      segment_id: secondId, instruction: { request_id: 'request-2', text: 'A shore' }, reference_segment_id: firstId,
      reference_asset_ids: [copy!.assetId],
    })
    expect(harness!.store.get(projectId)?.thumbnailAssetId).toBe(data.segments[1]!.last_frame_asset_id)
  })

  it('continues with its copy of a library image that the library deleted, and rejects a deleted image it never copied', async () => {
    const { assets } = await openRef2va()
    const created = await harness!.start(ref2vaPayload({ curated_prompts: ['A wave'] }))
    const projectId = created.project.projectId
    ;(await created.generation.nextCall()).finish.resolve()
    await created.socket.waitForStatus('idle', 1)
    await closeRun(created)
    const copyId = storedData(projectId).reference_copies[IMAGE_ID]!
    assets.deleteAsset('image')
    expect(assets.fileExists('image')).toBe(false)

    const reopened = await harness!.open(projectId)
    await reopened.socket.waitForStatus('idle')
    await reopened.project.processBrowserCommand({
      type: 'append_prompt', prompt: 'A shore', prompt_id: 'request-2', reference_asset_ids: ['image'],
    })
    const continuation = await reopened.generation.nextCall()
    expect(continuation.request.referenceImages).toEqual([referenceImage('image'), lastFrameBytes(1)])
    continuation.finish.resolve()
    await reopened.socket.waitForStatus('idle', 1)
    expect(reopened.project.completedSequencePrompts).toEqual(['A wave', 'A shore'])
    expect(storedData(projectId).segments[1]!.reference_asset_ids).toEqual([copyId])
    expect(assets.copyRequests).toEqual([['image', projectOwner(projectId)]])

    assets.addImage('other')
    assets.deleteAsset('other')
    const after = reopened.socket.entries.length
    await reopened.project.processBrowserCommand({
      type: 'append_prompt', prompt: 'A cliff', prompt_id: 'request-3', reference_asset_ids: ['other'],
    })
    expect(reopened.socket.events(after)).toEqual([{
      type: 'error', prompt_id: 'request-3', message: "Asset 'other' is unavailable. Select an asset from the library.",
    }])
    expect(assets.totalRetained()).toBe(0)
  })

  it('stores the segment in progress as cancelled without files when the socket closes', async () => {
    const { assets } = await openRef2va()
    const run = await harness!.start(ref2vaPayload({ curated_prompts: ['A wave'] }))
    const projectId = run.project.projectId
    await run.generation.nextCall()
    await closeRun(run)
    const [segment] = storedData(projectId).segments
    expect(segment).toMatchObject({
      status: 'cancelled', error: 'Project disconnected.', mime: null, video_asset_id: null, last_frame_asset_id: null,
    })
    expect(assets.list(projectOwner(projectId)).map(record => record.name)).toEqual(['image'])
    expect(harness!.store.get(projectId)?.thumbnailAssetId).toBeNull()

    const reopened = await harness!.open(projectId)
    await reopened.socket.waitForStatus('idle')
    expect(reopened.project.videoSegmentsById.get(segment!.segment_id)?.status).toBe('cancelled')
    expect(reopened.project.completedSequenceHistory).toEqual([])
  })

  it('revokes the lease of the socket that holds a project before another socket opens it', async () => {
    await openRef2va()
    const first = await harness!.start(ref2vaPayload({ curated_prompts: ['A wave'] }))
    const projectId = first.project.projectId
    ;(await first.generation.nextCall()).finish.resolve()
    await first.socket.waitForStatus('idle', 1)
    const second = await harness!.open(projectId)
    expect([first.holder.revocations, first.project.isClosed, await first.outcome]).toEqual([1, true, null])
    expect(second.project.completedSequencePrompts).toEqual(['A wave'])
    expect(harness!.store.isHeld(projectId)).toBe(true)
  })

  it('refuses to open a project that is not stored, belongs to another workload, or another model created', async () => {
    const { service, generation, store } = await openRef2va()
    const multiverse = store.create({ kind: 'multiverse', title: 'Tree', workload: { schemaVersion: 1, data: {} } })
    for (const projectId of [brandString<ProjectId>('missing'), brandString<ProjectId>('../p1'), multiverse.projectId]) {
      await expect(service.openProject({ projectId, socket: new FakeSocket(), holder: new FakeHolder() }))
        .rejects.toEqual(new ProjectValidationError('Project not found.', 'Project not found'))
    }
    expect(store.isHeld(multiverse.projectId)).toBe(false)
    const created = await harness!.start(ref2vaPayload())
    await closeRun(created)
    generation.facts = ltxFacts()
    const error = await service.openProject({ projectId: created.project.projectId, socket: new FakeSocket(), holder: new FakeHolder() })
      .catch((reason: unknown) => reason)
    expect(error).toEqual(new ProjectValidationError('This project was created with h3-ref2va; this server serves fast-ltx23.', 'Model unavailable'))
    expect((error as ProjectValidationError).reason).toBe('Model unavailable')
    expect(store.isHeld(created.project.projectId)).toBe(false)
  })
})

/** The creation config of a schema-1 reference-image project. */
const LEGACY_CONFIG = {
  model_id: 'h3-ref2va', generation_mode: 'ref2va', aspect_ratio: '16:9', resolution: '720p', segment_count: 2,
  segment_duration_sec: 5, frame_width: 1344, frame_height: 768, num_frames: 124,
}

/**
 * Write a schema-1 project as earlier versions of `@dreamverse/project` stored it: two completed segments with their
 * files, the second continuing the first, and one segment that was generating when the server stopped.
 * @param root - the project store root.
 * @param projectId - the project ID.
 * @param referenceAssetIds - the library images that the segments reference.
 */
function writeLegacyProject(root: string, projectId: string, referenceAssetIds: string[]): void {
  const segment = (segmentId: string, fields: Record<string, unknown>) => ({
    segment_id: segmentId, prompt: `Prompt ${segmentId}`, source: 'preset', instruction: null, enhanced: false,
    sequence_index: null, reference_segment_id: null, reference_asset_ids: referenceAssetIds, status: 'completed',
    error: null, mime: 'video/mp4', created_at: '2026-09-01T00:00:00.000Z', ...fields,
  })
  const directory = join(root, projectId)
  mkdirSync(join(directory, 'segments'), { recursive: true })
  writeFileSync(join(directory, 'project.json'), JSON.stringify({
    schema_version: 1, project_id: projectId, title: `Legacy ${projectId}`, created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-02T00:00:00.000Z', creation_config: LEGACY_CONFIG, prompt_enhancement_enabled: false,
    prompt_sequence_id: 'ocean', prompt_sequence_label: 'Ocean',
    segments: [
      segment('s1', { sequence_index: 0 }),
      segment('s2', { source: 'user', instruction: { request_id: 'request-1', text: 'A shore' }, reference_segment_id: 's1' }),
      segment('s3', { status: 'generating', mime: null }),
    ],
    completed_sequences: [['s1'], ['s1', 's2']],
  }))
  for (const segmentId of ['s1', 's2']) {
    writeFileSync(join(directory, 'segments', `${segmentId}.mp4`), `legacy video ${segmentId}`)
    writeFileSync(join(directory, 'segments', `${segmentId}.png`), `legacy frame ${segmentId}`)
  }
}

describe('schema-1 project migration', () => {
  it('migrates schema-1 projects at startup into dreamverse projects that own their files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dreamverse-legacy-projects-'))
    const projectId = brandString<ProjectId>('p1')
    writeLegacyProject(root, projectId, ['image'])
    const { assets, store } = await openRef2va(root)
    const owner = projectOwner(projectId)
    const record = store.get(projectId)!
    const data = record.workload.data as DreamverseProjectData
    const copyId = data.reference_copies[IMAGE_ID]!
    expect(record).toMatchObject({
      kind: 'dreamverse', title: 'Legacy p1', createdAt: '2026-09-01T00:00:00.000Z', workload: { schemaVersion: 1 },
      thumbnailAssetId: data.segments[1]!.last_frame_asset_id,
    })
    expect(data).toMatchObject({
      creation_config: LEGACY_CONFIG, prompt_sequence_id: 'ocean', prompt_sequence_label: 'Ocean',
      completed_sequences: [['s1'], ['s1', 's2']],
      segments: [
        { segment_id: 's1', status: 'completed', reference_asset_ids: [copyId] },
        { segment_id: 's2', status: 'completed', reference_segment_id: 's1', reference_asset_ids: [copyId] },
        { segment_id: 's3', status: 'generating', video_asset_id: null, last_frame_asset_id: null },
      ],
    })
    expect(data.segments.slice(0, 2).map(segment => [
      fileContent(segment.video_asset_id!).toString(), fileContent(segment.last_frame_asset_id!).toString(),
    ])).toEqual([['legacy video s1', 'legacy frame s1'], ['legacy video s2', 'legacy frame s2']])
    expect(assets.list(owner).map(file => file.name)).toEqual(['image', 's1.mp4', 's1.png', 's2.mp4', 's2.png'])
    expect([existsSync(join(root, 'p1', 'segments')), existsSync(join(root, 'p1', 'project.legacy.json'))]).toEqual([false, true])

    const reopened = await harness!.open(projectId)
    await reopened.socket.waitForStatus('idle')
    expect(reopened.project.videoSegmentsById.get(brandString<SegmentId>('s3'))?.status).toBe('cancelled')
    await reopened.project.processBrowserCommand({ type: 'append_prompt', prompt: 'A cliff', reference_asset_ids: ['image'] })
    const continuation = await reopened.generation.nextCall()
    expect(continuation.request.referenceImages).toEqual([referenceImage('image'), Buffer.from('legacy frame s2')])
    expect(assets.copyRequests).toEqual([['image', owner]])
  })

  it('retries a project that an earlier run left unfinished, skips a gone reference image, and changes nothing on a re-run', async () => {
    const { assets, store } = await openRef2va()
    const root = harness!.projectRoot
    const projectId = brandString<ProjectId>('p2')
    writeLegacyProject(root, projectId, ['image', 'gone'])
    // A run that stopped before writing the record left one file that the project owns.
    const stale = await assets.addBytes({ owner: projectOwner(projectId), name: 's1.mp4', mimeType: 'video/mp4' }, Buffer.from('partial'))
    const warnings: string[] = []
    const services = { store, assets, warn: (message: string) => { warnings.push(message) } }
    await migrateLegacyProjects(services)
    expect(() => assets.get(stale.assetId)).toThrow(/unavailable/)
    expect(warnings).toEqual(['DreamVerse project p2: reference image gone is gone; its segments keep no copy.'])
    const data = store.get(projectId)!.workload.data as DreamverseProjectData
    expect(data.reference_copies).toEqual({ image: expect.any(String) as string })
    expect(data.segments[0]!.reference_asset_ids).toEqual([data.reference_copies[IMAGE_ID]])
    const migrated = store.get(projectId)
    const files = assets.list(projectOwner(projectId))

    await migrateLegacyProjects(services)
    expect(warnings).toHaveLength(1)
    expect([store.get(projectId), assets.list(projectOwner(projectId))]).toEqual([migrated, files])
  })
})
