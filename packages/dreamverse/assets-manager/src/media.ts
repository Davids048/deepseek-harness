/**
 * Upload limits and content inspection for the image, video, and audio library.
 *
 * A port of `apps/dreamverse/dreamverse/assets/media.py`. Images decode through `sharp`; video and audio are probed
 * with the `ffprobe` executable found on `PATH`, using the reference argument list.
 *
 * @module @dreamverse/assets-manager/media
 */
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'

import sharp from 'sharp'

/** An upload does not satisfy the library's media requirements; the reference `MediaValidationError(ValueError)`. */
export class MediaValidationError extends Error {
  override name = 'MediaValidationError'
}

/** An upload exceeds the byte limit for its media type. */
export class UploadTooLargeError extends MediaValidationError {
  override name = 'UploadTooLargeError'
}

/** The library's media categories, in upload-policy order. */
export type MediaType = 'image' | 'video' | 'audio'

/** Metadata derived from upload content: frame size for images and videos, duration for videos and audio. */
export interface MediaMetadata {
  readonly mediaType: MediaType
  readonly mimeType: string
  readonly width: number | null
  readonly height: number | null
  readonly durationSec: number | null
}

/** The reference `upload_policy_as_dict()` payload; keys stay snake_case because browser forms read them. */
export type UploadPolicy = {
  image: { mime_types: string[]; extensions: string[]; max_bytes: number; max_pixels: number }
  video: { mime_types: string[]; extensions: string[]; max_bytes: number; max_pixels: number; max_duration_sec: number }
  audio: {
    mime_types: string[]
    extensions: string[]
    max_bytes: number
    max_duration_sec: number
    max_channels: number
  }
}

/**
 * Expose the same upload rules used by content validation to browser forms.
 * @returns a fresh copy of the reference upload policy.
 */
export function uploadPolicy(): UploadPolicy {
  return {
    image: {
      mime_types: ['image/png', 'image/jpeg', 'image/webp'],
      extensions: ['.png', '.jpg', '.jpeg', '.webp'],
      max_bytes: 15 * 1024 * 1024,
      max_pixels: 16_777_216,
    },
    video: {
      mime_types: ['video/mp4', 'video/quicktime', 'video/webm'],
      extensions: ['.mp4', '.mov', '.webm'],
      max_bytes: 100 * 1024 * 1024,
      max_pixels: 8_294_400,
      max_duration_sec: 30,
    },
    audio: {
      mime_types: ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/ogg', 'audio/webm'],
      extensions: ['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.webm'],
      max_bytes: 100 * 1024 * 1024,
      max_duration_sec: 30,
      max_channels: 2,
    },
  }
}

/**
 * Classify a declared MIME type by the upload policy.
 * @param mimeType - the MIME type the browser declared for the upload.
 * @returns the media type whose policy lists the MIME type.
 * @throws {MediaValidationError} when no policy lists the MIME type.
 */
export function mediaTypeForMime(mimeType: string): MediaType {
  const policy = uploadPolicy()
  for (const mediaType of ['image', 'video', 'audio'] as const) {
    if (policy[mediaType].mime_types.includes(mimeType)) return mediaType
  }
  throw new MediaValidationError('Unsupported media type. Select an image, video, or audio format listed in Assets.')
}

/**
 * Decode images or inspect local media streams before publishing an upload.
 * @param filePath - the uploaded file on local disk.
 * @param mimeType - the MIME type the browser declared; images report the MIME type of their content instead.
 * @returns the media metadata stored with the asset.
 * @throws {MediaValidationError} with the reference message when the content fails a check.
 * @throws {UploadTooLargeError} when the file exceeds its media type's byte limit.
 */
export async function inspectMedia(filePath: string, mimeType: string): Promise<MediaMetadata> {
  const mediaType = mediaTypeForMime(mimeType)
  const policy = uploadPolicy()
  const maxBytes = policy[mediaType].max_bytes
  const sizeBytes = (await stat(filePath)).size
  if (sizeBytes === 0) throw new MediaValidationError('The uploaded file is empty.')
  if (sizeBytes > maxBytes) throw new UploadTooLargeError(`The ${mediaType} exceeds the ${maxBytes} byte upload limit.`)
  if (mediaType === 'image') return await inspectImage(filePath, policy.image.max_pixels)
  return await inspectVideoOrAudio(filePath, mediaType, mimeType)
}

/** The image formats the library accepts, keyed by the `sharp` format name detected from content. */
const IMAGE_MIME_TYPES = new Map([['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']])

/** Pillow's `Image.open` raises `DecompressionBombError` above twice `Image.MAX_IMAGE_PIXELS` (89478485). */
const PILLOW_DECOMPRESSION_BOMB_PIXELS = 2 * 89_478_485

/** Pillow rejects decoder errors and truncated data but accepts decoder warnings, which `sharp` rejects by default. */
const IMAGE_DECODE_OPTIONS = { failOn: 'error' } as const

/**
 * Validate a supported still image and derive its MIME type from content.
 * @param filePath - the uploaded file.
 * @param maxPixels - the image policy's pixel limit.
 * @returns the image metadata with the detected MIME type.
 */
async function inspectImage(filePath: string, maxPixels: number): Promise<MediaMetadata> {
  try {
    const content = await readFile(filePath)
    const { format, width, height, pages } = await sharp(content, IMAGE_DECODE_OPTIONS).metadata()
    if (Math.max(1, width) * Math.max(1, height) > PILLOW_DECOMPRESSION_BOMB_PIXELS) {
      throw new RangeError('The image exceeds the Pillow decompression bomb limit.')
    }
    const mimeType = IMAGE_MIME_TYPES.get(format)
    if (mimeType === undefined) throw new MediaValidationError('Unsupported image content. Use PNG, JPEG, or WebP.')
    if (width * height > maxPixels) throw new MediaValidationError(`Images must contain at most ${maxPixels} pixels.`)
    // `sharp` reports WebP animation frames as pages but reads only the default image of an APNG file.
    const frameCount = format === 'png' ? pngFrameCount(content) : pages ?? 1
    if (frameCount > 1) throw new MediaValidationError('Upload a still image, or upload the animation as a video.')
    // Header parsing alone accepts truncated JPEG files; decoding every pixel rejects them.
    await sharp(content, IMAGE_DECODE_OPTIONS).raw().toBuffer()
    return { mediaType: 'image', mimeType, width, height, durationSec: null }
  } catch (error) {
    if (error instanceof MediaValidationError) throw error
    throw new MediaValidationError('The image could not be decoded. Use PNG, JPEG, or WebP.', { cause: error })
  }
}

/**
 * Count APNG frames as Pillow's PNG reader does before `is_animated`: it reads the chunks before the first `IDAT`,
 * takes the frame count from an `acTL` chunk declaring 1 to 2³¹ frames, and ignores the animation when a second
 * `acTL` chunk follows.
 * @param content - the PNG file bytes.
 * @returns the declared frame count, or 1 for a still PNG.
 */
function pngFrameCount(content: Buffer): number {
  let frameCount: number | null = null
  for (let offset = 8; offset + 8 <= content.length;) {
    const length = content.readUInt32BE(offset)
    const chunkType = content.toString('latin1', offset + 4, offset + 8)
    if (chunkType === 'IDAT' || chunkType === 'IEND') break
    if (chunkType === 'acTL' && length >= 8 && offset + 16 <= content.length) {
      const declaredFrames = content.readUInt32BE(offset + 8)
      if (frameCount !== null) frameCount = null
      else if (declaredFrames !== 0 && declaredFrames <= 0x80000000) frameCount = declaredFrames
    }
    offset += 12 + length
  }
  return frameCount ?? 1
}

/** `ffprobe` options that restrict input to local container files and print JSON; the file path follows them. */
const FFPROBE_ARGUMENTS = [
  '-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,mp3,wav,flac,ogg',
  '-show_format', '-show_streams', '-of', 'json',
]

/** The container names that `format_name` must include. */
const MEDIA_FORMAT_NAMES = new Set(['mov', 'mp4', 'matroska', 'webm', 'mp3', 'wav', 'flac', 'ogg'])

/** The `ffprobe -show_format -show_streams -of json` fields the inspection reads. */
interface FfprobeInspection {
  format?: { format_name?: string; duration?: string }
  streams?: { codec_type?: string; channels?: number; width?: number; height?: number }[]
}

const execFileAsync = promisify(execFile)

/**
 * Probe local containers while excluding playlists and network input protocols.
 * @param filePath - the uploaded file.
 * @param mediaType - the declared media type; the file needs at least one stream of this type.
 * @param mimeType - the declared MIME type, stored unchanged.
 * @returns the stream metadata; videos report the first video stream's frame size.
 */
async function inspectVideoOrAudio(
  filePath: string, mediaType: 'video' | 'audio', mimeType: string,
): Promise<MediaMetadata> {
  const policy = uploadPolicy()
  let inspection: FfprobeInspection
  try {
    // `subprocess.run(timeout=15)` kills the child with SIGKILL when the timeout expires.
    const { stdout } = await execFileAsync('ffprobe', [...FFPROBE_ARGUMENTS, filePath], {
      timeout: 15_000, killSignal: 'SIGKILL',
    })
    inspection = JSON.parse(stdout) as FfprobeInspection
  } catch (error) {
    const message = 'The media file could not be decoded. Check its format and try again.'
    throw new MediaValidationError(message, { cause: error })
  }
  const formats = (inspection.format?.format_name ?? '').split(',')
  if (!formats.some(formatName => MEDIA_FORMAT_NAMES.has(formatName))) {
    throw new MediaValidationError('Upload a media file rather than a playlist or external reference.')
  }
  const streams = inspection.streams ?? []
  const selectedStreams = streams.filter(stream => stream.codec_type === mediaType)
  const [firstSelectedStream] = selectedStreams
  if (firstSelectedStream === undefined) throw new MediaValidationError(`The file contains no ${mediaType} stream.`)
  for (const stream of streams) {
    if (stream.codec_type === 'audio' && ![1, 2].includes(stream.channels ?? 0)) {
      throw new MediaValidationError('Audio must be mono or stereo, including video soundtracks.')
    }
  }
  const maxDurationSec = policy[mediaType].max_duration_sec
  const durationSec = Number(inspection.format?.duration ?? Number.NaN)
  if (!Number.isFinite(durationSec) || !(durationSec > 0 && durationSec <= maxDurationSec)) {
    throw new MediaValidationError(`Video and audio must be longer than 0 and at most ${maxDurationSec} seconds.`)
  }
  if (mediaType === 'audio') return { mediaType, mimeType, width: null, height: null, durationSec }
  for (const stream of selectedStreams) {
    if ((stream.width ?? 0) * (stream.height ?? 0) > policy.video.max_pixels) {
      throw new MediaValidationError(`Videos must contain at most ${policy.video.max_pixels} pixels per frame.`)
    }
  }
  const { width, height } = firstSelectedStream
  return { mediaType, mimeType, width: Number(width), height: Number(height), durationSec }
}
