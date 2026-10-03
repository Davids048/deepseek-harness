/**
 * `@dreamverse/project-controller`: the project surface that the DreamVerse browser UI talks to. It registers `/ws`
 * project sockets and the health, readiness, and creation capability routes on the DSH web server (`webServer`).
 * `@dreamverse/project-store/routes` serves the stored projects.
 * Unloading the plugin removes the routes, terminates every project socket, and waits for the project connections to
 * finish their cleanup.
 *
 * @module @dreamverse/project-controller
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@dreamverse/assets-manager'
import type {} from '@dreamverse/generation-client'
import type {} from '@dreamverse/project'
import { DreamverseProjectController } from './project-controller.ts'

export type * from './dependencies.ts'

export const name = 'dreamverse-project-controller'

export const inject = ['webServer', 'dreamverseGeneration', 'dreamverseAssetsManager', 'dreamverseProjects']

/**
 * Register the project socket and HTTP routes on the web server until the plugin unloads.
 * @param ctx - plugin context with the web server and the injected DreamVerse services.
 */
export function apply(ctx: Context): void {
  const controller = new DreamverseProjectController({
    generation: ctx.dreamverseGeneration,
    assets: ctx.dreamverseAssetsManager,
    projects: ctx.dreamverseProjects,
    logger: ctx.logger('dreamverse'),
  })
  ctx.effect(() => () => controller.close(), 'dreamverse project connections')
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/ws',
    handler: (request, socket, head) => { controller.acceptUpgrade(request, socket, head) },
  }), 'dreamverse /ws')
  for (const path of controller.routePaths) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: (request, response) => { controller.serveHttp(request, response) },
    }), `dreamverse ${path}`)
  }
}
