/**
 * One segment's model input, origin, dependency, and generation outcome.
 *
 * @module @dreamverse/project/video-segment
 */

import { randomUUID } from 'node:crypto'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { CreationConfig } from '@dreamverse/segment-generation'
import type { AssetId, AssetRecord } from './dependencies.ts'
import { textOr } from './python-values.ts'

/**
 * The ID of one segment of a DreamVerse project, stored in the project's workload data. The page's `SegmentId` in
 * `@dreamverse/project-controller/client/ids.ts` uses the same brand label.
 */
export type SegmentId = Branded<'DreamverseSegmentId'>

/**
 * The ID of one browser instruction: the browser's `prompt_id`, which the browser events about the instruction carry.
 * The page's `PromptId` in `@dreamverse/project-controller/client/ids.ts` uses the same brand label.
 */
export type PromptId = Branded<'DreamversePromptId'>

/** Original browser instruction and its request identity, shared by the segments it produces. */
export interface UserInstruction {
  readonly requestId: PromptId
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
  return { requestId: brandString<PromptId>(textOr(requestId, randomUUID())), text: textOr(text, '').trim() }
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
  segmentId?: SegmentId
  referenceSegmentId?: SegmentId | null
  referenceAssets?: readonly AssetRecord[]
  /** ISO-8601 UTC creation time; a restored segment keeps its stored time. */
  createdAt?: string
}

/**
 * One version of a video segment, from complete prompt input through delivered output.
 *
 * The prompt and the project's creation config are the segment's model input. `referenceSegmentId` names the
 * preceding video that the segment continues; null starts independent video. A completed segment names its stored
 * video and last frame in the file store; a later segment starts from that last frame, and
 * `@dreamverse/segment-generation` decides which images a request carries. Reference assets are the action's ordered
 * selection as copies that the project owns. `mime` is the video's MIME type with codecs once the video starts.
 */
export class VideoSegment {
  readonly prompt: string
  readonly creationConfig: CreationConfig
  readonly source: SegmentSource
  readonly instruction: UserInstruction | null
  readonly enhanced: boolean
  readonly sequenceIndex: number | null
  readonly segmentId: SegmentId
  readonly referenceAssets: readonly AssetRecord[]
  readonly createdAt: string
  referenceSegmentId: SegmentId | null
  status: SegmentStatus = 'pending'
  deliveryStats: SegmentDeliveryStats | null = null
  /** The file store ID of the segment's fragmented MP4, once the segment completes. */
  videoAssetId: AssetId | null = null
  /** The file store ID of the segment's last frame PNG, once the segment completes. */
  lastFrameAssetId: AssetId | null = null
  mime: string | null = null
  error: string | null = null

  /**
   * Copy the init fields and apply the reference dataclass defaults, including a random UUID segment ID and the
   * current time.
   */
  constructor(init: VideoSegmentInit) {
    this.prompt = init.prompt
    this.creationConfig = init.creationConfig
    this.source = init.source
    this.instruction = init.instruction ?? null
    this.enhanced = init.enhanced ?? false
    this.sequenceIndex = init.sequenceIndex ?? null
    this.segmentId = init.segmentId ?? brandString<SegmentId>(randomUUID())
    this.referenceSegmentId = init.referenceSegmentId ?? null
    this.referenceAssets = init.referenceAssets ?? []
    this.createdAt = init.createdAt ?? new Date().toISOString()
  }

  /** The browser's prompt origin label. */
  get wireSource(): string {
    if (this.source === 'preset') return 'curated'
    if (this.source === 'automatic') return 'auto_enhanced'
    return this.enhanced ? 'user_enhanced' : 'user_raw'
  }
}
