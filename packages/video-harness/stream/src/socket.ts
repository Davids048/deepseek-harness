/**
 * A minimal RFC 6455 server socket for the `/vh/ws` route: the opening handshake over a Node upgrade request, text
 * and binary frames out, masked client frames in, ping/pong, and close. It covers exactly what a browser page needs
 * from this route, so the package needs no WebSocket library.
 *
 * @module @video-harness/stream/socket
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** The GUID every WebSocket handshake concatenates to the client key. */
const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Frame opcodes the socket handles. */
const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const

/** What the route learns from a socket. */
export interface ServerSocketHandlers {
  /** A complete text message from the browser. */
  onText(text: string): void
  /** The socket closed, from either side. */
  onClose(): void
}

/**
 * Build one frame with the given opcode and payload; server frames are never masked.
 * @param opcode - the frame opcode.
 * @param payload - the payload bytes.
 * @returns the encoded frame.
 */
export function encodeFrame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.byteLength
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/** One decoded client frame. */
interface ClientFrame {
  fin: boolean
  opcode: number
  payload: Buffer
  /** Bytes the frame occupied in the input. */
  size: number
}

/**
 * Decode one client frame from the start of `input`, unmasking its payload.
 * @param input - buffered bytes from the client.
 * @returns the frame, or null while the frame is incomplete.
 */
export function decodeFrame(input: Buffer): ClientFrame | null {
  if (input.length < 2) return null
  const first = input[0] ?? 0
  const second = input[1] ?? 0
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (input.length < 4) return null
    length = input.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (input.length < 10) return null
    length = Number(input.readBigUInt64BE(2))
    offset = 10
  }
  const maskLength = masked ? 4 : 0
  if (input.length < offset + maskLength + length) return null
  const mask = input.subarray(offset, offset + maskLength)
  const payload = Buffer.from(input.subarray(offset + maskLength, offset + maskLength + length))
  if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0)
  return { fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload, size: offset + maskLength + length }
}

/** The server end of one accepted browser socket. */
export class ServerSocket {
  private pending = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentOpcode: number = OPCODE.text
  private closed = false

  /**
   * @param socket - the raw connection after the handshake.
   * @param handlers - what to do with messages and the close.
   */
  constructor(private readonly socket: Duplex, private readonly handlers: ServerSocketHandlers) {
    socket.on('data', (data: Buffer) => { this.receive(data) })
    socket.on('close', () => { this.finish() })
    socket.on('error', () => { this.finish() })
  }

  /** @param text - a text message. */
  sendText(text: string): void {
    this.write(encodeFrame(OPCODE.text, Buffer.from(text, 'utf8')))
  }

  /** @param bytes - a binary message. */
  sendBinary(bytes: Uint8Array): void {
    this.write(encodeFrame(OPCODE.binary, bytes))
  }

  /** Send a ping so idle proxies keep the connection. */
  ping(): void {
    this.write(encodeFrame(OPCODE.ping, Buffer.alloc(0)))
  }

  /**
   * Close the connection with a status code.
   * @param code - the close code; 1000 is a normal close.
   */
  close(code = 1000): void {
    if (this.closed) return
    const payload = Buffer.alloc(2)
    payload.writeUInt16BE(code, 0)
    this.write(encodeFrame(OPCODE.close, payload))
    this.socket.end()
    this.finish()
  }

  private write(frame: Buffer): void {
    if (this.closed || this.socket.destroyed) return
    this.socket.write(frame)
  }

  /** Decode every complete frame in the buffered input; a close frame answers with a close and ends the socket. */
  private receive(data: Buffer): void {
    this.pending = Buffer.concat([this.pending, data])
    for (let frame = decodeFrame(this.pending); frame !== null; frame = decodeFrame(this.pending)) {
      this.pending = this.pending.subarray(frame.size)
      this.handle(frame)
    }
  }

  private handle(frame: ClientFrame): void {
    switch (frame.opcode) {
      case OPCODE.ping:
        this.write(encodeFrame(OPCODE.pong, frame.payload))
        return
      case OPCODE.pong:
        return
      case OPCODE.close:
        this.close()
        return
      case OPCODE.continuation:
        this.fragments.push(frame.payload)
        break
      default:
        this.fragmentOpcode = frame.opcode
        this.fragments = [frame.payload]
    }
    if (!frame.fin) return
    const message = Buffer.concat(this.fragments)
    this.fragments = []
    // Binary messages from the browser have no meaning on this route; only text carries commands.
    if (this.fragmentOpcode === OPCODE.text) this.handlers.onText(message.toString('utf8'))
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.handlers.onClose()
  }
}

/**
 * Complete the WebSocket handshake of an upgrade request, or refuse it.
 * @param request - the upgrade request.
 * @param socket - the raw connection.
 * @param head - bytes the client sent after the request head.
 * @param handlers - what to do with messages and the close.
 * @returns the server socket, or null when the request was not a WebSocket upgrade (the socket is then ended).
 */
export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  handlers: ServerSocketHandlers,
): ServerSocket | null {
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string' || String(request.headers['upgrade']).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    return null
  }
  const accept = createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  const server = new ServerSocket(socket, handlers)
  if (head.length > 0) socket.unshift(head)
  return server
}

/**
 * Refuse an upgrade with an HTTP status and close the connection.
 * @param socket - the raw connection.
 * @param status - 401 or 403.
 */
export function refuseUpgrade(socket: Duplex, status: number): void {
  const text = status === 401 ? 'Unauthorized' : 'Forbidden'
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}
