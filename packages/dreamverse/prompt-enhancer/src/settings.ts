/**
 * Prompt request defaults, shared deadlines, and provider order.
 *
 * @module @dreamverse/prompt-enhancer/settings
 */
import { PromptValueError } from './utils/errors.ts'
import { reprPython, stripWhitespace, toPythonFloat } from './utils/python-text.ts'

/** Default deadline for one prompt operation. */
export const PROMPT_TIMEOUT_MS = 20000
/** Provider names in race order; the first name labels failure results. */
export const PROMPT_PROVIDER_PRIORITY = ['cerebras', 'groq'] as const

/** Logical model used when `FASTVIDEO_PROMPT_MODEL` is absent or blank. */
const DEFAULT_REWRITE_MODEL = 'gpt-oss-120b'

/**
 * Clamp a temperature like Python `min(2.0, max(0.0, value))`, which maps NaN to 0.0.
 * @param value - the requested temperature.
 * @returns the temperature within [0, 2].
 */
function clampTemperature(value: number): number {
  const lower = value > 0 ? value : 0
  return lower < 2 ? lower : 2
}

/** Mutable request defaults shared by prompt features and the prompt configuration route. */
export class PromptSettings {
  rewriteDefaultModel: string
  rewriteModelOptions: string[]
  temperature: number
  rewriteDefaultTemperature: number
  maxCompletionTokens: number

  /**
   * Initialize request defaults without loading or saving prompt templates.
   * @param configuredModel - the `FASTVIDEO_PROMPT_MODEL` value; absent or blank selects `gpt-oss-120b`.
   */
  constructor(configuredModel: string | undefined) {
    this.rewriteDefaultModel = stripWhitespace(configuredModel ?? '') || DEFAULT_REWRITE_MODEL
    this.rewriteModelOptions = [this.rewriteDefaultModel]
    this.temperature = 1.0
    this.rewriteDefaultTemperature = this.temperature
    this.rewriteDefaultTemperature = this.resolveRewriteTemperature(this.temperature)
    this.maxCompletionTokens = 3000
  }

  /**
   * Expose editable rewrite defaults for the prompt configuration route.
   * @returns the reference snake_case settings fields.
   */
  getConfig(): { rewrite_model: string; rewrite_model_options: string[]; rewrite_temperature: number } {
    return {
      rewrite_model: this.rewriteDefaultModel,
      rewrite_model_options: [...this.rewriteModelOptions],
      rewrite_temperature: this.rewriteDefaultTemperature,
    }
  }

  /**
   * Select an allowed rewrite model for subsequent requests.
   * @param rewriteModel - the requested model name.
   * @returns the stored model name.
   */
  setRewriteDefaultModel(rewriteModel: unknown): string {
    this.rewriteDefaultModel = this.validateRewriteModel(rewriteModel)
    return this.rewriteDefaultModel
  }

  /**
   * Return an allowed model name without changing request defaults.
   * @param rewriteModel - the requested model name.
   * @returns the stripped model name.
   * @throws PromptValueError when the name is blank or not an allowed option.
   */
  validateRewriteModel(rewriteModel: unknown): string {
    const normalized = typeof rewriteModel === 'string' ? stripWhitespace(rewriteModel) : ''
    if (!normalized) throw new PromptValueError('rewrite_model cannot be empty.')
    if (!this.rewriteModelOptions.includes(normalized)) {
      const allowed = this.rewriteModelOptions.join(', ')
      throw new PromptValueError(`Unsupported rewrite_model ${reprPython(normalized)}. Expected one of: ${allowed}.`)
    }
    return normalized
  }

  /**
   * Store a numeric rewrite temperature within the supported range.
   * @param rewriteTemperature - the requested temperature.
   * @returns the stored temperature.
   */
  setRewriteDefaultTemperature(rewriteTemperature: unknown): number {
    this.rewriteDefaultTemperature = this.validateRewriteTemperature(rewriteTemperature)
    return this.rewriteDefaultTemperature
  }

  /**
   * Return a clamped numeric temperature without changing request defaults. Booleans count as numeric because
   * Python `bool` is an `int`.
   * @param rewriteTemperature - the requested temperature.
   * @returns the temperature within [0, 2].
   * @throws PromptValueError when the value is not numeric.
   */
  validateRewriteTemperature(rewriteTemperature: unknown): number {
    if (typeof rewriteTemperature !== 'number' && typeof rewriteTemperature !== 'boolean') {
      throw new PromptValueError('rewrite_temperature must be numeric.')
    }
    return this.resolveRewriteTemperature(Number(rewriteTemperature))
  }

  /**
   * Resolve a per-request model choice.
   * @param requestedModel - a browser-supplied model name.
   * @returns the stripped name when it is an allowed option, otherwise the default model.
   */
  resolveRewriteModel(requestedModel: unknown): string {
    const candidate = typeof requestedModel === 'string' ? stripWhitespace(requestedModel) : ''
    if (candidate && this.rewriteModelOptions.includes(candidate)) return candidate
    return this.rewriteDefaultModel
  }

  /**
   * Resolve an optional temperature and clamp it to the supported range.
   * @param requestedTemperature - a browser-supplied value that Python converts with `float()`.
   * @returns the clamped temperature, or the default when the value is absent or not convertible.
   */
  resolveRewriteTemperature(requestedTemperature: unknown): number {
    if (requestedTemperature === null || requestedTemperature === undefined) return this.rewriteDefaultTemperature
    const numericValue = toPythonFloat(requestedTemperature)
    if (numericValue === undefined) return this.rewriteDefaultTemperature
    return clampTemperature(numericValue)
  }
}
