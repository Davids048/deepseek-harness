/**
 * Browser API of DreamVerse. While a Connection service is mounted, the plugin registers authenticated Fetch routes
 * under `/api/dv/*`; while a web server is mounted, it serves a project's changes as server-sent events at
 * `/dv/events`, admitting a request only when Connection accepts its cookie. The canvas, the timeline and the asset
 * pool panel read the project state through these routes and write records through `dvProject.run`, the same entry point
 * the agent's tools use.
 *
 * @module @dv/api
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ProjectId } from '@dv/project'
import type {} from '@dv/asset-pool'
import { answer, ApiHandlers, ApiRequestError, type ApiServices, requireProject } from './api.ts'
import { assetImportRoutes } from './asset-import.ts'
import { serveEventStream } from './events.ts'
import { CanvasLayoutStore, layoutRoutes } from './layout.ts'
import { projectAdminRoutes } from './projects-admin.ts'
import { workspaceRoutes } from './workspaces.ts'

export { answer, ApiHandlers, ApiRequestError, messageOf, type ApiServices, type OperationRequest, type WireProject } from './api.ts'
export { ASSET_IMPORT_ROUTE } from './asset-import.ts'
export { frameOf, serveEventStream, type EventStreamSources } from './events.ts'
export { LAYOUT_ROUTE, type CanvasLayout, type CanvasViewport, type NodePosition } from './layout.ts'
export { PROJECT_ADMIN_ROUTES } from './projects-admin.ts'
export type { WireProjectCover, WireProjectSummary } from './summaries.ts'
export { WORKSPACE_ROUTES } from './workspaces.ts'
export {
  mentionedAssets, projectIdOf, toWireOperation, toWireState, type ProjectAsset, type WireHistory, type WireOperation, type WireState,
} from './wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The browser API: project state, operation declarations, human operation calls, undo and redo, and the history. */
    dvApi: DvApi
  }
}

/** Configuration of the API plugin. */
export interface Config {
  /** Milliseconds between keep-alive comments on the event stream. */
  keepaliveMs: number
  /**
   * The state directory: canvas layouts under `canvas-layout/`, the project → Workspace links in `workspaces.json`,
   * the entry Workspace under `entry/`, and the session binding files of `@dv/project` under `sessions/`.
   */
  stateRoot: string
}

/** Runtime schema of {@link Config}. */
export const Config: z<Config> = z.object({
  keepaliveMs: z.number().default(15_000),
  stateRoot: z.string().required(),
})

/** The path below the web root where the event stream is served. */
export const EVENTS_PATH = '/dv/events'

/** The Fetch route paths, below the Connection's `/api` channel. */
export const ROUTES = {
  projects: '/api/dv/projects',
  projectSummaries: '/api/dv/projects/summary',
  state: '/api/dv/state',
  operations: '/api/dv/operations',
  operation: '/api/dv/operation',
  undo: '/api/dv/undo',
  redo: '/api/dv/redo',
  acceptStale: '/api/dv/stale/accept',
  history: '/api/dv/history',
} as const

/**
 * The JSON body of a request, or an empty object when the body is absent or not JSON.
 * @param request - the request.
 * @returns the parsed body.
 */
async function bodyOf(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    // A missing or malformed body is reported by the operation as a missing field, not as a transport failure.
    return {}
  }
}

/** The API service. */
export default class DvApi extends Service {
  static inject = ['dvProject', 'dvAssetPool']
  static Config = Config

  /** The transport-independent route handlers. */
  readonly api: ApiHandlers

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'dvApi')
    const services: ApiServices = { project: ctx.dvProject, assets: ctx.dvAssetPool }
    this.api = new ApiHandlers(services)
    ctx.inject(['connection'], (connected) => {
      for (const route of this.fetchRoutes()) {
        connected.effect(() => {
          const dispose = connected.connection.fetch.register(route)
          return () => { void dispose() }
        }, `dvApi ${route.path}`)
      }
    })
    ctx.inject(['webServer'], (web) => {
      web.effect(() => web.webServer.register({
        kind: 'prefix', path: EVENTS_PATH, handler: (request, response) => { this.serveEvents(web, request, response) },
      }), `dvApi ${EVENTS_PATH}`)
    })
  }

  /** @returns the Fetch routes in path order. */
  fetchRoutes(): ConnectionFetchRoute[] {
    const api = this.api
    const query = (request: Request, name: string): string | null => new URL(request.url).searchParams.get(name)
    const withBody = (run: (body: unknown) => unknown) => async (request: Request): Promise<Response> => {
      const body = await bodyOf(request)
      return answer(() => run(body))
    }
    // The layout route writes the layout files and project deletion deletes them.
    const layouts = new CanvasLayoutStore(join(this.config.stateRoot, 'canvas-layout'))
    return [
      {
        path: ROUTES.projects, methods: ['GET', 'POST'], requestBody: 'buffered',
        fetch: request => request.method === 'GET'
          ? answer(() => api.listProjects(query(request, 'session')))
          : withBody(body => api.createProject(body))(request),
      },
      {
        path: ROUTES.projectSummaries, methods: ['GET'], requestBody: 'buffered',
        fetch: request => answer(() => api.listProjectSummaries(query(request, 'project'), query(request, 'timeline'))),
      },
      {
        path: ROUTES.state, methods: ['GET'], requestBody: 'buffered',
        fetch: request => answer(() => api.getState(query(request, 'project'))),
      },
      { path: ROUTES.operations, methods: ['GET'], requestBody: 'buffered', fetch: () => answer(() => api.listOperations()) },
      { path: ROUTES.operation, methods: ['POST'], requestBody: 'buffered', fetch: withBody(body => api.runOperation(body)) },
      { path: ROUTES.undo, methods: ['POST'], requestBody: 'buffered', fetch: withBody(body => api.undo(body)) },
      { path: ROUTES.redo, methods: ['POST'], requestBody: 'buffered', fetch: withBody(body => api.redo(body)) },
      { path: ROUTES.acceptStale, methods: ['POST'], requestBody: 'buffered', fetch: withBody(body => api.acceptStale(body)) },
      { path: ROUTES.history, methods: ['POST'], requestBody: 'buffered', fetch: withBody(body => api.listHistory(body)) },
      ...layoutRoutes(this.ctx.dvProject, layouts),
      ...workspaceRoutes(this.ctx.dvProject, this.config.stateRoot),
      ...projectAdminRoutes(this.ctx.dvProject, this.config.stateRoot, layouts),
      ...assetImportRoutes({ project: this.ctx.dvProject, assets: this.ctx.dvAssetPool }),
    ]
  }

  /**
   * Serve `/dv/events?project=<id>`: refuse requests the Connection rejects, answer the JSON error body of the Fetch
   * routes for a malformed project (400 `invalid_params`) or an unknown one (404 `unknown_project`), else stream the
   * project's changes.
   * @param web - the context that holds the web server, used to look the Connection up.
   * @param request - the HTTP request.
   * @param response - the HTTP response.
   */
  private serveEvents(web: Context, request: IncomingMessage, response: ServerResponse): void {
    const connection = web.get('connection')
    const rejection = connection?.requestRejection({ headers: request.headers })
    if (rejection !== undefined) {
      response.writeHead(rejection).end()
      return
    }
    const url = new URL(String(request.url), 'http://localhost')
    let projectId: ProjectId
    try {
      projectId = requireProject(this.ctx.dvProject, url.searchParams.get('project'))
    } catch (error) {
      if (!(error instanceof ApiRequestError)) throw error
      const body = JSON.stringify({ error: error.message, code: error.code })
      response.writeHead(error.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(body)
      return
    }
    serveEventStream(projectId, request, response, {
      subscribe: (id, listener) => this.ctx.dvProject.subscribe(id, listener),
      keepaliveMs: this.config.keepaliveMs,
    })
  }
}
