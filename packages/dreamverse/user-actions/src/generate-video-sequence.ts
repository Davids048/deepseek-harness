/**
 * Cordis plugin for the `generate_video_sequence` action: generate and record a video sequence from a seed
 * instruction or from supplied prompts. Port of the reference `generate_video_sequence.py`; the project queues this
 * action from `project_init_v1`.
 *
 * @module @dreamverse/user-actions/generate-video-sequence
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  DreamverseValueError,
  createUserInstruction,
  payloadGet,
  type ActionPayload,
  type Project,
  type UserActionOptions,
} from '@dreamverse/project'
import { generateRewrittenSequence } from './rewritten-sequence.ts'

export const name = 'dreamverse-generate-video-sequence'
export const inject = ['dreamverseProjects']

/**
 * Expand the seed when supplied; otherwise generate the selected number of prepared prompts, then record the sequence.
 * @param project - the project that owns the round.
 * @param payload - the queued action: `prompt` holds the seed, `prompts` the prepared prompts.
 * @param options - the retained reference assets.
 */
export async function generateVideoSequence(
  project: Project,
  payload: ActionPayload,
  { referenceAssets }: UserActionOptions,
): Promise<void> {
  const instruction = createUserInstruction(payload['prompt_id'], payload['prompt'])
  if (instruction.text) {
    await generateRewrittenSequence(project, instruction, { sourcePrompts: [], promptsToRewrite: [], referenceAssets })
    return
  }
  const prompts = payloadGet(payload, 'prompts')
  if (!Array.isArray(prompts) || prompts.length === 0
    || prompts.some(prompt => typeof prompt !== 'string' || !prompt.trim())) {
    throw new DreamverseValueError('A video sequence requires nonempty prompts.')
  }
  const preparedPrompts = prompts.map((prompt: string) => prompt.trim())
  const segmentCount = project.videoGenerationSettings.segment_count
  if (preparedPrompts.length < segmentCount) {
    throw new DreamverseValueError(
      `Requested ${segmentCount} segments, but the preset provides ${preparedPrompts.length} prompts.`)
  }
  const segments = preparedPrompts.slice(0, segmentCount).map((prompt, index) => project.buildVideoSegment(prompt, {
    source: 'preset', sequenceIndex: index, referenceAssets,
  }))
  const plan = project.registerSegmentsAndBuildGenerationPlan(segments)
  await project.executeGenerationPlan(plan)
  project.recordCompletedSequence(plan.sequenceIds)
}

/**
 * Register the `generate_video_sequence` handler for the lifetime of this plugin.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.dreamverseProjects.registerUserAction({
    actionTypes: ['generate_video_sequence'], handler: generateVideoSequence,
  }))
}
