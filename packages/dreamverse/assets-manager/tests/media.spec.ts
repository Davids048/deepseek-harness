/**
 * Verify upload policy, MIME classification, and content inspection against results of the Python reference
 * `inspect_media` for the same inputs. The video and audio cases run the `ffprobe` found on `PATH` and skip without it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { crc32 } from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MediaValidationError, UploadTooLargeError, inspectMedia, mediaTypeForMime, uploadPolicy } from '../src/media.ts'
import { FFPROBE_ON_PATH, fixturePath, imageBytes, temporaryDirectory, wavBytes, type TemporaryDirectory } from './support.ts'

const IMAGE_DECODE_MESSAGE = 'The image could not be decoded. Use PNG, JPEG, or WebP.'
const MEDIA_DECODE_MESSAGE = 'The media file could not be decoded. Check its format and try again.'
const DURATION_MESSAGE = 'Video and audio must be longer than 0 and at most 30 seconds.'
const CHANNELS_MESSAGE = 'Audio must be mono or stereo, including video soundtracks.'

let temporary: TemporaryDirectory

beforeEach(() => {
  temporary = temporaryDirectory()
})

afterEach(() => {
  vi.unstubAllEnvs()
  temporary.cleanup()
})

/**
 * Write test bytes into the temporary directory.
 * @param name - the file name.
 * @param content - the file bytes.
 * @returns the file path.
 */
function writeInput(name: string, content: Uint8Array | string): string {
  const filePath = path.join(temporary.directory, name)
  fs.writeFileSync(filePath, content)
  return filePath
}

/**
 * Rewrite the IHDR frame size of a PNG file and its checksum, leaving the pixel data unchanged.
 * @param png - a PNG file.
 * @param width - the declared width.
 * @param height - the declared height.
 * @returns the edited PNG bytes.
 */
function withDeclaredPngSize(png: Buffer, width: number, height: number): Buffer {
  const edited = Buffer.from(png)
  edited.writeUInt32BE(width, 16)
  edited.writeUInt32BE(height, 20)
  edited.writeUInt32BE(crc32(edited.subarray(12, 29)), 29)
  return edited
}

describe('uploadPolicy', () => {
  it('returns the reference upload_policy_as_dict payload as a fresh object', () => {
    const policy = uploadPolicy()
    expect(JSON.stringify(policy)).toBe(JSON.stringify({
      image: {
        mime_types: ['image/png', 'image/jpeg', 'image/webp'], extensions: ['.png', '.jpg', '.jpeg', '.webp'],
        max_bytes: 15728640, max_pixels: 16777216,
      },
      video: {
        mime_types: ['video/mp4', 'video/quicktime', 'video/webm'], extensions: ['.mp4', '.mov', '.webm'],
        max_bytes: 104857600, max_pixels: 8294400, max_duration_sec: 30,
      },
      audio: {
        mime_types: ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/ogg', 'audio/webm'],
        extensions: ['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.webm'],
        max_bytes: 104857600, max_duration_sec: 30, max_channels: 2,
      },
    }))
    policy.image.mime_types.push('image/gif')
    expect(uploadPolicy().image.mime_types).toEqual(['image/png', 'image/jpeg', 'image/webp'])
  })
})

describe('mediaTypeForMime', () => {
  it('classifies policy MIME types and rejects others', () => {
    expect(['image/png', 'video/webm', 'audio/webm', 'audio/x-wav'].map(mediaTypeForMime))
      .toEqual(['image', 'video', 'audio', 'audio'])
    expect(() => mediaTypeForMime('image/gif'))
      .toThrow(new MediaValidationError('Unsupported media type. Select an image, video, or audio format listed in Assets.'))
  })
})

describe('inspectMedia images', () => {
  it.each([['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']] as const)(
    'reports the %s content MIME type and frame size', async (format, mimeType) => {
      const filePath = writeInput('upload', await imageBytes(format))
      await expect(inspectMedia(filePath, 'image/png'))
        .resolves.toEqual({ mediaType: 'image', mimeType, width: 16, height: 12, durationSec: null })
    })

  it('accepts a JPEG whose decoder reports only a warning', async () => {
    const jpeg = await imageBytes('jpeg')
    // Entropy data cut short before the end-of-image marker makes libjpeg warn about a premature end of the data
    // segment; Pillow accepts the file.
    const filePath = writeInput('upload.jpg', Buffer.concat([jpeg.subarray(0, -6), jpeg.subarray(-2)]))
    await expect(inspectMedia(filePath, 'image/jpeg')).resolves.toMatchObject({ mimeType: 'image/jpeg', width: 16 })
  })

  it('accepts an image at the pixel limit', async () => {
    const filePath = writeInput('upload.png', await imageBytes('png', 4096, 4096))
    await expect(inspectMedia(filePath, 'image/png')).resolves.toMatchObject({ width: 4096, height: 4096 })
  })

  it('reports a header above the Pillow decompression bomb limit as undecodable', async () => {
    const png = await imageBytes('png')
    const overPixelLimit = writeInput('over-limit.png', withDeclaredPngSize(png, 4097, 4096))
    await expect(inspectMedia(overPixelLimit, 'image/png')).rejects.toThrow('Images must contain at most 16777216 pixels.')
    const overBombLimit = writeInput('bomb.png', withDeclaredPngSize(png, 13000, 13800))
    await expect(inspectMedia(overBombLimit, 'image/png')).rejects.toThrow(IMAGE_DECODE_MESSAGE)
  })

  it('checks size limits before decoding', async () => {
    await expect(inspectMedia(writeInput('empty.png', ''), 'image/png')).rejects.toThrow('The uploaded file is empty.')
    const oversized = inspectMedia(writeInput('large.png', Buffer.alloc(15 * 1024 * 1024 + 1)), 'image/png')
    await expect(oversized).rejects.toThrow(new UploadTooLargeError('The image exceeds the 15728640 byte upload limit.'))
    await expect(oversized).rejects.toBeInstanceOf(UploadTooLargeError)
  })

  it('rejects video bytes declared as an image', async () => {
    await expect(inspectMedia(fixturePath('video-16x16-stereo.mp4'), 'image/png')).rejects.toThrow(IMAGE_DECODE_MESSAGE)
  })
})

describe.skipIf(!FFPROBE_ON_PATH)('inspectMedia video and audio through ffprobe', () => {
  it('reads the frame size and duration of an MP4 file with a stereo soundtrack', async () => {
    const filePath = fixturePath('video-16x16-stereo.mp4')
    await expect(inspectMedia(filePath, 'video/mp4'))
      .resolves.toEqual({ mediaType: 'video', mimeType: 'video/mp4', width: 16, height: 16, durationSec: 1 })
    await expect(inspectMedia(filePath, 'audio/mp4'))
      .resolves.toEqual({ mediaType: 'audio', mimeType: 'audio/mp4', width: null, height: null, durationSec: 1 })
  })

  it.each([[1, 'audio/wav', 1], [2, 'audio/x-wav', 1], [1, 'audio/wav', 30]])(
    'accepts %i-channel WAV audio declared as %s lasting %i seconds', async (channels, mimeType, seconds) => {
      const filePath = writeInput('audio.wav', wavBytes(channels, seconds))
      await expect(inspectMedia(filePath, mimeType))
        .resolves.toEqual({ mediaType: 'audio', mimeType, width: null, height: null, durationSec: seconds })
    })

  it.each([
    ['5-channel WAV audio', () => writeInput('audio.wav', wavBytes(5, 1)), 'audio/wav', CHANNELS_MESSAGE],
    ['a 5.1 video soundtrack', () => fixturePath('video-16x16-5.1.mp4'), 'video/quicktime', CHANNELS_MESSAGE],
    ['a 31-second WAV file', () => writeInput('audio.wav', wavBytes(1, 31)), 'audio/wav', DURATION_MESSAGE],
    ['a 3842x2160 video', () => fixturePath('video-3842x2160.mp4'), 'video/mp4',
      'Videos must contain at most 8294400 pixels per frame.'],
    ['WAV audio declared as video', () => writeInput('audio.wav', wavBytes(1, 1)), 'video/mp4',
      'The file contains no video stream.'],
    ['an HLS playlist', () => writeInput('playlist.m3u8', '#EXTM3U\n#EXTINF:1,\nhttps://example.com/video.ts\n'),
      'video/mp4', MEDIA_DECODE_MESSAGE],
    ['bytes in no media format', () => writeInput('audio.mp3', 'garbage bytes'), 'audio/mpeg', MEDIA_DECODE_MESSAGE],
  ])('rejects %s', async (_case, input, mimeType, message) => {
    await expect(inspectMedia(input(), mimeType)).rejects.toThrow(new MediaValidationError(message))
  })
})

describe('inspectMedia without ffprobe', () => {
  it('reports media as undecodable when PATH has no ffprobe', async () => {
    vi.stubEnv('PATH', temporary.directory)
    const rejection = inspectMedia(writeInput('audio.wav', wavBytes(1, 1)), 'audio/wav')
    await expect(rejection).rejects.toThrow(new MediaValidationError(MEDIA_DECODE_MESSAGE))
    await expect(rejection).rejects.toHaveProperty('cause.code', 'ENOENT')
  })
})
