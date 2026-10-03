/**
 * Structural types for the services that the project controller consumes: the `dreamverseProjects` Project surface,
 * the `dreamverseGeneration` model facts and readiness, and the `dreamverseAssetsManager` upload policy. They restate
 * the members that `packages/dreamverse/README.md` defines, so the project controller compiles and tests against fakes.
 *
 * @module @dreamverse/project-controller/dependencies
 */
import type { ModelFacts } from '@dreamverse/generation-client'
import type { ProjectHolder, ProjectId } from '@dreamverse/project-store'

export type { ModelFacts, ProjectHolder, ProjectId }

/** One browser socket; the implementation serializes `sendJson` and `sendBytes` through one lock. */
export interface ProjectSocket {
  sendJson(event: object): Promise<void>
  sendBytes(chunk: Buffer): Promise<void>
}

/** The browser socket of a project and the party that holds its lease in `dreamverseProjectStore`. */
export interface ProjectConnectionInit {
  socket: ProjectSocket
  /** Receives `revoke()` when another party acquires the project. */
  holder: ProjectHolder
}

/** The inputs of `DreamverseProjects.openProject`. */
export interface ProjectOpenInit extends ProjectConnectionInit {
  projectId: ProjectId
}

/** The inputs of `DreamverseProjects.createProject`; the project store assigns the project ID. */
export interface ProjectInit extends ProjectConnectionInit {
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
  readonly projectId: ProjectId
  readonly videoGenerationSettings: CreationConfig
  processBrowserCommand(payload: Record<string, unknown>): Promise<void>
  /** Serves admitted rounds; rethrows failures that are not ValueError-kind, like the reference. */
  processQueuedGenerationActions(): Promise<void>
  /** Stops future work, aborts in-flight generation, drains it, releases retained assets, and stores the project. */
  closeAndWaitForGeneration(): Promise<void>
  /** Gives up the project's lease after `closeAndWaitForGeneration`. */
  releaseLease(): void
}

/** The `dreamverseProjects` members that the project controller calls. */
export interface DreamverseProjects {
  /** Stores a project and takes its lease; rejects with `ProjectValidationError` for a rejected project. */
  createProject(init: ProjectInit): Promise<Project>
  /**
   * Takes a stored project's lease, revoking its current holder first; rejects with `ProjectValidationError` for a
   * project that is not stored or cannot be opened.
   */
  openProject(init: ProjectOpenInit): Promise<Project>
  /** Writes one connection-level project log event; logging failures do not reject. */
  logProjectEvent(projectId: ProjectId, event: string, payload?: Record<string, unknown>): Promise<void>
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
