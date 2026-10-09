/**
 * Mounting for the API, chat references, stream, bundle and e2e specs: the real Project service, asset pool, `dvFfmpeg`,
 * the Story bible, Shot plan, Shot render and Timeline components, and optionally the DSH tool registry, over a temporary
 * root, with a fake `ref2va` render mode provider.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import DvAssetPool from '@dv/asset-pool'
import DvFfmpeg from '@dv/ffmpeg'
import DvProject from '@dv/project'
import * as RenderModes from '@dv/render-modes'
import type { Ref2vaRenderer, Ref2vaRequest, RenderModelFacts, RenderStreamEvent } from '@dv/render-modes'
import DvShotPlan from '@dv/shot-plan'
import DvShotRender from '@dv/shot-render'
import DvStoryBible from '@dv/story-bible'
import DvTimeline from '@dv/timeline'

/** The ffmpeg and ffprobe the fixtures use; the native build on this host, overridable for other machines. */
export const FFMPEG = process.env['DV_FFMPEG'] ?? '/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg'
export const FFPROBE = process.env['DV_FFPROBE'] ?? 'ffprobe'

const run = promisify(execFile)

/** Frame counts for each whole-second duration from `min` to `max`. */
function framesByDuration(min: number, max: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: max - min + 1 }, (_value, index) => [String(min + index), (min + index) * 24 + 1]))
}

/**
 * A reference-image model with small frames so the fake provider renders quickly.
 * @returns the facts.
 */
export function testFacts(): RenderModelFacts {
  return {
    modelId: 'test-ref2va', name: 'Test Ref2VA', aspectRatios: ['16:9', '9:16'], resolutions: ['720p'],
    frameSizes: { '16:9': { '720p': [192, 112] }, '9:16': { '720p': [112, 192] } }, minDurationSec: 1, maxDurationSec: 5,
    numFramesByDurationSec: framesByDuration(1, 5), maxReferenceImages: 2, imageLabels: ['Picture 1', 'Picture 2', 'Picture 3'],
    gpuSecondsPerVideoSecond: 4,
  }
}

/**
 * Encode a solid-color clip and grab its last frame with ffmpeg.
 * @param dir - where to write.
 * @param width - frame width.
 * @param height - frame height.
 * @param numFrames - frames at 24 fps.
 * @param color - an `RRGGBB` color.
 * @returns the bytes of the clip and the frame.
 */
export async function encodeClip(dir: string, width: number, height: number, numFrames: number, color = '3366cc'): Promise<{ video: Buffer; lastFrame: Buffer }> {
  const video = join(dir, 'clip.mp4')
  const frame = join(dir, 'last.png')
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${color}:s=${width}x${height}:d=${(numFrames / 24).toFixed(3)}:r=24`, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video])
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-sseof', '-0.05', '-i', video, '-frames:v', '1', frame])
  return { video: readFileSync(video), lastFrame: readFileSync(frame) }
}

/** A `ref2va` renderer that renders a solid-color clip for every request and remembers the requests. */
export class FakeRef2vaRenderer implements Ref2vaRenderer {
  facts = testFacts()
  readonly requests: Ref2vaRequest[] = []

  model(): Promise<RenderModelFacts> {
    return Promise.resolve(this.facts)
  }

  ready(): Promise<{ ready: boolean; detail: string | null }> {
    return Promise.resolve({ ready: true, detail: null })
  }

  /** Render the request's frames as a solid clip, then stream its last frame, its bytes in two chunks, and completion. */
  async *render(request: Ref2vaRequest): AsyncIterable<RenderStreamEvent> {
    this.requests.push(request)
    const dir = mkdtempSync(join(tmpdir(), 'dv-fake-render-'))
    try {
      const encoded = await encodeClip(dir, request.frameWidth, request.frameHeight, request.numFrames, colorFor(request.prompt))
      yield { kind: 'last_frame', png: encoded.lastFrame }
      yield { kind: 'video_start', mime: 'video/mp4; codecs="avc1.64001f"' }
      const half = Math.floor(encoded.video.length / 2)
      yield { kind: 'chunk', bytes: encoded.video.subarray(0, half) }
      yield { kind: 'chunk', bytes: encoded.video.subarray(half) }
      yield { kind: 'done', timings: { generation_s: 0.25, encode_s: 0.05 } }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** A `ref2va` provider plugin that registers one `FakeRef2vaRenderer` into `dvRef2va` under the backend name `fasth3`. */
export const FakeRef2vaProvider = {
  name: 'fake-ref2va',
  inject: ['dvRef2va'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.dvRef2va.register('fasth3', new FakeRef2vaRenderer()))
  },
}

/** A stable color for a prompt. */
function colorFor(prompt: string): string {
  let hash = 7
  for (const char of prompt) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash.toString(16).padStart(6, '0').slice(-6)
}

/** One mounted base fixture. */
export interface BaseFixture {
  context: Context
  project: DvProject
  assets: DvAssetPool
  /** The fake `ref2va` renderer, or null when the fixture registers none. */
  renderer: FakeRef2vaRenderer | null
  root: string
  /** Write a file with the given content and return its path, for imports. */
  writeFile(name: string, content?: string | Buffer): string
  /** Run one DSH tool through the real registry. */
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
  dispose(): Promise<void>
}

/** What a fixture mounts beside the components. */
export interface BaseFixtureOptions {
  root?: string
  /** `fake` registers the fake `ref2va` renderer; `none` registers no renderer. */
  generation?: 'fake' | 'none'
  /** Whether the DSH system prompt and tool registry are mounted. */
  dsh?: boolean
  /** The asset pool's public URL base; empty by default. */
  publicBaseUrl?: string
}

/**
 * Mount the Project service and the components in a fresh Cordis root.
 * @param options - which optional services to provide.
 * @returns the fixture.
 */
export async function startBase(options: BaseFixtureOptions = {}): Promise<BaseFixture> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'dv-base-'))
  const context = new Context()
  let renderer: FakeRef2vaRenderer | null = null
  await context.plugin({ name: RenderModes.name, apply: RenderModes.apply }).await()
  if ((options.generation ?? 'fake') === 'fake') {
    const fake = new FakeRef2vaRenderer()
    context.effect(() => context.dvRef2va.register('fake', fake))
    renderer = fake
  }
  if (options.dsh !== false) {
    await context.plugin(SystemPrompt, {}).await()
    await context.plugin(ToolRuntime).await()
  }
  await context.plugin(DvProject, {
    root: join(root, 'projects'), gpuConcurrency: 1, cpuConcurrency: 4, sessionRoot: join(root, 'sessions'), confirmGpuSecondsThreshold: 60,
    promptSectionOrder: 4900,
  }).await()
  await context.plugin(DvFfmpeg, { ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputLimitBytes: 1_048_576 }).await()
  await context.plugin(DvAssetPool, { root: join(root, 'assets'), publicBaseUrl: options.publicBaseUrl ?? '' }).await()
  await context.plugin(DvTimeline).await()
  await context.plugin(DvShotPlan).await()
  await context.plugin(DvStoryBible).await()
  await context.plugin(DvShotRender).await()
  let calls = 0
  return {
    context, project: context.dvProject, assets: context.dvAssetPool, renderer, root,
    writeFile(name, content = `FILE:${name}`) {
      const path = join(root, name)
      writeFileSync(path, content)
      return path
    },
    call(name, args) {
      calls += 1
      return context.tools.execute({ callId: ToolCallId(`call-${calls}`), name, arguments: args, signal: new AbortController().signal })
    },
    dispose: async () => {
      await context.fiber.dispose()
      if (options.root === undefined) rmSync(root, { recursive: true, force: true })
    },
  }
}
