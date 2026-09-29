/**
 * Application-facing prompt enhancement: choose the operation and generation instructions.
 *
 * `PromptEnhancer` dispatches expansion, continuation, and rollout requests to their features. It selects the system
 * template and output budget from the generation mode and operation, resolves template overrides, and normalizes
 * rollout input before selecting a template. Features receive the selected text and budget, build operation-specific
 * requests, and validate provider replies. Reference labels are request data: the enhancer receives no images, and
 * labels do not determine the generation mode.
 *
 * @module @dreamverse/prompt-enhancer/prompt-enhancer
 */
import type { PromptResult } from './features/index.ts'
import { continueVideo } from './features/continuation.ts'
import { rewriteRollout, type RolloutResult } from './features/rollout.ts'
import { expandClip } from './features/single-clip.ts'
import { createVendorClients, type PromptDiagnostics, type VendorSettings } from './llm/client.ts'
import { ProviderRace } from './llm/race.ts'
import { PromptSettings } from './settings.ts'
import { getTemplateConfig, saveTemplates, type TemplateConfig, type TemplateUpdate } from './templates/editor.ts'
import { PromptTemplates, type PromptTemplateOptions } from './templates/loader.ts'
import { PromptValueError } from './utils/errors.ts'
import { stripWhitespace } from './utils/python-text.ts'

/** Minimum completion budget for Ref2VA, whose H3 prompts need 350–500-word shot descriptions per segment. */
const REF2VA_MIN_COMPLETION_TOKENS = 8192

/** Plugin configuration consumed by `PromptEnhancer.fromConfig`. */
export interface PromptEnhancerConfig extends VendorSettings, PromptTemplateOptions {
  /** `FASTVIDEO_PROMPT_MODEL`. */
  readonly model?: string | undefined
}

/** Options shared by the three prompt operations. */
export interface OperationOptions {
  /** The segment duration in seconds. */
  readonly segmentDurationSec: number
  /** The operation deadline; `null` or omission selects the race default. */
  readonly timeoutMs?: number | null | undefined
  /** `t2va`, `i2v`, or `ref2va`; omission selects `t2va`. */
  readonly generationMode?: string | undefined
  /** Ordered labels of the protagonist's reference images. */
  readonly referenceLabels?: readonly string[] | undefined
  /** Aborts the provider race; the operation then rejects with the abort reason. */
  readonly signal?: AbortSignal | undefined
}

/** Options of `PromptEnhancer.expandClip`. */
export interface ExpandClipRequest extends OperationOptions {
  readonly model?: string | null | undefined
}

/** Options of `PromptEnhancer.continueVideo`. */
export interface ContinueVideoRequest extends OperationOptions {
  readonly lockedSegments?: readonly unknown[] | null | undefined
  readonly nextSegmentIdx?: number | null | undefined
  readonly model?: string | null | undefined
}

/** Options of `PromptEnhancer.rewriteRollout`. */
export interface RewriteRolloutRequest extends OperationOptions {
  /** The number of prompts to create when no source prompts remain after normalization. */
  readonly segmentCount: number
  /** The browser's prompt window; when it holds usable prompts it replaces `prompts`. */
  readonly promptsToRewrite?: unknown
  readonly presetId?: string | null | undefined
  readonly presetLabel?: string | null | undefined
  readonly rewriteInstruction?: string | null | undefined
  readonly rewriteModel?: string | null | undefined
  readonly rewriteTemperature?: number | null | undefined
  /** The project's rewrite template for `t2va` and `i2v`. */
  readonly systemPromptOverride?: string | null | undefined
  /** The project's creation template for `t2va` and `i2v`; it takes precedence when the source is empty. */
  readonly newRolloutSystemPromptOverride?: string | null | undefined
}

/** Template and settings edits accepted by the prompt configuration route, keyed by its JSON fields. */
export interface PromptConfigUpdate extends TemplateUpdate {
  readonly rewrite_model?: string | null | undefined
  readonly rewrite_temperature?: number | null | undefined
}

/** The prompt configuration served by the prompt configuration route, keyed by its JSON fields. */
export interface PromptConfig extends TemplateConfig {
  rewrite_model: string
  rewrite_model_options: string[]
  rewrite_temperature: number
}

/**
 * Keep usable caller prompts before choosing a rollout template and feature input.
 * @param values - a prompt list from the project or the browser.
 * @returns the stripped nonblank string entries, or `[]` for a non-list.
 */
function normalizePromptsToRewrite(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values.flatMap((value: unknown) =>
    typeof value === 'string' && stripWhitespace(value) ? [stripWhitespace(value)] : [])
}

/** Dispatch prompt operations and select their templates using an explicit generation mode. */
export class PromptEnhancer {
  /**
   * @param settings - the mutable request defaults.
   * @param templates - the loaded templates shared by every operation.
   * @param race - the provider race and its success counters.
   */
  constructor(readonly settings: PromptSettings, readonly templates: PromptTemplates, readonly race: ProviderRace) {}

  /**
   * Load configured templates and construct the configured provider clients, in the reference order: template
   * failures are reported before missing API keys.
   * @param config - the plugin configuration.
   * @param diagnostics - the sink for `[ENHANCE]` lines.
   * @returns the configured enhancer.
   * @throws PromptRuntimeError for a template failure or a missing API key.
   */
  static fromConfig(config: PromptEnhancerConfig, diagnostics: PromptDiagnostics): PromptEnhancer {
    const settings = new PromptSettings(config.model)
    const templates = new PromptTemplates(config)
    const clients = createVendorClients(settings.rewriteDefaultModel, config, diagnostics)
    return new PromptEnhancer(settings, templates, ProviderRace.fromConfig(clients, diagnostics))
  }

  /**
   * Expand a user idea into a standalone clip prompt.
   * @param conditioningPrompt - the user's idea.
   * @param request - the duration, model, mode, labels, deadline, and abort signal.
   * @returns the accepted prompt, or an empty prompt with the failure.
   * @throws PromptValueError for an unsupported generation mode.
   */
  async expandClip(conditioningPrompt: string | null, request: ExpandClipRequest): Promise<PromptResult> {
    const generationMode = request.generationMode ?? 't2va'
    return await expandClip(conditioningPrompt, {
      ...request,
      settings: this.settings,
      systemPrompt: this.selectSystemPrompt(generationMode, this.templates.autoSystemPrompt),
      maxCompletionTokens: this.selectMaxCompletionTokens(generationMode),
      race: this.race,
    })
  }

  /**
   * Continue locked segments from a user steer prompt or, for `null`, an inferred next beat.
   * @param conditioningPrompt - the user's direction, or `null` for automatic continuation.
   * @param request - the duration, history, model, mode, labels, deadline, and abort signal.
   * @returns the accepted prompt, or an empty prompt with the failure.
   * @throws PromptValueError for an unsupported generation mode.
   */
  async continueVideo(conditioningPrompt: string | null, request: ContinueVideoRequest): Promise<PromptResult> {
    const generationMode = request.generationMode ?? 't2va'
    return await continueVideo(conditioningPrompt, {
      ...request,
      settings: this.settings,
      systemPrompt: this.selectSystemPrompt(generationMode, this.templates.enhanceSystemPrompt),
      maxCompletionTokens: this.selectMaxCompletionTokens(generationMode),
      race: this.race,
    })
  }

  /**
   * Select the source prompts and template, then request a complete rollout.
   * @param prompts - the project's stored prompts.
   * @param request - the count, duration, browser window, metadata, overrides, mode, labels, deadline, and signal.
   * @returns the accepted rollout, or the source prompts with the failure.
   * @throws PromptValueError for an unsupported generation mode.
   */
  async rewriteRollout(prompts: readonly unknown[], request: RewriteRolloutRequest): Promise<RolloutResult> {
    const browserWindow = normalizePromptsToRewrite(request.promptsToRewrite)
    const sourcePrompts = browserWindow.length > 0 ? browserWindow : normalizePromptsToRewrite(prompts)
    let defaultPrompt: string
    let override: string | null | undefined
    if (sourcePrompts.length > 0) {
      defaultPrompt = this.templates.rewriteAllSystemPrompt
      override = request.systemPromptOverride
    } else {
      defaultPrompt = this.templates.rewriteUserSystemPrompt
      override = request.newRolloutSystemPromptOverride || request.systemPromptOverride
    }
    const generationMode = request.generationMode ?? 't2va'
    return await rewriteRollout(sourcePrompts, {
      ...request,
      settings: this.settings,
      systemPrompt: this.selectSystemPrompt(generationMode, defaultPrompt, override),
      maxCompletionTokens: this.selectMaxCompletionTokens(generationMode),
      race: this.race,
    })
  }

  /**
   * Select generation instructions; Ref2VA uses its dedicated complete-shot template.
   * @param generationMode - the project's generation mode.
   * @param defaultPrompt - the operation's template for `t2va` and `i2v`.
   * @param override - a project template that replaces the default when nonblank.
   * @returns the system prompt.
   * @throws PromptValueError for an unsupported generation mode.
   */
  private selectSystemPrompt(generationMode: string, defaultPrompt: string, override?: string | null): string {
    if (generationMode === 'ref2va') return this.templates.ref2vaSystemPrompt
    if (generationMode !== 't2va' && generationMode !== 'i2v') {
      throw new PromptValueError(`Unsupported prompt enhancement generation mode: ${generationMode}`)
    }
    return (typeof override === 'string' ? stripWhitespace(override) : '') || defaultPrompt
  }

  /**
   * Allow detailed Ref2VA shots while preserving larger configured completion budgets.
   * @param generationMode - the project's generation mode.
   * @returns the completion budget.
   */
  private selectMaxCompletionTokens(generationMode: string): number {
    if (generationMode === 'ref2va') return Math.max(REF2VA_MIN_COMPLETION_TOKENS, this.settings.maxCompletionTokens)
    return this.settings.maxCompletionTokens
  }

  /**
   * Resolve a per-request model choice.
   * @param requestedModel - a browser-supplied model name.
   * @returns the allowed model, or the default model.
   */
  resolveRewriteModel(requestedModel: unknown): string {
    return this.settings.resolveRewriteModel(requestedModel)
  }

  /**
   * Resolve a per-request temperature.
   * @param requestedTemperature - a browser-supplied temperature.
   * @returns the clamped temperature, or the default temperature.
   */
  resolveRewriteTemperature(requestedTemperature: unknown): number {
    return this.settings.resolveRewriteTemperature(requestedTemperature)
  }

  /**
   * Read the editable prompt configuration.
   * @returns the template fields followed by the settings fields, keyed like the reference route.
   */
  getPromptConfig(): PromptConfig {
    return { ...getTemplateConfig(this.templates), ...this.settings.getConfig() }
  }

  /**
   * Validate the update, save templates, then apply defaults and reload prompt text.
   *
   * Validation failures preserve files and runtime settings. File write or reload failures propagate with any earlier
   * writes or assignments still applied.
   * @param update - the template and settings edits.
   * @returns the prompt configuration after the edits.
   * @throws PromptValueError for a rejected edit; PromptRuntimeError for a save or reload failure.
   */
  savePromptConfig(update: PromptConfigUpdate): PromptConfig {
    let rewriteModel = update.rewrite_model
    let rewriteTemperature = update.rewrite_temperature
    if (rewriteModel !== null && rewriteModel !== undefined) {
      rewriteModel = this.settings.validateRewriteModel(rewriteModel)
    }
    if (rewriteTemperature !== null && rewriteTemperature !== undefined) {
      rewriteTemperature = this.settings.validateRewriteTemperature(rewriteTemperature)
    }
    saveTemplates(this.templates, update)
    if (rewriteModel !== null && rewriteModel !== undefined) this.settings.setRewriteDefaultModel(rewriteModel)
    if (rewriteTemperature !== null && rewriteTemperature !== undefined) {
      this.settings.setRewriteDefaultTemperature(rewriteTemperature)
    }
    this.templates.reload()
    return this.getPromptConfig()
  }

  /**
   * Count accepted replies per provider.
   * @returns the counts keyed by provider name.
   */
  getProviderSuccessCounts(): Record<string, number> {
    return this.race.getProviderSuccessCounts()
  }
}
