/**
 * Cordis plugin for the `simple_generate` action: generate one independent video clip and record it as the completed
 * sequence. Port of the reference `generate_single_clip.py`.
 *
 * @module @dreamverse/user-actions/generate-single-clip
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  DreamverseValueError,
  ProjectClosedError,
  createUserInstruction,
  errorMessage,
  isTruthy,
  payloadGet,
  round2,
  textOr,
  type ActionPayload,
  type AssetRecord,
  type Project,
  type PromptResult,
  type UserActionOptions,
  type UserInstruction,
} from '@dreamverse/project'

export const name = 'dreamverse-generate-single-clip'
export const inject = ['dreamverseProjects']

/**
 * Prepare an independent clip, apply its selected settings, and record successful video.
 *
 * The clip's `enhancement_enabled` choice becomes the project's setting. Its preset metadata becomes the project's
 * metadata during generation and reverts when generation fails.
 * @param project - the project that owns the round.
 * @param payload - the `simple_generate` command.
 * @param options - the retained reference assets.
 */
export async function generateSingleClip(
  project: Project,
  payload: ActionPayload,
  { referenceAssets }: UserActionOptions,
): Promise<void> {
  const instruction = createUserInstruction(payload['prompt_id'], payload['prompt'])
  const enhance = isTruthy(payloadGet(payload, 'enhancement_enabled', project.promptEnhancementEnabled))
  let prompt = instruction.text.trim()
  if (!prompt) throw new DreamverseValueError('A video clip requires a prompt.')
  if (enhance) prompt = await expandClip(project, instruction, prompt, referenceAssets)
  const segment = project.buildVideoSegment(prompt, {
    source: 'user', instruction, enhanced: enhance, sequenceIndex: 0, referenceAssets,
  })
  const plan = project.registerSegmentsAndBuildGenerationPlan([segment])
  if (enhance) {
    await project.sendBrowserEvent({
      type: 'prompt_ready', prompt_id: instruction.requestId, prompt, source: segment.wireSource,
    })
  }
  const presetId = project.promptSequenceId
  const presetLabel = project.promptSequenceLabel
  project.promptEnhancementEnabled = enhance
  project.promptSequenceId = textOr(payload['preset_id'], '').trim() || project.promptSequenceId
  project.promptSequenceLabel = textOr(payload['preset_label'], '').trim() || project.promptSequenceLabel
  try {
    await project.logProjectEvent('simple_generate', {
      prompt_id: instruction.requestId, prompt: instruction.text, preset_id: project.promptSequenceId,
      enhancement_enabled: enhance, reference_asset_ids: referenceAssets.map(asset => asset.assetId),
    })
    await project.executeGenerationPlan(plan)
  } catch (error) {
    if (!(error instanceof ProjectClosedError)) {
      project.promptSequenceId = presetId
      project.promptSequenceLabel = presetLabel
    }
    throw error
  }
  project.recordCompletedSequence(plan.sequenceIds)
}

/**
 * Report prompt progress and expand the clip prompt with the prompt enhancer.
 * @param project - the project that owns the round.
 * @param instruction - the clip instruction.
 * @param prompt - the stripped raw prompt.
 * @param referenceAssets - the retained reference assets, whose count selects the prompt image labels.
 * @returns the expanded prompt.
 * @throws {DreamverseValueError} when the provider fails, falls back, or returns nothing.
 */
async function expandClip(
  project: Project,
  instruction: UserInstruction,
  prompt: string,
  referenceAssets: readonly AssetRecord[],
): Promise<string> {
  const model = project.promptEnhancementModel
  const settings = project.videoGenerationSettings
  await project.sendBrowserEvent({ type: 'prompt_received', prompt_id: instruction.requestId })
  await project.sendBrowserEvent({ type: 'prompt_enhancing', prompt_id: instruction.requestId })
  await project.logProjectEvent('enhance_request', {
    prompt_id: instruction.requestId, raw_prompt: instruction.text, enhancement_enabled: true, rewrite_model: model,
  })
  let response: PromptResult
  try {
    response = await project.awaitPromptWork(async () => await project.promptEnhancer.expandClip(prompt, {
      generationMode: settings.generation_mode, segmentDurationSec: settings.segment_duration_sec,
      referenceLabels: project.promptImageLabels({ referenceCount: referenceAssets.length }).referenceLabels,
      signal: project.generationSignal,
    }))
  } catch (error) {
    if (error instanceof ProjectClosedError) throw error
    await project.logProjectEvent('rewrite_exception', {
      kind: 'enhance_prompt', prompt_id: instruction.requestId,
      raw_prompt: instruction.text, rewrite_model: model, error: errorMessage(error),
    })
    throw new DreamverseValueError('Prompt extension failed for this request.')
  }
  const expanded = response.prompt ? response.prompt.trim() : ''
  await project.logProjectEvent('rewrite_done', {
    kind: 'enhance_prompt', latency_ms: round2(response.latencyMs), response: expanded,
    error: response.error, fallback_used: response.fallbackUsed,
    provider: response.provider, model: response.model,
  })
  if (response.fallbackUsed || !expanded) throw new DreamverseValueError('Prompt extension failed for this request.')
  return expanded
}

/**
 * Register the `simple_generate` handler for the lifetime of this plugin.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.dreamverseProjects.registerUserAction({
    actionTypes: ['simple_generate'], handler: generateSingleClip,
  }))
}
