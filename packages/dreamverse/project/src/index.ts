/**
 * `dreamverseProjects`: DreamVerse projects, the user-action registry, and the project event log.
 *
 * This package ports `dreamverse/project/` from the Python reference, except the user actions and the browser
 * WebSocket connection. User-action plugins register their handlers here; the browser server creates or opens one
 * `Project` per socket and drives it through `processBrowserCommand`, `processQueuedGenerationActions`, and
 * `closeAndWaitForGeneration`. The service owns the project store under `projectRoot`: every project's record and
 * segment files, which the project list, project reads, segment file reads, and project deletion serve.
 *
 * @module @dreamverse/project
 */

import { existsSync } from 'node:fs'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { DreamverseAssetsManager, DreamversePromptEnhancer } from './dependencies.ts'
import { errorMessage } from './errors.ts'
import {
  Project, type ProjectInit, type ProjectOpenInit, type ProjectServices, type UserActionHandler, type UserActionRegistration,
} from './project.ts'
import { ProjectEventLogger } from './project-logger.ts'
import { ProjectStore, isStoredId, type PersistedProject, type SegmentFileKind } from './project-store.ts'

export * from './conditioning.ts'
export * from './dependencies.ts'
export * from './errors.ts'
export * from './generation-plan.ts'
export * from './generation-plan-controller.ts'
export * from './project.ts'
export * from './project-creation.ts'
export * from './project-logger.ts'
export * from './project-store.ts'
export * from './python-values.ts'
export * from './video-segment.ts'
export * from './video-stream.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dreamverseProjects: DreamverseProjects
  }
}

/** `dreamverseProjects` plugin configuration. */
export interface Config {
  /** Directory under which the service writes `<hostname>/<yymmdd_HHMMSS_ffffff>.jsonl`. */
  projectLogRoot: string
  /** Directory holding one `<project_id>/` directory per stored project; created when missing. */
  projectRoot: string
}

/**
 * Creates and opens projects, dispatches their queued actions to registered user actions, writes the project log, and
 * serves the stored projects.
 */
export class DreamverseProjects extends Service {
  static inject = ['dreamverseGeneration', 'dreamverseAssetsManager', 'dreamversePromptEnhancer']

  static Config: z<Config> = z.object({
    projectLogRoot: z.string().required(),
    projectRoot: z.string().required(),
  })

  private readonly userActions = new Map<string, UserActionHandler>()
  private readonly eventLogger: ProjectEventLogger
  private readonly store: ProjectStore

  constructor(ctx: Context, config: Config) {
    super(ctx, 'dreamverseProjects')
    this.eventLogger = new ProjectEventLogger(config.projectLogRoot)
    this.store = new ProjectStore(config.projectRoot)
  }

  /**
   * Serve action types with a user-action handler. Call it inside the plugin's `ctx.effect()` so unloading the
   * plugin removes the handler; a later queued action of a removed type fails with `Unsupported project action`.
   * @param registration - the action types and their handler.
   * @returns the disposer that removes the handler for every listed type.
   * @throws Error when another plugin already serves one of the action types.
   */
  registerUserAction(registration: UserActionRegistration): () => void {
    const claimed = registration.actionTypes.filter(actionType => this.userActions.has(actionType))
    if (claimed.length > 0) throw new Error(`DreamVerse user action already registered: ${claimed.join(', ')}`)
    for (const actionType of registration.actionTypes) this.userActions.set(actionType, registration.handler)
    return () => {
      for (const actionType of registration.actionTypes) {
        if (this.userActions.get(actionType) === registration.handler) this.userActions.delete(actionType)
      }
    }
  }

  /**
   * Create and store one browser project, following the reference `Project.__init__` steps.
   * @param init - the project ID, the `project_init_v1` message, and the browser socket.
   * @returns the project, with its initial action queued when the message supplies prompts or an instruction.
   * @throws {ProjectValidationError} for rejected creation input; an error that is not a `DreamverseValueError`
   *   when the generation backend cannot report its model facts.
   */
  async createProject(init: ProjectInit): Promise<Project> {
    return await Project.create(init, this.projectServices())
  }

  /**
   * Rebuild one stored project for a browser socket; see `Project.open`.
   * @param init - the project ID and the browser socket.
   * @returns the project, idle.
   * @throws {ProjectValidationError} with reason `Project not found`, `Model unavailable`, or
   *   `Invalid reference asset`; an Error for an invalid stored record or an unreachable generation backend.
   */
  async openProject(init: ProjectOpenInit): Promise<Project> {
    return await Project.open(init, this.projectServices())
  }

  /**
   * Read every stored project. A project whose record cannot be read is skipped with a warning.
   * @returns the records, most recently updated first.
   */
  listProjects(): PersistedProject[] {
    const records: PersistedProject[] = []
    for (const projectId of this.store.projectIds()) {
      try {
        const record = this.store.read(projectId)
        if (record !== undefined) records.push(record)
      } catch (error) {
        this.ctx.logger.warn(`Skipping unreadable project ${projectId}: ${errorMessage(error)}`)
      }
    }
    return records.sort((left, right) => right.updated_at.localeCompare(left.updated_at))
  }

  /**
   * Read one stored project.
   * @param projectId - the project ID.
   * @returns the record, or undefined when no such project is stored.
   * @throws Error when the stored record is invalid.
   */
  readProject(projectId: string): PersistedProject | undefined {
    return this.store.read(projectId)
  }

  /**
   * Locate one stored segment file.
   * @param projectId - the project ID.
   * @param segmentId - the segment ID.
   * @param kind - the segment's video or last frame.
   * @returns the file's path, or undefined when either ID is invalid or the file does not exist.
   */
  segmentFile(projectId: string, segmentId: string, kind: SegmentFileKind): string | undefined {
    if (!isStoredId(projectId) || !isStoredId(segmentId)) return undefined
    const path = this.store.segmentFilePath(projectId, segmentId, kind)
    return existsSync(path) ? path : undefined
  }

  /**
   * Remove one stored project with its files and its asset references. The caller ensures that no socket serves the
   * project.
   * @param projectId - the project ID.
   * @returns false when no such project is stored.
   */
  deleteProject(projectId: string): boolean {
    if (this.store.read(projectId) === undefined) return false
    this.assetsManager().removeProjectReferences(projectId)
    this.store.delete(projectId)
    return true
  }

  /**
   * Append one project event to the log; a write failure only warns.
   * @param projectId - the project that produced the event.
   * @param event - the event name.
   * @param payload - the event fields, written after the entry header.
   */
  logProjectEvent(projectId: string, event: string, payload?: Record<string, unknown>): Promise<void> {
    try {
      this.eventLogger.writeEvent(event, projectId, payload)
    } catch (error) {
      this.ctx.logger.warn(`Failed to write project log (${event}): ${errorMessage(error)}`)
    }
    return Promise.resolve()
  }

  /** Read by name: this package declares only the `dreamverseAssetsManager` members it calls. */
  private assetsManager(): DreamverseAssetsManager {
    return this.ctx.get('dreamverseAssetsManager') as DreamverseAssetsManager
  }

  /** The services that a created or opened project calls. */
  private projectServices(): ProjectServices {
    return {
      generation: this.ctx.dreamverseGeneration,
      assets: this.assetsManager(),
      // Read by name: `RewriteRolloutOptions.presetId` carries the raw `preset_id` payload value, which the
      // prompt-enhancer's declared `string | null` option type does not admit.
      promptEnhancer: this.ctx.get('dreamversePromptEnhancer') as DreamversePromptEnhancer,
      resolveUserAction: actionType => this.userActions.get(actionType),
      logProjectEvent: (projectId, event, payload) => this.logProjectEvent(projectId, event, payload),
      store: this.store,
    }
  }
}

export default DreamverseProjects
