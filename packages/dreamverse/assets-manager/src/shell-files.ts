/**
 * The DSH page shell's own files under `/assets/`. The shell's `index.html` loads its scripts, styles, fonts, and
 * language packs from `./assets/`, which shares the `/assets` prefix with the DreamVerse asset routes, so the asset
 * routes hand those GET and HEAD requests to this responder.
 *
 * @module @dreamverse/assets-manager/shell-files
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { serveStatic } from '@deepseek-ai/dsh-host-frontend-static'

/**
 * Build a responder that serves files from the built DSH page shell, resolved the way `dsh-web-app` resolves it.
 * @returns the responder, or `undefined` when this composition lacks the shell package.
 */
export function shellFileResponder(): ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined {
  let distRoot: string
  try {
    distRoot = join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist')
  } catch {
    // A composition without the DSH web shell has no shell files; its asset routes keep FastAPI's 404 and 405.
    return undefined
  }
  const distIndex = join(distRoot, 'index.html')
  return async (request, response) => {
    await serveStatic(
      decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname),
      response,
      distRoot,
      distIndex,
      () => {
        // A path under /assets never names the shell index, which only frontend-static serves with authorization.
        response.writeHead(404)
        response.end()
        return false
      },
      () => Promise.reject(new Error('The shell index is served by frontend-static.')),
    )
  }
}
