/**
 * Structural types for the services that the project controller consumes: the `dreamverseProjects` Project surface,
 * the `dreamverseGeneration` model facts and readiness, and the `dreamverseAssetsManager` upload policy. They restate
 * the members that `packages/dreamverse/README.md` defines, so the project controller compiles and tests against fakes.
 *
 * @module @dreamverse/project-controller/dependencies
 */

/** One browser socket; the implementation serializes `sendJson` and `sendBytes` through one lock. */
export interface ProjectSocket {
  sendJson(event: object): Promise<void>
  sendBytes(chunk: Buffer): Promise<void>
}

/** The inputs of `DreamverseProjects.createProject`. */
export interface ProjectInit {
  projectId: string
  /** The complete `project_init_v1` message. */
  payload: Record<string, unknown>
  socket: ProjectSocket
}

/** The `ProjectCreationConfig.as_dict()` fields that the `gpu_assigned` event reports. */
export interface CreationConfig {
  model_id: string
  generation_mode: string
  aspect_ratio: string
  resolution: string
  segment_count: number
  segment_duration_sec: number
}

/** The Project members that one browser connection drives. */
export interface Project {
  readonly projectId: string
  readonly videoGenerationSettings: CreationConfig
  processBrowserCommand(payload: Record<string, unknown>): Promise<void>
  /** Serves admitted rounds; rethrows failures that are not ValueError-kind, like the reference. */
  processQueuedGenerationActions(): Promise<void>
  /** Stops future work, aborts in-flight generation, drains it, and releases retained assets. */
  closeAndWaitForGeneration(): Promise<void>
}

/** The `dreamverseProjects` members that the project controller calls. */
export interface DreamverseProjects {
  /** Rejects with `ProjectValidationError` for a rejected project. */
  createProject(init: ProjectInit): Promise<Project>
  /** Writes one connection-level project log event; logging failures do not reject. */
  logProjectEvent(projectId: string, event: string, payload?: Record<string, unknown>): Promise<void>
}

/** The `ModelFacts` fields that `GET /creation-capabilities` reports. */
export interface ModelFacts {
  modelId: string
  /** Generation mode ID to its conditioning input kind. */
  generationModes: Record<string, string>
  /** Generation mode ID to the message that rejects it. */
  unsupportedGenerationModes: Record<string, string>
  aspectRatios: string[]
  resolutions: string[]
  minSegmentDurationSec: number
  maxSegmentDurationSec: number
  maxReferenceImages: number
  usesPreviousFrame: boolean
}

/** The `dreamverseGeneration` members that the project controller's HTTP routes call. */
export interface DreamverseGeneration {
  /** The generation backend's model facts; rejects when the backend is unreachable. */
  model(): Promise<ModelFacts>
  /** The generation backend's readiness; rejects when the backend is unreachable. */
  ready(): Promise<{ ready: boolean; detail: string | null }>
}

/** The `dreamverseAssetsManager` member that `GET /creation-capabilities` calls. */
export interface DreamverseAssetsManager {
  /** The reference `upload_policy_as_dict()` payload. */
  uploadPolicy(): Record<string, unknown>
}
