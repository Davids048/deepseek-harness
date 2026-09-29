/**
 * HTTP helpers shared by the browser server routes: request body reading, FastAPI JSON body decoding and validation
 * issues, and Starlette-compatible responses.
 *
 * @module @dreamverse/browser-server/http
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'

/** One FastAPI `RequestValidationError` entry. */
export interface ValidationIssue {
  type: string
  loc: Array<string | number>
  msg: string
  input: unknown
  ctx?: { error: unknown }
}

/** Read a complete request body. */
async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/**
 * Read the request body as FastAPI does for a JSON body parameter: parse JSON when the content type is absent or
 * `application/json` / `application/*+json`, otherwise keep the text.
 * @param request - the incoming request.
 * @returns the body value, `undefined` for an empty body, or the JSON decode failure issue.
 */
export async function decodeJsonBody(request: IncomingMessage): Promise<{ value: unknown } | { issue: ValidationIssue }> {
  const body = await readRequestBody(request)
  const contentType = request.headers['content-type']
  if (body.length === 0) return { value: undefined }
  const mediaType = ((contentType ?? '').split(';')[0] ?? '').trim().toLowerCase()
  if (contentType && mediaType !== 'application/json' && !/^application\/.+\+json$/.test(mediaType)) {
    return { value: body.toString('utf8') }
  }
  try {
    return { value: JSON.parse(body.toString('utf8')) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const position = Number(/at position (\d+)/.exec(message)?.[1] ?? 0)
    return { issue: { type: 'json_invalid', loc: ['body', position], msg: 'JSON decode error', input: {}, ctx: { error: message } } }
  }
}

/**
 * Accept a decoded body for a required pydantic model body parameter.
 * @param value - the decoded body.
 * @returns the JSON object, or the pydantic issue for an absent body or a value other than an object.
 */
export function bodyObject(value: unknown): { body: Record<string, unknown> } | { issue: ValidationIssue } {
  if (value === undefined || value === null) return { issue: { type: 'missing', loc: ['body'], msg: 'Field required', input: null } }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { issue: { type: 'model_attributes_type', loc: ['body'], msg: 'Input should be a valid dictionary or object to extract fields from', input: value } }
  }
  return { body: value as Record<string, unknown> }
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
