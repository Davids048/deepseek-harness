/**
 * Segment conditioning: whether a segment continues a predecessor, which images its request carries in which order,
 * and how its prompt names them.
 *
 * Each request image has a fixed source: one of the segment's selected reference images, or the predecessor's last
 * frame. One mapping, `segmentImages`, orders those sources and gives position N the label `Picture N`. The
 * selected reference images always come first in selection order, so the user's `Picture 1` to `Picture K` keep their
 * numbers whether or not the segment continues a predecessor; the predecessor's last frame follows them as
 * `Picture K+1`. User actions read the labels before they request prompts; the generation plan controller reads the
 * images when it builds the request. Both derive from the same mapping, so a prompt names the images that its request
 * carries.
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

/** One request image and its source: a selected reference image, or the predecessor's last frame. */
type SegmentImage<Reference, Frame> = { kind: 'reference'; source: Reference } | { kind: 'last_frame'; source: Frame }

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
 * Order the images of one segment request; position N of the result is `Picture N`. The sent reference images come
 * first in selection order, and the predecessor's last frame, for a continued segment, comes after them.
 * @param modelFacts - the served model's facts.
 * @param generationMode - the project's generation mode.
 * @param references - the segment's selected reference images, in selection order.
 * @param lastFrame - the predecessor's last frame for a continued segment, or null for an independent segment.
 * @returns the request images in request order.
 */
function segmentImages<Reference, Frame>(
  modelFacts: Pick<ModelFacts, 'generationModes'>,
  generationMode: string,
  references: readonly Reference[],
  lastFrame: Frame | null,
): SegmentImage<Reference, Frame>[] {
  const sent = sendsReferenceImages(modelFacts, generationMode, lastFrame !== null) ? references : []
  const images: SegmentImage<Reference, Frame>[] = sent.map(source => ({ kind: 'reference', source }))
  if (lastFrame !== null) images.push({ kind: 'last_frame', source: lastFrame })
  return images
}

/**
 * Name the images of one segment request for its prompt with the labels that `segmentImages` assigns.
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
  const references = Array.from({ length: referenceCount }, (_value, index) => index)
  const result: SegmentImageLabels = { referenceLabels: [], firstFrameLabel: null }
  segmentImages(modelFacts, generationMode, references, continuesPrevious ? true : null).forEach((image, position) => {
    const label = modelFacts.referenceLabels[position]
    if (label === undefined) return
    if (image.kind === 'reference') result.referenceLabels.push(label)
    else result.firstFrameLabel = label
  })
  return result
}

/**
 * Read the images of one registered segment's request in the order that `segmentImages` assigns, which is the
 * order that `segmentImageLabels` names them.
 * @param modelFacts - the served model's facts.
 * @param segment - the segment to generate.
 * @param predecessor - the completed segment that it continues, or null for an independent segment.
 * @returns the sent reference images' bytes in selection order, then the predecessor's last frame for a continued
 *   segment.
 * @throws Error when the predecessor kept no last frame.
 */
export async function segmentRequestImages(
  modelFacts: Pick<ModelFacts, 'generationModes'>,
  segment: VideoSegment,
  predecessor: VideoSegment | null,
): Promise<Buffer[]> {
  let lastFrame: Buffer | null = null
  if (predecessor !== null) {
    if (predecessor.lastFrame === null) {
      throw new Error(`Video segment ${predecessor.segmentId} kept no last frame to continue from.`)
    }
    lastFrame = predecessor.lastFrame
  }
  const images = segmentImages(modelFacts, segment.creationConfig.generation_mode, segment.referenceAssets, lastFrame)
  return await Promise.all(images.map(async image =>
    image.kind === 'last_frame' ? image.source : await readFile(image.source.filePath)))
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
