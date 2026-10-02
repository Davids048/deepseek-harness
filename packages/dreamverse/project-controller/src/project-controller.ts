/**
 * The DreamVerse project controller: accepts `/ws` project sockets and serves the health, readiness, creation
 * capability, and stored-project routes, routed like the reference FastAPI application. The plugin registers them on
 * the DSH web server.
 *
 * @module @dreamverse/project-controller/project-controller
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Logger } from '@deepseek-ai/cordis'
import { serveRoutes, type Route } from '@dreamverse/http-routes'
import { WebSocketServer, type WebSocket } from 'ws'
import { getCreationCapabilities } from './creation-route.ts'
import type { DreamverseAssetsManager, DreamverseGeneration, DreamverseProjects } from './dependencies.ts'
import { getHealthz, getReadyz } from './health-routes.ts'
import { OpenProjectRegistry, ProjectConnection } from './project-connection.ts'
import { projectRoutes } from './project-routes.ts'
import { BrowserProjectSocket } from './project-socket.ts'

/** How often the server pings each open project socket so that proxies keep it open while it is idle. */
const PROJECT_SOCKET_PING_INTERVAL_MS = 20_000

/** The services the project controller routes to. */
export interface ProjectControllerServices {
  generation: DreamverseGeneration
  assets: DreamverseAssetsManager
  projects: DreamverseProjects
  logger: Logger
}

/** The `/ws` project sockets and the controller's HTTP routes, detached from any listener. */
export class DreamverseProjectController {
  /** The exact paths of {@link routes}, which the plugin registers on the web server. */
  readonly routePaths = ['/health', '/healthz', '/readyz', '/creation-capabilities'] as const
  /** The prefix paths of {@link routes}, which the plugin registers on the web server. */
  readonly routePrefixes = ['/projects'] as const
  private readonly projectSockets = new WebSocketServer({ noServer: true })
  /** The connection that serves each open project. */
  private readonly registry = new OpenProjectRegistry()
  /** Running project connections; closing waits for their cleanup. */
  private readonly connections = new Set<Promise<void>>()
  /** The HTTP routes in the reference registration order. */
  private readonly routes: Route[]

  /**
   * @param services - the generation, asset, project, and logger services.
   */
  constructor(private readonly services: ProjectControllerServices) {
    const { generation, assets, projects, logger } = services
    this.routes = [
      { method: 'GET', path: /^\/health$/, handle: (_request, response) => { getHealthz(response) } },
      { method: 'GET', path: /^\/healthz$/, handle: (_request, response) => { getHealthz(response) } },
      { method: 'GET', path: /^\/readyz$/, handle: (_request, response) => getReadyz(response, generation, logger) },
      { method: 'GET', path: /^\/creation-capabilities$/, handle: (_request, response) => getCreationCapabilities(response, generation, assets, logger) },
      ...projectRoutes(projects, this.registry),
    ]
  }

  /**
   * Complete a `/ws` upgrade and run one project connection over the socket.
   * @param request - the upgrade request.
   * @param socket - the upgraded network socket.
   * @param head - the first packet of the upgraded stream.
   */
  acceptUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.projectSockets.handleUpgrade(request, socket, head, (projectSocket) => { this.serveProject(projectSocket) })
  }

  /**
   * Serve one HTTP request through the controller's route table.
   * @param request - the browser request.
   * @param response - the browser response.
   */
  serveHttp(request: IncomingMessage, response: ServerResponse): void {
    serveRoutes(this.routes, request, response, this.services.logger)
  }

  /** Terminate every project socket and wait for every project connection to finish its cleanup. */
  async close(): Promise<void> {
    for (const projectSocket of this.projectSockets.clients) projectSocket.terminate()
    await Promise.all(this.connections)
  }

  private serveProject(projectSocket: WebSocket): void {
    // A proxy such as a Cloudflare tunnel drops a socket that carries no data for about two minutes, which happens
    // between generation rounds. The reference uvicorn server pings every 20 seconds by default; do the same.
    const pingTimer = setInterval(() => { projectSocket.ping() }, PROJECT_SOCKET_PING_INTERVAL_MS)
    projectSocket.once('close', () => { clearInterval(pingTimer) })
    const { projects, logger } = this.services
    const connection = new ProjectConnection(new BrowserProjectSocket(projectSocket), { projects, logger, registry: this.registry })
    const running = connection.run().catch((error: unknown) => { this.services.logger.warn(error) })
    this.connections.add(running)
    void running.finally(() => { this.connections.delete(running) })
  }
}
