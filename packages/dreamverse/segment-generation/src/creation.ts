/**
 * Creation choices and reference selections, validated against the served model's facts. Port of the reference
 * `project_creation.py` without prompt safety, together with the `ModelCapabilities` checks that it calls. Every
 * workload that generates segments resolves its creation settings here.
 *
 * @module @dreamverse/segment-generation/creation
 */

import { DreamverseValueError, ProjectValidationError } from '@dreamverse/generation-client'
import { referenceImageLimit } from './conditioning.ts'
import type { ModelFacts } from './dependencies.ts'
import { payloadGet, pythonRepr, textOr, type ActionPayload } from './python-values.ts'

/** Selectable numbers of segments in a project's first sequence. */
export const SEGMENT_COUNTS: readonly number[] = [1, 2, 3, 4, 5, 6]

/** The reference `ProjectCreationConfig.as_dict()`; keys keep the reference wire spelling. */
export interface CreationConfig {
  /** The served model's ID. */
  model_id: string
  generation_mode: string
  aspect_ratio: string
  resolution: string
  segment_count: number
  segment_duration_sec: number
  frame_width: number
  frame_height: number
  num_frames: number
}

/** The creation choices that `ModelCapabilities.validate_creation` checks. */
interface CreationChoice {
  generationMode: string
  aspectRatio: string
  resolution: string
  segmentDurationSec: number
}

/**
 * Python `type(value) is int` for a JSON value. JSON parsing in Node cannot distinguish `5.0` from `5`.
 * @param value - the JSON value.
 * @returns whether the value is an integral number.
 */
function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/**
 * Resolve project choices with the served model's facts, as the reference `parse_project_creation_config` does.
 * @param payload - the `project_init_v1` message.
 * @param modelFacts - the served model's facts.
 * @returns the creation config with the model's frame size and frame count for the chosen settings.
 * @throws {DreamverseValueError} with the reference message for a choice that the served model cannot execute.
 */
export function parseProjectCreationConfig(payload: Record<string, unknown>, modelFacts: ModelFacts): CreationConfig {
  const selectedModel = modelFacts.modelId
  const rawModelId = payloadGet(payload, 'model_id', selectedModel)
  if (typeof rawModelId !== 'string') throw new DreamverseValueError('model_id must be a string.')
  if (rawModelId.trim() !== selectedModel) {
    throw new DreamverseValueError(
      `This server serves ${selectedModel}; requested model ${pythonRepr(rawModelId)} is unavailable.`)
  }
  // Omitted browser choices use application defaults; the model facts validate the selection.
  const [defaultGenerationMode = ''] = Object.keys(modelFacts.generationModes)
  const generationMode = textOr(payload['generation_mode'], defaultGenerationMode).trim()
  const aspectRatio = textOr(payload['aspect_ratio'], '16:9').trim()
  const resolution = textOr(payload['resolution'], '720p').trim()
  const segmentCount = payloadGet(payload, 'segment_count', 6)
  if (!isInteger(segmentCount) || !SEGMENT_COUNTS.includes(segmentCount)) {
    throw new DreamverseValueError('segment_count must be an integer from 1 to 6.')
  }
  const segmentDurationSec = payloadGet(payload, 'segment_duration_sec')
  if (!isInteger(segmentDurationSec)) {
    throw new DreamverseValueError('segment_duration_sec is required and must be an integer.')
  }
  validateCreation(modelFacts, { generationMode, aspectRatio, resolution, segmentDurationSec })
  const frameSize = modelFacts.frameSizes[aspectRatio]?.[resolution]
  const numFrames = modelFacts.numFramesByDurationSec[String(segmentDurationSec)]
  if (frameSize === undefined || numFrames === undefined) {
    throw new Error(`The ${selectedModel} model facts omit ${aspectRatio} ${resolution} at ${segmentDurationSec} seconds.`)
  }
  return {
    model_id: selectedModel,
    generation_mode: generationMode,
    aspect_ratio: aspectRatio,
    resolution,
    segment_count: segmentCount,
    segment_duration_sec: segmentDurationSec,
    frame_width: frameSize[0],
    frame_height: frameSize[1],
    num_frames: numFrames,
  }
}

/**
 * Validate creation choices before any reference asset is retained; port of `validate_project_creation` without
 * prompt safety.
 * @param payload - the `project_init_v1` message.
 * @param modelFacts - the served model's facts.
 * @returns the creation config.
 * @throws {ProjectValidationError} with reason `Invalid creation config` for a rejected choice.
 */
export function validateProjectCreation(payload: Record<string, unknown>, modelFacts: ModelFacts): CreationConfig {
  try {
    return parseProjectCreationConfig(payload, modelFacts)
  } catch (error) {
    if (!(error instanceof DreamverseValueError)) throw error
    throw new ProjectValidationError(error.message, 'Invalid creation config')
  }
}

/**
 * Accept one ordered list of library IDs for a submitted generation action; port of `parse_reference_asset_ids`.
 * @param payload - the action payload.
 * @returns the asset IDs in selection order.
 * @throws {DreamverseValueError} for inline images, a malformed list, or duplicate IDs.
 */
export function parseReferenceAssetIds(payload: ActionPayload): string[] {
  if (Object.hasOwn(payload, 'initial_image') || Object.hasOwn(payload, 'last_frame_image')) {
    throw new DreamverseValueError('Upload references through /assets and supply reference_asset_ids.')
  }
  const values = payloadGet(payload, 'reference_asset_ids', [])
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim())) {
    throw new DreamverseValueError('reference_asset_ids must be a list of nonempty asset IDs.')
  }
  if (new Set(values).size !== values.length) throw new DreamverseValueError('reference_asset_ids must not contain duplicates.')
  return values as string[]
}

/**
 * Check the selected mode's image count before accepting a generation action; port of
 * `ModelCapabilities.validate_reference_assets`. The limit is `referenceImageLimit`, which keeps a request image for
 * a continued segment's first frame.
 * @param modelFacts - the served model's facts.
 * @param generationMode - the project's validated generation mode.
 * @param referenceCount - the number of selected reference assets.
 * @throws {DreamverseValueError} when the mode does not accept the count.
 */
export function validateReferenceAssets(modelFacts: ModelFacts, generationMode: string, referenceCount: number): void {
  if (modelFacts.generationModes[generationMode] === 'text') {
    if (referenceCount > 0) throw new DreamverseValueError('Text-to-video mode does not accept reference images.')
    return
  }
  const limit = referenceImageLimit(modelFacts, generationMode)
  if (!(referenceCount >= 1 && referenceCount <= limit)) {
    throw new DreamverseValueError(`${generationMode} requires 1 to ${limit} reference images.`)
  }
}

/**
 * Reject creation choices that the served model cannot execute; port of `ModelCapabilities.validate_creation`.
 * @param modelFacts - the served model's facts.
 * @param choice - the stripped mode, aspect ratio, resolution, and the integral segment duration.
 * @throws {DreamverseValueError} with the reference message for the first unsupported choice.
 */
function validateCreation(modelFacts: ModelFacts, choice: CreationChoice): void {
  const { generationMode, segmentDurationSec } = choice
  const unsupportedMessage = Object.hasOwn(modelFacts.unsupportedGenerationModes, generationMode)
    ? modelFacts.unsupportedGenerationModes[generationMode]
    : undefined
  if (unsupportedMessage !== undefined) throw new DreamverseValueError(unsupportedMessage)
  if (!Object.hasOwn(modelFacts.generationModes, generationMode)) {
    throw new DreamverseValueError(`Unsupported generation_mode: ${generationMode}`)
  }
  validateDimensions(modelFacts, choice.aspectRatio, choice.resolution)
  const { minSegmentDurationSec: min, maxSegmentDurationSec: max } = modelFacts
  if (!(segmentDurationSec >= min && segmentDurationSec <= max)) {
    throw new DreamverseValueError(`segment_duration_sec must be from ${min} to ${max} for ${modelFacts.modelId}.`)
  }
}

/**
 * Reject an aspect ratio or resolution that the served model does not offer; port of
 * `ModelCapabilities.validate_dimensions`.
 * @param modelFacts - the served model's facts.
 * @param aspectRatio - the stripped aspect ratio label.
 * @param resolution - the stripped resolution label.
 * @throws {DreamverseValueError} for an unsupported label.
 */
function validateDimensions(modelFacts: ModelFacts, aspectRatio: string, resolution: string): void {
  if (!modelFacts.aspectRatios.includes(aspectRatio)) throw new DreamverseValueError(`Unsupported aspect_ratio: ${aspectRatio}`)
  if (!modelFacts.resolutions.includes(resolution)) throw new DreamverseValueError(`Unsupported resolution: ${resolution}`)
}
