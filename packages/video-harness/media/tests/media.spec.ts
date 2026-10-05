import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** The part of a subprocess handle that `vhMedia` reads. */
type FakeHandle = Pick<SubprocessHandle, 'collected' | 'done' | 'terminate' | 'waitForExit'>
import VhAssets, { type AssetId } from '@video-harness/assets'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VhMedia, { MediaError, lastFrameAttempts } from '../src/index.ts'

const FFMPEG = process.env['VH_FFMPEG'] ?? '/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg'
const FFPROBE = process.env['VH_FFPROBE'] ?? 'ffprobe'
const hasFfmpeg = existsSync(FFMPEG)

interface Fixture { context: Context; assets: VhAssets; media: VhMedia; root: string }
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

async function start(options: { subprocess?: FakeSubprocess; outputLimitBytes?: number } = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'vh-media-'))
  const context = new Context()
  if (options.subprocess !== undefined) context.provide('subprocess', options.subprocess)
  await context.plugin(VhAssets, { root: join(root, 'assets') }).await()
  const outputLimitBytes = options.outputLimitBytes ?? 1_048_576
  await context.plugin(VhMedia, { ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputLimitBytes }).await()
  const fixture = { context, assets: context.vhAssets, media: context.vhMedia, root }
  fixtures.push(fixture)
  return fixture
}

/** Render a solid-color clip into the store through `run` itself; `fragmented` writes the fMP4 layout a streaming backend sends. */
async function clip(fixture: Fixture, color: string, seconds: number, size = '160x90', fragmented = false): Promise<AssetId> {
  const layout = fragmented ? ['-movflags', 'frag_keyframe+empty_moov+default_base_moof'] : []
  const result = await fixture.media.run({
    argv: ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=${seconds}:r=10`, '-pix_fmt', 'yuv420p', ...layout, '{{out:clip.mp4}}'],
    inputs: [],
    outputs: [{ name: 'clip.mp4', mime: 'video/mp4' }],
  })
  return result.outputs[0] as AssetId
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.context.fiber.dispose()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

describe.skipIf(!hasFfmpeg)('vhMedia with ffmpeg', () => {
  it('runs commands with expanded placeholders and stores declared outputs with their producer', async () => {
    const fixture = await start()
    const first = await clip(fixture, 'red', 1)
    expect(fixture.assets.get(first).mime).toBe('video/mp4')
    const again = await clip(fixture, 'red', 1)
    expect(again).toBe(first)
    const probe = await fixture.media.probe(first)
    expect(probe).toMatchObject({ width: 160, height: 90, hasAudio: false, codec: 'h264' })
    expect(probe.durationSec).toBeCloseTo(1, 0)
  })

  it('rejects placeholder mistakes, non-zero exits, and unwritten outputs with the command output', async () => {
    const fixture = await start()
    const source = await clip(fixture, 'blue', 1)
    await expect(fixture.media.run({ argv: ['ffmpeg', '{{in:3}}'], inputs: [source], outputs: [] })).rejects.toThrow('only 1 were given')
    await expect(fixture.media.run({ argv: ['ffmpeg', '{{out:nope.mp4}}'], inputs: [], outputs: [] })).rejects.toThrow("undeclared output 'nope.mp4'")
    await expect(fixture.media.run({ argv: ['ffmpeg', '-i', '/no/such/file', '{{out:x.mp4}}'], inputs: [], outputs: [{ name: 'x.mp4', mime: 'video/mp4' }] }))
      .rejects.toSatisfy((error: unknown) => error instanceof MediaError && error.stderr.length > 0 && error.message.includes('exited with'))
    await expect(fixture.media.run({ argv: ['ffmpeg', '-version'], inputs: [], outputs: [{ name: 'never.mp4', mime: 'video/mp4' }] }))
      .rejects.toThrow("did not write declared output 'never.mp4'")
    await expect(fixture.media.run({ argv: ['/no/such/program'], inputs: [], outputs: [] })).rejects.toThrow(MediaError)
  })

  it('extracts frames, trims with and without re-encoding, and concatenates clips', async () => {
    const fixture = await start()
    const red = await clip(fixture, 'red', 2)
    const blue = await clip(fixture, 'blue', 1)
    const producedBy = 'op-1' as never
    const first = await fixture.media.extractFrame(red, 'first', producedBy)
    const last = await fixture.media.extractFrame(red, 'last')
    const middle = await fixture.media.extractFrame(red, 1)
    for (const frame of [first, last, middle]) expect(fixture.assets.get(frame).mime).toBe('image/png')
    expect(fixture.assets.get(first).producedBy).toBe('op-1')
    const exact = await fixture.media.trim(red, { startSec: 0.5, endSec: 1.5 })
    expect((await fixture.media.probe(exact)).durationSec).toBeCloseTo(1, 0)
    const copied = await fixture.media.trim(red, { startSec: 1, reencode: false })
    expect(fixture.assets.get(copied).mime).toBe('video/mp4')
    const joined = await fixture.media.concat([red, blue])
    expect((await fixture.media.probe(joined)).durationSec).toBeCloseTo(3, 0)
    await expect(fixture.media.concat([])).rejects.toThrow('at least one clip')
  })

  it('reads the last frame of a fragmented clip, falls through the seek attempts, and rethrows non-media failures', async () => {
    const fixture = await start()
    const fragmented = await clip(fixture, 'green', 2, '160x90', true)
    const last = await fixture.media.extractFrame(fragmented, 'last')
    expect(fixture.assets.get(last).mime).toBe('image/png')
    // ffprobe keeps running for real; only the ffmpeg attempts are scripted.
    const original = fixture.media.run.bind(fixture.media)
    const failing = (error: Error, times: number) => {
      let left = times
      return vi.spyOn(fixture.media, 'run').mockImplementation((request) => {
        if (request.argv[0] === 'ffprobe' || left <= 0) return original(request)
        left -= 1
        return Promise.reject(error)
      })
    }
    // The first attempt (an input seek near the probed duration) fails: the tail-window attempt still yields a frame.
    const once = failing(new MediaError('ffmpeg did not write declared output', ''), 1)
    const recovered = await fixture.media.extractFrame(fragmented, 'last')
    expect(fixture.assets.get(recovered).mime).toBe('image/png')
    expect(once).toHaveBeenCalledTimes(3)
    once.mockRestore()
    // Every attempt failing surfaces the last media error; a non-media failure is not retried.
    const always = failing(new MediaError('no frame', 'stderr'), Number.POSITIVE_INFINITY)
    await expect(fixture.media.extractFrame(fragmented, 'last')).rejects.toThrow('no frame')
    always.mockRestore()
    const broken = failing(new TypeError('not media'), Number.POSITIVE_INFINITY)
    await expect(fixture.media.extractFrame(fragmented, 'last')).rejects.toThrow(TypeError)
    expect(broken).toHaveBeenCalledTimes(2)
    broken.mockRestore()
  })

  it('falls back to re-encoding when the stream-copy concatenation fails, and rethrows other errors', async () => {
    const fixture = await start()
    const red = await clip(fixture, 'red', 1)
    const small = await clip(fixture, 'green', 1, '80x46')
    const run = fixture.media.run.bind(fixture.media)
    const spy = vi.spyOn(fixture.media, 'run').mockImplementationOnce(() => Promise.reject(new MediaError('copy failed', 'mismatch')))
    spy.mockImplementation(run)
    const joined = await fixture.media.concat([red, small])
    expect((await fixture.media.probe(joined)).durationSec).toBeCloseTo(2, 0)
    vi.spyOn(fixture.media, 'run').mockImplementationOnce(() => Promise.reject(new TypeError('boom')))
    await expect(fixture.media.concat([red])).rejects.toThrow(TypeError)
  })

  it('reports nulls when ffprobe knows nothing about a file', async () => {
    const fixture = await start()
    const text = fixture.assets.put(Buffer.from('not media'), { mime: 'text/plain' })
    vi.spyOn(fixture.media, 'run').mockResolvedValueOnce({ outputs: [], stdout: '{}', stderr: '', exitCode: 0 })
    expect(await fixture.media.probe(text)).toEqual({
      durationSec: null, videoDurationSec: null, width: null, height: null, hasAudio: false, codec: null,
    })
    vi.spyOn(fixture.media, 'run').mockResolvedValueOnce({
      outputs: [], stdout: JSON.stringify({ streams: [{ codec_type: 'video', duration: '2.5', codec_name: 'vp9' }, { codec_type: 'audio' }] }), stderr: '', exitCode: 0,
    })
    expect(await fixture.media.probe(text)).toEqual({ durationSec: 2.5, videoDurationSec: 2.5, width: null, height: null, hasAudio: true, codec: 'vp9' })
  })

  it('runs through the harness subprocess service when it is mounted, and terminates on timeout', async () => {
    const subprocess = new FakeSubprocess()
    const fixture = await start({ subprocess })
    const red = await clip(fixture, 'red', 1)
    expect(subprocess.specs).toHaveLength(1)
    expect(subprocess.specs[0]?.argv[0]).toBe(FFMPEG)
    const probe = await fixture.media.probe(red)
    expect(probe.codec).toBe('h264')
    await expect(fixture.media.run({ argv: ['sleep', '5'], inputs: [], outputs: [], timeoutMs: 100 })).rejects.toThrow(MediaError)
    expect(subprocess.terminated).toBe(1)
  })
})

describe('lastFrameAttempts', () => {
  it('seeks near the probed duration first and always ends with the tail window', () => {
    const [seek, tail] = lastFrameAttempts(5.25)
    expect(seek).toEqual(expect.arrayContaining(['-ss', '5.15', '-update', '1']))
    expect(tail).toEqual(expect.arrayContaining(['-an', '-update', '1']))
    expect(tail).not.toContain('-ss')
    expect(lastFrameAttempts(null)).toHaveLength(1)
    expect(lastFrameAttempts(0)).toHaveLength(1)
    expect(lastFrameAttempts(Number.NaN)).toHaveLength(1)
    expect(lastFrameAttempts(0.01)[0]).toEqual(expect.arrayContaining(['-ss', '0']))
  })
})

describe('vhMedia configuration', () => {
  it('rejects an empty command, reports empty streams when the managed handle collects none, and sizes the fallback from the lead clip', async () => {
    const fixture = await start()
    await expect(fixture.media.run({ argv: [], inputs: [], outputs: [] })).rejects.toThrow()
    const silent = new FakeSubprocess()
    silent.collectStreams = false
    const managed = await start({ subprocess: silent })
    const result = await managed.media.run({ argv: ['ffmpeg', '-version'], inputs: [], outputs: [] })
    expect(result).toMatchObject({ stdout: '', stderr: '', exitCode: 0 })
    const a = await clip(fixture, 'red', 1)
    const b = await clip(fixture, 'blue', 1, '120x60')
    vi.spyOn(fixture.media, 'run').mockImplementationOnce(() => Promise.reject(new MediaError('copy failed', 'mismatch')))
    vi.spyOn(fixture.media, 'probe').mockResolvedValueOnce({ durationSec: 1, videoDurationSec: null, width: null, height: null, hasAudio: false, codec: null })
    const joined = await fixture.media.concat([a, b])
    expect((await fixture.media.probe(joined)).width).toBe(1280)
  })

  it('requires both binaries', async () => {
    const context = new Context()
    await context.plugin(VhAssets, { root: mkdtempSync(join(tmpdir(), 'vh-media-cfg-')) }).await()
    expect(() => VhMedia.Config({ ffmpegPath: 'x' } as never)).toThrow()
    expect(VhMedia.Config({ ffmpegPath: 'x', ffprobePath: 'y' } as never).outputLimitBytes).toBe(1_048_576)
    await context.fiber.dispose()
  })
})
