/**
 * Cordis plugin that serves the shared project layer's `/projects` routes on the DSH web server for its lifetime:
 * `GET /projects?kind=<kind>`, `GET /projects/<project_id>`, and `DELETE /projects/<project_id>`.
 *
 * @module @dreamverse/project-store/routes
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { serveRoutes } from '@dreamverse/http-routes'
import type {} from './index.ts'
import { projectRoutes } from './http.ts'

export const name = 'dreamverse-project-store-routes'
export const inject = ['webServer', 'dreamverseProjectStore', 'dreamverseAssetsManager']

/**
 * Register the `/projects` prefix route until the plugin unloads.
 * @param ctx - plugin context with the web server, the project store, and the file store.
 */
export function apply(ctx: Context): void {
  const logger = ctx.logger('dreamverse')
  const routes = projectRoutes(ctx.dreamverseProjectStore, ctx.dreamverseAssetsManager)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/projects',
    handler: (request, response) => { serveRoutes(routes, request, response, logger) },
  }), 'dreamverse /projects routes')
}
