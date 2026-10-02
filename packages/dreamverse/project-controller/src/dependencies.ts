/**
 * Structural types for the services that the project controller consumes: the `dreamverseProjects` Project surface
 * and stored projects, the `dreamverseGeneration` model facts and readiness, and the `dreamverseAssetsManager` upload
 * policy. They restate
 * the members that `packages/dreamverse/README.md` defines, so the project controller compiles and tests against fakes.
 *
 * @module @dreamverse/project-controller/dependencies
 */

/** One browser socket; the implementation serializes `sendJson` and `sendBytes` through one lock. */
export interface ProjectSocket {
  sendJson(event: object): Promise<void>
  sendBytes(chunk: Buffer): Promise<void>
}

/** The inputs of `DreamverseProjects.openProject`. */
export interface ProjectOpenInit {
  projectId: string
  socket: ProjectSocket
}

/** The inputs of `DreamverseProjects.createProject`. */
export interface ProjectInit extends ProjectOpenInit {
  /** The complete `project_init_v1` message. */
  payload: Record<string, unknown>
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

/** The fields of one stored segment that the project routes report. */
export interface PersistedSegment {
  readonly segment_id: string
  readonly prompt: string
  /** `completed` for a segment whose video is stored. */
  readonly status: string
  readonly mime: string | null
  readonly instruction: { readonly request_id: string; readonly text: string } | null
}

/** The fields of one stored project (`project.json`) that the project routes report. */
export interface PersistedProject {
  readonly project_id: string
  readonly title: string
  readonly created_at: string
  readonly updated_at: string
  readonly creation_config: CreationConfig
  readonly segments: readonly PersistedSegment[]
  /** Each completed round's display sequence of segment IDs, oldest first. */
  readonly completed_sequences: readonly (readonly string[])[]
}

/** The `dreamverseProjects` members that the project controller calls. */
export interface DreamverseProjects {
  /** Rejects with `ProjectValidationError` for a rejected project. */
  createProject(init: ProjectInit): Promise<Project>
  /** Rejects with `ProjectValidationError` for a project that is not stored or cannot be opened. */
  openProject(init: ProjectOpenInit): Promise<Project>
  /** Every stored project, most recently updated first. */
  listProjects(): readonly PersistedProject[]
  /** One stored project, or undefined when it is not stored. */
  readProject(projectId: string): PersistedProject | undefined
  /** The path of a stored segment's video or last frame, or undefined when it does not exist. */
  segmentFile(projectId: string, segmentId: string, kind: 'video' | 'frame'): string | undefined
  /** Removes a stored project; false when it is not stored. The caller ensures that no socket serves it. */
  deleteProject(projectId: string): boolean
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
