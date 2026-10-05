/**
 * `generate.video` over the DreamVerse generation backend: one shot from a prompt, the reference images of the
 * entities it names, and optionally the last frame of the shot it continues. The backend's model facts decide the
 * frame size and frame count; the DreamVerse conditioning rules decide which images the request carries in which
 * order. The video and its last frame are stored as two outputs, so a later shot can start from output `#1`.
 *
 * @module @video-harness/tools/specs-generate
 */
import { randomInt } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  segmentImageLabels, segmentRequestImages, validateReferenceAssets, type AssetRecord, type DreamverseGeneration, type ModelFacts,
} from '@dreamverse/segment-generation'
import type { AssetId, OpId, ProjectId } from '@video-harness/oplog'
import { GENERATE_VIDEO_TOOL, type ToolExecution, type ToolResult } from '@video-harness/runtime'
import type VhAssets from '@video-harness/assets'
import { label, number, text } from './specs-basic.ts'
import { inputAssets } from './specs-media.ts'
import type { ToolSpec } from './types.ts'

/** The seed range of the generation backend. */
const SEED_LIMIT = 2 ** 31

/**
 * Where a shot's bytes go while the backend is still producing them, so browsers can watch the shot generate. The
 * shape is `@video-harness/stream`'s `openSegment`; the tool only needs the structural type.
 */
export interface SegmentStreamSink {
  openSegment(projectId: ProjectId, opId: OpId, init: { mime: string; segmentIdx: number }): {
    chunk(bytes: Uint8Array): void
    complete(): void
    fail(error: Error): void
  }
}

/** The live stream of one shot, or null while no sink is mounted. */
type LiveSegment = ReturnType<SegmentStreamSink['openSegment']> | null

/**
 * A DreamVerse asset record over a harness asset, so the DreamVerse conditioning helpers can read the file.
 * @param assets - the harness store.
 * @param id - the asset.
 * @returns the record; its owner is nominal because the harness store has no owners.
 */
export function assetRecord(assets: VhAssets, id: AssetId): AssetRecord {
  const meta = assets.get(id)
  return {
    assetId: brandString<AssetRecord['assetId']>(id), owner: 'library', name: meta.name, mediaType: meta.mime.startsWith('video/') ? 'video' : 'image',
    mimeType: meta.mime, filePath: assets.path(id), sizeBytes: meta.sizeBytes, width: meta.width, height: meta.height,
    durationSec: meta.durationSec, createdAt: meta.createdAt,
  }
}

/** The frame size and frame count a shot asks for, after the model facts validated the choices. */
export interface ShotGeometry {
  mode: string
  aspectRatio: string
  resolution: string
  width: number
  height: number
  durationSec: number
  numFrames: number
}

/**
 * Resolve a shot's geometry from its params and the served model's facts. Omitted params take the model's first
 * mode, first aspect ratio, first resolution, and shortest duration.
 * @param facts - the served model.
 * @param params - the record params.
 * @returns the geometry.
 * @throws Error naming the allowed values when a param is outside the model's facts.
 */
export function shotGeometry(facts: ModelFacts, params: Record<string, unknown>): ShotGeometry {
  const mode = text(params['generation_mode'], Object.keys(facts.generationModes)[0] ?? '')
  if (facts.generationModes[mode] === undefined) throw new Error(`generation_mode must be one of ${Object.keys(facts.generationModes).join(', ')}.`)
  const aspectRatio = text(params['aspect_ratio'], facts.aspectRatios[0] ?? '')
  const resolution = text(params['resolution'], facts.resolutions[0] ?? '')
  const size = facts.frameSizes[aspectRatio]?.[resolution]
  if (size === undefined) throw new Error(`aspect_ratio and resolution must be one of ${facts.aspectRatios.join(', ')} at ${facts.resolutions.join(', ')}.`)
  const durationSec = number(params['duration_sec'], facts.minSegmentDurationSec)
  const numFrames = facts.numFramesByDurationSec[String(durationSec)]
  if (numFrames === undefined) throw new Error(`duration_sec must be a whole number from ${facts.minSegmentDurationSec} to ${facts.maxSegmentDurationSec}.`)
  return { mode, aspectRatio, resolution, width: size[0], height: size[1], durationSec, numFrames }
}

/**
 * The backend's end-to-end time of one request in seconds: the longest timing it reported, because the end-to-end
 * timing includes the others. Keys ending in `_ms` are milliseconds; other keys are seconds.
 * @param timings - the backend's `done` timings.
 * @returns seconds, rounded to milliseconds; 0 when the backend reported none.
 */
export function backendSeconds(timings: Record<string, number>): number {
  const seconds = Object.entries(timings).map(([key, value]) => key.endsWith('_ms') ? value / 1000 : value)
  return Math.round(Math.max(0, ...seconds) * 1000) / 1000
}

/** The MIME type without parameters, as the asset store records it. */
function baseMime(mime: string): string {
  return mime.replace(/;.*$/s, '').trim()
}

/**
 * Request one shot from the backend and store its video and last frame. While a stream sink is mounted, the chunks
 * also go to it as they arrive, so browsers watch the shot before the record completes.
 * @param generation - the backend client.
 * @param execution - the tool call.
 * @param streamSink - looks the live sink up per call, so a sink mounted later is still used.
 * @returns the video and last-frame assets with the recorded generation facts.
 */
async function generateShot(
  generation: DreamverseGeneration,
  execution: ToolExecution,
  streamSink?: () => SegmentStreamSink | undefined,
): Promise<ToolResult> {
  const facts = await generation.model()
  const geometry = shotGeometry(facts, execution.params)
  const prompt = text(execution.params['prompt'])
  if (prompt === '') throw new Error('generate.video needs a `prompt`.')
  const references = inputAssets(execution, 'reference')
  const firstFrame = inputAssets(execution, 'first_frame')[0]
  validateReferenceAssets(facts, geometry.mode, references.length)
  const continues = firstFrame !== undefined
  const referenceImages = await segmentRequestImages(
    facts, geometry.mode, references.map(id => assetRecord(execution.assets, id)),
    continues ? assetRecord(execution.assets, firstFrame) : null,
  )
  const seed = number(execution.params['seed'], randomInt(SEED_LIMIT))
  const videoPath = join(execution.scratchDir, 'shot.mp4')
  const file = createWriteStream(videoPath)
  let lastFrame: Buffer | null = null
  let mime: string | null = null
  let timings: Record<string, number> = {}
  let finished = false
  let live: LiveSegment = null
  try {
    for await (const output of generation.generateSegment({
      prompt, frameWidth: geometry.width, frameHeight: geometry.height, numFrames: geometry.numFrames, referenceImages, seed,
      returnLastFrame: true,
    })) {
      switch (output.kind) {
        case 'last_frame':
          lastFrame = output.png
          break
        case 'video_start':
          mime = output.mime
          // The slot a plan assigned the shot tells the page which clip is playing; a free-standing shot has none.
          live = streamSink?.()?.openSegment(execution.projectId, execution.op.id, { mime: output.mime, segmentIdx: number(execution.params['shot'], 0) }) ?? null
          break
        case 'chunk':
          live?.chunk(output.bytes)
          if (!file.write(output.bytes)) await new Promise<void>(resolve => file.once('drain', resolve))
          break
        case 'done':
          timings = output.timings
          finished = true
          live?.complete()
          live = null
          break
        /* v8 ignore next 4 -- closed-union exhaustiveness guard. */
        default: {
          const unexpected: never = output
          throw new Error(`Unexpected segment output: ${JSON.stringify(unexpected)}`)
        }
      }
    }
  } catch (error) {
    live?.fail(error instanceof Error ? error : new Error(String(error)))
    live = null
    throw error
  } finally {
    await new Promise<void>(resolve => file.end(resolve))
  }
  if (live !== null) live.fail(new Error('The generation stream ended before the backend reported completion.'))
  if (!finished || mime === null) throw new Error('The generation stream ended before the backend reported completion.')
  if (lastFrame === null) throw new Error('The backend returned no last frame.')
  const shortId = execution.op.id.slice(0, 8)
  const video = execution.assets.put({ path: videoPath }, {
    mime: baseMime(mime), name: `${shortId}.mp4`, producedBy: execution.op.id, width: geometry.width, height: geometry.height, durationSec: geometry.durationSec,
  })
  const frame = execution.assets.put(lastFrame, { mime: 'image/png', name: `${shortId}-last.png`, producedBy: execution.op.id, width: geometry.width, height: geometry.height })
  const labels = segmentImageLabels(facts, geometry.mode, references.length, continues)
  return {
    outputs: [video, frame],
    cost: { gpu_s: backendSeconds(timings) },
    report: {
      seed, model: facts.modelId, generation_mode: geometry.mode, aspect_ratio: geometry.aspectRatio, resolution: geometry.resolution,
      duration_sec: geometry.durationSec, frame_width: geometry.width, frame_height: geometry.height, num_frames: geometry.numFrames,
      image_labels: labels, timings,
    },
  }
}

/**
 * The `generate.video` tool over a generation backend client.
 * @param generation - the backend client.
 * @param streamSink - looks up the live media sink (`vhStream`) per call; omitted, shots are only stored.
 * @returns the spec.
 */
export function generateVideoTool(generation: DreamverseGeneration, streamSink?: () => SegmentStreamSink | undefined): ToolSpec {
  return {
    name: GENERATE_VIDEO_TOOL,
    version: 'dreamverse-1',
    summary: 'Generate one shot from a prompt and reference images. Name characters and styles through the reference input (c1@1); pass continue_from to start from the last frame of an earlier shot. Outputs: the video, then its last frame. Every call is a new take; a changed prompt for the same shot passes base_op.',
    inputs: {
      reference: { type: 'image', many: true, entity: true, description: 'Reference images or entity versions whose reference images the shot carries, in prompt order (Picture 1, Picture 2, …).' },
      first_frame: { type: 'image', description: 'The frame the shot starts from, usually output #1 of the previous shot.' },
    },
    params: {
      prompt: { type: 'string', required: true, description: 'The complete shot prompt; refer to reference images as Picture 1, Picture 2, … in input order.' },
      duration_sec: { type: 'integer', description: 'Whole seconds within the model range; default the model minimum.' },
      aspect_ratio: { type: 'string', description: 'One of the model aspect ratios; default the first.' },
      resolution: { type: 'string', description: 'One of the model resolutions; default the first.' },
      generation_mode: { type: 'string', description: 'One of the model generation modes; default the first.' },
      seed: { type: 'integer', description: 'Fixed seed; omitted, a random seed is drawn and recorded.' },
    },
    outputs: [{ role: 'video', type: 'video' }, { role: 'last_frame', type: 'image' }],
    deterministic: false,
    cost: 'gpu',
    confirm: 'cost',
    summarize: op => `shot "${text(op.params['prompt']).slice(0, 60)}" (${label(op.report?.['duration_sec'] ?? op.params['duration_sec'])}s, seed ${label(op.report?.['seed'])})`,
    execute: execution => generateShot(generation, execution, streamSink),
  }
}
