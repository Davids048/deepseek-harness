/**
 * A project's changes as a server-sent event stream: one event per Project change, named by its kind (`record` for an
 * appended record, `update` for a record update), and a
 * comment line every keep-alive interval so proxies keep the response open.
 *
 * @module @dv/api/events
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProjectEvent, ProjectId } from '@dv/project'

/** What the stream needs from its owner. */
export interface EventStreamSources {
  subscribe(projectId: ProjectId, listener: (event: ProjectEvent) => void): () => void
  /** Milliseconds between keep-alive comments. */
  keepaliveMs: number
}

/**
 * Serialize one Project change as an SSE frame named by its kind.
 * @param event - the change.
 * @returns the frame text.
 */
export function frameOf(event: ProjectEvent): string {
  return `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * Serve one project's changes until the client disconnects.
 * @param projectId - the project.
 * @param request - the HTTP request; its close ends the subscription.
 * @param response - the HTTP response kept open for the stream.
 * @param sources - the subscription and the keep-alive interval.
 */
export function serveEventStream(
  projectId: ProjectId,
  request: IncomingMessage,
  response: ServerResponse,
  sources: EventStreamSources,
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  response.write(`: connected ${projectId}\n\n`)
  // A named event (comments are invisible to EventSource) lets the browser tell a live stream from a buffered one.
  response.write('event: ready\ndata: {}\n\n')
  const unsubscribe = sources.subscribe(projectId, (event) => { response.write(frameOf(event)) })
  const keepalive = setInterval(() => { response.write(': keepalive\n\n') }, sources.keepaliveMs)
  const end = (): void => {
    clearInterval(keepalive)
    unsubscribe()
    response.end()
  }
  request.on('close', end)
  response.on('close', end)
}
