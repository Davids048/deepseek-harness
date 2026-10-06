/**
 * The segment broadcaster: every shot that is generating is a stream of fMP4 chunks that any number of browser
 * subscribers of its project receive in the DreamVerse media framing (`media_init`, binary chunks,
 * `media_segment_complete`). Chunks of a segment that is still in flight are kept, up to a byte budget, so a browser
 * that subscribes mid-shot still receives the whole segment.
 *
 * @module @video-harness/stream/broadcast
 */
import type { ProjectId, RecordId } from '@dv/project'

/** What `openSegment` learns about the shot. */
export interface SegmentInit {
  /** The MIME type the backend announced, codecs included. */
  mime: string
  /** The 1-based slot the shot targets when known, else 0. */
  segmentIdx: number
}

/** The writer's end of one segment stream. */
export interface SegmentStream {
  chunk(bytes: Uint8Array): void
  complete(): void
  fail(error: Error): void
}

/** One frame as a subscriber receives it: a JSON event or raw media bytes. */
export type StreamFrame = { kind: 'json'; data: Record<string, unknown> } | { kind: 'binary'; data: Uint8Array }

/** A segment whose `done` has not arrived yet. */
interface InFlightSegment {
  streamId: RecordId
  segmentIdx: number
  mime: string
  chunks: Uint8Array[]
  bufferedBytes: number
  /** True once the byte budget stopped the buffer; late subscribers then get no replay of this segment. */
  truncated: boolean
}

/** Fan-out of in-flight segments to per-project subscribers, with bounded replay for late subscribers. */
export class SegmentBroadcaster {
  private readonly subscribers = new Map<ProjectId, Set<(frame: StreamFrame) => void>>()
  private readonly inFlightSegments = new Map<ProjectId, Map<RecordId, InFlightSegment>>()

  /** @param bufferBytes - the most bytes one in-flight segment keeps for late subscribers. */
  constructor(private readonly bufferBytes: number) {}

  /**
   * Start a segment: subscribers receive `media_init` now, chunks as they arrive, and `media_segment_complete` at the
   * end. The record ID is the `stream_id` the browser sees.
   * @param projectId - the project the shot belongs to.
   * @param record - the generating record.
   * @param init - MIME type and slot.
   * @returns the writer's end.
   */
  openSegment(projectId: ProjectId, record: RecordId, init: SegmentInit): SegmentStream {
    const segment: InFlightSegment = {
      streamId: record, segmentIdx: init.segmentIdx, mime: init.mime, chunks: [], bufferedBytes: 0, truncated: false,
    }
    const segments = this.inFlightSegments.get(projectId) ?? new Map<RecordId, InFlightSegment>()
    segments.set(record, segment)
    this.inFlightSegments.set(projectId, segments)
    this.emit(projectId, { kind: 'json', data: mediaInit(segment) })
    return {
      chunk: (bytes) => {
        if (segment.bufferedBytes + bytes.byteLength <= this.bufferBytes) {
          segment.chunks.push(bytes)
          segment.bufferedBytes += bytes.byteLength
        } else {
          segment.truncated = true
        }
        this.emit(projectId, { kind: 'binary', data: bytes })
      },
      complete: () => {
        segments.delete(record)
        this.emit(projectId, { kind: 'json', data: { type: 'media_segment_complete', segment_idx: segment.segmentIdx, stream_id: record } })
      },
      fail: (error) => {
        segments.delete(record)
        this.emit(projectId, { kind: 'json', data: { type: 'error', stream_id: record, message: error.message } })
      },
    }
  }

  /**
   * Receive every frame of a project from now on; segments already in flight are replayed first (`media_init` and
   * their buffered chunks), unless their buffer was truncated.
   * @param projectId - the project.
   * @param listener - called synchronously per frame.
   * @returns a function that stops the subscription.
   */
  subscribe(projectId: ProjectId, listener: (frame: StreamFrame) => void): () => void {
    for (const segment of this.inFlightSegments.get(projectId)?.values() ?? []) {
      if (segment.truncated) continue
      listener({ kind: 'json', data: mediaInit(segment) })
      for (const chunk of segment.chunks) listener({ kind: 'binary', data: chunk })
    }
    const listeners = this.subscribers.get(projectId) ?? new Set()
    listeners.add(listener)
    this.subscribers.set(projectId, listeners)
    return () => { listeners.delete(listener) }
  }

  /**
   * @param projectId - the project.
   * @returns the stream IDs of its segments still generating.
   */
  inFlight(projectId: ProjectId): RecordId[] {
    return [...this.inFlightSegments.get(projectId)?.keys() ?? []]
  }

  private emit(projectId: ProjectId, frame: StreamFrame): void {
    for (const listener of this.subscribers.get(projectId) ?? []) listener(frame)
  }
}

/** The `media_init` event of a segment, as the DreamVerse page expects it. */
function mediaInit(segment: InFlightSegment): Record<string, unknown> {
  return { type: 'media_init', segment_idx: segment.segmentIdx, mime: segment.mime, stream_id: segment.streamId }
}
