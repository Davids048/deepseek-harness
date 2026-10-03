/**
 * Prompt request defaults and provider order.
 *
 * @module @dreamverse/prompt-enhancer/settings
 */
import { stripWhitespace } from './utils/python-text.ts'

/** Provider names in race order; the first name labels failure results. */
export const PROMPT_PROVIDER_PRIORITY = ['cerebras', 'groq'] as const

/** Logical model used when `FASTVIDEO_PROMPT_MODEL` is absent or blank. */
const DEFAULT_REWRITE_MODEL = 'gpt-oss-120b'

/** Request defaults shared by every prompt operation; they are fixed when the enhancer starts. */
export class PromptSettings {
  /** The logical model of every prompt request. */
  rewriteDefaultModel: string
  /** The sampling temperature of clip expansion and continuation requests. */
  temperature: number
  /** The sampling temperature of rollout requests. */
  rewriteDefaultTemperature: number
  maxCompletionTokens: number

  /**
   * Initialize request defaults without loading prompt templates.
   * @param configuredModel - the `FASTVIDEO_PROMPT_MODEL` value; absent or blank selects `gpt-oss-120b`.
   */
  constructor(configuredModel: string | undefined) {
    this.rewriteDefaultModel = stripWhitespace(configuredModel ?? '') || DEFAULT_REWRITE_MODEL
    this.temperature = 1.0
    this.rewriteDefaultTemperature = this.temperature
    this.maxCompletionTokens = 3000
  }
}
