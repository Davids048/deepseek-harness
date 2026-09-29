/**
 * Starlette-compatible HTTP routing for the DreamVerse routes that plugins register on the DSH web server: FastAPI
 * validation issues and JSON responses, Starlette plain-text responses, the ASGI percent-decoded request path, and a
 * route table dispatched like Starlette's router.
 *
 * @module @dreamverse/http-routes
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Logger } from '@deepseek-ai/cordis'

/** One FastAPI `RequestValidationError` entry. */
export interface ValidationIssue {
  type: string
  loc: Array<string | number>
  msg: string
  input: unknown
  ctx?: { error: unknown }
}

/** One FastAPI route: one method and one path pattern whose groups are the decoded path parameters. */
export interface Route {
  method: string
  path: RegExp
  handle: (request: IncomingMessage, response: ServerResponse, pathParams: string[]) => void | Promise<void>
}

/**
 * Send a JSON response like FastAPI's `JSONResponse`.
 * @param response - the response to complete.
 * @param status - the HTTP status.
 * @param body - the JSON value.
 * @param headers - extra response headers.
 */
export function sendJson(response: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    ...headers,
    'content-length': Buffer.byteLength(text),
    'content-type': 'application/json',
  })
  response.end(text)
}

/**
 * Send a Starlette `PlainTextResponse`.
 * @param response - the response to complete.
 * @param status - the HTTP status.
 * @param text - the body text.
 * @param headers - extra response headers.
 */
export function sendPlainText(response: ServerResponse, status: number, text: string, headers: OutgoingHttpHeaders = {}): void {
  response.writeHead(status, {
    ...headers,
    'content-length': Buffer.byteLength(text),
    'content-type': 'text/plain; charset=utf-8',
  })
  response.end(text)
}

/**
 * Send Starlette's plain-text response for an unhandled route exception.
 * @param response - the response to complete.
 */
export function sendInternalServerError(response: ServerResponse): void {
  sendPlainText(response, 500, 'Internal Server Error')
}

/**
 * Read the request path without its query, percent-decoded as UTF-8 with replacement characters like the ASGI `path`
 * that Starlette's router matches.
 * @param request - the incoming request.
 * @returns the decoded path.
 */
export function requestPath(request: IncomingMessage): string {
  const rawPath = (request.url ?? '/').split('?')[0] ?? '/'
  return rawPath.replace(/(%[0-9a-f]{2})+/gi, escapes => Buffer.from(escapes.replaceAll('%', ''), 'hex').toString('utf8'))
}

/**
 * Route one HTTP request like Starlette's router: the first route matching the decoded path and method handles it; a
 * path match with another method answers 405 with the first such route's method, and no match answers 404. A failed
 * route answers Starlette's plain 500 before the response starts and destroys the response afterwards.
 * @param routes - the route table in registration order.
 * @param request - the incoming request.
 * @param response - the response to complete.
 * @param logger - receives route failures.
 */
export function serveRoutes(routes: readonly Route[], request: IncomingMessage, response: ServerResponse, logger: Logger): void {
  const path = requestPath(request)
  let pathMatch: Route | undefined
  for (const route of routes) {
    const match = route.path.exec(path)
    if (!match) continue
    if (route.method !== request.method) {
      pathMatch ??= route
      continue
    }
    Promise.resolve()
      .then(() => route.handle(request, response, match.slice(1)))
      .catch((error: unknown) => {
        logger.error(error)
        if (response.headersSent) response.destroy()
        else sendInternalServerError(response)
      })
    return
  }
  if (pathMatch) sendJson(response, 405, { detail: 'Method Not Allowed' }, { allow: pathMatch.method })
  else sendJson(response, 404, { detail: 'Not Found' })
}
