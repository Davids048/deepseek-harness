/**
 * Stream one segment's generated media to the project's browser socket and report delivery statistics.
 *
 * @module @dreamverse/project/video-stream
 */

import { randomUUID } from 'node:crypto'
import type { SegmentRequest } from './dependencies.ts'
import { DreamverseValueError, GenerationSegmentError, ProjectClosedError } from './errors.ts'
import type { Project } from './project.ts'
import type { SegmentDeliveryStats } from './video-segment.ts'

/** The outcome of one successfully streamed segment. */
export interface StreamedSegment {
  deliveryStats: SegmentDeliveryStats
  /** The PNG of the segment's last decoded frame; null when the request did not ask for it. */
  lastFrame: Buffer | null
}

/**
 * Build a browser stream ID in the reference `generate_stream_id` form, such as `seg007-abcd1234`.
 * @param segmentIdx - the segment's one-based display position.
 * @returns a new stream ID.
 */
function generateStreamId(segmentIdx: number): string {
  return `seg${String(segmentIdx).padStart(3, '0')}-${randomUUID().replaceAll('-', '').slice(0, 8)}`
}

/**
 * Stream video start and bytes, announcing media completion only after the backend's `done`.
 *
 * Leaving the segment iteration cancels its generation request, including when socket delivery fails; the backend
 * finishes a segment whose generation has started. Delivery statistics count only successful binary sends. A backend
 * `invalid_request` failure becomes `DreamverseValueError`, other backend failures become plain errors with the same
 * message, and any failure after the project closes becomes `ProjectClosedError`.
 * @param project - the project whose socket receives the media and whose generation client streams the segment.
 * @param segmentIdx - the segment's one-based position in the plan's display sequence, sent in browser events.
 * @param request - the segment input, carrying the project's abort signal.
 * @returns the backend's timings with the delivered chunk and byte counts, and the segment's last frame.
 * @throws Error when the stream ends before `done`, sends no video start, or omits a requested last frame.
 */
export async function streamSegmentToBrowser(
  project: Pick<Project, 'sendBrowserEvent' | 'socket' | 'generation'>,
  segmentIdx: number,
  request: SegmentRequest,
): Promise<StreamedSegment> {
  let chunkCount = 0
  let byteCount = 0
  let streamId: string | null = null
  let lastFrame: Buffer | null = null
  try {
    for await (const output of project.generation.generateSegment(request)) {
      switch (output.kind) {
        case 'last_frame':
          lastFrame = output.png
          break
        case 'video_start':
          streamId = generateStreamId(segmentIdx)
          await project.sendBrowserEvent({ type: 'media_init', segment_idx: segmentIdx, mime: output.mime, stream_id: streamId })
          break
        case 'chunk':
          if (output.bytes.length > 0) {
            await project.socket.sendBytes(output.bytes)
            chunkCount += 1
            byteCount += output.bytes.length
          }
          break
        case 'done':
          if (streamId === null) throw new Error(`Segment ${segmentIdx} AV stream did not initialize (no media_init event)`)
          if (request.returnLastFrame && lastFrame === null) {
            throw new Error(`Segment ${segmentIdx} finished without the requested last frame`)
          }
          await project.sendBrowserEvent({ type: 'media_segment_complete', segment_idx: segmentIdx, stream_id: streamId })
          return { deliveryStats: { timings: output.timings, chunkCount, byteCount }, lastFrame }
        default: {
          const unexpected: never = output
          throw new Error(`Unexpected segment output: ${JSON.stringify(unexpected)}`)
        }
      }
    }
    throw new Error(`Segment ${segmentIdx} stream ended without a successful backend reply`)
  } catch (error) {
    if (request.signal?.aborted) throw new ProjectClosedError()
    if (error instanceof GenerationSegmentError) {
      throw error.isValueError ? new DreamverseValueError(error.message) : new Error(error.message)
    }
    throw error
  }
}
