/**
 * Minimal user-action handlers for project specs, so project behavior is exercised without the user-action package.
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PromptId, UserActionHandler } from '../src/index.ts'

/**
 * A plugin that registers one handler for the given action types, as a user-action plugin does.
 * @param actionTypes - the served action types.
 * @param handler - the handler.
 * @returns the plugin object.
 */
export function actionPlugin(actionTypes: string[], handler: UserActionHandler): Plugin {
  return {
    name: `test-actions:${actionTypes.join(',')}`,
    inject: ['dreamverseProjects'],
    apply(ctx: Context) {
      ctx.effect(() => ctx.dreamverseProjects.registerUserAction({ actionTypes, handler }))
    },
  }
}

/** Generate `payload.prompts` (or `[payload.prompt]`) as a new sequence of preset segments and record it. */
export const generatePrompts: UserActionHandler = async (project, payload, { referenceAssets }) => {
  const prompts = Array.isArray(payload['prompts']) && payload['prompts'].length > 0
    ? payload['prompts'] as string[]
    : [String(payload['prompt'])]
  const segments = prompts.map((prompt, index) => project.buildVideoSegment(prompt, {
    source: 'preset', sequenceIndex: index, referenceAssets,
  }))
  const plan = project.registerSegmentsAndBuildGenerationPlan(segments)
  await project.executeGenerationPlan(plan)
  project.recordCompletedSequence(plan.sequenceIds)
}

/** Append `payload.prompt` as one user segment to the completed sequence and record the extended sequence. */
export const appendPrompt: UserActionHandler = async (project, payload, { referenceAssets }) => {
  const instruction = { requestId: brandString<PromptId>(String(payload['prompt_id'])), text: String(payload['prompt']) }
  const segment = project.buildVideoSegment(instruction.text, { source: 'user', instruction, referenceAssets })
  const plan = project.registerSegmentsAndBuildGenerationPlan([segment], { append: true })
  await project.executeGenerationPlan(plan)
  project.recordCompletedSequence(plan.sequenceIds)
}
