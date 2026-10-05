/**
 * The DreamVerse page's lobby routes on the video-harness runtime. The page probes `GET /healthz` and `GET /readyz`
 * before it starts a project and reads `GET /creation-capabilities` to build its creation form; the old
 * `@dreamverse/project-controller` served those beside the `/ws` protocol. This plugin serves them from the shared
 * generation client alone, so the page's lobby works while its project work goes through `/api/vh/*` and the agent
 * session.
 *
 * @module @video-harness/dreamverse-bridge
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@dreamverse/assets-manager'
import type {} from '@dreamverse/generation-client'
import { lobbyCapabilitiesAsDict } from '@dreamverse/segment-generation'

export const name = 'vh-dreamverse-bridge'
export const inject = ['webServer', 'dreamverseGeneration']

/** The upload policy the page reads when no asset manager is mounted: images only, up to 20 MB. */
const DEFAULT_UPLOAD_POLICY: Record<string, unknown> = {
  image: { mime_types: ['image/png', 'image/jpeg', 'image/webp'], max_bytes: 20 * 1024 * 1024 },
  video: { mime_types: [], max_bytes: 0 },
  audio: { mime_types: [], max_bytes: 0 },
}

/**
 * Write one JSON response.
 * @param response - the HTTP response.
 * @param status - the status code.
 * @param body - the JSON body.
 */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

/**
 * Register the three lobby routes for the plugin's lifetime.
 * @param ctx - plugin context with a web server and the generation client.
 */
export function apply(ctx: Context): void {
  const routes: Record<string, (request: IncomingMessage, response: ServerResponse) => Promise<void>> = {
    '/healthz': (_request, response) => { sendJson(response, 200, { status: 'ok', service: 'video-harness' }); return Promise.resolve() },
    '/health': (_request, response) => { sendJson(response, 200, { status: 'ok', service: 'video-harness' }); return Promise.resolve() },
    '/readyz': async (_request, response) => {
      try {
        const readiness = await ctx.dreamverseGeneration.ready()
        sendJson(response, readiness.ready ? 200 : 503, { status: readiness.ready ? 'ready' : 'not_ready', service: 'video-harness', detail: readiness.detail, ts: new Date().toISOString() })
      } catch (error) {
        sendJson(response, 503, { status: 'not_ready', service: 'video-harness', detail: error instanceof Error ? error.message : String(error) })
      }
    },
    '/creation-capabilities': async (_request, response) => {
      try {
        const model = await ctx.dreamverseGeneration.model()
        const uploadPolicy = ctx.get('dreamverseAssetsManager')?.uploadPolicy() ?? DEFAULT_UPLOAD_POLICY
        sendJson(response, 200, lobbyCapabilitiesAsDict(model, uploadPolicy))
      } catch (error) {
        sendJson(response, 503, { detail: error instanceof Error ? error.message : String(error) })
      }
    },
  }
  for (const [path, handler] of Object.entries(routes)) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler: (request, response) => { void handler(request, response) } }), `vh-dreamverse-bridge ${path}`)
  }
}
