/**
 * Port of the reference `ProjectConnection` (`dreamverse/project/project_websocket_connection.py`): one `/ws`
 * socket serves one project until disconnect, explicit leave, or failure.
 *
 * @module @dreamverse/browser-server/project-connection
 */
import { randomUUID } from 'node:crypto'
import type { Logger } from '@deepseek-ai/cordis'
import { ProjectValidationError } from '@dreamverse/project'
import type { DreamverseProjects, Project } from './dependencies.ts'
import { WebSocketDisconnect, type BrowserProjectSocket } from './project-socket.ts'

/** The services one project connection uses. */
export interface ProjectConnectionServices {
  projects: DreamverseProjects
  logger: Logger
}

/** Python type names of JSON values, for the reference's `AttributeError` text. */
function pythonTypeName(value: unknown): string {
  if (value === null) return 'NoneType'
  if (Array.isArray(value)) return 'list'
  if (typeof value === 'string') return 'str'
  if (typeof value === 'boolean') return 'bool'
  return Number.isInteger(value) ? 'int' : 'float'
}

/**
 * Accept one received JSON value where the reference calls `payload.get(...)`; a JSON value other than an object
 * fails with the reference `AttributeError` text.
 * @param payload - one received JSON value.
 * @returns the JSON object.
 */
function jsonObject(payload: unknown): Record<string, unknown> {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) return payload as Record<string, unknown>
  throw new Error(`'${pythonTypeName(payload)}' object has no attribute 'get'`)
}

/** Resolve once `task` settles, ignoring its outcome; its supervisor already reported any failure. */
async function settled(task: Promise<void> | undefined): Promise<void> {
  await task?.then(() => {}, () => {})
}

/** Serve one project over one browser socket, like the reference `ProjectConnection.run`. */
export class ProjectConnection {
  readonly projectId = randomUUID()
  private project: Project | undefined
  private projectTask: Promise<void> | undefined
  private receiveTask: Promise<void> | undefined
  /** Stops the receive loop, like cancelling the reference receive task. */
  private readonly receiveStop = new AbortController()
  /** Stops the steps before generation, like cancelling the reference project task. */
  private readonly projectStop = new AbortController()
  /** True once the project task entered `processQueuedGenerationActions`, which only closing the project ends. */
  private generating = false

  /**
   * @param socket - the accepted browser socket.
   * @param services - the project and logger services.
   */
  constructor(private readonly socket: BrowserProjectSocket, private readonly services: ProjectConnectionServices) {}

  /**
   * Accept one project request and supervise generation alongside browser commands.
   * Receiving starts with generation, so a disconnect stops queued work. Cleanup joins the receiver and project
   * tasks before releasing project resources and closing the socket.
   * @returns a promise that settles after cleanup; it rejects only when reporting a validation error fails.
   */
  async run(): Promise<void> {
    try {
      await this.services.projects.logProjectEvent(this.projectId, 'websocket_connected')
      const payload = jsonObject(await this.socket.receiveJson(this.receiveStop.signal))
      if (payload.type !== 'project_init_v1') {
        throw new ProjectValidationError('The first message must be project_init_v1.', 'Invalid project initialization')
      }
      const project = await this.services.projects.createProject({ projectId: this.projectId, payload, socket: this.socket })
      this.project = project
      this.projectTask = this.runProject(project)
      this.receiveTask = this.receiveCommands(project)
      // The first task to settle decides the outcome, like asyncio.wait(FIRST_COMPLETED).
      await Promise.race([this.projectTask, this.receiveTask])
    } catch (error) {
      if (error instanceof ProjectValidationError) {
        await this.socket.sendJson({ type: 'error', message: error.message })
        this.socket.close(1003, error.reason)
      } else if (error instanceof WebSocketDisconnect) {
        this.services.logger.info(`Project ${this.projectId.slice(0, 8)} disconnected`)
      } else {
        const message = error instanceof Error ? error.message : String(error)
        this.services.logger.error(`Project ${this.projectId.slice(0, 8)} error: ${message}`)
        await this.socket.sendJson({ type: 'error', message: `AV streaming failed: ${message}` }).catch(() => {
          // A send failure here means the browser already disconnected; the reference suppresses it the same way.
        })
      }
    } finally {
      await this.stopProject()
    }
  }

  /**
   * Report the project's creation settings, then serve its queued generation actions until the project closes.
   * The generation backend holds its GPU worker for its lifetime, so `gpu_assigned` follows project creation
   * immediately.
   */
  private async runProject(project: Project): Promise<void> {
    const stop = this.projectStop.signal
    const config = project.videoGenerationSettings
    await this.socket.sendJson({
      type: 'gpu_assigned',
      creation_config: {
        model_id: config.model_id,
        generation_mode: config.generation_mode,
        aspect_ratio: config.aspect_ratio,
        resolution: config.resolution,
        segment_count: config.segment_count,
        segment_duration_sec: config.segment_duration_sec,
      },
    })
    stop.throwIfAborted()
    await this.services.projects.logProjectEvent(this.projectId, 'gpu_assigned')
    stop.throwIfAborted()
    this.generating = true
    try {
      await project.processQueuedGenerationActions()
    } finally {
      await project.closeAndWaitForGeneration()
    }
  }

  /** Let the project admit each received action while observing disconnects. */
  private async receiveCommands(project: Project): Promise<void> {
    for (;;) {
      const payload = jsonObject(await this.socket.receiveJson(this.receiveStop.signal))
      if (payload.type === 'leave') return
      if (payload.type === 'project_init_v1') {
        await this.socket.sendJson({
          type: 'error',
          message: 'This connection already has a project. Open a separate connection for another project.',
        })
        continue
      }
      await project.processBrowserCommand(payload)
    }
  }

  /**
   * Join project execution before releasing project resources and closing the socket, in the reference
   * `_stop_project` order. The project has no task cancellation, so closing it ends its generation loop.
   */
  private async stopProject(): Promise<void> {
    this.receiveStop.abort()
    await settled(this.receiveTask)
    try {
      this.projectStop.abort()
      if (this.project && this.generating) await this.project.closeAndWaitForGeneration()
      await settled(this.projectTask)
    } finally {
      if (this.project) await this.project.closeAndWaitForGeneration()
      this.socket.close()
    }
  }
}
