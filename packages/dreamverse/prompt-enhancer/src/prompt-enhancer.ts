/**
 * Application-facing prompt enhancement: choose the operation and generation instructions.
 *
 * `PromptEnhancer` dispatches expansion, continuation, and rollout requests to their features. It selects the system
 * template and output budget from the generation mode and operation, and normalizes rollout input before selecting a
 * template. Features receive the selected text and budget, build operation-specific
 * requests, and validate provider replies. Reference labels are request data: the enhancer receives no images, and
 * labels do not determine the generation mode.
 *
 * @module @dreamverse/prompt-enhancer/prompt-enhancer
 */
import type { PromptResult } from './features/index.ts'
import { continueVideo } from './features/continuation.ts'
import { rewriteRollout, type ContinuedSegmentLabels, type RolloutResult } from './features/rollout.ts'
import { expandClip } from './features/single-clip.ts'
import { createVendorClients, type PromptDiagnostics, type VendorSettings } from './llm/client.ts'
import { ProviderRace } from './llm/race.ts'
import { PromptSettings } from './settings.ts'
import { PromptTemplates, type PromptTemplateOptions } from './templates/loader.ts'
import { PromptValueError } from './utils/errors.ts'
import { stripWhitespace } from './utils/python-text.ts'

/** Minimum completion budget for Ref2VA, whose H3 prompts need 350–500-word shot descriptions per segment. */
const REF2VA_MIN_COMPLETION_TOKENS = 8192

/** Plugin configuration consumed by `PromptEnhancer.fromConfig`. */
export interface PromptEnhancerConfig extends VendorSettings, PromptTemplateOptions {
  /** `FASTVIDEO_PROMPT_MODEL`. */
  readonly model?: string | undefined
  /** Deadline of one prompt operation in milliseconds. */
  readonly timeoutMs: number
}

/** Options shared by the three prompt operations. */
export interface OperationOptions {
  /** The segment duration in seconds. */
  readonly segmentDurationSec: number
  /** `t2va`, `i2v`, or `ref2va`; omission selects `t2va`. */
  readonly generationMode?: string | undefined
  /** Ordered labels of the protagonist's reference images; for a rollout, those of its first segment. */
  readonly referenceLabels?: readonly string[] | undefined
  /** Aborts the provider race; the operation then rejects with the abort reason. */
  readonly signal?: AbortSignal | undefined
}

/** Options of `PromptEnhancer.expandClip`. */
export type ExpandClipRequest = OperationOptions

/** Options of `PromptEnhancer.continueVideo`. */
export interface ContinueVideoRequest extends OperationOptions {
  readonly lockedSegments?: readonly unknown[] | null | undefined
  readonly nextSegmentIdx?: number | null | undefined
  /** Label of the previous segment's last frame that the new segment starts from; null or omitted for none. */
  readonly firstFrameLabel?: string | null | undefined
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
  /** Labels of the segments after the first, which start from the previous segment's last frame; null for none. */
  readonly continuedSegmentLabels?: ContinuedSegmentLabels | null | undefined
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
   * @param settings - the request defaults.
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
    return new PromptEnhancer(settings, templates, ProviderRace.fromConfig(clients, config.timeoutMs, diagnostics))
  }

  /**
   * Expand a user idea into a standalone clip prompt.
   * @param conditioningPrompt - the user's idea.
   * @param request - the duration, mode, labels, and abort signal.
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
   * @param request - the duration, history, mode, labels, and abort signal.
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
   * @param request - the count, duration, browser window, metadata, mode, labels, and signal.
   * @returns the accepted rollout, or the source prompts with the failure.
   * @throws PromptValueError for an unsupported generation mode.
   */
  async rewriteRollout(prompts: readonly unknown[], request: RewriteRolloutRequest): Promise<RolloutResult> {
    const browserWindow = normalizePromptsToRewrite(request.promptsToRewrite)
    const sourcePrompts = browserWindow.length > 0 ? browserWindow : normalizePromptsToRewrite(prompts)
    const defaultPrompt = sourcePrompts.length > 0
      ? this.templates.rewriteAllSystemPrompt
      : this.templates.rewriteUserSystemPrompt
    const generationMode = request.generationMode ?? 't2va'
    return await rewriteRollout(sourcePrompts, {
      ...request,
      settings: this.settings,
      systemPrompt: this.selectSystemPrompt(generationMode, defaultPrompt),
      maxCompletionTokens: this.selectMaxCompletionTokens(generationMode),
      race: this.race,
    })
  }

  /**
   * Select generation instructions; Ref2VA uses its dedicated complete-shot template.
   * @param generationMode - the project's generation mode.
   * @param defaultPrompt - the operation's template for `t2va` and `i2v`.
   * @returns the system prompt.
   * @throws PromptValueError for an unsupported generation mode.
   */
  private selectSystemPrompt(generationMode: string, defaultPrompt: string): string {
    if (generationMode === 'ref2va') return this.templates.ref2vaSystemPrompt
    if (generationMode !== 't2va' && generationMode !== 'i2v') {
      throw new PromptValueError(`Unsupported prompt enhancement generation mode: ${generationMode}`)
    }
    return defaultPrompt
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
   * Read the logical model of every prompt request.
   * @returns the `FASTVIDEO_PROMPT_MODEL` value, or `gpt-oss-120b` when it is absent or blank.
   */
  rewriteModel(): string {
    return this.settings.rewriteDefaultModel
  }

  /**
   * Count accepted replies per provider.
   * @returns the counts keyed by provider name.
   */
  getProviderSuccessCounts(): Record<string, number> {
    return this.race.getProviderSuccessCounts()
  }
}
