/**
 * The media processing service of the video harness as `vhMedia`: ffmpeg and ffprobe over assets of the
 * content-addressed store. Every result is written back into `vhAssets` with the operation that produced it, so a
 * trim, a frame, or a concatenation is traceable like a generated clip.
 *
 * Commands run through `ctx.subprocess` when that service is mounted (the harness's managed process range), else
 * through Node's `child_process`, so the service also works in a bare Cordis root such as a test.
 *
 * @module @video-harness/media
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import type { AssetId, OpId } from '@video-harness/assets'
import type {} from '@video-harness/assets'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** ffmpeg and ffprobe over stored assets: probe, extract frames, trim, concatenate, run declared commands. */
    vhMedia: VhMedia
  }
}

/** `vhMedia` plugin configuration. */
export interface Config {
  /** The ffmpeg binary. */
  ffmpegPath: string
  /** The ffprobe binary; a bare name is resolved on `PATH`. */
  ffprobePath: string
  /** Bytes of stdout and stderr kept per command; longer output is truncated to its tail. */
  outputLimitBytes: number
}

/** Loader validation; both binaries are required so a profile states where its media tools come from. */
export const Config: z<Config> = z.object({
  ffmpegPath: z.string().required(),
  ffprobePath: z.string().required(),
  outputLimitBytes: z.number().default(1_048_576),
})

/** One declared output file of a command. */
export interface DeclaredOutput {
  /** The file name inside the command's working directory; `{{out:<name>}}` in `argv` expands to its path. */
  name: string
  mime: string
}

/** A command over stored assets. */
export interface RunRequest {
  /**
   * The program and its arguments. `argv[0]` of `ffmpeg` or `ffprobe` maps to the configured binaries. `{{in:<n>}}`
   * expands to the path of the n-th input asset and `{{out:<name>}}` to the path of a declared output.
   */
  argv: readonly string[]
  inputs: readonly AssetId[]
  outputs: readonly DeclaredOutput[]
  /** The operation recorded as the producer of every output asset. */
  producedBy?: OpId | null
  /**
   * Text files to write into the working directory before the command runs, for programs that read a list file;
   * `{{in:<n>}}` and `{{out:<name>}}` expand inside the content too.
   */
  files?: readonly { name: string; content: string }[]
  /** Milliseconds before the command is terminated; defaults to ten minutes. */
  timeoutMs?: number
}

/** What a command left behind. */
export interface RunResult {
  /** The declared outputs that the command wrote, in declaration order; a declared file the command did not write is an error. */
  outputs: AssetId[]
  stdout: string
  stderr: string
  exitCode: number
}

/** What ffprobe reports about an asset. */
export interface ProbeResult {
  durationSec: number | null
  /** The first video stream's own duration; it can be shorter than `durationSec` when the audio track runs longer. */
  videoDurationSec: number | null
  width: number | null
  height: number | null
  hasAudio: boolean
  /** The first video stream's codec name, or null for audio-only media. */
  codec: string | null
}

/** Where to take a frame. */
export type FrameAt = 'first' | 'last' | number

/**
 * The ffmpeg command lines that read a clip's last frame, in the order to try them: an input seek just before the
 * video stream's end, then a full decode where every frame overwrites the output so the last one survives. The seek
 * uses the video stream's duration because generated clips carry an audio track that runs past the last video frame,
 * and a seek relative to the container duration lands after it and writes nothing.
 * @param videoDurationSec - the video stream's duration, or null when ffprobe reported none.
 * @returns the argument lists, each with `{{in:0}}` and `{{out:frame.png}}` placeholders.
 */
export function lastFrameAttempts(videoDurationSec: number | null): string[][] {
  const attempts: string[][] = []
  if (videoDurationSec !== null && Number.isFinite(videoDurationSec) && videoDurationSec > 0) {
    attempts.push(['ffmpeg', '-y', '-loglevel', 'error', '-ss', String(Math.max(0, videoDurationSec - 0.1)), '-i', '{{in:0}}', '-update', '1', '{{out:frame.png}}'])
  }
  attempts.push(['ffmpeg', '-y', '-loglevel', 'error', '-i', '{{in:0}}', '-an', '-update', '1', '{{out:frame.png}}'])
  return attempts
}

/** A command exited non-zero or did not write a declared output. */
export class MediaError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message)
    this.name = 'MediaError'
  }
}

const DEFAULT_TIMEOUT_MS = 600_000
const PLACEHOLDER = /\{\{(in|out):([^}]+)\}\}/g

/** The last lines of a stream, for error messages. */
function tail(text: string, lines = 6): string {
  return text.trim().split('\n').slice(-lines).join('\n')
}

/** ffprobe's JSON for one file. */
interface ProbeJson {
  format?: { duration?: string }
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }>
}

/** Run media commands over stored assets and store their results. */
export default class VhMedia extends Service {
  static inject = ['vhAssets']
  static Config = Config

  private readonly config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'vhMedia')
    this.config = config
  }

  /**
   * Run one command in a scratch directory with its inputs materialized and its declared outputs collected into the
   * store. Input assets are referenced by their immutable store paths; the command cannot change them.
   * @param request - the command, inputs, and declared outputs.
   * @returns the stored outputs and the captured streams.
   * @throws MediaError when the command exits non-zero or leaves a declared output unwritten.
   */
  async run(request: RunRequest): Promise<RunResult> {
    const assets = this.ctx.vhAssets
    const inputPaths = request.inputs.map(id => assets.path(id))
    const scratch = mkdtempSync(join(tmpdir(), 'vh-media-'))
    try {
      const expand = (text: string): string => text.replace(PLACEHOLDER, (_match, kind: string, key: string) => {
        if (kind === 'in') {
          const path = inputPaths[Number(key)]
          if (path === undefined) throw new MediaError(`Command references input ${key}, but only ${inputPaths.length} were given.`, '')
          return path
        }
        if (!request.outputs.some(output => output.name === key)) throw new MediaError(`Command references undeclared output '${key}'.`, '')
        return join(scratch, key)
      })
      const argv = request.argv.map(expand)
      for (const file of request.files ?? []) writeFileSync(join(scratch, file.name), expand(file.content))
      const program = this.resolveProgram(argv[0] ?? '')
      const outcome = await this.execute(program, argv.slice(1), scratch, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      if (outcome.exitCode !== 0) {
        throw new MediaError(`${argv[0]} exited with ${outcome.exitCode}: ${tail(outcome.stderr)}`, outcome.stderr)
      }
      const written = new Set(readdirSync(scratch))
      const outputs = request.outputs.map((output) => {
        if (!written.has(output.name)) throw new MediaError(`${argv[0]} did not write declared output '${output.name}'.`, outcome.stderr)
        const meta = { mime: output.mime, name: output.name, producedBy: request.producedBy ?? null }
        return assets.put({ path: join(scratch, output.name) }, meta)
      })
      return { outputs, stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /**
   * Read duration, dimensions, audio presence, and video codec.
   * @param asset - a stored media asset.
   * @returns the probe result; fields ffprobe cannot determine are null.
   */
  async probe(asset: AssetId): Promise<ProbeResult> {
    const result = await this.run({
      argv: ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '{{in:0}}'],
      inputs: [asset],
      outputs: [],
    })
    const json = JSON.parse(result.stdout) as ProbeJson
    const streams = json.streams ?? []
    const video = streams.find(stream => stream.codec_type === 'video')
    const durationText = json.format?.duration ?? video?.duration
    const duration = durationText === undefined ? Number.NaN : Number(durationText)
    const videoDuration = video?.duration === undefined ? Number.NaN : Number(video.duration)
    return {
      durationSec: Number.isFinite(duration) ? duration : null,
      videoDurationSec: Number.isFinite(videoDuration) ? videoDuration : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      hasAudio: streams.some(stream => stream.codec_type === 'audio'),
      codec: video?.codec_name ?? null,
    }
  }

  /**
   * Extract one frame as PNG.
   * @param asset - a stored video.
   * @param at - `first`, `last`, or a time in seconds.
   * @param producedBy - the operation recorded as the frame's producer.
   * @returns the PNG asset.
   */
  async extractFrame(asset: AssetId, at: FrameAt, producedBy: OpId | null = null): Promise<AssetId> {
    if (at === 'last') return this.extractLastFrame(asset, producedBy)
    const seek = at === 'first' ? [] : ['-ss', String(at)]
    const result = await this.run({
      argv: ['ffmpeg', '-y', '-loglevel', 'error', ...seek, '-i', '{{in:0}}', '-frames:v', '1', '{{out:frame.png}}'],
      inputs: [asset],
      outputs: [{ name: 'frame.png', mime: 'image/png' }],
      producedBy,
    })
    return result.outputs[0] as AssetId
  }

  /**
   * The last frame. A fragmented MP4 from a streaming backend carries no reliable duration in its header, so a tail
   * seek relative to the end can land past the final frame and ffmpeg writes nothing; each attempt in
   * {@link lastFrameAttempts} is tried until one yields a frame.
   * @param asset - a stored video.
   * @param producedBy - the operation recorded as the frame's producer.
   * @returns the PNG asset.
   * @throws MediaError from the final attempt when none produced a frame.
   */
  private async extractLastFrame(asset: AssetId, producedBy: OpId | null): Promise<AssetId> {
    const probed = await this.probe(asset)
    let failure = new MediaError('No attempt to read the last frame ran.', '')
    for (const argv of lastFrameAttempts(probed.videoDurationSec ?? probed.durationSec)) {
      try {
        const result = await this.run({ argv, inputs: [asset], outputs: [{ name: 'frame.png', mime: 'image/png' }], producedBy })
        return result.outputs[0] as AssetId
      } catch (error: unknown) {
        if (!(error instanceof MediaError)) throw error
        failure = error
      }
    }
    throw failure
  }

  /**
   * Cut a range out of a clip. Re-encoding cuts on the exact frame; `reencode: false` copies streams and cuts on the
   * nearest keyframe instead.
   * @param asset - a stored video.
   * @param range - start, optional end, and whether to re-encode (default true).
   * @param producedBy - the operation recorded as the producer.
   * @returns the trimmed clip.
   */
  async trim(
    asset: AssetId, range: { startSec: number; endSec?: number; reencode?: boolean }, producedBy: OpId | null = null,
  ): Promise<AssetId> {
    const reencode = range.reencode ?? true
    const codec = reencode ? ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] : ['-c', 'copy']
    const end = range.endSec === undefined ? [] : ['-to', String(range.endSec)]
    // With stream copy the seek must come before `-i` to land on a keyframe; with re-encoding it comes after so the
    // decoder sees the frames before the cut and the cut is exact.
    const argv = reencode
      ? ['ffmpeg', '-y', '-loglevel', 'error', '-i', '{{in:0}}', '-ss', String(range.startSec), ...end, ...codec, '-movflags', '+faststart', '{{out:trimmed.mp4}}']
      : ['ffmpeg', '-y', '-loglevel', 'error', '-ss', String(range.startSec), '-i', '{{in:0}}', ...end, ...codec, '-movflags', '+faststart', '{{out:trimmed.mp4}}']
    const result = await this.run({ argv, inputs: [asset], outputs: [{ name: 'trimmed.mp4', mime: 'video/mp4' }], producedBy })
    return result.outputs[0] as AssetId
  }

  /**
   * Join clips in order. Stream copy through the concat demuxer is tried first; when the inputs disagree on codec or
   * geometry it fails, and the clips are re-encoded through the concat filter instead.
   * @param assets - the clips, in playback order.
   * @param producedBy - the operation recorded as the producer.
   * @returns the joined clip.
   */
  async concat(assets: readonly AssetId[], producedBy: OpId | null = null): Promise<AssetId> {
    if (assets.length === 0) throw new MediaError('concat needs at least one clip.', '')
    const output = { name: 'joined.mp4', mime: 'video/mp4' }
    try {
      const result = await this.run({
        argv: ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', '{{out:joined.mp4}}'],
        inputs: assets,
        outputs: [output],
        files: [{ name: 'list.txt', content: assets.map((_asset, index) => `file '{{in:${index}}}'`).join('\n') }],
        producedBy,
      })
      return result.outputs[0] as AssetId
    } catch (error: unknown) {
      if (!(error instanceof MediaError)) throw error
      // The concat filter needs equal geometry: every clip is scaled and padded to the first clip's frame size.
      const lead = await this.probe(assets[0] as AssetId)
      const width = lead.width ?? 1280
      const height = lead.height ?? 720
      const inputs = assets.flatMap((_asset, index) => ['-i', `{{in:${index}}}`])
      const scaled = assets.map((_asset, index) =>
        `[${index}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`)
      const filter = `${scaled.join(';')};${assets.map((_asset, index) => `[v${index}]`).join('')}concat=n=${assets.length}:v=1:a=0[v]`
      const result = await this.run({
        argv: ['ffmpeg', '-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '{{out:joined.mp4}}'],
        inputs: assets,
        outputs: [output],
        producedBy,
      })
      return result.outputs[0] as AssetId
    }
  }

  /** Map the configured binaries; any other program runs as named. */
  private resolveProgram(name: string): string {
    if (name === 'ffmpeg') return this.config.ffmpegPath
    if (name === 'ffprobe') return this.config.ffprobePath
    return name
  }

  /** Run through the harness subprocess service when it is mounted, else through `child_process`. */
  private async execute(
    program: string, args: string[], cwd: string, timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const subprocess = this.ctx.get('subprocess')
    if (subprocess !== undefined) return await this.executeManaged(subprocess, program, args, cwd, timeoutMs)
    return await new Promise((resolve) => {
      execFile(program, args, { cwd, timeout: timeoutMs, maxBuffer: this.config.outputLimitBytes, encoding: 'utf8' }, (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ stdout, stderr: error === null ? stderr : `${stderr}\n${error.message}`.trim(), exitCode })
      })
    })
  }

  /** Spawn through `ctx.subprocess` with collected output and a timeout that terminates the managed range. */
  private async executeManaged(
    subprocess: SubprocessRuntime, program: string, args: string[], cwd: string, timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const limit = { maxBytes: this.config.outputLimitBytes }
    const handle = subprocess.spawn({
      argv: [program, ...args], cwd, stdio: { stdin: 'ignore', stdout: limit, stderr: limit }, graceMs: 5_000,
    })
    const timer = setTimeout(() => { handle.terminate() }, timeoutMs)
    try {
      const outcome = await handle.done
      return {
        stdout: handle.collected.stdout?.readFrom(0).text ?? '',
        stderr: handle.collected.stderr?.readFrom(0).text ?? '',
        exitCode: outcome.exitCode ?? 1,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
