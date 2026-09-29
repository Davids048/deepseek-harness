/**
 * Build operation-specific requests and validate generated prompts.
 *
 * `PromptEnhancer` supplies the selected system text and request inputs. Features own the clip, continuation, and
 * rollout payloads, output schemas, and response acceptance.
 *
 * @module @dreamverse/prompt-enhancer/features
 */
import type { ProviderRace } from '../llm/race.ts'
import type { PromptSettings } from '../settings.ts'

/** One generated prompt, or an empty prompt with the failure that replaced it. */
export interface PromptResult {
  prompt: string
  fallbackUsed: boolean
  error: string | null
  provider: string
  model: string
  latencyMs: number
}

/** Inputs every feature receives from `PromptEnhancer`. */
export interface FeatureDependencies {
  /** The operation's segment duration in seconds. */
  readonly segmentDurationSec: number
  readonly settings: PromptSettings
  /** The system template selected for the generation mode and operation. */
  readonly systemPrompt: string
  /** The completion budget selected for the generation mode. */
  readonly maxCompletionTokens: number
  readonly race: ProviderRace
  /** The operation deadline; `null` or omission selects the race default. */
  readonly timeoutMs?: number | null | undefined
  /** Ordered labels of the protagonist's reference images; they add request data only. */
  readonly referenceLabels?: readonly string[] | undefined
  /** Aborts the provider race; the feature then rejects with the abort reason instead of returning a fallback. */
  readonly signal?: AbortSignal | undefined
}

/**
 * Milliseconds elapsed since a `performance.now()` reading.
 * @param started - the start reading.
 * @returns the elapsed time in milliseconds.
 */
export function elapsedMs(started: number): number {
  return performance.now() - started
}
