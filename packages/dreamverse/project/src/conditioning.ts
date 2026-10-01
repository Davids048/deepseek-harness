/**
 * Segment conditioning: whether a segment continues a predecessor, which images its request carries in which order,
 * and how its prompt names them.
 *
 * A segment that continues a predecessor starts from the predecessor's last frame. Its request sends that frame
 * first, as `Picture 1`, then the segment's reference images as `Picture 2` and later labels. An independent segment
 * sends only its reference images, from `Picture 1`. User actions read the labels before they request prompts; the
 * generation plan controller reads the images when it builds the request. Both read this module, so a prompt names
 * the images that its request carries.
 *
 * @module @dreamverse/project/conditioning
 */

import { readFile } from 'node:fs/promises'
import type { ModelFacts } from './dependencies.ts'
import type { VideoSegment } from './video-segment.ts'

/** Where a segment sits in its round; it decides whether the segment continues a predecessor. */
export interface SegmentPosition {
  /** Whether the round extends the latest completed sequence. */
  append: boolean
  /** The segment's zero-based index in its round. */
  index: number
  /** The number of reference assets that the segment carries. */
  referenceCount: number
}

/** Prompt labels of one segment request's images. */
export interface SegmentImageLabels {
  /** Labels of the segment's reference images, in request order. */
  referenceLabels: string[]
  /** Label of the predecessor's last frame that the segment starts from; null when the request carries none. */
  firstFrameLabel: string | null
}

/**
 * Decide whether a segment continues a predecessor. Models that use the previous frame chain every later segment of a
 * round; a round's first segment continues the latest completed segment when the round appends, except that an image
 * supplied to an appended first-frame shot starts that shot from the image. Reference images keep the chain.
 * @param modelFacts - the served model's facts.
 * @param generationMode - the project's generation mode.
 * @param position - the segment's round position and reference count.
 * @returns whether the segment continues the segment before it.
 */
export function continuesPreviousSegment(
  modelFacts: Pick<ModelFacts, 'usesPreviousFrame' | 'generationModes'>,
  generationMode: string,
  position: SegmentPosition,
): boolean {
  if (!modelFacts.usesPreviousFrame) return false
  if (position.index > 0) return true
  if (!position.append) return false
  return !(position.referenceCount > 0 && modelFacts.generationModes[generationMode] === 'initial_image')
}

/**
 * Whether a segment request carries the segment's reference images. A continued first-frame shot starts from its
 * predecessor's last frame instead of a supplied first frame.
 * @param modelFacts - the served model's facts.
 * @param generationMode - the project's generation mode.
 * @param continuesPrevious - whether the segment continues a predecessor.
 * @returns false only for a continued segment of a first-frame mode.
 */
function sendsReferenceImages(
  modelFacts: Pick<ModelFacts, 'generationModes'>,
  generationMode: string,
  continuesPrevious: boolean,
): boolean {
  return !(continuesPrevious && modelFacts.generationModes[generationMode] === 'initial_image')
}

/**
 * Name the images of one segment request for its prompt, in request order.
 * @param modelFacts - the served model's facts; models without numbered labels name no images.
 * @param generationMode - the project's generation mode.
 * @param referenceCount - the number of reference assets that the segment carries.
 * @param continuesPrevious - whether the segment continues a predecessor.
 * @returns the reference image labels and the first-frame label.
 */
export function segmentImageLabels(
  modelFacts: Pick<ModelFacts, 'referenceLabels' | 'generationModes'>,
  generationMode: string,
  referenceCount: number,
  continuesPrevious: boolean,
): SegmentImageLabels {
  const labels = modelFacts.referenceLabels
  const sentReferences = sendsReferenceImages(modelFacts, generationMode, continuesPrevious) ? referenceCount : 0
  if (!continuesPrevious) return { referenceLabels: labels.slice(0, sentReferences), firstFrameLabel: null }
  return { referenceLabels: labels.slice(1, sentReferences + 1), firstFrameLabel: labels[0] ?? null }
}

/**
 * Read the images of one registered segment's request, in the order that `segmentImageLabels` names them.
 * @param modelFacts - the served model's facts.
 * @param segment - the segment to generate.
 * @param predecessor - the completed segment that it continues, or null for an independent segment.
 * @returns the predecessor's last frame when the segment continues one, then the reference images' bytes.
 * @throws Error when the predecessor kept no last frame.
 */
export async function segmentRequestImages(
  modelFacts: Pick<ModelFacts, 'generationModes'>,
  segment: VideoSegment,
  predecessor: VideoSegment | null,
): Promise<Buffer[]> {
  const generationMode = segment.creationConfig.generation_mode
  const references = sendsReferenceImages(modelFacts, generationMode, predecessor !== null)
    ? await Promise.all(segment.referenceAssets.map(async asset => await readFile(asset.filePath)))
    : []
  if (predecessor === null) return references
  if (predecessor.lastFrame === null) {
    throw new Error(`Video segment ${predecessor.segmentId} kept no last frame to continue from.`)
  }
  return [predecessor.lastFrame, ...references]
}

/**
 * The most reference images that one action may select. A reference-image mode of a model that continues segments
 * keeps one request image for the predecessor's last frame.
 * @param modelFacts - the served model's facts.
 * @param generationMode - the generation mode of the selection.
 * @returns the selection limit.
 */
export function referenceImageLimit(
  modelFacts: Pick<ModelFacts, 'maxReferenceImages' | 'usesPreviousFrame' | 'generationModes'>,
  generationMode: string,
): number {
  const keepsLastFrameSlot = modelFacts.usesPreviousFrame && modelFacts.generationModes[generationMode] === 'reference_images'
  return keepsLastFrameSlot ? modelFacts.maxReferenceImages - 1 : modelFacts.maxReferenceImages
}
