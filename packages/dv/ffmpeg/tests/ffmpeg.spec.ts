/** Unit tests of the `dvFfmpeg` runner: placeholders, errors, probing, and the managed subprocess path. */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DvFfmpeg, { FfmpegError } from '../src/index.ts'

const FFMPEG = process.env['DV_FFMPEG'] ?? '/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg'
const FFPROBE = process.env['DV_FFPROBE'] ?? 'ffprobe'
const hasFfmpeg = existsSync(FFMPEG)

/** The part of a subprocess handle that `dvFfmpeg` reads. */
type FakeHandle = Pick<SubprocessHandle, 'collected' | 'done' | 'terminate' | 'waitForExit'>

interface Fixture { context: Context; ffmpeg: DvFfmpeg; dir: string }
const fixtures: Fixture[] = []

/**
 * A stand-in for the harness subprocess service: spawns through `child_process` and exposes the collected streams the
 * way `SubprocessHandle` does, so the managed execution path runs without the real provider.
 */
class FakeSubprocess {
  readonly specs: SubprocessSpawnSpec[] = []
  terminated = 0
  /** Whether the handle exposes collected streams, as a provider configured without collection would not. */
  collectStreams = true

  spawn(spec: SubprocessSpawnSpec): FakeHandle {
    this.specs.push(spec)
    const [program, ...args] = spec.argv
    const child = spawn(program ?? '', args, { cwd: spec.cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
    })
    return {
      collected: this.collectStreams
        ? {
          stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
        }
        : {},
      done,
      terminate: () => { this.terminated += 1; child.kill('SIGKILL') },
      waitForExit: () => done.then(() => true),
    }
  }
}

/**
 * Start the runner in a bare Cordis root.
 * @param subprocess - a fake harness subprocess service, when the managed path is under test.
 * @returns the fixture with a scratch directory.
 */
async function start(subprocess?: FakeSubprocess): Promise<Fixture> {
  const context = new Context()
  if (subprocess !== undefined) context.provide('subprocess', subprocess)
  await context.plugin(DvFfmpeg, { ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputLimitBytes: 1_048_576 }).await()
  const fixture = { context, ffmpeg: context.dvFfmpeg, dir: mkdtempSync(join(tmpdir(), 'dv-ffmpeg-')) }
  fixtures.push(fixture)
  return fixture
}

/**
 * Render a solid-color clip into the fixture directory through `run` itself.
 * @param fixture - the fixture.
 * @param name - the output file name.
 * @param seconds - the clip length.
 * @returns the clip's path.
 */
async function clip(fixture: Fixture, name: string, seconds: number): Promise<string> {
  const result = await fixture.ffmpeg.run({
    argv: ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=red:s=160x90:d=${seconds}:r=10`, '-pix_fmt', 'yuv420p', `{{out:${name}}}`],
    inputs: [], outputs: [name], dir: fixture.dir,
  })
  return result.outputs[0] as string
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.context.fiber.dispose()
    rmSync(fixture.dir, { recursive: true, force: true })
  }
})

describe.skipIf(!hasFfmpeg)('dvFfmpeg with ffmpeg', () => {
  it('runs a command with expanded inputs, outputs and list files, and probes the result', async () => {
    const fixture = await start()
    const red = await clip(fixture, 'red.mp4', 1)
    expect(red).toBe(join(fixture.dir, 'red.mp4'))
    const joined = await fixture.ffmpeg.run({
      argv: ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '{{out:joined.mp4}}'],
      inputs: [red, red], outputs: ['joined.mp4'], dir: fixture.dir,
      files: [{ name: 'list.txt', content: "file '{{in:0}}'\nfile '{{in:1}}'" }],
    })
    expect(readFileSync(join(fixture.dir, 'list.txt'), 'utf8')).toBe(`file '${red}'\nfile '${red}'`)
    const probe = await fixture.ffmpeg.probe(joined.outputs[0] as string)
    expect(probe).toMatchObject({ width: 160, height: 90, hasAudio: false, codec: 'h264' })
    expect(probe.durationSec).toBeCloseTo(2, 0)
  })

  it('rejects placeholder mistakes, non-zero exits, and unwritten outputs with the command output', async () => {
    const fixture = await start()
    const red = await clip(fixture, 'red.mp4', 1)
    const run = (argv: string[], inputs: string[], outputs: string[]) => fixture.ffmpeg.run({ argv, inputs, outputs, dir: fixture.dir })
    await expect(run(['ffmpeg', '{{in:3}}'], [red], [])).rejects.toThrow('only 1 were given')
    await expect(run(['ffmpeg', '{{out:nope.mp4}}'], [], [])).rejects.toThrow("undeclared output 'nope.mp4'")
    await expect(run(['ffmpeg', '-i', '/no/such/file', '{{out:x.mp4}}'], [], ['x.mp4']))
      .rejects.toSatisfy((error: unknown) => error instanceof FfmpegError && error.stderr.length > 0 && error.message.includes('exited with'))
    await expect(run(['ffmpeg', '-version'], [], ['never.mp4'])).rejects.toThrow("did not write declared output 'never.mp4'")
    await expect(run(['/no/such/program'], [], [])).rejects.toThrow(FfmpegError)
    await expect(run([], [], [])).rejects.toThrow()
    const text = join(fixture.dir, 'note.txt')
    writeFileSync(text, 'not a video')
    await expect(fixture.ffmpeg.probe(text)).rejects.toThrow(FfmpegError)
  })

  it('runs through the harness subprocess service when it is mounted, and terminates on timeout', async () => {
    const subprocess = new FakeSubprocess()
    const fixture = await start(subprocess)
    const red = await clip(fixture, 'red.mp4', 1)
    expect(subprocess.specs[0]?.argv[0]).toBe(FFMPEG)
    expect((await fixture.ffmpeg.probe(red)).codec).toBe('h264')
    await expect(fixture.ffmpeg.run({ argv: ['sleep', '5'], inputs: [], outputs: [], dir: fixture.dir, timeoutMs: 100 })).rejects.toThrow(FfmpegError)
    expect(subprocess.terminated).toBe(1)
    const silent = new FakeSubprocess()
    silent.collectStreams = false
    const managed = await start(silent)
    expect(await managed.ffmpeg.run({ argv: ['ffmpeg', '-version'], inputs: [], outputs: [], dir: managed.dir }))
      .toMatchObject({ stdout: '', stderr: '', exitCode: 0 })
  })
})

describe('dvFfmpeg probe parsing and configuration', () => {
  it('reports nulls for fields ffprobe does not know, and the video stream duration', async () => {
    const fixture = await start()
    vi.spyOn(fixture.ffmpeg, 'run').mockResolvedValueOnce({ outputs: [], stdout: '{}', stderr: '', exitCode: 0 })
    expect(await fixture.ffmpeg.probe('/any')).toEqual({
      durationSec: null, videoDurationSec: null, width: null, height: null, hasAudio: false, codec: null,
    })
    vi.spyOn(fixture.ffmpeg, 'run').mockResolvedValueOnce({
      outputs: [], stdout: JSON.stringify({ streams: [{ codec_type: 'video', duration: '2.5', codec_name: 'vp9' }, { codec_type: 'audio' }] }),
      stderr: '', exitCode: 0,
    })
    expect(await fixture.ffmpeg.probe('/any')).toEqual({ durationSec: 2.5, videoDurationSec: 2.5, width: null, height: null, hasAudio: true, codec: 'vp9' })
  })

  it('requires both binaries', () => {
    expect(() => DvFfmpeg.Config({ ffmpegPath: 'x' } as never)).toThrow()
    expect(DvFfmpeg.Config({ ffmpegPath: 'x', ffprobePath: 'y' } as never).outputLimitBytes).toBe(1_048_576)
  })
})
