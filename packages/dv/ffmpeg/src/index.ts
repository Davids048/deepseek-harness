/**
 * The ffmpeg runner of DreamVerse as the `dvFfmpeg` Cordis service: it runs ffmpeg and ffprobe over files on disk and
 * reads what ffprobe reports. Components call it from their operations: the Asset pool grabs stills, Deliver exports
 * timelines, and Inspector reads asset metadata. The runner never stores anything: a command reads input files by path
 * and writes its declared outputs into a directory the caller gives, usually the operation's `scratchDir`, and the
 * operation imports the outputs into the asset pool with `OperationContext.importAsset`.
 *
 * Commands run through `ctx.subprocess` when that service is mounted (the harness's managed process range), else
 * through Node's `child_process`, so the service also works in a bare Cordis root such as a test.
 *
 * @module @dv/ffmpeg
 */
import { execFile } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The ffmpeg runner: ffmpeg and ffprobe over files on disk. */
    dvFfmpeg: DvFfmpeg
  }
}

/** `dvFfmpeg` plugin configuration. */
export interface Config {
  /** The ffmpeg binary. */
  ffmpegPath: string
  /** The ffprobe binary; a bare name is resolved on `PATH`. */
  ffprobePath: string
  /** Bytes of stdout and stderr kept per command; longer output is truncated to its tail. */
  outputLimitBytes: number
}

/** Loader validation; both binaries are required so a profile states where its ffmpeg comes from. */
export const Config: z<Config> = z.object({
  ffmpegPath: z.string().required(),
  ffprobePath: z.string().required(),
  outputLimitBytes: z.number().default(1_048_576),
})

/** One command over files. */
export interface FfmpegRequest {
  /**
   * The program and its arguments. `argv[0]` of `ffmpeg` or `ffprobe` maps to the configured binaries. `{{in:<n>}}`
   * expands to the n-th input path and `{{out:<name>}}` to the path of a declared output inside `dir`.
   */
  argv: readonly string[]
  /** Absolute paths of the input files. */
  inputs: readonly string[]
  /** The file names the command must write into `dir`. */
  outputs: readonly string[]
  /** An existing directory: the command's working directory, where it writes its outputs and `files`. */
  dir: string
  /**
   * Text files to write into `dir` before the command runs, for programs that read a list file; `{{in:<n>}}` and
   * `{{out:<name>}}` expand inside the content too.
   */
  files?: readonly { name: string; content: string }[]
  /** Milliseconds before the command is terminated; defaults to ten minutes. */
  timeoutMs?: number
}

/** What a command left behind. */
export interface FfmpegResult {
  /** The absolute paths of the declared outputs, in declaration order. */
  outputs: string[]
  stdout: string
  stderr: string
  exitCode: number
}

/** What ffprobe reports about a file. */
export interface ProbeResult {
  durationSec: number | null
  /** The first video stream's own duration; it can be shorter than `durationSec` when the audio track runs longer. */
  videoDurationSec: number | null
  width: number | null
  height: number | null
  hasAudio: boolean
  /** The first video stream's codec name, or null for audio-only files. */
  codec: string | null
}

/** A command exited non-zero, referenced an unknown placeholder, or did not write a declared output. */
export class FfmpegError extends Error {
  /**
   * @param message - what went wrong, with the last lines of stderr for a failed command.
   * @param stderr - the command's whole captured stderr; empty when the command did not run.
   */
  constructor(message: string, readonly stderr: string) {
    super(message)
    this.name = 'FfmpegError'
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

/** Run ffmpeg and ffprobe over files. */
export default class DvFfmpeg extends Service {
  static Config = Config

  private readonly config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'dvFfmpeg')
    this.config = config
  }

  /**
   * Run one command in `request.dir` with its placeholders expanded, and check that it wrote every declared output.
   * @param request - the command, its input paths, its declared outputs, and its directory.
   * @returns the output paths and the captured streams.
   * @throws FfmpegError when a placeholder names an unknown input or output, the command exits non-zero, or it leaves
   *   a declared output unwritten.
   */
  async run(request: FfmpegRequest): Promise<FfmpegResult> {
    const expand = (text: string): string => text.replace(PLACEHOLDER, (_match, kind: string, key: string) => {
      if (kind === 'in') {
        const path = request.inputs[Number(key)]
        if (path === undefined) throw new FfmpegError(`Command references input ${key}, but only ${request.inputs.length} were given.`, '')
        return path
      }
      if (!request.outputs.includes(key)) throw new FfmpegError(`Command references undeclared output '${key}'.`, '')
      return join(request.dir, key)
    })
    const argv = request.argv.map(expand)
    for (const file of request.files ?? []) writeFileSync(join(request.dir, file.name), expand(file.content))
    const program = this.resolveProgram(argv[0] ?? '')
    const outcome = await this.execute(program, argv.slice(1), request.dir, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (outcome.exitCode !== 0) throw new FfmpegError(`${argv[0]} exited with ${outcome.exitCode}: ${tail(outcome.stderr)}`, outcome.stderr)
    const written = new Set(readdirSync(request.dir))
    const outputs = request.outputs.map((name) => {
      if (!written.has(name)) throw new FfmpegError(`${argv[0]} did not write declared output '${name}'.`, outcome.stderr)
      return join(request.dir, name)
    })
    return { outputs, stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode }
  }

  /**
   * Read duration, dimensions, audio presence, and video codec of a file.
   * @param path - the file.
   * @returns the probe result; fields ffprobe cannot determine are null.
   * @throws FfmpegError when ffprobe fails, for example on a file that is not audio, video or an image.
   */
  async probe(path: string): Promise<ProbeResult> {
    const result = await this.run({
      argv: ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '{{in:0}}'],
      inputs: [path],
      outputs: [],
      dir: tmpdir(),
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
      const options = { cwd, timeout: timeoutMs, maxBuffer: this.config.outputLimitBytes, encoding: 'utf8' } as const
      execFile(program, args, options, (error, stdout, stderr) => {
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
