/**
 * The operation log as a server-sent event stream: one `op` event per append or patch, one `head` event per head move,
 * and a comment line every keep-alive interval so proxies keep the response open.
 *
 * @module @video-harness/views/events
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OpLogEvent, ProjectId } from '@video-harness/oplog'

/** What the stream needs from its owner. */
export interface EventStreamSources {
  subscribe(projectId: ProjectId, listener: (event: OpLogEvent) => void): () => void
  /** Milliseconds between keep-alive comments. */
  keepaliveMs: number
}

/**
 * Serialize one log event as an SSE frame.
 * @param event - the log event.
 * @returns the frame text.
 */
export function frameOf(event: OpLogEvent): string {
  const name = event.kind === 'head' ? 'head' : 'op'
  return `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * Serve one project's log changes until the client disconnects.
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
