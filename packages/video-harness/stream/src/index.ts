/**
 * Live media of the video harness as the `vhStream` Cordis service: `generate.video` hands each shot's fMP4 chunks to
 * the service while the backend is still producing them, and every browser subscribed to the project over the
 * `/vh/ws` route receives them in the framing the DreamVerse page already plays (`media_init`, binary chunks,
 * `media_segment_complete`). The same socket forwards operation-log changes (`op`, `head`), so a page follows media and
 * state on one connection.
 *
 * @module @video-harness/stream
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type { ProjectEvent, ProjectId, RecordId } from '@dv/project'
import type {} from '@dv/project'
import { SegmentBroadcaster, type SegmentInit, type SegmentStream, type StreamFrame } from './broadcast.ts'
import { acceptWebSocket, refuseUpgrade, type ServerSocket } from './socket.ts'

export { SegmentBroadcaster, type SegmentInit, type SegmentStream, type StreamFrame } from './broadcast.ts'
export { acceptWebSocket, decodeFrame, encodeFrame, refuseUpgrade, ServerSocket } from './socket.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Live fMP4 broadcast of generating shots and the `/vh/ws` route. */
    vhStream: VhStream
  }
}

/** `vhStream` plugin configuration. */
export interface Config {
  /** The most bytes one in-flight segment keeps for browsers that subscribe mid-shot. */
  bufferBytes: number
  /** Interval of the server pings that keep idle proxies from closing the socket. */
  pingMs: number
}

/** Loader validation. */
export const Config: z<Config> = z.object({
  bufferBytes: z.number().default(64 * 1024 * 1024),
  pingMs: z.number().default(20_000),
})

/** The first message a page sends on `/vh/ws`. */
interface SubscribeCommand {
  type: 'subscribe'
  project_id: string
}

/** Whether a decoded message is the subscribe command. */
function isSubscribe(value: unknown): value is SubscribeCommand {
  return typeof value === 'object' && value !== null && (value as SubscribeCommand).type === 'subscribe' && typeof (value as SubscribeCommand).project_id === 'string'
}

/** Broadcaster plus the `/vh/ws` route; the route is registered while a web server exists. */
export default class VhStream extends Service {
  static Config = Config

  private readonly broadcaster: SegmentBroadcaster
  private readonly sockets = new Set<ServerSocket>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'vhStream')
    this.broadcaster = new SegmentBroadcaster(config.bufferBytes)
    ctx.inject(['webServer'], (web) => {
      web.effect(() => web.webServer.registerUpgrade({
        path: '/vh/ws',
        handler: (request, socket, head) => { this.acceptUpgrade(web, request, socket, head) },
      }), 'video-harness /vh/ws route')
      web.effect(() => () => { for (const open of this.sockets) open.close(1001) }, 'video-harness /vh/ws sockets')
    })
  }

  /**
   * Start broadcasting one shot; see {@link SegmentBroadcaster.openSegment}.
   * @param projectId - the project.
   * @param record - the generating record, which becomes the browser's `stream_id`.
   * @param init - MIME type and slot.
   * @returns the writer's end.
   */
  openSegment(projectId: ProjectId, record: RecordId, init: SegmentInit): SegmentStream {
    return this.broadcaster.openSegment(projectId, record, init)
  }

  /**
   * Receive a project's frames in-process, the way a socket does.
   * @param projectId - the project.
   * @param listener - called per frame.
   * @returns a function that stops the subscription.
   */
  subscribe(projectId: ProjectId, listener: (frame: StreamFrame) => void): () => void {
    return this.broadcaster.subscribe(projectId, listener)
  }

  /** @returns how many browser sockets are open. */
  get openSockets(): number {
    return this.sockets.size
  }

  /**
   * Admit the upgrade when the Connection service accepts the request (or no Connection exists), complete the
   * handshake, and serve the socket until it closes.
   */
  private acceptUpgrade(web: Context, request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const rejection = web.get('connection')?.requestRejection({ headers: request.headers })
    if (rejection !== undefined) {
      refuseUpgrade(socket, rejection)
      return
    }
    let unsubscribe: (() => void)[] = []
    let server: ServerSocket | null = null
    const handlers = {
      onText: (text: string) => {
        if (server === null) return
        let command: unknown
        try {
          command = JSON.parse(text)
        } catch {
          server.sendText(JSON.stringify({ type: 'error', message: 'Messages must be JSON.' }))
          return
        }
        if (!isSubscribe(command)) {
          server.sendText(JSON.stringify({ type: 'error', message: "The first message must be {type:'subscribe', project_id}." }))
          return
        }
        for (const stop of unsubscribe) stop()
        unsubscribe = this.serveProject(server, brandString<ProjectId>(command.project_id))
      },
      onClose: () => {
        for (const stop of unsubscribe) stop()
        unsubscribe = []
        if (server !== null) this.sockets.delete(server)
        clearInterval(pings)
      },
    }
    server = acceptWebSocket(request, socket, head, handlers)
    if (server === null) return
    this.sockets.add(server)
    const pings = setInterval(() => server?.ping(), this.config.pingMs)
    pings.unref()
  }

  /**
   * Subscribe one socket to a project's media frames and operation-log changes, after acknowledging with the
   * segments still in flight.
   * @returns the functions that end both subscriptions.
   */
  private serveProject(server: ServerSocket, projectId: ProjectId): (() => void)[] {
    server.sendText(JSON.stringify({ type: 'subscribed', project_id: projectId, in_flight: this.broadcaster.inFlight(projectId) }))
    const stops = [this.broadcaster.subscribe(projectId, (frame) => {
      if (frame.kind === 'binary') server.sendBinary(frame.data)
      else server.sendText(JSON.stringify(frame.data))
    })]
    const project = this.ctx.get('dvProject')
    if (project !== undefined) {
      try {
        stops.push(project.subscribe(projectId, (event: ProjectEvent) => {
          // A removed draft branch has no head, so its `head` message carries `to: null`.
          const message = event.kind === 'branch'
            ? { type: 'head', branch: event.name, to: event.branch?.head ?? null }
            : { type: 'op', change: event.kind === 'record' ? 'append' : 'patch', op: event.record }
          server.sendText(JSON.stringify(message))
        }))
      } catch (error) {
        server.sendText(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) }))
      }
    }
    return stops
  }
}
