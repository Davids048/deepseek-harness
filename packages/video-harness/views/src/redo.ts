/**
 * Redo for the cuts editor. Undo (`POST /api/vh/undo`) moves `main` back one turn and leaves the turn's records in the
 * log, so redo is a fast-forward of `main` to the head it had before the undo. The browser remembers that head.
 *
 * Route: `POST /api/vh/redo` with `{project, to}` moves `main` to the record `to` when the current `main` head is an
 * ancestor of `to`, and returns the heads afterwards. Any other `to` is refused with 409, so redo can never drop a
 * record that `main` holds.
 *
 * @module @video-harness/views/redo
 */
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type VhOpLog from '@video-harness/oplog'
import { MAIN_BRANCH } from '@video-harness/oplog'
import type { OpId } from '@video-harness/oplog'
import { projectIdOf } from './wire.ts'

/** The Fetch route path. */
export const REDO_ROUTE = '/api/vh/redo'

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
 * The redo Fetch route.
 * @param log - the operation log.
 * @returns the route.
 */
export function redoRoutes(log: Pick<VhOpLog, 'project' | 'heads' | 'ancestors' | 'moveHead'>): ConnectionFetchRoute[] {
  const handle = async (request: Request): Promise<Response> => {
    const body: unknown = await request.json().catch(() => ({}))
    const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    const projectId = projectIdOf(record['project'])
    const to = record['to']
    if (projectId === null || typeof to !== 'string' || to === '') return json({ error: "'project' and 'to' are required." }, 400)
    try {
      log.project(projectId)
    } catch {
      // The log throws for an unknown project; the route reports it as 404.
      return json({ error: `Unknown project '${projectId}'.` }, 404)
    }
    try {
      const mainHead = log.heads(projectId)[MAIN_BRANCH]
      const chain = log.ancestors(projectId, to as OpId)
      if (mainHead === undefined || to === mainHead || !chain.some(op => op.id === mainHead)) {
        return json({ error: 'Nothing to redo: main has changed since the undo.' }, 409)
      }
      log.moveHead(projectId, MAIN_BRANCH, to as OpId)
      return json({ heads: log.heads(projectId) })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 409)
    }
  }
  return [{ path: REDO_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: handle }]
}
