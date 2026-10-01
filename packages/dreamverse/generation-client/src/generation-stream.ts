/**
 * Client side of the generation backend's `POST /v1/streamv2/generate`. Each segment request is one HTTP request
 * whose response is a server-sent event stream: `last_frame`, `video_start`, `video_chunk` events, then `done`, or an
 * `error` event.
 *
 * @module @dreamverse/generation-client/generation-stream
 */
import { GenerationSegmentError } from './errors.ts'
import type { SegmentOutput, SegmentRequest } from './types.ts'

/** One server-sent event: its `event` field and its joined `data` lines. */
interface StreamEvent {
  event: string
  data: string
}

/** The HTTP 400 body and the data of an `error` event. */
interface ErrorBody {
  code: string
  message: string
}

/** `last_frame` and `video_chunk` event data: base64 bytes. */
interface BytesData {
  data: string
}

/**
 * The failure that a backend error stands for; `invalid_request` is the `ValueError` kind.
 * @param body - the backend's error code and message.
 * @returns the segment error.
 */
function segmentError(body: ErrorBody): GenerationSegmentError {
  return new GenerationSegmentError(body.message, body.code, body.code === 'invalid_request')
}

/**
 * The JSON request body; the seed is sent only when the request sets one.
 * @param request - the segment inputs.
 * @returns the wire fields.
 */
function requestBody(request: SegmentRequest): Record<string, unknown> {
  return {
    prompt: request.prompt,
    reference_images: request.referenceImages.map(image => image.toString('base64')),
    width: request.frameWidth,
    height: request.frameHeight,
    num_frames: request.numFrames,
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    return_last_frame: request.returnLastFrame,
  }
}

/**
 * Parse a server-sent event stream into events, yielding each event when its terminating blank line arrives.
 * Comment lines and fields other than `event` and `data` are ignored; an event without data is dropped.
 * @param body - the response body.
 * @returns the events in arrival order.
 */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let event = 'message'
  let data: string[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      pending += decoder.decode(value, { stream: true })
      for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (line === '') {
          if (data.length > 0) yield { event, data: data.join('\n') }
          event = 'message'
          data = []
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        const fieldValue = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') event = fieldValue
        else if (field === 'data') data.push(fieldValue)
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Send one segment request and yield the backend's outputs in arrival order.
 *
 * The iteration ends after `done`. HTTP 400 and an `error` event reject with `GenerationSegmentError`; any other
 * status, an unknown event, or a stream that ends before `done` rejects with a plain `Error`. Leaving the iteration
 * cancels the HTTP request. Aborting `request.signal` cancels it at once and rejects with `signal.reason`; the backend
 * finishes a segment whose generation has started.
 * @param url - the URL of `/v1/streamv2/generate`.
 * @param request - the segment inputs and an optional abort signal.
 * @returns the backend outputs in arrival order.
 */
export async function* generateSegment(url: URL, request: SegmentRequest): AsyncGenerator<SegmentOutput> {
  const { signal } = request
  signal?.throwIfAborted()
  const connection = new AbortController()
  const onAbort = (): void => { connection.abort(signal?.reason) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(requestBody(request)),
      signal: connection.signal,
    })
    if (response.status === 400) throw segmentError(await response.json() as ErrorBody)
    if (response.status !== 200 || response.body === null) {
      throw new Error(`DreamVerse generation backend POST ${url.pathname} returned HTTP ${response.status}: ${await response.text()}`)
    }
    for await (const event of readEvents(response.body)) {
      switch (event.event) {
        case 'last_frame':
          yield { kind: 'last_frame', png: Buffer.from((JSON.parse(event.data) as BytesData).data, 'base64') }
          break
        case 'video_start':
          yield { kind: 'video_start', mime: (JSON.parse(event.data) as { mime: string }).mime }
          break
        case 'video_chunk':
          yield { kind: 'chunk', bytes: Buffer.from((JSON.parse(event.data) as BytesData).data, 'base64') }
          break
        case 'done':
          yield { kind: 'done', timings: (JSON.parse(event.data) as { timings: Record<string, number> }).timings }
          return
        case 'error':
          throw segmentError(JSON.parse(event.data) as ErrorBody)
        default:
          throw new Error(`Unexpected DreamVerse generation event: ${event.event}`)
      }
    }
    throw new Error('DreamVerse generation stream ended before its done event.')
  } catch (error) {
    // An abort rejects with its `signal.reason`.
    if (signal?.aborted) throw signal.reason
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    connection.abort()
  }
}
