/**
 * DreamVerse prompt enhancement as the `dreamversePromptEnhancer` Cordis service.
 *
 * A port of `apps/dreamverse/dreamverse/prompt_enhancement/` except prompt safety, which stays in the runtime service.
 * The service owns prompt settings, the bundled prompt templates, and the Cerebras/Groq provider race. Provider
 * credentials, model aliases, endpoints, and template paths arrive as Config fields that the bundle patch fills from
 * the reference environment variables.
 *
 * @module @dreamverse/prompt-enhancer
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import type { PromptResult } from './features/index.ts'
import type { RolloutResult } from './features/rollout.ts'
import { DEFAULT_CEREBRAS_BASE_URL, DEFAULT_GROQ_API_BASE_URL, type PromptDiagnostics } from './llm/client.ts'
import {
  PromptEnhancer, type ContinueVideoRequest, type ExpandClipRequest, type RewriteRolloutRequest,
} from './prompt-enhancer.ts'

export type { PromptResult } from './features/index.ts'
export type { ContinuedSegmentLabels, RolloutResult } from './features/rollout.ts'
export type { ContinueVideoRequest, ExpandClipRequest, RewriteRolloutRequest } from './prompt-enhancer.ts'
export { PromptRuntimeError, PromptValueError } from './utils/errors.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DreamVerse prompt expansion, continuation, and rollout rewriting. */
    dreamversePromptEnhancer: DreamversePromptEnhancer
  }
}

/** Provider, model, endpoint, and template choices; each field names the reference environment variable. */
export interface Config {
  /** `CEREBRAS_API_KEY`; absent or blank fails plugin start. */
  cerebrasApiKey?: string | undefined
  /** `GROQ_API_KEY`; absent or blank fails plugin start. */
  groqApiKey?: string | undefined
  /** `FASTVIDEO_PROMPT_MODEL`; absent or blank selects `gpt-oss-120b`. */
  model?: string | undefined
  /** `FASTVIDEO_PROMPT_CEREBRAS_MODEL`; absent or blank sends the logical model. */
  cerebrasModel?: string | undefined
  /** `FASTVIDEO_PROMPT_GROQ_MODEL`; absent or blank sends `openai/<logical model>`. */
  groqModel?: string | undefined
  /** `FASTVIDEO_PROMPT_GROQ_API_BASE_URL`; blank selects the OpenAI SDK endpoint, as in the reference. */
  groqApiBaseUrl: string
  /** `CEREBRAS_BASE_URL`, the Cerebras SDK's base URL variable. */
  cerebrasBaseUrl: string
  /** `FASTVIDEO_PROMPT_ENHANCE_SYSTEM_PROMPT_PATH`. */
  enhanceSystemPromptPath?: string | undefined
  /** `FASTVIDEO_PROMPT_AUTO_SYSTEM_PROMPT_PATH`. */
  autoSystemPromptPath?: string | undefined
  /** `FASTVIDEO_PROMPT_REWRITE_ALL_SYSTEM_PROMPT_PATH`. */
  rewriteAllSystemPromptPath?: string | undefined
  /** `FASTVIDEO_PROMPT_REWRITE_USER_SYSTEM_PROMPT_PATH`. */
  rewriteUserSystemPromptPath?: string | undefined
}

/** Loader validation and defaults; an absent environment variable reaches the schema as `undefined`. */
export const Config = z.object({
  cerebrasApiKey: z.string(),
  groqApiKey: z.string(),
  model: z.string(),
  cerebrasModel: z.string(),
  groqModel: z.string(),
  groqApiBaseUrl: z.string().default(DEFAULT_GROQ_API_BASE_URL),
  cerebrasBaseUrl: z.string().default(DEFAULT_CEREBRAS_BASE_URL),
  enhanceSystemPromptPath: z.string(),
  autoSystemPromptPath: z.string(),
  rewriteAllSystemPromptPath: z.string(),
  rewriteUserSystemPromptPath: z.string(),
})

/**
 * The `dreamversePromptEnhancer` service: a `PromptEnhancer` built from Config at plugin start.
 *
 * Construction loads every required template and captures both API keys, so a missing template or key fails the
 * plugin with the reference message. `[ENHANCE]` diagnostics go to this plugin's logger.
 */
export default class DreamversePromptEnhancer extends Service {
  static Config = Config
  private readonly enhancer: PromptEnhancer

  constructor(ctx: Context, config: Config) {
    const logger = ctx.logger('dreamverse-prompt-enhancer')
    const diagnostics: PromptDiagnostics = {
      info: (line) => { logger.info('%s', line) },
      warn: (line) => { logger.warn('%s', line) },
    }
    const enhancer = PromptEnhancer.fromConfig(config, diagnostics)
    super(ctx, 'dreamversePromptEnhancer')
    this.enhancer = enhancer
  }

  /**
   * Expand a user idea into a standalone clip prompt.
   * @param conditioningPrompt - the user's idea.
   * @param request - the duration, mode, labels, deadline, and abort signal.
   * @returns the accepted prompt, or an empty prompt with the failure.
   */
  expandClip(conditioningPrompt: string | null, request: ExpandClipRequest): Promise<PromptResult> {
    return this.enhancer.expandClip(conditioningPrompt, request)
  }

  /**
   * Continue locked segments from a user steer prompt or, for `null`, an inferred next beat.
   * @param conditioningPrompt - the user's direction, or `null` for automatic continuation.
   * @param request - the duration, history, mode, labels, deadline, and abort signal.
   * @returns the accepted prompt, or an empty prompt with the failure.
   */
  continueVideo(conditioningPrompt: string | null, request: ContinueVideoRequest): Promise<PromptResult> {
    return this.enhancer.continueVideo(conditioningPrompt, request)
  }

  /**
   * Select the source prompts and template, then request a complete rollout.
   * @param prompts - the project's stored prompts.
   * @param request - the count, duration, browser window, metadata, mode, labels, deadline, and signal.
   * @returns the accepted rollout, or the source prompts with the failure.
   */
  rewriteRollout(prompts: readonly unknown[], request: RewriteRolloutRequest): Promise<RolloutResult> {
    return this.enhancer.rewriteRollout(prompts, request)
  }

  /**
   * Read the logical model of every prompt request; project logs and browser events report it.
   * @returns the `FASTVIDEO_PROMPT_MODEL` value, or `gpt-oss-120b` when it is absent or blank.
   */
  rewriteModel(): string {
    return this.enhancer.rewriteModel()
  }

  /**
   * Count accepted replies per provider for monitoring.
   * @returns the counts keyed by provider name.
   */
  getProviderSuccessCounts(): Record<string, number> {
    return this.enhancer.getProviderSuccessCounts()
  }
}
