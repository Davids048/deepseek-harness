/**
 * HTTP helpers shared by the browser server routes: FastAPI validation issues and Starlette-compatible responses.
 *
 * @module @dreamverse/browser-server/http
 */
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http'

/** One FastAPI `RequestValidationError` entry. */
export interface ValidationIssue {
  type: string
  loc: Array<string | number>
  msg: string
  input: unknown
  ctx?: { error: unknown }
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
