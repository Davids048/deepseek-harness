import type { AssetUploadPolicy, MediaUploadPolicy, ReferenceDraft } from '@dreamverse/assets-manager/client/assets.ts'
import { SEGMENT_COUNTS } from './creationConfig.ts'
import type {
  AspectRatioId,
  CreationModeId,
  CreationModelId,
  ResolutionId,
} from './creationConfig.ts'
import { fromGenerationMode, toGenerationMode, type GenerationMode } from './generationMode.ts'
import { isJsonObject } from './json.ts'

/** A list with at least one item, so its first item always exists. */
export type NonEmptyList<T> = [T, ...T[]]

const ALL_MODEL_IDS: CreationModelId[] = ['fast-ltx23', 'fast-ltx2', 'fast-h3', 'h3-ref2va']
const ALL_GENERATION_MODES: GenerationMode[] = ['t2va', 'i2v', 'fl2va', 'ref2va']
const ALL_ASPECT_RATIOS: AspectRatioId[] = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
const ALL_RESOLUTIONS: ResolutionId[] = ['480p', '720p', '1080p', '4k']

/** Accepted choices and per-segment duration bounds for the served model. */
export interface LobbyCreationCapabilities {
  model_id: CreationModelId
  generation_modes: NonEmptyList<GenerationMode>
  aspect_ratios: NonEmptyList<AspectRatioId>
  resolutions: NonEmptyList<ResolutionId>
  min_segment_duration_sec: number
  max_segment_duration_sec: number
  segment_counts: NonEmptyList<number>
  unsupported_generation_modes: Record<string, string>
  reference_inputs: {
    media_types: string[]
    max_count: number
    conditioning: 'first_frame' | 'reference'
  }
  asset_upload: AssetUploadPolicy
}

/** The lobby's creation choices for the next project. */
export interface LobbySelection {
  modeId: CreationModeId
  aspectRatio: AspectRatioId
  resolution: ResolutionId
  segmentDurationSec: number
  segmentCount: number
}

/** Whether a value is a nonempty list of allowed choices. */
function isChoiceList<T extends string | number>(value: unknown, choices: readonly T[]): value is NonEmptyList<T> {
  return Array.isArray(value) && value.length > 0
    && value.every((item: unknown) => choices.some(choice => choice === item))
}

/** Whether a value is a list of strings. */
function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

/** Whether a value is an integer of at least `minimum`. */
function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
}

/** Whether a value maps generation modes to nonempty explanations. */
function isNoticeRecord(value: unknown): value is Record<string, string> {
  return isJsonObject(value)
    && Object.values(value).every(message => typeof message === 'string' && message.trim().length > 0)
}

/** Decode one media kind's upload limits, keeping the optional limits that the server sends. */
function parseMediaUploadPolicy(policy: unknown): MediaUploadPolicy | null {
  if (!isJsonObject(policy)) return null
  const { mime_types: mimeTypes, extensions, max_bytes: maxBytes } = policy
  if (!isStringList(mimeTypes) || mimeTypes.length === 0 || !mimeTypes.every(mime => mime.length > 0)
    || !isStringList(extensions) || !isIntegerAtLeast(maxBytes, 1)) return null
  return {
    mime_types: mimeTypes,
    extensions,
    max_bytes: maxBytes,
    ...(typeof policy.max_pixels === 'number' ? { max_pixels: policy.max_pixels } : {}),
    ...(typeof policy.max_duration_sec === 'number' ? { max_duration_sec: policy.max_duration_sec } : {}),
    ...(typeof policy.max_channels === 'number' ? { max_channels: policy.max_channels } : {}),
  }
}

/**
 * Decode the served model's complete record; missing or invalid choices leave creation unavailable.
 * @param payload - the decoded `/creation-capabilities` response.
 * @returns the capabilities, or `null` when any required field is missing or invalid.
 */
export function parseLobbyCapabilities(payload: unknown): LobbyCreationCapabilities | null {
  if (!isJsonObject(payload) || !isChoiceList(payload.model_ids, ALL_MODEL_IDS) || payload.model_ids.length !== 1) {
    return null
  }
  if (!isJsonObject(payload.models)) return null
  const [modelId] = payload.model_ids
  const choices = payload.models[modelId]
  if (!isJsonObject(choices)) return null
  if (
    !isChoiceList(choices.generation_modes, ALL_GENERATION_MODES) ||
		!isChoiceList(choices.aspect_ratios, ALL_ASPECT_RATIOS) ||
		!isChoiceList(choices.resolutions, ALL_RESOLUTIONS) ||
		typeof choices.min_segment_duration_sec !== 'number' ||
		!Number.isInteger(choices.min_segment_duration_sec) || choices.min_segment_duration_sec < 1 ||
		typeof choices.max_segment_duration_sec !== 'number' ||
		!Number.isInteger(choices.max_segment_duration_sec) || choices.max_segment_duration_sec < choices.min_segment_duration_sec ||
		!isChoiceList(payload.segment_counts, SEGMENT_COUNTS)
  ) return null

  const unsupportedModes = choices.unsupported_generation_modes
  if (!isNoticeRecord(unsupportedModes)) return null
  const referenceInputs = choices.reference_inputs
  if (!isJsonObject(referenceInputs)) return null
  const { media_types: mediaTypes, max_count: maxCount, conditioning } = referenceInputs
  if (!isStringList(mediaTypes) || mediaTypes.length === 0 || !mediaTypes.every(kind => kind === 'image')
    || !isIntegerAtLeast(maxCount, 1) || (conditioning !== 'first_frame' && conditioning !== 'reference')) return null
  const upload = payload.asset_upload
  if (!isJsonObject(upload)) return null
  const image = parseMediaUploadPolicy(upload.image)
  const video = parseMediaUploadPolicy(upload.video)
  const audio = parseMediaUploadPolicy(upload.audio)
  if (!image || !video || !audio) return null

  return {
    model_id: modelId,
    generation_modes: choices.generation_modes,
    aspect_ratios: choices.aspect_ratios,
    resolutions: choices.resolutions,
    min_segment_duration_sec: choices.min_segment_duration_sec,
    max_segment_duration_sec: choices.max_segment_duration_sec,
    segment_counts: payload.segment_counts,
    unsupported_generation_modes: unsupportedModes,
    reference_inputs: { media_types: mediaTypes, max_count: maxCount, conditioning },
    asset_upload: { image, video, audio } satisfies AssetUploadPolicy,
  }
}

/**
 * Whether the served model accepts a creation mode.
 * @param modeId - the lobby's mode choice.
 * @param capabilities - the served model's capabilities.
 * @returns true when the mode's wire generation mode is advertised.
 */
export function isSupportedCreationMode(modeId: CreationModeId, capabilities: LobbyCreationCapabilities): boolean {
  return capabilities.generation_modes.includes(toGenerationMode(modeId))
}

/**
 * Whether the served model accepts a resolution.
 * @param resolution - the lobby's resolution choice.
 * @param capabilities - the served model's capabilities.
 * @returns true when the resolution is advertised.
 */
export function isSupportedResolution(resolution: ResolutionId, capabilities: LobbyCreationCapabilities): boolean {
  return capabilities.resolutions.includes(resolution)
}

/**
 * The served model's explanation for a mode it does not support.
 * @param modeId - the lobby's mode choice.
 * @param capabilities - the served model's capabilities.
 * @returns the explanation, or `null` when the model names none for the mode.
 */
export function unsupportedModeNotice(modeId: CreationModeId, capabilities: LobbyCreationCapabilities): string | null {
  const wireMode = toGenerationMode(modeId)
  return capabilities.unsupported_generation_modes[wireMode] ?? null
}

/** Preserve valid preferences, bound segment length, and select advertised values for unsupported choices. */
export function clampLobbySelectionToCapabilities(input: LobbySelection & {
  capabilities: LobbyCreationCapabilities
}): LobbySelection {
  const { capabilities } = input
  return {
    modeId: isSupportedCreationMode(input.modeId, capabilities)
      ? input.modeId : fromGenerationMode(capabilities.generation_modes[0]),
    aspectRatio: capabilities.aspect_ratios.includes(input.aspectRatio)
      ? input.aspectRatio : capabilities.aspect_ratios[0],
    resolution: isSupportedResolution(input.resolution, capabilities)
      ? input.resolution : capabilities.resolutions[0],
    segmentCount: capabilities.segment_counts.includes(input.segmentCount)
      ? input.segmentCount : capabilities.segment_counts[0],
    segmentDurationSec: Number.isInteger(input.segmentDurationSec)
      ? Math.min(Math.max(input.segmentDurationSec, capabilities.min_segment_duration_sec), capabilities.max_segment_duration_sec)
      : capabilities.min_segment_duration_sec,
  }
}

/** Validate selected preferences and reference files before project admission. */
export function validateLobbyCreationSelection(input: LobbySelection & {
  capabilities: LobbyCreationCapabilities
  references?: readonly ReferenceDraft[]
}): string | null {
  const unsupportedMode = unsupportedModeNotice(input.modeId, input.capabilities)
  if (unsupportedMode) return unsupportedMode
  if (!isSupportedCreationMode(input.modeId, input.capabilities)) {
    return 'Selected mode is not supported yet.'
  }
  if (!input.capabilities.aspect_ratios.includes(input.aspectRatio)) {
    return 'Selected aspect ratio is not supported for this model yet.'
  }
  if (!isSupportedResolution(input.resolution, input.capabilities)) {
    return 'Selected resolution is not supported for this model yet.'
  }
  if (!input.capabilities.segment_counts.includes(input.segmentCount)) {
    return 'Selected segment count is not supported.'
  }
  if (!Number.isInteger(input.segmentDurationSec) || input.segmentDurationSec < input.capabilities.min_segment_duration_sec
		|| input.segmentDurationSec > input.capabilities.max_segment_duration_sec) {
    return `Duration per segment must be a whole number from ${input.capabilities.min_segment_duration_sec} to ${input.capabilities.max_segment_duration_sec} seconds.`
  }
  return validateReferenceSelection(input.modeId, input.references ?? [], input.capabilities)
}

/** Apply the served generation limits to the request's ordered image selection. */
export function validateReferenceSelection(
  modeId: CreationModeId,
  references: readonly ReferenceDraft[],
  capabilities: LobbyCreationCapabilities,
): string | null {
  if (modeId === 't2v') return references.length ? 'Text to video does not accept reference images.' : null
  const limit = modeId === 'i2v' ? 1 : capabilities.reference_inputs.max_count
  if (references.length < 1 || references.length > limit) return `Select ${limit === 1 ? 'one reference image' : `1 to ${limit} reference images`}.`
  for (const reference of references) {
    const mime = reference.kind === 'localFile' ? reference.file.type : reference.asset.mime_type
    const size = reference.kind === 'localFile' ? reference.file.size : reference.asset.size_bytes
    if (!capabilities.asset_upload.image.mime_types.includes(mime)) return 'This generation workflow accepts images only.'
    if (size > capabilities.asset_upload.image.max_bytes) return 'Reference image exceeds the upload size limit.'
  }

  return null
}
