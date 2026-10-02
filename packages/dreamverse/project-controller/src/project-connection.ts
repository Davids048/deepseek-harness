/**
 * Port of the reference `ProjectConnection` (`dreamverse/project/project_websocket_connection.py`): one `/ws`
 * socket serves one project until disconnect, explicit leave, failure, or takeover. The first message either creates
 * a project (`project_init_v1`) or opens a stored one (`project_open_v1`); `OpenProjectRegistry` keeps one connection
 * per open project, and a later open of the same project takes the project over from the earlier connection.
 *
 * @module @dreamverse/project-controller/project-connection
 */
import { randomUUID } from 'node:crypto'
import type { Logger } from '@deepseek-ai/cordis'
import { ProjectValidationError } from '@dreamverse/project'
import type { DreamverseProjects, Project } from './dependencies.ts'
import { WebSocketDisconnect, type BrowserProjectSocket } from './project-socket.ts'

/** The browser error that a connection receives when another connection opens its project. */
export const PROJECT_TAKEN_OVER_MESSAGE = 'This project was opened in another window.'

/** The connection that serves each open project ID; a later connection that opens the same project takes it over. */
export class OpenProjectRegistry {
  private readonly connections = new Map<string, ProjectConnection>()

  /**
   * @param projectId - the project ID.
   * @returns whether a connection serves the project or is opening it.
   */
  has(projectId: string): boolean {
    return this.connections.has(projectId)
  }

  /**
   * Make `connection` the one that serves `projectId`. When another connection served it, that connection is taken
   * over and has finished its cleanup, which stores the project, before the returned promise settles.
   * @param projectId - the project ID.
   * @param connection - the connection that creates or opens the project.
   */
  async claim(projectId: string, connection: ProjectConnection): Promise<void> {
    const holder = this.connections.get(projectId)
    this.connections.set(projectId, connection)
    if (holder !== undefined && holder !== connection) await holder.takeOver()
  }

  /**
   * Remove `connection`'s claim; a claim that a later connection has taken over stays.
   * @param projectId - the project ID.
   * @param connection - the connection that finished.
   */
  release(projectId: string, connection: ProjectConnection): void {
    if (this.connections.get(projectId) === connection) this.connections.delete(projectId)
  }
}

/** The services one project connection uses. */
export interface ProjectConnectionServices {
  projects: DreamverseProjects
  logger: Logger
  registry: OpenProjectRegistry
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
  /** A new UUID that a created project takes; `project_open_v1` replaces it with the opened project's ID. */
  private servedProjectId: string = randomUUID()
  private project: Project | undefined
  private projectTask: Promise<void> | undefined
  private receiveTask: Promise<void> | undefined
  /** Stops the receive loop, like cancelling the reference receive task. */
  private readonly receiveStop = new AbortController()
  /** Stops the steps before generation, like cancelling the reference project task. */
  private readonly projectStop = new AbortController()
  /** True once the project task entered `processQueuedGenerationActions`, which only closing the project ends. */
  private generating = false
  /** True once this connection holds a claim in the registry for `projectId`. */
  private claimed = false
  /** True once a later connection opened this connection's project. */
  private takenOver = false
  private finish!: () => void
  /** Settles after `run()` finished its cleanup. */
  private readonly finished = new Promise<void>((resolve) => { this.finish = resolve })

  /**
   * @param socket - the accepted browser socket.
   * @param services - the project and logger services and the open project registry.
   */
  constructor(private readonly socket: BrowserProjectSocket, private readonly services: ProjectConnectionServices) {}

  /** The served project's ID, which the connection's project log events carry. */
  get projectId(): string {
    return this.servedProjectId
  }

  /**
   * Accept one project request and supervise generation alongside browser commands.
   * Receiving starts with generation, so a disconnect stops queued work. Cleanup joins the receiver and project
   * tasks before releasing project resources, closing the socket, and releasing the registry claim.
   * @returns a promise that settles after cleanup; it rejects only when reporting a validation error fails.
   */
  async run(): Promise<void> {
    try {
      await this.services.projects.logProjectEvent(this.projectId, 'websocket_connected')
      const payload = jsonObject(await this.socket.receiveJson(this.receiveStop.signal))
      const project = await this.startProject(payload)
      this.project = project
      this.projectTask = this.runProject(project)
      this.receiveTask = this.receiveCommands(project)
      // The first task to settle decides the outcome, like asyncio.wait(FIRST_COMPLETED).
      await Promise.race([this.projectTask, this.receiveTask])
    } catch (error) {
      if (this.takenOver) {
        this.services.logger.info(`Project ${this.projectId.slice(0, 8)} opened in another window`)
      } else if (error instanceof ProjectValidationError) {
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
      try {
        await this.stopProject()
      } finally {
        if (this.claimed) this.services.registry.release(this.projectId, this)
        this.finish()
      }
    }
  }

  /**
   * Hand the project to a connection that opened it later: tell the browser, close this socket, stop serving, and
   * wait until this connection's cleanup has stored the project.
   */
  async takeOver(): Promise<void> {
    this.takenOver = true
    await this.socket.sendJson({ type: 'error', message: PROJECT_TAKEN_OVER_MESSAGE }).catch(() => {
      // A send failure means the browser already disconnected; the takeover proceeds without the notice.
    })
    this.socket.close(1000, 'Project opened in another window')
    this.receiveStop.abort()
    await this.finished
  }

  /**
   * Create the project that `project_init_v1` describes, or open the stored project that `project_open_v1` names, and
   * claim its ID. Opening claims before it reads the store, so a connection that served the project has stored it.
   * @param payload - the first browser message.
   * @returns the project.
   * @throws {ProjectValidationError} for another first message, a missing project ID, or a rejected project.
   */
  private async startProject(payload: Record<string, unknown>): Promise<Project> {
    const { projects, registry } = this.services
    if (payload.type === 'project_init_v1') {
      const project = await projects.createProject({ projectId: this.projectId, payload, socket: this.socket })
      this.claimed = true
      await registry.claim(this.projectId, this)
      return project
    }
    if (payload.type === 'project_open_v1') {
      const projectId = payload['project_id']
      if (typeof projectId !== 'string' || projectId === '') {
        throw new ProjectValidationError('project_open_v1 requires a project_id.', 'Invalid project initialization')
      }
      this.servedProjectId = projectId
      this.claimed = true
      await registry.claim(projectId, this)
      return await projects.openProject({ projectId, socket: this.socket })
    }
    throw new ProjectValidationError(
      'The first message must be project_init_v1 or project_open_v1.', 'Invalid project initialization')
  }

  /**
   * Report the project's ID and creation settings, then serve its queued generation actions until the project closes.
   * The generation backend holds its GPU worker for its lifetime, so `gpu_assigned` follows project creation or
   * opening immediately; the generation loop then reports the round status, which is `idle` for an opened project.
   */
  private async runProject(project: Project): Promise<void> {
    const stop = this.projectStop.signal
    const config = project.videoGenerationSettings
    await this.socket.sendJson({
      type: 'gpu_assigned',
      project_id: project.projectId,
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
      if (payload.type === 'project_init_v1' || payload.type === 'project_open_v1') {
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
