/**
 * Client side of the generation backend's `WS /v1/generation` protocol. Each segment request opens its own socket,
 * sends one `generate_segment` message, and reads the backend's outputs until a terminal message.
 *
 * @module @dreamverse/generation-client/generation-socket
 */
import WebSocket, { type RawData } from 'ws'
import { GenerationSegmentError } from './errors.ts'
import type { SegmentOutput, SegmentRequest } from './types.ts'

/** Server-to-client JSON messages of one segment request. */
type GenerationMessage =
  | { type: 'media_metadata'; stream_id: string; mime: string }
  | { type: 'media_end'; stream_id: string; chunks: number }
  | { type: 'segment_finished'; timings: Record<string, number>; continuation_handle: string }
  | { type: 'segment_error'; error_type: string; is_value_error: boolean; message: string }
  | { type: 'segment_ended' }

/** A text frame holds one JSON message; a binary frame holds one encoded media chunk. */
type GenerationFrame = { binary: false; text: string } | { binary: true; bytes: Buffer }

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
}

/**
 * One generation socket with its received frames buffered in arrival order for a single reader. Frames that arrived
 * before the server closed the socket stay readable; after they are consumed, or after `cancel`, every read rejects
 * with the ending reason.
 */
class GenerationSocket {
  readonly socket: WebSocket
  /** Resolves when the socket opens; rejects with the ending reason when the socket ends first. */
  readonly opened: Promise<void>
  private readonly frames: GenerationFrame[] = []
  private reader: { resolve: (frame: GenerationFrame) => void; reject: (reason: unknown) => void } | undefined
  private ended: { reason: unknown } | undefined
  private failOpen!: (reason: unknown) => void

  /** Open the socket and start buffering its frames; a socket error or close ends every later read. */
  constructor(url: URL) {
    this.socket = new WebSocket(url)
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', () => { resolve() })
      this.failOpen = reject
    })
    this.socket.on('message', (data, isBinary) => {
      const bytes = toBuffer(data)
      this.push(isBinary ? { binary: true, bytes } : { binary: false, text: bytes.toString('utf8') })
    })
    this.socket.on('error', (error) => { this.end(error) })
    this.socket.on('close', (code, reason) => {
      const detail = reason.length > 0 ? `: ${reason.toString('utf8')}` : ''
      this.end(new Error(`DreamVerse generation socket closed (code ${code}${detail}).`))
    })
  }

  /**
   * Read the next message; binary frames come back as their bytes.
   * @returns the parsed JSON message or the chunk bytes.
   */
  async next(): Promise<GenerationMessage | Buffer> {
    const frame = this.frames.shift() ?? await this.waitForFrame()
    return frame.binary ? frame.bytes : JSON.parse(frame.text) as GenerationMessage
  }

  /**
   * Send one JSON message.
   * @param message - the client-to-server message.
   * @returns a promise that settles when `ws` has written the frame.
   */
  send(message: object): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(message), (error) => { if (error) reject(error); else resolve() })
    })
  }

  /**
   * Drop buffered frames, fail the waiting read with `reason`, and close the socket.
   * @param reason - the rejection that every later read receives.
   */
  cancel(reason: unknown): void {
    this.frames.length = 0
    this.end(reason)
    this.socket.close(1000)
  }

  private waitForFrame(): Promise<GenerationFrame> {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- An abort rejects with its `signal.reason`.
    if (this.ended) return Promise.reject(this.ended.reason)
    return new Promise((resolve, reject) => { this.reader = { resolve, reject } })
  }

  private push(frame: GenerationFrame): void {
    if (this.ended) return
    const reader = this.reader
    this.reader = undefined
    if (reader) reader.resolve(frame)
    else this.frames.push(frame)
  }

  private end(reason: unknown): void {
    if (this.ended) return
    this.ended = { reason }
    this.failOpen(reason)
    const reader = this.reader
    this.reader = undefined
    reader?.reject(reason)
  }
}

/**
 * Send one `generate_segment` request on its own socket and yield the backend's outputs in arrival order.
 *
 * The iteration ends after `segment_finished` or `segment_ended` and rejects with `GenerationSegmentError` after
 * `segment_error`. Leaving the iteration closes the socket. Aborting `request.signal` closes the socket at once and
 * rejects with `signal.reason`; the backend finishes the abandoned segment on its side.
 * @param url - the `ws:` or `wss:` URL of `/v1/generation`.
 * @param request - the segment inputs and an optional abort signal.
 * @returns the backend outputs in arrival order.
 */
export async function* generateSegment(url: URL, request: SegmentRequest): AsyncGenerator<SegmentOutput> {
  const { signal } = request
  signal?.throwIfAborted()
  const connection = new GenerationSocket(url)
  const onAbort = (): void => { connection.cancel(signal?.reason) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await connection.opened
    await connection.send({
      type: 'generate_segment',
      prompt: request.prompt,
      frame_width: request.frameWidth,
      frame_height: request.frameHeight,
      num_frames: request.numFrames,
      segment_idx: request.segmentIdx,
      continue_from: request.continueFrom,
      reference_images: request.referenceImages.map(image => ({ name: image.name, data: image.data.toString('base64') })),
    })
    for (;;) {
      const message = await connection.next()
      if (Buffer.isBuffer(message)) {
        yield { kind: 'chunk', bytes: message }
        continue
      }
      switch (message.type) {
        case 'media_metadata':
          yield { kind: 'media_metadata', streamId: message.stream_id, mime: message.mime }
          break
        case 'media_end':
          yield { kind: 'media_end', streamId: message.stream_id, chunks: message.chunks }
          break
        case 'segment_finished':
          yield { kind: 'segment_finished', timings: message.timings, continuationHandle: message.continuation_handle }
          return
        case 'segment_error':
          throw new GenerationSegmentError(message.message, message.error_type, message.is_value_error)
        case 'segment_ended':
          return
        default: {
          const unexpected: never = message
          throw new Error(`Unexpected DreamVerse generation message: ${JSON.stringify(unexpected)}`)
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    connection.socket.close(1000)
  }
}
