/**
 * Shared workflow of the sequence actions: expand a seed or rewrite a prompt window, then generate and record the
 * resulting sequence. Port of `_generate_rewritten_sequence` in the reference `rewrite_video_sequence.py`.
 *
 * @module @dreamverse/user-actions/rewritten-sequence
 */

import {
  DreamverseValueError,
  ProjectClosedError,
  errorMessage,
  isTruthy,
  round2,
  type AssetRecord,
  type Project,
  type RolloutResult,
  type UserInstruction,
} from '@dreamverse/project'

/** Inputs of one rewritten sequence. */
export interface RewrittenSequenceInput {
  /** The completed sequence's prompts; empty for a seed expansion. */
  sourcePrompts: string[]
  /** The browser's selected prompt window, passed to the prompt enhancer unvalidated as in the reference. */
  promptsToRewrite: unknown
  referenceAssets: readonly AssetRecord[]
}

/**
 * Expand or rewrite prompts, publish prompt progress, and record the generated sequence.
 *
 * Prompt failures report `rewrite_seed_prompts_complete` with an error and fail the round with a
 * `DreamverseValueError`. A generation failure restores the accepted sequence's preset metadata.
 * @param project - the project that owns the round.
 * @param instruction - the seed or rewrite instruction and its request ID.
 * @param input - the source prompts, the selected window, and the retained reference assets.
 */
export async function generateRewrittenSequence(
  project: Project,
  instruction: UserInstruction,
  input: RewrittenSequenceInput,
): Promise<void> {
  if (!instruction.text.trim() && input.sourcePrompts.length === 0 && !isTruthy(input.promptsToRewrite)) {
    throw new DreamverseValueError('A sequence rewrite requires prompts or an instruction.')
  }
  const response = await requestRollout(project, instruction, input)
  const latencyMs = round2(response.latencyMs)
  const complete = { type: 'rewrite_seed_prompts_complete', prompt_id: instruction.requestId }
  await project.logProjectEvent('rewrite_done', {
    kind: 'seed_rewrite', rewrite_instruction: instruction.text,
    latency_ms: latencyMs, response: response.rawResponseText || '',
  })
  if (response.fallbackUsed || response.prompts.length === 0 || response.prompts.some(prompt => !prompt.trim())) {
    const error = response.error || 'Prompt rewrite failed for this request.'
    await project.sendBrowserEvent({ ...complete, error, model: response.model, latency_ms: latencyMs })
    throw new DreamverseValueError(error)
  }
  const prompts = response.prompts.map(prompt => prompt.trim())
  const segments = prompts.map((prompt, index) => project.buildVideoSegment(prompt, {
    source: 'user', instruction, enhanced: true, sequenceIndex: index, referenceAssets: input.referenceAssets,
  }))
  const plan = project.registerSegmentsAndBuildGenerationPlan(segments)
  const presetId = project.promptSequenceId
  const presetLabel = project.promptSequenceLabel
  project.promptSequenceId = response.rolloutId
  project.promptSequenceLabel = response.rolloutLabel
  try {
    await project.sendBrowserEvent({
      type: 'seed_prompts_updated', prompts, model: response.model,
      latency_ms: latencyMs, raw_llm_output: response.rawResponseText,
    })
    await project.sendBrowserEvent(complete)
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
 * Request the rollout with the project's preset and generation settings captured before the provider wait.
 * @param project - the project that owns the round.
 * @param instruction - the seed or rewrite instruction.
 * @param input - the source prompts, the selected window, and the retained reference assets.
 * @returns the prompt enhancer's rollout.
 * @throws {DreamverseValueError} with the provider failure's message, after reporting it to the browser.
 */
async function requestRollout(
  project: Project,
  instruction: UserInstruction,
  input: RewrittenSequenceInput,
): Promise<RolloutResult> {
  const sourcePrompts = [...input.sourcePrompts]
  const promptsToRewrite: unknown = structuredClone(input.promptsToRewrite)
  const presetId = project.promptSequenceId
  const presetLabel = project.promptSequenceLabel
  const model = project.promptEnhancementModel
  const timeoutMs = project.promptEnhancementTimeoutMs
  const settings = project.videoGenerationSettings
  try {
    return await project.awaitPromptWork(async () => await project.promptEnhancer.rewriteRollout(sourcePrompts, {
      promptsToRewrite, presetId, presetLabel, rewriteInstruction: instruction.text, timeoutMs,
      generationMode: settings.generation_mode,
      referenceLabels: project.buildPromptImageLabels(input.referenceAssets.length),
      segmentCount: settings.segment_count, segmentDurationSec: settings.segment_duration_sec,
      signal: project.generationSignal,
    }))
  } catch (error) {
    if (error instanceof ProjectClosedError) {
      await project.logProjectEvent('rewrite_cancelled', {
        kind: 'seed_rewrite', rewrite_instruction: instruction.text, rewrite_model: model,
      })
      throw error
    }
    const message = errorMessage(error)
    await project.logProjectEvent('rewrite_exception', {
      kind: 'seed_rewrite', rewrite_instruction: instruction.text, rewrite_model: model, error: message,
    })
    await project.sendBrowserEvent({
      type: 'rewrite_seed_prompts_complete', prompt_id: instruction.requestId,
      error: message, model, latency_ms: 0,
    })
    throw new DreamverseValueError(message)
  }
}
