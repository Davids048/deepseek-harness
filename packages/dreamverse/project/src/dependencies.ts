/**
 * Service members that the project package consumes. Generation types come from `@dreamverse/generation-client`.
 * The `dreamverseAssetsManager` and `dreamversePromptEnhancer` members restate what project and user-action code calls, as
 * the package README defines them, so both packages compile and test against fakes.
 *
 * @module @dreamverse/project/dependencies
 */

import type { ModelFacts, SegmentOutput, SegmentRequest } from '@dreamverse/generation-client'

export type { ModelFacts, SegmentOutput, SegmentRequest }

/** The `dreamverseGeneration` members that project code calls. */
export interface DreamverseGeneration {
  /** Rejects with a non-`DreamverseValueError` error when the backend is unreachable. */
  model(): Promise<ModelFacts>
  /**
   * Stream one segment. A backend failure rejects with `GenerationSegmentError`; aborting `request.signal` rejects
   * with `signal.reason`.
   */
  generateSegment(request: SegmentRequest): AsyncIterable<SegmentOutput>
}

/** One asset library record, as `dreamverseAssetsManager` returns it. */
export interface AssetRecord {
  assetId: string
  name: string
  /** `image`, `video`, or `audio`. */
  mediaType: string
  mimeType: string
  filePath: string
  sizeBytes: number
  width: number | null
  height: number | null
  durationSec: number | null
}

/** The `dreamverseAssetsManager` members that project code calls. */
export interface DreamverseAssetsManager {
  /**
   * Resolve every ID, then protect the files in request order until `release`.
   * @throws an error named `AssetNotFoundError` when an asset is absent or deleted; nothing is retained then.
   */
  retain(assetIds: readonly string[]): AssetRecord[]
  /** Release one accepted retention and remove deleted files that no retention protects any more. */
  release(assetIds: readonly string[]): void
}

/** Reference `PromptResult`. */
export interface PromptResult {
  prompt: string
  fallbackUsed: boolean
  error: string | null
  provider: string
  model: string
  latencyMs: number
}

/** Reference `RolloutResult`. */
export interface RolloutResult {
  prompts: string[]
  sourcePrompts: string[]
  fallbackUsed: boolean
  error: string | null
  provider: string
  model: string
  latencyMs: number
  rolloutId: string
  rolloutLabel: string
  rawResponseText: string | null
}

/** Keyword arguments of `PromptEnhancer.expand_clip`, plus the abort signal that stops the provider race. */
export interface ExpandClipOptions {
  segmentDurationSec: number
  model: string
  timeoutMs: number
  generationMode: string
  referenceLabels: string[]
  /** The project's generation signal; aborting it rejects the operation. */
  signal: AbortSignal
}

/** Keyword arguments of `PromptEnhancer.continue_video`. */
export interface ContinueVideoOptions extends ExpandClipOptions {
  lockedSegments: string[]
  nextSegmentIdx: number
}

/**
 * Keyword arguments of `PromptEnhancer.rewrite_rollout`, plus the abort signal that stops the provider race.
 * Browser-supplied values stay untyped as in the reference.
 */
export interface RewriteRolloutOptions {
  segmentCount: number
  segmentDurationSec: number
  promptsToRewrite: unknown
  presetId: unknown
  presetLabel: unknown
  rewriteInstruction: string
  rewriteModel: string
  rewriteTemperature: number
  timeoutMs: number
  generationMode: string
  referenceLabels: string[]
  systemPromptOverride: string
  newRolloutSystemPromptOverride: string
  /** The project's generation signal; aborting it rejects the operation. */
  signal: AbortSignal
}

/** The `dreamversePromptEnhancer` members that project and user-action code calls. */
export interface DreamversePromptEnhancer {
  resolveRewriteModel(requestedModel: unknown): string
  resolveRewriteTemperature(requestedTemperature: unknown): number
  expandClip(conditioningPrompt: string, options: ExpandClipOptions): Promise<PromptResult>
  continueVideo(conditioningPrompt: string | null, options: ContinueVideoOptions): Promise<PromptResult>
  rewriteRollout(prompts: string[], options: RewriteRolloutOptions): Promise<RolloutResult>
}

/** Reference `PROMPT_TIMEOUT_MS` from `prompt_enhancement/settings.py`: the provider deadline for project prompts. */
export const PROMPT_TIMEOUT_MS = 20000
