/**
 * Execute a fixed generation plan and stream every segment as its output arrives.
 *
 * User actions prepare plans; this controller only submits ready segments and records outcomes, including each
 * segment's last frame, which a later segment starts from.
 *
 * @module @dreamverse/project/generation-plan-controller
 */

import { segmentRequestImages } from './conditioning.ts'
import { ProjectClosedError, errorMessage } from './errors.ts'
import { segmentRecord, type GenerationPlan } from './generation-plan.ts'
import type { Project } from './project.ts'
import { round2 } from './python-values.ts'
import type { VideoSegment } from './video-segment.ts'
import { streamSegmentToBrowser } from './video-stream.ts'

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
   * Publish segment origin, submit its input to the generation backend, and retain its output statistics and last
   * frame.
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
    const streamed = await streamSegmentToBrowser(project, segmentIdx, {
      prompt: segment.prompt,
      frameWidth: creationConfig.frame_width,
      frameHeight: creationConfig.frame_height,
      numFrames: creationConfig.num_frames,
      referenceImages: await segmentRequestImages(project.modelFacts, segment, predecessor),
      // A later round can continue any completed segment of a model that continues segments.
      returnLastFrame: project.modelFacts.usesPreviousFrame,
      signal: project.generationSignal,
    })
    segment.deliveryStats = streamed.deliveryStats
    segment.lastFrame = streamed.lastFrame
    segment.status = 'completed'
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
}
