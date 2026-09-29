import { SEGMENT_COUNTS } from './creationConfig.ts'
import type {
  AspectRatioId,
  CreationModeId,
  CreationModelId,
  ResolutionId,
} from './creationConfig.ts'
import { fromGenerationMode, type GenerationMode } from './generationMode.ts'

const LOBBY_MODEL_IDS = new Set<CreationModelId>(['fast-ltx2', 'fast-ltx23', 'fast-h3', 'h3-ref2va'])
const ASPECT_RATIO_IDS = new Set<AspectRatioId>(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'])
const RESOLUTION_IDS = new Set<ResolutionId>(['480p', '720p', '1080p', '4k'])

export interface EchoedProjectCreationConfig {
  modelId: CreationModelId
  modeId: CreationModeId
  aspectRatio: AspectRatioId
  resolution: ResolutionId
  segmentDurationSec: number
  segmentCount: number
}

export interface CreationInitPayload {
  model_id: string
  aspect_ratio: string
  resolution: string
  segment_duration_sec: number
  segment_count: number
  reference_asset_ids: string[]
}

/** Parse the server's echoed project creation choices. */
export function parseEchoedCreationConfig(data: unknown): EchoedProjectCreationConfig | null {
  if (!data || typeof data !== 'object') {
    return null
  }
  const creationConfig = (data as Record<string, unknown>).creation_config
  if (!creationConfig || typeof creationConfig !== 'object') {
    return null
  }
  const config = creationConfig as Record<string, unknown>
  const modelId = typeof config.model_id === 'string' && LOBBY_MODEL_IDS.has(config.model_id as CreationModelId)
    ? (config.model_id as CreationModelId)
    : null
  const generationMode = typeof config.generation_mode === 'string' ? config.generation_mode as GenerationMode : null
  const modeId = generationMode === 'i2v' || generationMode === 't2va' || generationMode === 'fl2va' || generationMode === 'ref2va'
    ? fromGenerationMode(generationMode)
    : null
  const aspectRatio = typeof config.aspect_ratio === 'string' && ASPECT_RATIO_IDS.has(config.aspect_ratio as AspectRatioId)
    ? (config.aspect_ratio as AspectRatioId)
    : null
  const resolution = typeof config.resolution === 'string' && RESOLUTION_IDS.has(config.resolution as ResolutionId)
    ? (config.resolution as ResolutionId)
    : null
  const segmentDurationSec = typeof config.segment_duration_sec === 'number'
    && Number.isInteger(config.segment_duration_sec) && config.segment_duration_sec > 0
    ? config.segment_duration_sec
    : null
  const segmentCount = typeof config.segment_count === 'number' && SEGMENT_COUNTS.some(count => count === config.segment_count)
    ? config.segment_count : null
  if (modelId === null || modeId === null || aspectRatio === null || resolution === null
    || segmentDurationSec === null || segmentCount === null) {
    return null
  }
  return {
    modelId,
    modeId,
    aspectRatio,
    resolution,
    segmentDurationSec,
    segmentCount,
  }
}

/** Serialize a completed upload selection with the creation settings captured at submission. */
export function buildCreationInitPayload(input: {
  modelId: string
  modeId: CreationModeId
  aspectRatio: string
  resolution: string
  segmentDurationSec: number
  segmentCount: number
  referenceAssetIds: string[]
}): CreationInitPayload {
  return {
    model_id: input.modelId,
    aspect_ratio: input.aspectRatio,
    resolution: input.resolution,
    segment_duration_sec: input.segmentDurationSec,
    segment_count: input.segmentCount,
    reference_asset_ids: [...input.referenceAssetIds],
  }
}
