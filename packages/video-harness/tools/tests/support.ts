/**
 * Mounting for the tools specs: the real asset store, Project service, media service, tool registry, and `vhTools`
 * over a temporary root, with fakes for the generation backend, the model, and the attachment service.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import DreamverseGeneration, { type ModelFacts, type SegmentOutput, type SegmentRequest } from '@dreamverse/generation-client'
import DvProject from '@dv/project'
import VhAssets from '@video-harness/assets'
import VhMedia from '@video-harness/media'
import VhTools from '../src/index.ts'

/** The ffmpeg and ffprobe the fixtures use; the native build on this host, overridable for other machines. */
export const FFMPEG = process.env['VH_FFMPEG'] ?? '/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg'
export const FFPROBE = process.env['VH_FFPROBE'] ?? 'ffprobe'

const run = promisify(execFile)

/** Frame counts for each whole-second duration from `min` to `max`. */
function framesByDuration(min: number, max: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: max - min + 1 }, (_value, index) => [String(min + index), (min + index) * 24 + 1]))
}

/**
 * A reference-image model with small frames so the fake backend renders quickly.
 * @returns the facts.
 */
export function testFacts(): ModelFacts {
  return {
    modelId: 'test-ref2va', name: 'Test Ref2VA', generationModes: { ref2va: 'reference_images' }, unsupportedGenerationModes: {},
    aspectRatios: ['16:9', '9:16'], resolutions: ['720p'], minSegmentDurationSec: 1, maxSegmentDurationSec: 5, maxReferenceImages: 3,
    maxReferenceAspectRatio: 4, usesPreviousFrame: true, frameSizes: { '16:9': { '720p': [192, 112] }, '9:16': { '720p': [112, 192] } },
    numFramesByDurationSec: framesByDuration(1, 5), referenceLabels: ['Picture 1', 'Picture 2', 'Picture 3'],
  }
}

/**
 * Render a solid-color clip and its last frame with ffmpeg.
 * @param dir - where to write.
 * @param width - frame width.
 * @param height - frame height.
 * @param numFrames - frames at 24 fps.
 * @param color - an `RRGGBB` color.
 * @returns the bytes of the clip and the frame.
 */
export async function renderClip(dir: string, width: number, height: number, numFrames: number, color = '3366cc'): Promise<{ video: Buffer; lastFrame: Buffer }> {
  const video = join(dir, 'clip.mp4')
  const frame = join(dir, 'last.png')
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${color}:s=${width}x${height}:d=${(numFrames / 24).toFixed(3)}:r=24`, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video])
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-sseof', '-0.05', '-i', video, '-frames:v', '1', frame])
  return { video: readFileSync(video), lastFrame: readFileSync(frame) }
}

/** A generation backend that renders a solid-color clip for every request and remembers the requests. */
export class FakeGeneration {
  facts = testFacts()
  readonly requests: SegmentRequest[] = []
  /** When set, `generateSegment` rejects with this error before streaming. */
  failure: Error | null = null
  /** An event to leave out of the stream, to exercise the tool's checks. */
  omit: 'last_frame' | 'done' | null = null
  /** Extra zero bytes appended as one chunk, to exercise write backpressure. */
  padChunkBytes = 0

  model(): Promise<ModelFacts> {
    return Promise.resolve(this.facts)
  }

  async *generateSegment(request: SegmentRequest): AsyncIterable<SegmentOutput> {
    this.requests.push(request)
    if (this.failure !== null) throw this.failure
    const dir = mkdtempSync(join(tmpdir(), 'vh-fake-generation-'))
    try {
      const rendered = await renderClip(dir, request.frameWidth, request.frameHeight, request.numFrames, colorFor(request.prompt))
      if (this.omit !== 'last_frame') yield { kind: 'last_frame', png: rendered.lastFrame }
      yield { kind: 'video_start', mime: 'video/mp4; codecs="avc1.64001f"' }
      const half = Math.floor(rendered.video.length / 2)
      yield { kind: 'chunk', bytes: rendered.video.subarray(0, half) }
      yield { kind: 'chunk', bytes: rendered.video.subarray(half) }
      if (this.padChunkBytes > 0) yield { kind: 'chunk', bytes: Buffer.alloc(this.padChunkBytes) }
      if (this.omit !== 'done') yield { kind: 'done', timings: { generation_s: 0.25, encode_s: 0.05 } }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** A stable color for a prompt. */
function colorFor(prompt: string): string {
  let hash = 7
  for (const char of prompt) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash.toString(16).padStart(6, '0').slice(-6)
}

/** An attachment service that accepts every image and remembers it. */
export class FakeAttachments {
  readonly saved: SaveImageAttachment[] = []

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    return Promise.resolve({
      attachmentId: brandString<ImageAttachmentRef['attachmentId']>(`att-${this.saved.length}`), mediaType: input.mediaType, bytes: input.data.byteLength, width: 192, height: 112,
      ...input.name === undefined ? {} : { name: input.name },
    })
  }

  /** Read back a saved image by its reference. */
  readImage(ref: ImageAttachmentRef): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }> {
    const saved = this.saved[Number(ref.attachmentId.slice('att-'.length)) - 1]
    if (saved === undefined) return Promise.reject(new Error(`unknown attachment ${ref.attachmentId}`))
    return Promise.resolve({ ref, data: saved.data })
  }
}

/** A model that answers every request with one text reply. */
export class FakeLlm {
  readonly requests: GenerateOptions[] = []
  reply: string | Error = 'A person in a blue room, centered, soft light.'
  /** A reasoning block emitted before the reply, when set. */
  reasoning: string | null = null
  /** What the route declares; undefined declares nothing. */
  modalities: string[] | undefined = ['text', 'image']

  resolveModelInfo(): Promise<{ inputModalities?: string[] }> {
    return Promise.resolve(this.modalities === undefined ? {} : { inputModalities: this.modalities })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const reply = this.reply
    const reasoning = this.reasoning
    return (async function* (): AsyncGenerator<StreamChunk> {
      if (reply instanceof Error) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: reply.message, code: 'TEST' } } }
        return
      }
      if (reasoning !== null) {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
      }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: reply }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

/** The default model selection the fake `agentDefaultModel` reports. */
export interface TestRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/** One mounted tools fixture. */
export interface ToolsFixture {
  context: Context
  tools: VhTools
  toolsFiber: Fiber
  project: DvProject
  assets: VhAssets
  media: VhMedia
  generation: FakeGeneration
  llm: FakeLlm
  attachments: FakeAttachments
  /** The selection the fake default model reports; tests change it in place. */
  route: TestRoute
  root: string
  /** Write a file with the given content and return its path, for imports. */
  writeFile(name: string, content?: string | Buffer): string
  /** Run one DSH tool through the real registry. */
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
  dispose(): Promise<void>
}

/** What a fixture mounts beside the harness packages. */
export interface ToolsFixtureOptions {
  root?: string
  /** `fake` provides the fake backend, a URL mounts the real client against it, `none` mounts no backend. */
  generation?: 'fake' | 'none' | { baseUrl: string }
  /** Whether the model, default model, and attachment fakes are provided. */
  perception?: boolean
  /** The `imageInput` switch of the tools plugin; defaults to true. */
  imageInput?: boolean
  /** Whether the DSH tool registry is mounted. */
  dsh?: boolean
}

/**
 * Mount everything in a fresh Cordis root.
 * @param options - which optional services to provide.
 * @returns the fixture.
 */
export async function startTools(options: ToolsFixtureOptions = {}): Promise<ToolsFixture> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'vh-tools-'))
  const context = new Context()
  const generation = new FakeGeneration()
  const llm = new FakeLlm()
  const attachments = new FakeAttachments()
  const route: TestRoute = { provider: 'test-provider', model: 'test-vision' }
  const generationMode = options.generation ?? 'fake'
  if (generationMode === 'fake') context.provide('dreamverseGeneration', generation)
  else if (generationMode !== 'none') await context.plugin(DreamverseGeneration, { baseUrl: generationMode.baseUrl }).await()
  if (options.perception !== false) {
    context.provide('llm', llm)
    context.provide('agentDefaultModel', { currentSelection: () => route })
    context.provide('attachments', attachments)
  }
  if (options.dsh !== false) {
    await context.plugin(SystemPrompt, {}).await()
    await context.plugin(ToolRuntime).await()
  }
  await context.plugin(VhAssets, { root: join(root, 'assets') }).await()
  await context.plugin(DvProject, { root: join(root, 'projects'), gpuConcurrency: 1, cpuConcurrency: 4 }).await()
  await context.plugin(VhMedia, { ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputLimitBytes: 1_048_576 }).await()
  const toolsFiber = context.plugin(VhTools, { perceptionMaxTokens: 1024, imageInput: options.imageInput ?? true, sessionStateRoot: join(root, 'sessions'), publicBaseUrl: '', confirmGpuSecondsThreshold: 60, gpuSecondsPerVideoSecond: 4 })
  await toolsFiber.await()
  let calls = 0
  return {
    context, tools: context.vhTools, toolsFiber, project: context.dvProject, assets: context.vhAssets, media: context.vhMedia,
    generation, llm, attachments, route, root,
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

/** The text of a tool result's content. */
export function resultText(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
