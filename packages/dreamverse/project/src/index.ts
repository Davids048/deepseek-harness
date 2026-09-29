/**
 * `dreamverseProjects`: DreamVerse projects, the user-action registry, and the project event log.
 *
 * This package ports `dreamverse/project/` from the Python reference, except the user actions and the browser
 * WebSocket connection. User-action plugins register their handlers here; the browser server creates one `Project`
 * per socket and drives it through `processBrowserCommand`, `processQueuedGenerationActions`, and
 * `closeAndWaitForGeneration`.
 *
 * @module @dreamverse/project
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { DreamverseAssetsManager, DreamversePromptEnhancer } from './dependencies.ts'
import { errorMessage } from './errors.ts'
import { Project, type ProjectInit, type UserActionHandler, type UserActionRegistration } from './project.ts'
import { ProjectEventLogger } from './project-logger.ts'

export * from './dependencies.ts'
export * from './errors.ts'
export * from './generation-plan.ts'
export * from './generation-plan-controller.ts'
export * from './project.ts'
export * from './project-creation.ts'
export * from './project-logger.ts'
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
}

/** Creates projects, dispatches their queued actions to registered user actions, and writes the project log. */
export class DreamverseProjects extends Service {
  static inject = ['dreamverseGeneration', 'dreamverseAssetsManager', 'dreamversePromptEnhancer']

  static Config: z<Config> = z.object({
    projectLogRoot: z.string().required(),
  })

  private readonly userActions = new Map<string, UserActionHandler>()
  private readonly eventLogger: ProjectEventLogger

  constructor(ctx: Context, config: Config) {
    super(ctx, 'dreamverseProjects')
    this.eventLogger = new ProjectEventLogger(config.projectLogRoot)
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
   * Create one browser project, following the reference `Project.__init__` steps.
   * @param init - the project ID, the `project_init_v1` message, and the browser socket.
   * @returns the project, with its initial action queued when the message supplies prompts or an instruction.
   * @throws {ProjectValidationError} for rejected creation input; an error that is not a `DreamverseValueError`
   *   when the generation backend cannot report its model facts.
   */
  async createProject(init: ProjectInit): Promise<Project> {
    return await Project.create(init, {
      generation: this.ctx.dreamverseGeneration,
      // Read by name: this package declares only the `dreamverseAssetsManager` members it calls.
      assets: this.ctx.get('dreamverseAssetsManager') as DreamverseAssetsManager,
      // Read by name: `RewriteRolloutOptions.presetId` carries the raw `preset_id` payload value, which the
      // prompt-enhancer's declared `string | null` option type does not admit.
      promptEnhancer: this.ctx.get('dreamversePromptEnhancer') as DreamversePromptEnhancer,
      resolveUserAction: actionType => this.userActions.get(actionType),
      logProjectEvent: (projectId, event, payload) => this.logProjectEvent(projectId, event, payload),
    })
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
}

export default DreamverseProjects
