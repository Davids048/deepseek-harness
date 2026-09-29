/**
 * Build and validate a continuation prompt using system instructions selected by `PromptEnhancer`.
 *
 * @module @dreamverse/prompt-enhancer/features/continuation
 */
import type { ChatRequest, VendorReply } from '../llm/client.ts'
import { errorText } from '../utils/errors.ts'
import { dumpsJson, stripWhitespace, type JsonObject } from '../utils/python-text.ts'
import { parseJsonObject, requirePromptField } from '../utils/schemas.ts'
import { elapsedMs, type FeatureDependencies, type PromptResult } from './index.ts'

/** Inputs of `continueVideo`. */
export interface ContinueVideoOptions extends FeatureDependencies {
  /** Accepted prompts of the existing segments; blank and non-string entries are ignored. */
  readonly lockedSegments?: readonly unknown[] | null | undefined
  /** The 1-based index of the new segment; other values select the segment after the locked history. */
  readonly nextSegmentIdx?: number | null | undefined
  /** The requested logical model; an unknown or absent name selects the settings default. */
  readonly model?: string | null | undefined
}

/**
 * List locked segments with their time ranges.
 * @param lockedSegments - the stripped locked prompts.
 * @param segmentDurationSec - the segment duration.
 * @returns one line per segment, or `(none)`.
 */
function formatLockedSegments(lockedSegments: readonly string[], segmentDurationSec: number): string {
  if (lockedSegments.length === 0) return '(none)'
  return lockedSegments.map((segment, i) =>
    `segment_${i + 1} (${i * segmentDurationSec}-${(i + 1) * segmentDurationSec}s): "${segment}"`).join('\n')
}

/**
 * Accept a reply whose JSON object carries a nonblank `next_prompt` string.
 * @param reply - the vendor reply.
 * @returns the stripped next prompt.
 */
function acceptContinuation(reply: VendorReply): string {
  return requirePromptField(parseJsonObject(reply.text), 'next_prompt')
}

/**
 * Request the next segment; a `null` or omitted user steer prompt asks the model to infer the next beat.
 * @param conditioningPrompt - the user's direction, or `null` for automatic continuation.
 * @param options - the selected template, budget, settings, race, history, and request inputs.
 * @returns the accepted prompt, or an empty prompt with the failure.
 */
export async function continueVideo(conditioningPrompt: unknown, options: ContinueVideoOptions): Promise<PromptResult> {
  const { settings, race, segmentDurationSec } = options
  const automatic = conditioningPrompt === null || conditioningPrompt === undefined
  const cleaned = typeof conditioningPrompt === 'string' ? stripWhitespace(conditioningPrompt) : ''
  const resolvedModel = settings.resolveRewriteModel(options.model)
  if (!automatic && !cleaned) {
    return {
      prompt: '',
      fallbackUsed: true,
      error: 'No valid prompt provided.',
      provider: race.providerLabel,
      model: resolvedModel,
      latencyMs: 0.0,
    }
  }

  const locked = (options.lockedSegments ?? []).flatMap(segment =>
    typeof segment === 'string' && stripWhitespace(segment) ? [stripWhitespace(segment)] : [])
  const nextSegmentIdx = options.nextSegmentIdx
  const segmentIdx = typeof nextSegmentIdx === 'number' && Number.isInteger(nextSegmentIdx) && nextSegmentIdx >= 1
    ? nextSegmentIdx
    : locked.length + 1
  let instruction = `<locked_segments>\n${formatLockedSegments(locked, segmentDurationSec)}\n</locked_segments>\n\n`
  if (automatic) {
    instruction += `Write exactly one new segment (segment_${segmentIdx}) `
      + 'that continues linearly from the locked segments. '
      + 'Infer the next narrative beat from this history. '
  } else {
    instruction += `<conditioning_prompt>${cleaned}</conditioning_prompt>\n\n`
      + `Write exactly one new segment (segment_${segmentIdx}) `
      + 'continuing from the locked segments. '
  }
  instruction += `The segment lasts ${segmentDurationSec} seconds. `
    + 'Respond with valid JSON only as {"next_prompt": "..."}.'
  const userPayload: JsonObject = { request: instruction, segment_duration_sec: segmentDurationSec }
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
    const [provider, prompt] = await race.firstAccepted(request, acceptContinuation, {
      operationName: automatic ? 'generate_auto_prompt' : 'enhance_prompt',
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
