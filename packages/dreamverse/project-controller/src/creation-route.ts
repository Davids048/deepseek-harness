/**
 * Port of the reference `dreamverse/routes/creation.py`: `GET /creation-capabilities` reports the served model's
 * creation choices, the segment counts, and the asset upload policy for the browser's creation form.
 *
 * @module @dreamverse/project-controller/creation-route
 */
import type { ServerResponse } from 'node:http'
import type { Logger } from '@deepseek-ai/cordis'
import { referenceImageLimit } from '@dreamverse/project'
import type { DreamverseAssetsManager, DreamverseGeneration, ModelFacts } from './dependencies.ts'
import { BACKEND_UNREACHABLE_DETAIL } from './health-routes.ts'
import { sendJson } from '@dreamverse/http-routes'

/** The reference `SEGMENT_COUNTS` of `project_creation.py`. */
const SEGMENT_COUNTS = [1, 2, 3, 4, 5, 6]

/**
 * The reference `_model_capabilities_as_dict`: one model's choices in the creation-capabilities fields. A model with a
 * reference-image mode reports that mode's selection limit and `reference` conditioning; any other model reports its
 * image limit and `first_frame` conditioning.
 */
function modelCapabilitiesAsDict(model: ModelFacts): Record<string, unknown> {
  const referenceMode = Object.keys(model.generationModes).find(mode => model.generationModes[mode] === 'reference_images')
  return {
    generation_modes: Object.keys(model.generationModes).sort(),
    aspect_ratios: [...model.aspectRatios].sort(),
    resolutions: [...model.resolutions].sort(),
    min_segment_duration_sec: model.minSegmentDurationSec,
    max_segment_duration_sec: model.maxSegmentDurationSec,
    unsupported_generation_modes: { ...model.unsupportedGenerationModes },
    reference_inputs: {
      media_types: ['image'],
      max_count: referenceMode === undefined ? model.maxReferenceImages : referenceImageLimit(model, referenceMode),
      conditioning: referenceMode === undefined ? 'first_frame' : 'reference',
    },
  }
}

/**
 * The reference `lobby_capabilities_as_dict`.
 * @param model - the generation backend's model facts.
 * @param uploadPolicy - the asset library's upload policy.
 * @returns the creation-capabilities payload.
 */
export function lobbyCapabilitiesAsDict(model: ModelFacts, uploadPolicy: Record<string, unknown>): Record<string, unknown> {
  const choices = modelCapabilitiesAsDict(model)
  return {
    model_ids: [model.modelId],
    segment_counts: [...SEGMENT_COUNTS],
    asset_upload: uploadPolicy,
    models: { [model.modelId]: choices },
    ...choices,
  }
}

/**
 * Serve `GET /creation-capabilities`; an unreachable generation backend answers 503 with `detail`.
 * @param response - the browser response.
 * @param generation - the generation backend client.
 * @param assets - the asset library.
 * @param logger - receives the failure of an unreachable backend.
 */
export async function getCreationCapabilities(
  response: ServerResponse,
  generation: DreamverseGeneration,
  assets: DreamverseAssetsManager,
  logger: Logger,
): Promise<void> {
  let model: ModelFacts
  try {
    model = await generation.model()
  } catch (error) {
    logger.warn(error)
    sendJson(response, 503, { detail: BACKEND_UNREACHABLE_DETAIL })
    return
  }
  sendJson(response, 200, lobbyCapabilitiesAsDict(model, assets.uploadPolicy()))
}
