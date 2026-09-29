/**
 * Stream one segment's worker media to the project's browser socket and report delivery statistics.
 *
 * @module @dreamverse/project/video-stream
 */

import type { SegmentRequest } from './dependencies.ts'
import { DreamverseValueError, GenerationSegmentError, ProjectClosedError } from './errors.ts'
import type { Project } from './project.ts'
import type { SegmentDeliveryStats } from './video-segment.ts'

/** The outcome of one successfully streamed segment. */
export interface StreamedSegment {
  deliveryStats: SegmentDeliveryStats
  /** The backend's handle for continuing the streamed segment. */
  continuationHandle: string
}

/**
 * Stream metadata and bytes, announcing media completion only after worker success.
 *
 * Leaving the segment iteration closes its generation socket, including when socket delivery fails; the backend
 * finishes an abandoned segment on its side. Delivery statistics count only successful binary sends. A worker
 * `ValueError` becomes `DreamverseValueError`, other worker failures become plain errors with the same message, and
 * any failure after the project closes becomes `ProjectClosedError`.
 * @param project - the project whose socket receives the media and whose generation client streams the segment.
 * @param request - the segment input, carrying the project's abort signal.
 * @returns worker timings with the delivered chunk and byte counts, and the segment's continuation handle.
 */
export async function streamSegmentToBrowser(
  project: Pick<Project, 'sendBrowserEvent' | 'socket' | 'generation'>,
  request: SegmentRequest,
): Promise<StreamedSegment> {
  let chunkCount = 0
  let byteCount = 0
  let streamInitialized = false
  let mediaEndStreamId: string | null = null
  try {
    for await (const output of project.generation.generateSegment(request)) {
      switch (output.kind) {
        case 'media_metadata':
          await project.sendBrowserEvent({
            type: 'media_init', segment_idx: request.segmentIdx, mime: output.mime, stream_id: output.streamId,
          })
          streamInitialized = true
          break
        case 'chunk':
          if (output.bytes.length > 0) {
            await project.socket.sendBytes(output.bytes)
            chunkCount += 1
            byteCount += output.bytes.length
          }
          break
        case 'media_end':
          mediaEndStreamId = output.streamId
          break
        case 'segment_finished':
          if (!streamInitialized) {
            throw new Error(`Segment ${request.segmentIdx} AV stream did not initialize (no media_init event)`)
          }
          if (mediaEndStreamId !== null) {
            await project.sendBrowserEvent({
              type: 'media_segment_complete', segment_idx: request.segmentIdx, stream_id: mediaEndStreamId,
            })
          }
          return {
            deliveryStats: { timings: output.timings, chunkCount, byteCount },
            continuationHandle: output.continuationHandle,
          }
        default: {
          const unexpected: never = output
          throw new Error(`Unexpected segment output: ${JSON.stringify(unexpected)}`)
        }
      }
    }
    throw new Error(`Segment ${request.segmentIdx} stream ended without a successful worker reply`)
  } catch (error) {
    if (request.signal?.aborted) throw new ProjectClosedError()
    if (error instanceof GenerationSegmentError) {
      throw error.isValueError ? new DreamverseValueError(error.message) : new Error(error.message)
    }
    throw error
  }
}
