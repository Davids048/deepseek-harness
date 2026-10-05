/**
 * The tools the runtime ships so a project works before any model-backed tool is mounted: uploads, entities, plans,
 * sequence edits, a deterministic clip trim through ffmpeg, and a placeholder video generator that renders a solid
 * color clip with ffmpeg's `lavfi` source. Model-backed tools replace `generate.video` in a profile by registering the
 * same name.
 *
 * @module @video-harness/runtime/builtins
 */
import { execFile } from 'node:child_process'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { AssetId } from '@video-harness/oplog'
import { ENTITY_CREATE_TOOL, ENTITY_UPDATE_TOOL, SEQUENCE_TOOLS } from './fold.ts'
import type { RuntimeToolSpec, ToolExecution, ToolResult } from './types.ts'

const run = promisify(execFile)

/** A params field as text, or the fallback when it is absent or not a string. */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** A params field as a number, or the fallback when it is absent or not a finite number. */
function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** The placeholder generator renders this many frames per second. */
const PLACEHOLDER_FPS = 12

/**
 * A stable color for a prompt, so two placeholder clips with different prompts look different.
 * @param prompt - the clip prompt.
 * @returns an `RRGGBB` hex color.
 */
function colorFor(prompt: string): string {
  let hash = 0
  for (const char of prompt) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `${(hash & 0xff).toString(16).padStart(2, '0')}${((hash >> 8) & 0xff).toString(16).padStart(2, '0')}${((hash >> 16) & 0xff).toString(16).padStart(2, '0')}`
}

/**
 * Render a solid-color mp4 and its last frame as png into the scratch directory.
 * @param ffmpeg - the ffmpeg binary.
 * @param execution - the tool call; `params.prompt`, `params.durationSec`, `params.width`, `params.height`.
 * @returns the two file paths.
 */
async function renderPlaceholder(ffmpeg: string, execution: ToolExecution): Promise<{ video: string; lastFrame: string }> {
  const prompt = text(execution.params['prompt'], '')
  const duration = number(execution.params['durationSec'], 2)
  const width = number(execution.params['width'], 320)
  const height = number(execution.params['height'], 180)
  const video = join(execution.scratchDir, 'clip.mp4')
  const lastFrame = join(execution.scratchDir, 'last.png')
  const source = `color=c=0x${colorFor(prompt)}:s=${width}x${height}:d=${duration}:r=${PLACEHOLDER_FPS}`
  await run(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video])
  await run(ffmpeg, ['-y', '-loglevel', 'error', '-sseof', '-0.1', '-i', video, '-frames:v', '1', lastFrame])
  return { video, lastFrame }
}

/** `generate.video` placeholder: a solid-color clip whose color follows the prompt. */
function placeholderGenerate(ffmpeg: string): RuntimeToolSpec {
  return {
    name: 'generate.video',
    version: 'placeholder-1',
    deterministic: false,
    cost: 'gpu',
    async execute(execution): Promise<ToolResult> {
      const rendered = await renderPlaceholder(ffmpeg, execution)
      const duration = number(execution.params['durationSec'], 2)
      const video = execution.assets.put({ path: rendered.video }, {
        mime: 'video/mp4', name: `${execution.op.id.slice(0, 8)}.mp4`, producedBy: execution.op.id, durationSec: duration,
      })
      const lastFrame = execution.assets.put({ path: rendered.lastFrame }, {
        mime: 'image/png', name: `${execution.op.id.slice(0, 8)}-last.png`, producedBy: execution.op.id,
      })
      return { outputs: [video, lastFrame], cost: { gpu_s: 0, wall_s: 0 } }
    },
  }
}

/** `clip.trim`: cut `startSec..endSec` out of the single `clip` input into a new asset; deterministic. */
function clipTrim(ffmpeg: string): RuntimeToolSpec {
  return {
    name: 'clip.trim',
    version: '1',
    deterministic: true,
    cost: 'cpu',
    async execute(execution): Promise<ToolResult> {
      const clip = execution.inputs.find(input => input.role === 'clip')?.resolved
      if (clip === undefined || clip === null) throw new Error('clip.trim needs a `clip` input.')
      const output = join(execution.scratchDir, 'trimmed.mp4')
      const args = ['-y', '-loglevel', 'error', '-ss', String(number(execution.params['startSec'], 0)), '-i', execution.assets.path(clip)]
      const endSec = execution.params['endSec']
      if (typeof endSec === 'number') args.push('-to', String(endSec))
      await run(ffmpeg, [...args, '-c', 'copy', '-movflags', '+faststart', output])
      const trimmed = execution.assets.put({ path: output }, { mime: 'video/mp4', name: 'trimmed.mp4', producedBy: execution.op.id })
      return { outputs: [trimmed] }
    },
  }
}

/** `asset.upload`: bring a file on disk into the store. */
const assetUpload: RuntimeToolSpec = {
  name: 'asset.upload',
  version: '1',
  deterministic: true,
  cost: 'free',
  execute(execution): Promise<ToolResult> {
    const path = text(execution.params['path'], '')
    const id = execution.assets.put({ path }, {
      mime: text(execution.params['mime'], 'application/octet-stream'), name: text(execution.params['name'], basename(path)),
      producedBy: execution.op.id,
    })
    return Promise.resolve({ outputs: [id] })
  },
}

/** A tool whose whole effect is its record: the fold reads the params. */
function recordOnly(name: string): RuntimeToolSpec {
  return {
    name,
    version: '1',
    deterministic: true,
    cost: 'free',
    execute: () => Promise.resolve({ outputs: [] }),
  }
}

/** `plan.create`: store the plan JSON as an asset so the plan is reviewable like any other artifact. */
const planCreate: RuntimeToolSpec = {
  name: 'plan.create',
  version: '1',
  deterministic: true,
  cost: 'free',
  execute(execution): Promise<ToolResult> {
    const bytes = Buffer.from(JSON.stringify(execution.params['plan'] ?? {}, null, 2))
    const id = execution.assets.put(bytes, { mime: 'application/json', name: 'plan.json', producedBy: execution.op.id })
    return Promise.resolve({ outputs: [id] })
  },
}

/**
 * Every built-in tool.
 * @param ffmpeg - the ffmpeg binary used by the trim and the placeholder generator.
 * @returns the specs, in registration order.
 */
export function builtinTools(ffmpeg: string): RuntimeToolSpec[] {
  return [
    assetUpload,
    recordOnly(ENTITY_CREATE_TOOL),
    recordOnly(ENTITY_UPDATE_TOOL),
    planCreate,
    // `plan.approve` is a record whose params name the plan; the runtime schedules the plan's shots after it.
    recordOnly('plan.approve'),
    ...Object.values(SEQUENCE_TOOLS).map(recordOnly),
    clipTrim(ffmpeg),
    placeholderGenerate(ffmpeg),
  ]
}

/**
 * Whether an ffmpeg binary exists and runs.
 * @param ffmpeg - a path.
 * @returns true when `ffmpeg -version` succeeds.
 */
export async function ffmpegAvailable(ffmpeg: string): Promise<boolean> {
  try {
    await run(ffmpeg, ['-version'])
    return true
  } catch (error: unknown) {
    void error // a missing or broken binary only disables the ffmpeg-backed tools
    return false
  }
}

export type { AssetId }
