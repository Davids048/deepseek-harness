/**
 * DreamVerse UI kit, node half: serves the page's static images at the paths the FastVideo DreamVerse frontend uses
 * (`/logo.svg`, `/k2.png`, `/icon-simple.svg`). The browser half ships through `exports["./client"]`.
 *
 * @module @dreamverse/ui-kit
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** The static images and their content types, served from this package's `public/` directory. */
const PUBLIC_FILES: Readonly<Record<string, string>> = {
  'icon-simple.svg': 'image/svg+xml',
  'k2.png': 'image/png',
  'logo.svg': 'image/svg+xml',
}

const PUBLIC_DIRECTORY = join(import.meta.dirname, '..', 'public')

/**
 * Register one exact route per static image while a web server is available.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['webServer'], (webCtx) => {
    for (const [name, contentType] of Object.entries(PUBLIC_FILES)) {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: `/${name}`,
        handler: async (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET, HEAD' })
            response.end()
            return
          }
          const body = await readFile(join(PUBLIC_DIRECTORY, name))
          response.writeHead(200, { 'content-type': contentType, 'content-length': body.length })
          response.end(request.method === 'HEAD' ? undefined : body)
        },
      }), `dreamverse ui-kit: /${name}`)
    }
  })
}
