/**
 * A finite generation round described by references to project-owned segments.
 *
 * @module @dreamverse/project/generation-plan
 */

import { DreamverseValueError } from './errors.ts'
import type { VideoSegment } from './video-segment.ts'

/**
 * Python `segments[segment_id]`: the record of a segment ID that the caller knows exists.
 * @param segments - segment records by ID.
 * @param segmentId - the segment ID.
 * @returns the record.
 * @throws Error when no record exists, as the reference `KeyError` does.
 */
export function segmentRecord(segments: ReadonlyMap<string, VideoSegment>, segmentId: string): VideoSegment {
  const segment = segments.get(segmentId)
  if (segment === undefined) throw new Error(`Unknown video segment: ${segmentId}`)
  return segment
}

/**
 * Segment IDs to generate and their intended display sequence after success.
 *
 * Dependencies live on `VideoSegment.referenceSegmentId`. Display position alone does not require another
 * segment's output. A plan stays fixed during execution.
 */
export class GenerationPlan {
  readonly segmentIds: readonly string[]
  readonly sequenceIds: readonly string[]
  readonly append: boolean

  constructor(segmentIds: readonly string[], sequenceIds: readonly string[], append = false) {
    this.segmentIds = Object.freeze([...segmentIds])
    this.sequenceIds = Object.freeze([...sequenceIds])
    this.append = append
    Object.freeze(this)
  }

  /**
   * Reject missing records, reused work, and unresolved or cyclic reference dependencies.
   * @param segments - every segment record the plan may reference, by ID.
   * @throws {DreamverseValueError} when the plan cannot run to completion.
   */
  validate(segments: ReadonlyMap<string, VideoSegment>): void {
    if (this.segmentIds.length === 0 || new Set(this.segmentIds).size !== this.segmentIds.length) {
      throw new DreamverseValueError('A generation plan requires distinct segment IDs.')
    }
    if (new Set(this.sequenceIds).size !== this.sequenceIds.length) {
      throw new DreamverseValueError('A video sequence requires distinct segment IDs.')
    }
    if (!this.segmentIds.every(segmentId => this.sequenceIds.includes(segmentId))) {
      throw new DreamverseValueError('Every planned segment must appear in the video sequence.')
    }
    if (this.sequenceIds.some(segmentId => !segments.has(segmentId))) {
      throw new DreamverseValueError('The video sequence references an unknown segment.')
    }
    const pending = new Set(this.segmentIds)
    const resolved = new Set([...segments].filter(([, segment]) => segment.status === 'completed').map(([id]) => id))
    for (const segmentId of pending) {
      if (segmentRecord(segments, segmentId).status !== 'pending') {
        throw new DreamverseValueError('Only pending segments can enter a generation plan.')
      }
    }
    // Resolve dependency layers; a layer without ready segments means a cycle or a missing prerequisite.
    while (pending.size > 0) {
      const ready = [...pending].filter((segmentId) => {
        const reference = segmentRecord(segments, segmentId).referenceSegmentId
        return reference === null || resolved.has(reference)
      })
      if (ready.length === 0) {
        throw new DreamverseValueError('Segment references contain a cycle or an unavailable dependency.')
      }
      for (const segmentId of ready) {
        pending.delete(segmentId)
        resolved.add(segmentId)
      }
    }
  }

  /**
   * Select pending work whose concrete video reference has completed.
   * @param segments - the project's segment records by ID.
   * @returns the first ready segment in plan order, or null when none is ready.
   */
  nextReadySegment(segments: ReadonlyMap<string, VideoSegment>): VideoSegment | null {
    for (const segmentId of this.segmentIds) {
      const segment = segmentRecord(segments, segmentId)
      const reference = segment.referenceSegmentId
      if (segment.status === 'pending' && (reference === null || segmentRecord(segments, reference).status === 'completed')) {
        return segment
      }
    }
    return null
  }
}
