/**
 * Cordis plugin for the `append_prompt` and `auto_extend` actions: generate a continuation from the completed prompts
 * and an optional user steer prompt. Port of the reference `continue_video.py`.
 *
 * The project schedules `auto_extend`. This action owns manual prompt notifications, prompt enhancement, video
 * generation, and acceptance of the extended sequence.
 *
 * @module @dreamverse/user-actions/continue-video
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  DreamverseValueError,
  ProjectClosedError,
  createUserInstruction,
  errorMessage,
  round2,
  type ActionPayload,
  type AssetRecord,
  type Project,
  type PromptResult,
  type UserActionOptions,
  type UserInstruction,
} from '@dreamverse/project'

export const name = 'dreamverse-continue-video'
export const inject = ['dreamverseProjects']

/**
 * Generate and append one segment. Three cases share prompt preparation:
 *
 * 1. User steer with prompt enhancement disabled: the steer prompt is used as written.
 * 2. User steer with prompt enhancement enabled: the enhancer rewrites the steer prompt into a complete segment.
 * 3. `auto_extend`: no steer prompt, so the enhancer invents the next story beat, even when enhancement is disabled.
 *
 * A manual command reports `prompt_received`, `prompt_enhancing` when enhancement is enabled, and `prompt_ready`
 * before video submission.
 * @param project - the project that owns the round.
 * @param payload - the `append_prompt` command or the project's `auto_extend` action.
 * @param options - the retained reference assets.
 */
export async function continueVideo(
  project: Project,
  payload: ActionPayload,
  { referenceAssets }: UserActionOptions,
): Promise<void> {
  let instruction: UserInstruction | null = null
  if (payload['type'] !== 'auto_extend') {
    instruction = createUserInstruction(payload['prompt_id'], payload['prompt'])
    const completedIds = project.completedSequenceSegmentIds
    if (project.modelFacts.usesPreviousFrame && completedIds.length > 0
      && project.generationPlanController.lastCompletedSegmentId !== completedIds.at(-1)) {
      throw new DreamverseValueError('The previous generation failed. Rewrite the sequence before continuing it.')
    }
    await project.sendBrowserEvent({ type: 'prompt_received', prompt_id: instruction.requestId })
    if (project.promptEnhancementEnabled) {
      await project.sendBrowserEvent({ type: 'prompt_enhancing', prompt_id: instruction.requestId })
    }
  }
  const history = [...project.completedSequencePrompts]
  if (history.length === 0) throw new DreamverseValueError('Generate a video before requesting a continuation.')
  const isAutomatic = instruction === null
  const userPrompt = instruction ? instruction.text.trim() : ''
  const promptId = instruction ? instruction.requestId : null
  const rawPrompt = instruction ? instruction.text : null
  if (instruction && !userPrompt) throw new DreamverseValueError('A video continuation requires a prompt.')
  const enhance = isAutomatic || project.promptEnhancementEnabled
  await project.logProjectEvent('enhance_request', {
    prompt_id: promptId, raw_prompt: rawPrompt, enhancement_enabled: enhance, rewrite_model: project.promptEnhancementModel,
  })
  const prompt = enhance
    ? await enhanceContinuation(project, {
      conditioningPrompt: isAutomatic ? null : userPrompt, promptId, rawPrompt, history, referenceAssets,
    })
    : userPrompt
  const segment = project.buildVideoSegment(prompt, {
    source: isAutomatic ? 'automatic' : 'user', instruction, enhanced: enhance, referenceAssets,
  })
  const plan = project.registerSegmentsAndBuildGenerationPlan([segment], { append: true })
  await project.logProjectEvent('append_prompt', { prompt: rawPrompt, source: segment.wireSource })
  if (instruction !== null) {
    await project.sendBrowserEvent({
      type: 'prompt_ready', prompt_id: instruction.requestId, prompt: segment.prompt, source: segment.wireSource,
    })
  }
  await project.executeGenerationPlan(plan)
  project.recordCompletedSequence(plan.sequenceIds)
}

/** Inputs of one continuation enhancement. */
interface ContinuationRequest {
  /** The user steer prompt, or null for `auto_extend`, where the enhancer infers the next beat. */
  conditioningPrompt: string | null
  promptId: string | null
  rawPrompt: string | null
  history: string[]
  referenceAssets: readonly AssetRecord[]
}

/**
 * Return one enhanced continuation prompt.
 * @param project - the project that owns the round.
 * @param request - the steer prompt, its identity, the completed prompts, and the retained reference assets.
 * @returns the continuation prompt.
 * @throws {DreamverseValueError} when the provider fails, falls back, or returns nothing.
 */
async function enhanceContinuation(project: Project, request: ContinuationRequest): Promise<string> {
  const model = project.promptEnhancementModel
  const timeoutMs = project.promptEnhancementTimeoutMs
  const settings = project.videoGenerationSettings
  const { promptId, rawPrompt, history } = request
  const labels = project.promptImageLabels({ append: true, referenceCount: request.referenceAssets.length })
  let response: PromptResult
  try {
    response = await project.awaitPromptWork(async () => await project.promptEnhancer.continueVideo(
      request.conditioningPrompt, {
        lockedSegments: history, nextSegmentIdx: history.length + 1, timeoutMs,
        generationMode: settings.generation_mode, segmentDurationSec: settings.segment_duration_sec,
        referenceLabels: labels.referenceLabels, firstFrameLabel: labels.firstFrameLabel,
        signal: project.generationSignal,
      }))
  } catch (error) {
    if (error instanceof ProjectClosedError) throw error
    await project.logProjectEvent('rewrite_exception', {
      kind: 'enhance_prompt', prompt_id: promptId, raw_prompt: rawPrompt, rewrite_model: model, error: errorMessage(error),
    })
    throw new DreamverseValueError('Prompt extension failed for this request.')
  }
  const prompt = response.prompt ? response.prompt.trim() : ''
  await project.logProjectEvent('rewrite_done', {
    kind: 'enhance_prompt', latency_ms: round2(response.latencyMs), response: prompt,
    error: response.error, fallback_used: response.fallbackUsed,
    provider: response.provider, model: response.model,
  })
  if (response.fallbackUsed || !prompt) throw new DreamverseValueError('Prompt extension failed for this request.')
  return prompt
}

/**
 * Register the `append_prompt` and `auto_extend` handler for the lifetime of this plugin.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.dreamverseProjects.registerUserAction({
    actionTypes: ['append_prompt', 'auto_extend'], handler: continueVideo,
  }))
}
