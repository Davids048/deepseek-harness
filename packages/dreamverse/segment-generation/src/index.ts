/**
 * `dreamverseSegmentGeneration`: turns one scene of a workload's story into one generation and stores its result. The
 * package also holds the generation rules that every generating workload shares: creation settings validated against
 * the served model, the creation-capabilities payload, and segment conditioning (which images a request carries, in
 * which order, under which prompt labels). It depends on the generation backend client and the file store, and on no
 * workload.
 *
 * @module @dreamverse/segment-generation
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { DreamverseAssetsManager } from './dependencies.ts'
import { generateSegment, type GeneratedSegment, type SegmentGenerationRequest, type SegmentSink } from './generate.ts'

export { lobbyCapabilitiesAsDict } from './capabilities.ts'
export {
  continuesPreviousSegment,
  referenceImageLimit,
  segmentImageLabels,
  segmentRequestImages,
  type SegmentImageLabels,
  type SegmentPosition,
} from './conditioning.ts'
export {
  SEGMENT_COUNTS,
  parseProjectCreationConfig,
  parseReferenceAssetIds,
  validateProjectCreation,
  validateReferenceAssets,
  type CreationConfig,
} from './creation.ts'
export type * from './dependencies.ts'
export type { GeneratedSegment, SegmentGenerationRequest, SegmentGenerationServices, SegmentSink } from './generate.ts'
export type { ActionPayload } from './python-values.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Generates one segment of a workload's story and stores its video and last frame. */
    dreamverseSegmentGeneration: DreamverseSegmentGeneration
  }
}

/** Generates segments through `dreamverseGeneration` and stores their files in `dreamverseAssetsManager`. */
export class DreamverseSegmentGeneration extends Service {
  static inject = ['dreamverseGeneration', 'dreamverseAssetsManager']

  /** @param ctx - owning plugin context. */
  constructor(ctx: Context) {
    super(ctx, 'dreamverseSegmentGeneration')
  }

  /**
   * Generate one segment, hand its video to `sink` while it streams, and store the video and its last frame with
   * `request.owner`. Any failure leaves no file of the segment.
   * @param request - the segment to generate.
   * @param sink - where the video goes while it streams.
   * @returns the stored video and last frame with the delivery statistics.
   * @throws {DreamverseValueError} for a backend `invalid_request` failure; Error with the backend message for any
   *   other backend failure or an incomplete stream; the abort reason of `request.signal` once it aborts.
   */
  async generate(request: SegmentGenerationRequest, sink?: SegmentSink): Promise<GeneratedSegment> {
    return await generateSegment({
      generation: this.ctx.dreamverseGeneration,
      // Read by name: this package declares only the file store members that it calls.
      assets: this.ctx.get('dreamverseAssetsManager') as DreamverseAssetsManager,
    }, request, sink)
  }
}

export default DreamverseSegmentGeneration
