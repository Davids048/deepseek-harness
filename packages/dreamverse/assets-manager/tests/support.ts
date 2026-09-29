/**
 * Shared test inputs: temporary library roots, images built with `sharp`, PCM WAV files, and committed fixtures.
 *
 * `tests/fixtures/` holds inputs that `sharp` cannot write. `animated.png` and `still.bmp` come from Pillow, as the
 * reference tests build them. The MP4 files come from ffmpeg 7.0.2:
 * - `video-16x16-stereo.mp4`: `-f lavfi -i color=c=red:s=16x16:r=1 -f lavfi -i anullsrc=r=8000:cl=stereo -t 1
 *   -c:v mpeg4 -c:a aac -shortest -map_metadata -1 -fflags +bitexact`
 * - `video-16x16-5.1.mp4`: the same command with `cl=5.1`.
 * - `video-3842x2160.mp4`: `-f lavfi -i color=c=black:s=3842x2160:r=1 -t 1 -c:v libx264 -crf 51 -pix_fmt yuv420p
 *   -map_metadata -1 -fflags +bitexact`
 *
 * @module
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

/** A directory under the system temporary directory and its recursive removal. */
export interface TemporaryDirectory {
  directory: string
  cleanup: () => void
}

/** Create an empty directory that the caller removes with `cleanup`. */
export function temporaryDirectory(): TemporaryDirectory {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamverse-assets-manager-'))
  return {
    directory,
    cleanup: () => {
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

/**
 * The absolute path of a committed fixture.
 * @param name - the file name under `tests/fixtures/`.
 * @returns the fixture path.
 */
export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`fixtures/${name}`, import.meta.url))
}

/** True when an `ffprobe` executable runs from `PATH`; the video and audio inspection tests need one. */
export const FFPROBE_ON_PATH = ((): boolean => {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    // A missing executable (ENOENT) or a failing one both mean that no usable ffprobe is installed.
    return false
  }
})()

/**
 * Encode a solid red image, like the reference `Image.new("RGB", (16, 12), color="red")`.
 * @param format - the output format.
 * @param width - the image width in pixels.
 * @param height - the image height in pixels.
 * @returns the encoded image bytes.
 */
export async function imageBytes(format: 'png' | 'jpeg' | 'webp' | 'gif', width = 16, height = 12): Promise<Buffer> {
  const image = sharp({ create: { width, height, channels: 3, background: 'red' } })
  return await image.toFormat(format).toBuffer()
}

/**
 * Encode a two-frame red and blue animation.
 * @param format - the animated output format.
 * @returns the encoded animation bytes.
 */
export async function animatedImageBytes(format: 'webp' | 'gif'): Promise<Buffer> {
  const frames = await Promise.all(['red', 'blue'].map(background =>
    sharp({ create: { width: 16, height: 12, channels: 3, background } }).png().toBuffer()))
  return await sharp(frames, { join: { animated: true } }).toFormat(format).toBuffer()
}

/**
 * Write the 16-bit 8 kHz silent PCM WAV file that the reference tests produce with Python's `wave` module.
 * @param channels - the channel count.
 * @param seconds - the duration in seconds.
 * @returns the WAV file bytes.
 */
export function wavBytes(channels: number, seconds: number): Buffer {
  const sampleRate = 8000
  const bytesPerSample = 2
  const dataBytes = channels * bytesPerSample * sampleRate * seconds
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVEfmt ', 8, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28)
  header.writeUInt16LE(channels * bytesPerSample, 32)
  header.writeUInt16LE(bytesPerSample * 8, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(dataBytes, 40)
  return Buffer.concat([header, Buffer.alloc(dataBytes)])
}
