/**
 * The creation-capabilities payload of the reference `dreamverse/routes/creation.py`: the served model's creation
 * choices, the segment counts, and the asset upload policy. A workload's creation form reads it.
 *
 * @module @dreamverse/segment-generation/capabilities
 */

import { referenceImageLimit } from './conditioning.ts'
import { SEGMENT_COUNTS } from './creation.ts'
import type { ModelFacts } from './dependencies.ts'

/**
 * The reference `_model_capabilities_as_dict`: one model's choices in the creation-capabilities fields. A model with a
 * reference-image mode reports that mode's selection limit and `reference` conditioning; any other model reports its
 * image limit and `first_frame` conditioning.
 * @param model - the generation backend's model facts.
 * @returns the model's creation choices.
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
