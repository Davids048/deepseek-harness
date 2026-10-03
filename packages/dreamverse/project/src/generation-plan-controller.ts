/**
 * Execute a fixed generation plan and stream every segment as its output arrives.
 *
 * User actions prepare plans; this controller only submits ready segments to `dreamverseSegmentGeneration` and records
 * outcomes, including each segment's last frame, which a later segment starts from. The service stores a completed
 * segment's video and last frame in the file store before the project record names them.
 *
 * @module @dreamverse/project/generation-plan-controller
 */

import { randomUUID } from 'node:crypto'
import { projectOwner } from '@dreamverse/assets-manager'
import type { AssetRecord } from './dependencies.ts'
import { ProjectClosedError, errorMessage } from './errors.ts'
import { segmentRecord, type GenerationPlan } from './generation-plan.ts'
import type { Project } from './project.ts'
import { round2 } from './python-values.ts'
import type { VideoSegment } from './video-segment.ts'

/**
 * Build a browser stream ID in the reference `generate_stream_id` form, such as `seg007-abcd1234`.
 * @param segmentIdx - the segment's one-based display position.
 * @returns a new stream ID.
 */
function generateStreamId(segmentIdx: number): string {
  return `seg${String(segmentIdx).padStart(3, '0')}-${randomUUID().replaceAll('-', '').slice(0, 8)}`
}

/** Submit dependency-ready segments and settle one finite round. */
export class GenerationPlanController {
  /** The segment that this project generated last; null after any failed round. */
  lastCompletedSegmentId: string | null = null

  constructor(private readonly project: Project) {}

  /**
   * Generate the accepted plan without admitting edits between its segments.
   *
   * Independent segments start fresh video; a segment with a predecessor starts from the predecessor's last frame.
   * On failure, unfinished segments of the plan become `cancelled` when the project closed and `failed` otherwise,
   * and the error propagates.
   * @param plan - the fixed round.
   */
  async execute(plan: GenerationPlan): Promise<void> {
    const project = this.project
    plan.validate(project.videoSegmentsById)
    try {
      await this.announceRound(plan)
      for (let segment = plan.nextReadySegment(project.videoSegmentsById); segment !== null;
        segment = plan.nextReadySegment(project.videoSegmentsById)) {
        if (project.isClosed) throw new ProjectClosedError()
        const segmentIdx = plan.sequenceIds.indexOf(segment.segmentId) + 1
        await this.generateSegment(segment, segmentIdx)
        this.lastCompletedSegmentId = segment.segmentId
      }
      if (plan.segmentIds.some(segmentId => segmentRecord(project.videoSegmentsById, segmentId).status !== 'completed')) {
        throw new Error('Generation stopped before all segment dependencies completed.')
      }
      await project.sendBrowserEvent({ type: 'ltx2_stream_complete' })
      await project.logProjectEvent('ws_stream_complete')
    } catch (error) {
      this.lastCompletedSegmentId = null
      for (const segmentId of plan.segmentIds) {
        const segment = segmentRecord(project.videoSegmentsById, segmentId)
        if (segment.status === 'pending' || segment.status === 'generating') {
          segment.status = error instanceof ProjectClosedError ? 'cancelled' : 'failed'
          segment.error = errorMessage(error) || 'Project disconnected.'
        }
      }
      project.persist()
      throw error
    }
  }

  /** Describe the video and prompt window before sending this round's media. */
  private async announceRound(plan: GenerationPlan): Promise<void> {
    const project = this.project
    const sequence = plan.sequenceIds.map(segmentId => segmentRecord(project.videoSegmentsById, segmentId))
    const [firstSegmentId = ''] = plan.segmentIds
    const instruction = segmentRecord(project.videoSegmentsById, firstSegmentId).instruction
    await project.sendBrowserEvent({
      type: 'ltx2_stream_start',
      origin_prompt_id: instruction ? instruction.requestId : null,
      origin_prompt: instruction ? instruction.text : '',
      prompt_window_prompts: sequence.map(segment => segment.prompt),
      continuation: plan.append,
    })
  }

  /**
   * Publish segment origin, generate the segment through `dreamverseSegmentGeneration` while its video streams to the
   * browser (`media_init`, the binary chunks, then `media_segment_complete` after the service stored the files), and
   * record its stored files and delivery statistics.
   * @param segment - the ready segment.
   * @param segmentIdx - the segment's one-based position in the plan's display sequence.
   */
  private async generateSegment(segment: VideoSegment, segmentIdx: number): Promise<void> {
    const project = this.project
    await project.sendBrowserEvent({
      type: 'ltx2_segment_start', segment_idx: segmentIdx,
      source: segment.wireSource, seed_prompt_index: segment.sequenceIndex,
      prompt_id: segment.instruction ? segment.instruction.requestId : null,
    })
    await project.logProjectEvent('segment_start', {
      segment_idx: segmentIdx, segment_id: segment.segmentId,
      reference_asset_ids: segment.referenceAssets.map(asset => asset.assetId),
    })
    if (project.isClosed) throw new ProjectClosedError()
    segment.status = 'generating'
    const startedAt = performance.now()
    const predecessorId = segment.referenceSegmentId
    const predecessor = predecessorId === null ? null : segmentRecord(project.videoSegmentsById, predecessorId)
    const { creationConfig } = segment
    let streamId: string | null = null
    const generated = await project.segmentGeneration.generate({
      prompt: segment.prompt,
      frameWidth: creationConfig.frame_width,
      frameHeight: creationConfig.frame_height,
      numFrames: creationConfig.num_frames,
      generationMode: creationConfig.generation_mode,
      referenceAssets: segment.referenceAssets,
      previousLastFrame: predecessor === null ? null : this.lastFrameOf(predecessor),
      owner: projectOwner(project.projectId),
      name: segment.segmentId,
      signal: project.generationSignal,
    }, {
      videoStart: async (mime) => {
        streamId = generateStreamId(segmentIdx)
        await project.sendBrowserEvent({ type: 'media_init', segment_idx: segmentIdx, mime, stream_id: streamId })
      },
      chunk: async (bytes) => { await project.socket.sendBytes(bytes) },
    })
    await project.sendBrowserEvent({ type: 'media_segment_complete', segment_idx: segmentIdx, stream_id: streamId })
    segment.deliveryStats = { timings: generated.timings, chunkCount: generated.chunkCount, byteCount: generated.byteCount }
    segment.videoAssetId = generated.video.assetId
    segment.lastFrameAssetId = generated.lastFrame.assetId
    segment.mime = generated.mime
    segment.status = 'completed'
    project.persist()
    const totalMs = performance.now() - startedAt
    const workerMs = segment.deliveryStats.timings['e2e_latency_ms'] || 0
    const latency = {
      total: round2(totalMs), worker_e2e: round2(workerMs),
      main_user_step: round2(totalMs), overhead: round2(totalMs - workerMs),
    }
    await project.logProjectEvent('segment_complete', {
      segment_idx: segmentIdx, latency_ms: latency, data_size_bytes: segment.deliveryStats.byteCount,
    })
  }

  /**
   * @param predecessor - the completed segment that the next segment continues.
   * @returns the predecessor's stored last frame.
   * @throws Error when the predecessor kept no last frame.
   */
  private lastFrameOf(predecessor: VideoSegment): AssetRecord {
    if (predecessor.lastFrameAssetId === null) {
      throw new Error(`Video segment ${predecessor.segmentId} kept no last frame to continue from.`)
    }
    return this.project.assetRecord(predecessor.lastFrameAssetId)
  }
}
