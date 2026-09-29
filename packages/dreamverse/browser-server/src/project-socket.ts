/**
 * The browser end of one `/ws` project connection: JSON and binary sends serialized through one lock, and received
 * messages read in arrival order like Starlette's `WebSocket.receive_json`.
 *
 * @module @dreamverse/browser-server/project-socket
 */
import WebSocket, { type RawData } from 'ws'
import type { ProjectSocket } from './dependencies.ts'

/** The browser closed the socket; the reference raises Starlette's `WebSocketDisconnect`. */
export class WebSocketDisconnect extends Error {
  override name = 'WebSocketDisconnect'

  /** @param code - the WebSocket close code. */
  constructor(readonly code: number) {
    super(`WebSocket disconnected with code ${code}.`)
  }
}

/** A received text frame, or the fact that a binary frame arrived. */
type BrowserFrame = { binary: false; text: string } | { binary: true }

function frameText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString('utf8')
}

/** A `ws` browser socket adapted to the reference `ProjectConnection` send lock and receive calls. */
export class BrowserProjectSocket implements ProjectSocket {
  private sendChain: Promise<void> = Promise.resolve()
  private readonly frames: BrowserFrame[] = []
  private reader: { resolve: (frame: BrowserFrame) => void; reject: (reason: unknown) => void } | undefined
  private disconnect: WebSocketDisconnect | undefined
  private closeRequested = false

  /** @param socket - an accepted browser WebSocket. */
  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data, isBinary) => {
      this.push(isBinary ? { binary: true } : { binary: false, text: frameText(data) })
    })
    socket.on('close', (code) => { this.end(new WebSocketDisconnect(code)) })
    // `ws` emits `close` after every socket error, so the close listener reports the disconnect.
    socket.on('error', () => {})
  }

  /**
   * Send one JSON event after every earlier send has finished.
   * @param event - the browser event.
   * @returns a promise that settles when the frame is written.
   */
  sendJson(event: object): Promise<void> {
    return this.enqueue(JSON.stringify(event), false)
  }

  /**
   * Send one binary media chunk after every earlier send has finished.
   * @param chunk - the encoded media bytes.
   * @returns a promise that settles when the frame is written.
   */
  sendBytes(chunk: Buffer): Promise<void> {
    return this.enqueue(chunk, true)
  }

  /**
   * Receive the next message as JSON, like Starlette's `receive_json(mode="text")`.
   * Messages received before a disconnect stay readable; after them, reads reject with `WebSocketDisconnect`.
   * @param signal - aborting rejects a waiting read with `signal.reason`.
   * @returns the parsed JSON value.
   */
  async receiveJson(signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const frame = this.frames.shift() ?? await this.waitForFrame(signal)
    // Starlette reads `message["text"]`; a binary frame has no text key, so Python raises KeyError('text').
    if (frame.binary) throw new Error('\'text\'')
    return JSON.parse(frame.text)
  }

  /**
   * Close the socket once with the given status and reason; later calls do nothing.
   * @param code - the WebSocket close code.
   * @param reason - the close reason.
   */
  close(code = 1000, reason = ''): void {
    if (this.closeRequested) return
    this.closeRequested = true
    this.socket.close(code, reason)
  }

  private enqueue(data: string | Buffer, binary: boolean): Promise<void> {
    const sent = this.sendChain.then(() => this.write(data, binary))
    // Each caller observes its own failure; later sends still wait for this one to settle.
    this.sendChain = sent.catch(() => {})
    return sent
  }

  private write(data: string | Buffer, binary: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(this.disconnect ?? new WebSocketDisconnect(1006))
        return
      }
      this.socket.send(data, { binary }, (error) => { if (error) reject(error); else resolve() })
    })
  }

  /** Wait for the next frame; an abort frees the reader slot, so a later read still receives that frame. */
  private waitForFrame(signal: AbortSignal): Promise<BrowserFrame> {
    if (this.disconnect) return Promise.reject(this.disconnect)
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.reader = undefined
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.reader = {
        resolve: (frame) => { signal.removeEventListener('abort', onAbort); resolve(frame) },
        reject: (reason) => { signal.removeEventListener('abort', onAbort); reject(reason) },
      }
    })
  }

  private push(frame: BrowserFrame): void {
    const reader = this.reader
    this.reader = undefined
    if (reader) reader.resolve(frame)
    else this.frames.push(frame)
  }

  private end(disconnect: WebSocketDisconnect): void {
    this.disconnect = disconnect
    const reader = this.reader
    this.reader = undefined
    reader?.reject(disconnect)
  }
}
