/**
 * Port of Starlette's `FileResponse` (0.52) for `GET` requests: `Content-Type`, `Content-Length`, `Last-Modified`,
 * `ETag`, `Accept-Ranges`, and `Content-Disposition` headers, `If-Range`, single-range 206 responses, 400 for a
 * malformed `Range` header, and 416 for an unsatisfiable one.
 *
 * @module @dreamverse/browser-server/file-response
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { sendPlainText } from './http.ts'

/** Starlette's `MalformedRangeHeader`; its message becomes the 400 body. */
class MalformedRangeHeader extends Error {
  constructor(message = 'Malformed range header.') {
    super(message)
  }
}

/** Starlette's `RangeNotSatisfiable`. */
class RangeNotSatisfiable extends Error {}

/** Python `urllib.parse.quote(text)`: percent-encode UTF-8 bytes except letters, digits, `_.-~`, and `/`. */
function pythonQuote(text: string): string {
  return encodeURIComponent(text)
    .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll('%2F', '/')
}

/** Python `int(text)` for a stripped decimal string, or `null` where Python raises `ValueError`. */
function pythonInt(text: string): number | null {
  return /^[+-]?\d+(_\d+)*$/.test(text) ? Number(text.replaceAll('_', '')) : null
}

/**
 * Starlette's `_parse_ranges`: `[start, end)` pairs for each well-formed part; empty, dash-only, dashless, and
 * non-numeric parts are skipped.
 */
function parseRanges(ranges: string, fileSize: number): Array<[number, number]> {
  const parsed: Array<[number, number]> = []
  for (const rawPart of ranges.split(',')) {
    const part = rawPart.trim()
    if (!part || part === '-' || !part.includes('-')) continue
    const dash = part.indexOf('-')
    const startText = part.slice(0, dash).trim()
    const endText = part.slice(dash + 1).trim()
    const suffix = startText ? null : pythonInt(endText)
    const start = startText ? pythonInt(startText) : suffix === null ? null : fileSize - suffix
    if (start === null) continue
    const end = startText && endText ? pythonInt(endText) : null
    if (startText && endText && end === null) continue
    parsed.push([start, end !== null && end < fileSize ? end + 1 : fileSize])
  }
  return parsed
}

/**
 * Starlette's `_parse_range_header`, including its merge of overlapping ranges.
 * @throws MalformedRangeHeader or RangeNotSatisfiable.
 */
function parseRangeHeader(httpRange: string, fileSize: number): Array<[number, number]> {
  const equals = httpRange.indexOf('=')
  if (equals < 0) throw new MalformedRangeHeader()
  if (httpRange.slice(0, equals).trim().toLowerCase() !== 'bytes') throw new MalformedRangeHeader('Only support bytes range')
  const ranges = parseRanges(httpRange.slice(equals + 1), fileSize)
  if (ranges.length === 0) throw new MalformedRangeHeader('Range header: range must be requested')
  if (ranges.some(([start]) => !(start >= 0 && start < fileSize))) throw new RangeNotSatisfiable()
  if (ranges.some(([start, end]) => start > end)) throw new MalformedRangeHeader('Range header: start must be less than end')
  if (ranges.length === 1) return ranges
  const merged: Array<[number, number]> = []
  for (const [start, end] of ranges) {
    const index = merged.findIndex(([, mergedEnd]) => start <= mergedEnd)
    const [mergedStart, mergedEnd] = merged[index] ?? [0, 0]
    if (index < 0) merged.push([start, end])
    else if (end < mergedStart) merged.splice(index, 0, [start, end])
    else merged[index] = [Math.min(start, mergedStart), Math.max(end, mergedEnd)]
  }
  return merged
}

/** Python `str(float)` for a positive modification time. */
function pythonFloatText(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value)
}

/** One file to deliver. */
export interface FileDelivery {
  path: string
  mediaType: string
  /** The name that `Content-Disposition: inline` reports. */
  filename: string
}

/**
 * Send a file like Starlette's `FileResponse(path, media_type=..., filename=..., content_disposition_type="inline")`
 * for a `GET` request. A missing path or a path that is not a regular file rejects before the response starts. A
 * `Range` header selecting several ranges gets the complete file with status 200.
 * @param request - the browser request, whose `Range` and `If-Range` headers select the bytes.
 * @param response - the browser response.
 * @param file - the file path, media type, and download name.
 * @returns a promise that settles once the body is written or the browser disconnects.
 */
export async function sendFile(request: IncomingMessage, response: ServerResponse, file: FileDelivery): Promise<void> {
  const stats = await stat(file.path, { bigint: true })
  if (!stats.isFile()) throw new Error(`File at path ${file.path} is not a file.`)
  const fileSize = Number(stats.size)
  // Python's `st_mtime` is `sec + nsec * 1e-9` in double precision; `formatdate` and the ETag both read it.
  const mtime = Number(stats.mtimeNs / 1_000_000_000n) + Number(stats.mtimeNs % 1_000_000_000n) * 1e-9
  const lastModified = new Date(Math.floor(mtime) * 1000).toUTCString()
  const etag = `"${createHash('md5').update(`${pythonFloatText(mtime)}-${fileSize}`).digest('hex')}"`
  const quotedName = pythonQuote(file.filename)
  const headers: OutgoingHttpHeaders = {
    'content-type': file.mediaType,
    'accept-ranges': 'bytes',
    'content-disposition': quotedName === file.filename
      ? `inline; filename="${file.filename}"`
      : `inline; filename*=utf-8''${quotedName}`,
    'content-length': fileSize,
    'last-modified': lastModified,
    etag,
  }

  // Starlette honors `Range` only when `If-Range` is absent or names the current Last-Modified or ETag.
  const httpRange = request.headers.range
  const httpIfRange = request.headers['if-range']
  let ranges: Array<[number, number]> | undefined
  if (httpRange !== undefined && (httpIfRange === undefined || httpIfRange === lastModified || httpIfRange === etag)) {
    try {
      ranges = parseRangeHeader(httpRange, fileSize)
    } catch (error) {
      if (error instanceof MalformedRangeHeader) sendPlainText(response, 400, error.message)
      else if (error instanceof RangeNotSatisfiable) sendPlainText(response, 416, '', { 'content-range': `*/${fileSize}` })
      else throw error
      return
    }
  }
  const singleRange = ranges?.length === 1 ? ranges[0] : undefined
  if (singleRange !== undefined) {
    const [start, end] = singleRange
    response.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end - 1}/${fileSize}`, 'content-length': end - start })
    await writeFileBytes(response, file.path, start, end)
    return
  }
  response.writeHead(200, headers)
  await writeFileBytes(response, file.path, 0, fileSize)
}

/** Stream `[start, end)` of a file into the response; a browser disconnect ends the stream quietly. */
async function writeFileBytes(response: ServerResponse, path: string, start: number, end: number): Promise<void> {
  if (end <= start) {
    response.end()
    return
  }
  await pipeline(createReadStream(path, { start, end: end - 1 }), response).catch(() => {
    // `pipeline` destroyed the file stream and the response; a browser that left has nothing more to receive.
  })
}
