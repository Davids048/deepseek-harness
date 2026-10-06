/**
 * Browser API of the video harness. While a Connection service is mounted, the plugin registers authenticated Fetch
 * routes under `/api/vh/*`; while a web server is mounted, it serves a project's changes as server-sent events at
 * `/vh/events`, admitting a request only when Connection accepts its cookie. The canvas and the timeline read branch
 * state through these routes and write records through `dvProject.run`, the same entry point the agent's tools use.
 *
 * @module @video-harness/views
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ProjectId } from '@dv/project'
import type {} from '@dv/asset-pool'
import { ViewsApi, ViewsRequestError, type ViewsServices, messageOf } from './api.ts'
import { assetImportRoutes } from './asset-import.ts'
import { serveEventStream } from './events.ts'
import { layoutRoutes } from './layout.ts'
import { projectAdminRoutes } from './projects-admin.ts'
import { workspaceRoutes } from './workspaces.ts'
import { projectIdOf, type ViewSelection } from './wire.ts'

export { ViewsApi, ViewsRequestError, messageOf, type ViewInvokeBody, type ViewsServices } from './api.ts'
export { frameOf, serveEventStream, type EventStreamSources } from './events.ts'
export { mentionedAssets, projectIdOf, toWireState, toWireToolSpec, type ViewSelection, type WireState, type WireToolSpec } from './wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The browser API: branch state, tool declarations, human operation calls, drafts, and view selections. */
    vhViews: VhViews
  }
}

/** Configuration of the views plugin. */
export interface Config {
  /** Milliseconds between keep-alive comments on the event stream. */
  keepaliveMs: number
}

/** Runtime schema of {@link Config}. */
export const Config: z<Config> = z.object({
  keepaliveMs: z.number().default(15_000),
})

/** The path below the web root where the event stream is served. */
export const EVENTS_PATH = '/vh/events'

/** The Fetch route paths, below the Connection's `/api` channel. */
export const ROUTES = {
  projects: '/api/vh/projects',
  state: '/api/vh/state',
  tools: '/api/vh/tools',
  invoke: '/api/vh/invoke',
  acceptDraft: '/api/vh/drafts/accept',
  discardDraft: '/api/vh/drafts/discard',
  undo: '/api/vh/undo',
  redo: '/api/vh/redo',
  branch: '/api/vh/branch',
  switchBranch: '/api/vh/branch/switch',
  acceptStale: '/api/vh/stale/accept',
  selection: '/api/vh/selection',
} as const

/**
 * A JSON response with no caching.
 * @param value - the body.
 * @param status - the HTTP status.
 * @returns the response.
 */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

/**
 * Run a route body and translate request errors into their status.
 * @param run - the operation.
 * @returns the JSON response, or the error's status with its message.
 */
async function answer(run: () => unknown): Promise<Response> {
  try {
    return json(await run())
  } catch (error) {
    if (error instanceof ViewsRequestError) {
      return json({ ...error.details, error: error.message, ...error.code === null ? {} : { code: error.code } }, error.status)
    }
    return json({ error: messageOf(error) }, 500)
  }
}

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

/** The views service. */
export default class VhViews extends Service {
  static inject = ['dvProject', 'dvAssetPool']
  static Config = Config

  /** The transport-independent operations. */
  readonly api: ViewsApi

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'vhViews')
    const services: ViewsServices = { project: ctx.dvProject, assets: ctx.dvAssetPool }
    this.api = new ViewsApi(services)
    ctx.inject(['connection'], (connected) => {
      for (const route of this.fetchRoutes()) {
        connected.effect(() => {
          const dispose = connected.connection.fetch.register(route)
          return () => { void dispose() }
        }, `vhViews ${route.path}`)
      }
    })
    ctx.inject(['webServer'], (web) => {
      web.effect(() => web.webServer.register({
        kind: 'prefix', path: EVENTS_PATH, handler: (request, response) => { this.serveEvents(web, request, response) },
      }), `vhViews ${EVENTS_PATH}`)
    })
  }

  /**
   * @param projectId - a project.
   * @returns what a view last selected there, or null.
   */
  selection(projectId: ProjectId): ViewSelection | null {
    return this.api.selection(projectId)
  }

  /** @returns the Fetch routes in path order. */
  fetchRoutes(): ConnectionFetchRoute[] {
    const api = this.api
    const query = (request: Request, name: string): string | null => new URL(request.url).searchParams.get(name)
    const withBody = (run: (body: unknown) => unknown) => async (request: Request): Promise<Response> => {
      const body = await bodyOf(request)
      return answer(() => run(body))
    }
    return [
      {
        path: ROUTES.projects, methods: ['GET', 'POST'], requestBody: 'buffered',
        fetch: request => request.method === 'GET'
          ? answer(() => api.projects(query(request, 'session')))
          : withBody(body => api.create(body))(request),
      },
      { path: ROUTES.state, methods: ['GET'], requestBody: 'buffered', fetch: request => answer(() => api.state(query(request, 'project'), query(request, 'head') ?? undefined)) },
      { path: ROUTES.tools, methods: ['GET'], requestBody: 'buffered', fetch: () => answer(() => api.tools()) },
      { path: ROUTES.invoke, methods: ['POST'], requestBody: 'buffered', fetch: withBody(body => api.invoke(body)) },
      { path: ROUTES.acceptDraft, methods: ['POST'], requestBody: 'buffered', fetch: withBody(body => api.acceptDraft(body)) },
      { path: ROUTES.discardDraft, methods: ['POST'], requestBody: 'buffered', fetch: withBody(body => api.discardDraft(body)) },
      { path: ROUTES.undo, methods: ['POST'], requestBody: 'buffered', fetch: withBody(body => api.undo(body)) },
      { path: ROUTES.redo, methods: ['POST'], requestBody: 'buffered', fetch: withBody(body => api.redo(body)) },
      { path: ROUTES.branch, methods: ['POST'], requestBody: 'buffered', fetch: withBody(body => api.branch(body)) },
      { path: ROUTES.switchBranch, methods: ['POST'], requestBody: 'buffered', fetch: withBody(body => api.switchBranch(body)) },
      { path: ROUTES.acceptStale, methods: ['POST'], requestBody: 'buffered', fetch: withBody(body => api.acceptStale(body)) },
      {
        path: ROUTES.selection, methods: ['GET', 'POST'], requestBody: 'buffered',
        fetch: request => request.method === 'GET'
          ? answer(() => api.selection(query(request, 'project')))
          : withBody(body => api.select(body))(request),
      },
      ...layoutRoutes(this.ctx.dvProject),
      ...workspaceRoutes(this.ctx.dvProject),
      ...projectAdminRoutes(this.ctx.dvProject),
      ...assetImportRoutes({ project: this.ctx.dvProject, assets: this.ctx.dvAssetPool }),
    ]
  }

  /**
   * Serve `/vh/events?project=<id>`: refuse requests the Connection rejects, 400 without a project, 404 for an unknown
   * one, else stream the project's changes.
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
    const projectId = projectIdOf(url.searchParams.get('project'))
    if (projectId === null) {
      response.writeHead(400, { 'content-type': 'text/plain' }).end("'project' must name a project.")
      return
    }
    try {
      this.ctx.dvProject.openProject(projectId)
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end(`Unknown project '${projectId}'.`)
      return
    }
    serveEventStream(projectId, request, response, {
      subscribe: (id, listener) => this.ctx.dvProject.subscribe(id, listener),
      keepaliveMs: this.config.keepaliveMs,
    })
  }
}
