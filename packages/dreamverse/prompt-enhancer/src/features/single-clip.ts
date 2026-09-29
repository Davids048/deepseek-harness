/**
 * Build and validate one clip prompt using system instructions selected by `PromptEnhancer`.
 *
 * @module @dreamverse/prompt-enhancer/features/single-clip
 */
import type { ChatRequest, VendorReply } from '../llm/client.ts'
import { errorText } from '../utils/errors.ts'
import { dumpsJson, stripWhitespace, type JsonObject } from '../utils/python-text.ts'
import { parseJsonObject, requirePromptField } from '../utils/schemas.ts'
import { elapsedMs, type FeatureDependencies, type PromptResult } from './index.ts'

/** Inputs of `expandClip`. */
export interface ExpandClipOptions extends FeatureDependencies {
  /** The requested logical model; an unknown or absent name selects the settings default. */
  readonly model?: string | null | undefined
}

/**
 * Accept a reply whose JSON object carries a nonblank `prompt` string.
 * @param reply - the vendor reply.
 * @returns the stripped prompt.
 */
function acceptClip(reply: VendorReply): string {
  return requirePromptField(parseJsonObject(reply.text), 'prompt')
}

/**
 * Combine the selected instructions with a clip request and accept a nonempty JSON prompt.
 * @param conditioningPrompt - the user's idea; a blank or non-string value fails without a provider request.
 * @param options - the selected template, budget, settings, race, and request inputs.
 * @returns the accepted prompt, or an empty prompt with the failure.
 */
export async function expandClip(conditioningPrompt: unknown, options: ExpandClipOptions): Promise<PromptResult> {
  const { settings, race, segmentDurationSec } = options
  const cleaned = typeof conditioningPrompt === 'string' ? stripWhitespace(conditioningPrompt) : ''
  const resolvedModel = settings.resolveRewriteModel(options.model)
  if (!cleaned) {
    return {
      prompt: '',
      fallbackUsed: true,
      error: 'No valid prompt provided.',
      provider: race.providerLabel,
      model: resolvedModel,
      latencyMs: 0.0,
    }
  }

  const userPayload: JsonObject = {
    request: `Expand the user prompt into one complete ${segmentDurationSec}-second audiovisual shot. `
      + 'Respond with valid JSON only as {"prompt": "..."}.',
    segment_duration_sec: segmentDurationSec,
    user_prompt: cleaned,
  }
  const referenceLabels = options.referenceLabels ?? []
  if (referenceLabels.length > 0) userPayload['protagonist_reference_labels'] = [...referenceLabels]
  const request: ChatRequest = {
    systemPrompt: options.systemPrompt,
    userContent: dumpsJson(userPayload),
    model: resolvedModel,
    defaultModel: settings.rewriteDefaultModel,
    temperature: settings.temperature,
    maxCompletionTokens: options.maxCompletionTokens,
  }
  const started = performance.now()
  try {
    const [provider, prompt] = await race.firstAccepted(request, acceptClip, {
      operationName: 'enhance_prompt',
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    })
    return { prompt, fallbackUsed: false, error: null, provider, model: resolvedModel, latencyMs: elapsedMs(started) }
  } catch (error) {
    if (options.signal?.aborted) throw error
    return {
      prompt: '',
      fallbackUsed: true,
      error: errorText(error),
      provider: race.providerLabel,
      model: resolvedModel,
      latencyMs: elapsedMs(started),
    }
  }
}
