/**
 * One segment's model input, origin, dependency, and generation outcome.
 *
 * @module @dreamverse/project/video-segment
 */

import { randomUUID } from 'node:crypto'
import type { AssetRecord } from './dependencies.ts'
import type { CreationConfig } from './project-creation.ts'
import { textOr } from './python-values.ts'

/** Original browser instruction and its request identity, shared by the segments it produces. */
export interface UserInstruction {
  readonly requestId: string
  readonly text: string
}

/**
 * Read a browser instruction as the reference does: a missing or empty request ID gets a random UUID, and the text
 * is stripped.
 * @param requestId - the payload's `prompt_id` value.
 * @param text - the payload's instruction text value.
 * @returns the instruction shared by the action's segments.
 */
export function createUserInstruction(requestId: unknown, text: unknown): UserInstruction {
  return { requestId: textOr(requestId, randomUUID()), text: textOr(text, '').trim() }
}

/** Where a segment's prompt came from. */
export type SegmentSource = 'preset' | 'user' | 'automatic'

/** Generation state that `GenerationPlanController` and project closure write on a segment. */
export type SegmentStatus = 'pending' | 'generating' | 'completed' | 'failed' | 'cancelled'

/** Worker timings and the number of chunks and bytes successfully sent to the browser. */
export interface SegmentDeliveryStats {
  readonly timings: Record<string, number>
  readonly chunkCount: number
  readonly byteCount: number
}

/** Constructor fields of a `VideoSegment`; omitted fields take the reference dataclass defaults. */
export interface VideoSegmentInit {
  prompt: string
  creationConfig: CreationConfig
  source: SegmentSource
  instruction?: UserInstruction | null
  enhanced?: boolean
  sequenceIndex?: number | null
  segmentId?: string
  referenceSegmentId?: string | null
  referenceAssets?: readonly AssetRecord[]
}

/**
 * One version of a video segment, from complete prompt input through delivered output.
 *
 * The prompt and the project's creation config are the segment's model input. `referenceSegmentId` names the
 * preceding video that the segment continues; null starts independent video. `lastFrame` is the PNG of the
 * segment's last decoded frame, which a later segment starts from; `conditioning.ts` decides which images a request
 * carries. Reference assets record the action's ordered selection; file retention belongs to the executing action
 * and ends after its generation finishes.
 */
export class VideoSegment {
  readonly prompt: string
  readonly creationConfig: CreationConfig
  readonly source: SegmentSource
  readonly instruction: UserInstruction | null
  readonly enhanced: boolean
  readonly sequenceIndex: number | null
  readonly segmentId: string
  readonly referenceAssets: readonly AssetRecord[]
  referenceSegmentId: string | null
  status: SegmentStatus = 'pending'
  deliveryStats: SegmentDeliveryStats | null = null
  lastFrame: Buffer | null = null
  error: string | null = null

  /** Copy the init fields and apply the reference dataclass defaults, including a random UUID segment ID. */
  constructor(init: VideoSegmentInit) {
    this.prompt = init.prompt
    this.creationConfig = init.creationConfig
    this.source = init.source
    this.instruction = init.instruction ?? null
    this.enhanced = init.enhanced ?? false
    this.sequenceIndex = init.sequenceIndex ?? null
    this.segmentId = init.segmentId ?? randomUUID()
    this.referenceSegmentId = init.referenceSegmentId ?? null
    this.referenceAssets = init.referenceAssets ?? []
  }

  /** The browser's prompt origin label. */
  get wireSource(): string {
    if (this.source === 'preset') return 'curated'
    if (this.source === 'automatic') return 'auto_enhanced'
    return this.enhanced ? 'user_enhanced' : 'user_raw'
  }
}
