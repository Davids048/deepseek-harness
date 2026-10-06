/**
 * Mounting for the agent integration specs: the DSH system prompt and tool registry, the Project service, the asset
 * pool, `dvFfmpeg`, the Story bible, Shot plan, Shot render and Timeline components, and the agent integration over a
 * temporary root, with fakes for the generation backend and the attachment service.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ModelFacts, SegmentOutput, SegmentRequest } from '@dreamverse/generation-client'
import DvAssetPool from '@dv/asset-pool'
import DvFfmpeg from '@dv/ffmpeg'
import DvProject from '@dv/project'
import DvShotPlan from '@dv/shot-plan'
import DvShotRender from '@dv/shot-render'
import DvStoryBible from '@dv/story-bible'
import DvTimeline from '@dv/timeline'

/** The ffmpeg and ffprobe the fixtures use; the native build on this host, overridable for other machines. */
const FFMPEG = process.env['DV_FFMPEG'] ?? '/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg'
const FFPROBE = process.env['DV_FFPROBE'] ?? 'ffprobe'

const run = promisify(execFile)

/** A reference-image model with small frames, so the fake backend renders quickly. */
function testFacts(): ModelFacts {
  const frames = Object.fromEntries([1, 2, 3, 4, 5].map(seconds => [String(seconds), seconds * 24 + 1]))
  return {
    modelId: 'test-ref2va', name: 'Test Ref2VA', generationModes: { ref2va: 'reference_images' }, unsupportedGenerationModes: {},
    aspectRatios: ['16:9'], resolutions: ['720p'], minSegmentDurationSec: 1, maxSegmentDurationSec: 5, maxReferenceImages: 3,
    maxReferenceAspectRatio: 4, usesPreviousFrame: true, frameSizes: { '16:9': { '720p': [192, 112] } },
    numFramesByDurationSec: frames, referenceLabels: ['Picture 1', 'Picture 2', 'Picture 3'],
  }
}

/** A generation backend that renders a solid-color clip with ffmpeg for every request. */
class FakeGeneration {
  readonly facts = testFacts()

  model(): Promise<ModelFacts> {
    return Promise.resolve(this.facts)
  }

  /** Render the request's frames as a solid clip, then stream its last frame, its bytes, and completion. */
  async *generateSegment(request: SegmentRequest): AsyncIterable<SegmentOutput> {
    const dir = mkdtempSync(join(tmpdir(), 'dv-agent-generation-'))
    try {
      const video = join(dir, 'clip.mp4')
      const frame = join(dir, 'last.png')
      const seconds = (request.numFrames / 24).toFixed(3)
      await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x3366cc:s=${request.frameWidth}x${request.frameHeight}:d=${seconds}:r=24`,
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video])
      await run(FFMPEG, ['-y', '-loglevel', 'error', '-sseof', '-0.05', '-i', video, '-frames:v', '1', frame])
      yield { kind: 'last_frame', png: readFileSync(frame) }
      yield { kind: 'video_start', mime: 'video/mp4' }
      yield { kind: 'chunk', bytes: readFileSync(video) }
      yield { kind: 'done', timings: { generation_s: 0.25 } }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** An attachment service that accepts every image and reads it back. */
export class FakeAttachments {
  readonly saved: SaveImageAttachment[] = []

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    return Promise.resolve({
      attachmentId: brandString<ImageAttachmentRef['attachmentId']>(`att-${this.saved.length}`), mediaType: input.mediaType,
      bytes: input.data.byteLength, width: 192, height: 112, ...input.name === undefined ? {} : { name: input.name },
    })
  }

  /** Read back a saved image by its reference. */
  readImage(ref: ImageAttachmentRef): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }> {
    const saved = this.saved[Number(ref.attachmentId.slice('att-'.length)) - 1]
    if (saved === undefined) return Promise.reject(new Error(`unknown attachment ${ref.attachmentId}`))
    return Promise.resolve({ ref, data: saved.data })
  }
}

/** One mounted composition without the agent integration; the specs mount it with their own config. */
export interface AgentBase {
  context: Context
  project: DvProject
  assets: DvAssetPool
  attachments: FakeAttachments
  /** The temporary root; removed on disposal. */
  root: string
  /** Write a file with the given content and return its path, for imports. */
  writeFile(name: string, content?: string): string
  dispose(): Promise<void>
}

/**
 * Mount the composition in a fresh Cordis root.
 * @param publicBaseUrl - the asset pool's public URL base.
 * @returns the composition.
 */
export async function startBase(publicBaseUrl = ''): Promise<AgentBase> {
  const root = mkdtempSync(join(tmpdir(), 'dv-agent-'))
  const context = new Context()
  const attachments = new FakeAttachments()
  context.provide('dreamverseGeneration', new FakeGeneration())
  context.provide('attachments', attachments)
  await context.plugin(SystemPrompt, {}).await()
  await context.plugin(ToolRuntime).await()
  await context.plugin(DvProject, { root: join(root, 'projects'), gpuConcurrency: 1, cpuConcurrency: 4, sessionRoot: join(root, 'sessions') }).await()
  await context.plugin(DvFfmpeg, { ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputLimitBytes: 1_048_576 }).await()
  await context.plugin(DvAssetPool, { root: join(root, 'assets'), publicBaseUrl }).await()
  await context.plugin(DvTimeline).await()
  await context.plugin(DvShotPlan).await()
  await context.plugin(DvStoryBible).await()
  await context.plugin(DvShotRender, { gpuSecondsPerVideoSecond: 4 }).await()
  return {
    context, project: context.dvProject, assets: context.dvAssetPool, attachments, root,
    writeFile(name, content = `FILE:${name}`) {
      const path = join(root, name)
      writeFileSync(path, content)
      return path
    },
    dispose: async () => {
      await context.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** The text of a tool result's content. */
export function resultText(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
