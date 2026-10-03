/**
 * Service members that the project package consumes. Generation types come from `@dreamverse/generation-client`, file
 * store records from `@dreamverse/segment-generation`, and project store types from `@dreamverse/project-store`. The
 * `dreamverseAssetsManager`, `dreamverseProjectStore`, `dreamverseSegmentGeneration`, and `dreamversePromptEnhancer`
 * members restate what project and user-action code calls, as the package README defines them, so both packages
 * compile and test against fakes.
 *
 * @module @dreamverse/project/dependencies
 */

import type { ModelFacts, SegmentOutput, SegmentRequest } from '@dreamverse/generation-client'
import type { ProjectHolder, ProjectLease, ProjectRecord, UnrecognizedProject, WorkloadData } from '@dreamverse/project-store'
import type {
  AssetOwner,
  AssetRecord,
  AssetWriteOptions,
  GeneratedSegment,
  SegmentGenerationRequest,
  SegmentSink,
} from '@dreamverse/segment-generation'

export type { ModelFacts, SegmentOutput, SegmentRequest }
export type { AssetOwner, AssetRecord, AssetWriteOptions, GeneratedSegment, SegmentGenerationRequest, SegmentSink }
export type { ProjectHolder, ProjectLease, ProjectRecord, UnrecognizedProject, WorkloadData }

/** The `dreamverseGeneration` members that project code calls. */
export interface DreamverseGeneration {
  /** Rejects with a non-`DreamverseValueError` error when the backend is unreachable. */
  model(): Promise<ModelFacts>
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
  /**
   * Resolve one file of any owner.
   * @throws an error named `AssetNotFoundError` when the asset is absent or deleted.
   */
  get(assetId: string): AssetRecord
  /**
   * Copy one file for another owner.
   * @throws an error named `AssetNotFoundError` when the asset is absent or deleted.
   */
  copy(assetId: string, owner: AssetOwner): Promise<AssetRecord>
  /** Write one small file at once. */
  addBytes(options: AssetWriteOptions, bytes: Uint8Array): Promise<AssetRecord>
  /** Delete every file of an owner. */
  deleteOwnedBy(owner: AssetOwner): void
}

/** The `dreamverseProjectStore` members that project code calls. */
export interface DreamverseProjectStore {
  create(init: { kind: string; title: string; workload: WorkloadData }): ProjectRecord
  get(projectId: string): ProjectRecord | undefined
  /** Rejects with `ProjectNotFoundError` when the project is not stored; revokes the current holder first. */
  acquire(projectId: string, holder: ProjectHolder): Promise<ProjectLease>
  release(lease: ProjectLease): void
  updateWorkload(lease: ProjectLease, workload: WorkloadData): ProjectRecord
  setThumbnail(lease: ProjectLease, assetId: string | null): ProjectRecord
  listUnrecognized(): UnrecognizedProject[]
  migrate(projectId: string, init: { kind: string; title: string; createdAt: string; workload: WorkloadData }): ProjectRecord
}

/** The `dreamverseSegmentGeneration` members that project code calls. */
export interface DreamverseSegmentGeneration {
  /**
   * Generate one segment and store its video and last frame with `request.owner`.
   * @throws {DreamverseValueError} for a backend `invalid_request` failure; the abort reason once `request.signal`
   *   aborts.
   */
  generate(request: SegmentGenerationRequest, sink?: SegmentSink): Promise<GeneratedSegment>
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
  timeoutMs: number
  generationMode: string
  referenceLabels: string[]
  /** The project's generation signal; aborting it rejects the operation. */
  signal: AbortSignal
}

/** Keyword arguments of `PromptEnhancer.continue_video`, plus the first-frame label of the new segment. */
export interface ContinueVideoOptions extends ExpandClipOptions {
  lockedSegments: string[]
  nextSegmentIdx: number
  /** Label of the previous segment's last frame that the new segment starts from; null when it carries none. */
  firstFrameLabel: string | null
}

/** Image labels of the rollout segments after the first, each of which starts from the previous segment's last frame. */
export interface ContinuedSegmentLabels {
  referenceLabels: string[]
  firstFrameLabel: string
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
  timeoutMs: number
  generationMode: string
  /** Labels of the first segment's reference images. */
  referenceLabels: string[]
  /** Labels of every later segment; null when later segments do not continue their predecessor. */
  continuedSegmentLabels: ContinuedSegmentLabels | null
  /** The project's generation signal; aborting it rejects the operation. */
  signal: AbortSignal
}

/** The `dreamversePromptEnhancer` members that project and user-action code calls. */
export interface DreamversePromptEnhancer {
  /** The rewrite model configured at startup; browser events and project log events report it as `rewrite_model`. */
  rewriteModel(): string
  expandClip(conditioningPrompt: string, options: ExpandClipOptions): Promise<PromptResult>
  continueVideo(conditioningPrompt: string | null, options: ContinueVideoOptions): Promise<PromptResult>
  rewriteRollout(prompts: string[], options: RewriteRolloutOptions): Promise<RolloutResult>
}

/** Reference `PROMPT_TIMEOUT_MS` from `prompt_enhancement/settings.py`: the provider deadline for project prompts. */
export const PROMPT_TIMEOUT_MS = 20000
