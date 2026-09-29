/** A text frame: its decoded JSON value, which the protocol layer checks. */
export interface DecodedJsonEvent {
  kind: 'json'
  data: unknown
}

/** A binary frame: one media chunk. */
export interface DecodedBinaryEvent {
  kind: 'binary'
  data: ArrayBuffer
}

/** A frame that carries neither text nor binary data. */
export interface DecodedIgnoreEvent {
  kind: 'ignore'
  data: null
}

/** One decoded project-socket frame. */
export type DecodedWebSocketEvent =
  | DecodedJsonEvent
  | DecodedBinaryEvent
  | DecodedIgnoreEvent

/**
 * Decode one project-socket frame: JSON text, or a binary chunk as an `ArrayBuffer`.
 * @param event - the socket's message event.
 * @returns the decoded frame.
 */
export async function decodeWebSocketEvent(
  event: MessageEvent,
): Promise<DecodedWebSocketEvent> {
  if (typeof event.data === 'string') {
    const data: unknown = JSON.parse(event.data)
    return { kind: 'json', data }
  }

  const chunk =
    event.data instanceof ArrayBuffer
      ? event.data
      : event.data instanceof Blob
        ? await event.data.arrayBuffer()
        : null

  if (!chunk) {
    return { kind: 'ignore', data: null }
  }

  return {
    kind: 'binary',
    data: chunk,
  }
}
