/**
 * Cordis plugin for the `rewrite_seed_prompts` action: rewrite a whole prompt window and generate its replacement
 * video sequence. Port of `rewrite_video_sequence` in the reference `rewrite_video_sequence.py`.
 *
 * @module @dreamverse/user-actions/rewrite-video-sequence
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  createUserInstruction,
  payloadGet,
  textOr,
  type ActionPayload,
  type Project,
  type UserActionOptions,
} from '@dreamverse/project'
import { generateRewrittenSequence } from './rewritten-sequence.ts'

export const name = 'dreamverse-rewrite-video-sequence'
export const inject = ['dreamverseProjects']

/**
 * Apply the command's rewrite settings to the project, then replace the selected or completed sequence after
 * successful generation.
 * @param project - the project that owns the round.
 * @param payload - the `rewrite_seed_prompts` command.
 * @param options - the retained reference assets.
 */
export async function rewriteVideoSequence(
  project: Project,
  payload: ActionPayload,
  { referenceAssets }: UserActionOptions,
): Promise<void> {
  const instruction = createUserInstruction(payload['prompt_id'], payload['rewrite_instruction'])
  project.promptEnhancementModel = project.promptEnhancer.resolveRewriteModel(
    payloadGet(payload, 'rewrite_model', project.promptEnhancementModel))
  project.sequencePromptTemperature = project.promptEnhancer.resolveRewriteTemperature(
    payloadGet(payload, 'rewrite_temperature', project.sequencePromptTemperature))
  project.sequenceRewriteSystemPromptOverride = textOr(payload['rewrite_window_system_prompt'], '').trim()
  project.sequenceCreationSystemPromptOverride = textOr(payload['rewrite_user_system_prompt'], '').trim()
  await generateRewrittenSequence(project, instruction, {
    sourcePrompts: project.completedSequenceSegments.map(segment => segment.prompt),
    promptsToRewrite: payloadGet(payload, 'prompt_window_prompts'),
    referenceAssets,
  })
}

/**
 * Register the `rewrite_seed_prompts` handler for the lifetime of this plugin.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.dreamverseProjects.registerUserAction({
    actionTypes: ['rewrite_seed_prompts'], handler: rewriteVideoSequence,
  }))
}
