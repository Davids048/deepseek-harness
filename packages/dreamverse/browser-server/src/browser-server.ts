/**
 * The DreamVerse browser HTTP and WebSocket listener: `/ws` project connections and every browser HTTP route, routed
 * like the reference FastAPI application.
 *
 * @module @dreamverse/browser-server/browser-server
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Logger } from '@deepseek-ai/cordis'
import { WebSocketServer, type WebSocket } from 'ws'
import { deleteAsset, listAssets, readAssetContent, uploadAsset } from './asset-routes.ts'
import { getCreationCapabilities } from './creation-route.ts'
import type { DreamverseAssetsManager, DreamverseGeneration, DreamverseProjects } from './dependencies.ts'
import { getHealthz, getReadyz } from './health-routes.ts'
import { sendInternalServerError, sendJson } from './http.ts'
import { ProjectConnection } from './project-connection.ts'
import { BrowserProjectSocket } from './project-socket.ts'

/** The services the browser server routes to. */
export interface BrowserServerServices {
  generation: DreamverseGeneration
  assets: DreamverseAssetsManager
  projects: DreamverseProjects
  logger: Logger
}

/** One FastAPI route: one method and one path pattern whose groups are the decoded path parameters. */
interface Route {
  method: string
  path: RegExp
  handle: (request: IncomingMessage, response: ServerResponse, pathParams: string[]) => void | Promise<void>
}

/**
 * The request path without its query, percent-decoded as UTF-8 with replacement characters like the ASGI `path`
 * that Starlette's router matches.
 */
function requestPath(request: IncomingMessage): string {
  const rawPath = (request.url ?? '/').split('?')[0] ?? '/'
  return rawPath.replace(/(%[0-9a-f]{2})+/gi, escapes => Buffer.from(escapes.replaceAll('%', ''), 'hex').toString('utf8'))
}

/** One listener that serves browser HTTP requests and `/ws` project sockets. */
export class DreamverseBrowserServer {
  private readonly server: Server
  private readonly projectSockets = new WebSocketServer({ noServer: true })
  /** Running project connections; closing the listener waits for their cleanup. */
  private readonly connections = new Set<Promise<void>>()
  /** The HTTP routes in the reference registration order. */
  private readonly routes: Route[]

  /**
   * @param services - the generation, asset, project, and logger services.
   */
  constructor(private readonly services: BrowserServerServices) {
    this.routes = this.createRoutes()
    this.server = createServer((request, response) => { this.serveHttp(request, response) })
    this.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (requestPath(request) !== '/ws') {
        socket.destroy()
        return
      }
      this.projectSockets.handleUpgrade(request, socket, head, (projectSocket) => { this.serveProject(projectSocket) })
    })
  }

  /**
   * Start listening.
   * @param host - the listen address.
   * @param port - the listen port.
   * @returns a promise that settles once the listener accepts connections and rejects on a listen error.
   */
  listen(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => {
        this.server.off('error', reject)
        this.server.on('error', (error) => { this.services.logger.error(error) })
        resolve()
      })
    })
  }

  /**
   * Stop listening, terminate open HTTP connections and project sockets, and wait for every project connection
   * to finish its cleanup.
   */
  async close(): Promise<void> {
    const listenerClosed = new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
    this.server.closeAllConnections()
    for (const projectSocket of this.projectSockets.clients) projectSocket.terminate()
    await Promise.all([listenerClosed, ...this.connections])
  }

  /** The reference routes: health, creation capabilities, and assets. */
  private createRoutes(): Route[] {
    const { generation, assets, logger } = this.services
    return [
      { method: 'GET', path: /^\/health$/, handle: (_request, response) => { getHealthz(response) } },
      { method: 'GET', path: /^\/healthz$/, handle: (_request, response) => { getHealthz(response) } },
      { method: 'GET', path: /^\/readyz$/, handle: (_request, response) => getReadyz(response, generation, logger) },
      { method: 'GET', path: /^\/creation-capabilities$/, handle: (_request, response) => getCreationCapabilities(response, generation, assets, logger) },
      { method: 'GET', path: /^\/assets$/, handle: (_request, response) => { listAssets(response, assets) } },
      { method: 'POST', path: /^\/assets$/, handle: (request, response) => uploadAsset(request, response, assets) },
      {
        method: 'GET',
        path: /^\/assets\/([^/]+)\/content$/,
        handle: (request, response, [assetId = '']) => readAssetContent(request, response, assets, assetId, logger),
      },
      { method: 'DELETE', path: /^\/assets\/([^/]+)$/, handle: (_request, response, [assetId = '']) => { deleteAsset(response, assets, assetId) } },
    ]
  }

  private serveProject(projectSocket: WebSocket): void {
    const connection = new ProjectConnection(new BrowserProjectSocket(projectSocket), this.services)
    const running = connection.run().catch((error: unknown) => { this.services.logger.warn(error) })
    this.connections.add(running)
    void running.finally(() => { this.connections.delete(running) })
  }

  /**
   * Route one HTTP request like Starlette's router: the first route matching the path and method handles it; a path
   * match with another method answers 405 with the first such route's method, and no match answers 404. A failed
   * route answers Starlette's plain 500 before the response starts and destroys the response afterwards.
   */
  private serveHttp(request: IncomingMessage, response: ServerResponse): void {
    const path = requestPath(request)
    let pathMatch: Route | undefined
    for (const route of this.routes) {
      const match = route.path.exec(path)
      if (!match) continue
      if (route.method !== request.method) {
        pathMatch ??= route
        continue
      }
      Promise.resolve()
        .then(() => route.handle(request, response, match.slice(1)))
        .catch((error: unknown) => {
          this.services.logger.error(error)
          if (response.headersSent) response.destroy()
          else sendInternalServerError(response)
        })
      return
    }
    if (pathMatch) sendJson(response, 405, { detail: 'Method Not Allowed' }, { allow: pathMatch.method })
    else sendJson(response, 404, { detail: 'Not Found' })
  }
}
