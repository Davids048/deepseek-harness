/**
 * Media tools over `vhMedia`: deterministic cuts, joins, frames, and probes, and the one escape hatch for anything
 * else, `command.run`, which records the command text and its declared outputs.
 *
 * @module @video-harness/tools/specs-media
 */
import type VhMedia from '@video-harness/media'
import type { FrameAt } from '@video-harness/media'
import type { AssetId } from '@video-harness/oplog'
import type { ToolExecution, ToolResult } from '@video-harness/runtime'
import { label, number, text } from './specs-basic.ts'
import type { ToolSpec } from './types.ts'

/** The resolved assets of one input role, in order. */
export function inputAssets(execution: ToolExecution, role: string): AssetId[] {
  return execution.inputs.filter(input => input.role === role)
    .map(input => input.resolved)
    .filter((asset): asset is AssetId => asset !== null)
}

/** The single resolved asset of a role. */
export function requireInput(execution: ToolExecution, role: string): AssetId {
  const asset = inputAssets(execution, role)[0]
  if (asset === undefined) throw new Error(`Input "${role}" is required.`)
  return asset
}

/**
 * The media tools.
 * @param media - the media service they run on.
 * @returns the specs.
 */
/**
 * The frame position a caller asked for: `first`, `last`, a number of seconds, or a numeric string; anything else
 * means the last frame.
 * @param value - the raw `at` argument.
 * @returns the position.
 */
export function frameAt(value: unknown): FrameAt {
  if (value === 'first' || value === 'last') return value
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string') {
    const seconds = Number(value.trim())
    if (value.trim().length > 0 && Number.isFinite(seconds) && seconds >= 0) return seconds
  }
  return 'last'
}

export function mediaTools(media: VhMedia): ToolSpec[] {
  const clipTrim: ToolSpec = {
    name: 'clip.trim',
    version: '2',
    summary: 'Cut a range out of a clip into a new clip. Frame-accurate by default.',
    inputs: { clip: { type: 'video', required: true, description: 'The clip to cut.' } },
    params: {
      startSec: { type: 'number', required: true, description: 'Where the new clip starts, in seconds.' },
      endSec: { type: 'number', description: 'Where it ends; omitted keeps the rest of the clip.' },
      reencode: { type: 'boolean', description: 'false copies streams and cuts on the nearest keyframe; default true.' },
    },
    outputs: [{ role: 'clip', type: 'video' }],
    deterministic: true,
    cost: 'cpu',
    confirm: 'never',
    summarize: op => `trimmed from ${label(op.params['startSec'])}s${op.params['endSec'] === undefined ? '' : ` to ${label(op.params['endSec'])}s`}`,
    async execute(execution): Promise<ToolResult> {
      const clip = requireInput(execution, 'clip')
      const endSec = execution.params['endSec']
      const reencode = execution.params['reencode']
      const output = await media.trim(clip, {
        startSec: number(execution.params['startSec'], 0),
        ...typeof endSec === 'number' ? { endSec } : {},
        ...typeof reencode === 'boolean' ? { reencode } : {},
      }, execution.op.id)
      return { outputs: [output] }
    },
  }

  const mediaConcat: ToolSpec = {
    name: 'media.concat',
    version: '1',
    summary: 'Join clips in order into one video. Use the timeline order unless told otherwise.',
    inputs: { clip: { type: 'video', required: true, many: true, description: 'The clips in playback order.' } },
    params: {},
    outputs: [{ role: 'video', type: 'video' }],
    deterministic: true,
    cost: 'cpu',
    confirm: 'never',
    summarize: op => `joined ${op.inputs.length} clips`,
    async execute(execution): Promise<ToolResult> {
      const clips = inputAssets(execution, 'clip')
      if (clips.length === 0) throw new Error('media.concat needs at least one `clip` input.')
      return { outputs: [await media.concat(clips, execution.op.id)] }
    },
  }

  const extractFrame: ToolSpec = {
    name: 'media.extract_frame',
    version: '1',
    summary: 'Take one frame of a clip as PNG, to look at it or to use it as a reference.',
    inputs: { clip: { type: 'video', required: true, description: 'The clip.' } },
    params: {
      at: { oneOf: [{ type: 'string' }, { type: 'number' }], description: "'first', 'last', or a time in seconds (a number, or a numeric string such as '6.3'); default last." },
    },
    outputs: [{ role: 'frame', type: 'image' }],
    deterministic: true,
    cost: 'cpu',
    confirm: 'never',
    summarize: op => `frame at ${label(op.params['at'], 'last')}`,
    async execute(execution): Promise<ToolResult> {
      const clip = requireInput(execution, 'clip')
      return { outputs: [await media.extractFrame(clip, frameAt(execution.params['at']), execution.op.id)] }
    },
  }

  const probe: ToolSpec = {
    name: 'media.probe',
    version: '1',
    summary: 'Read duration, size, codec, and audio presence of a media asset.',
    inputs: { media: { type: 'any', required: true, description: 'The asset.' } },
    params: {},
    outputs: [{ role: 'info', type: 'json' }],
    deterministic: true,
    cost: 'cpu',
    confirm: 'never',
    summarize: op => `probed ${op.inputs[0]?.resolved?.slice(0, 8) ?? 'asset'}`,
    async execute(execution): Promise<ToolResult> {
      const asset = requireInput(execution, 'media')
      const info = await media.probe(asset)
      const id = execution.assets.put(Buffer.from(JSON.stringify(info)), { mime: 'application/json', name: 'probe.json', producedBy: execution.op.id })
      return { outputs: [id], report: { ...info } }
    },
  }

  const commandRun: ToolSpec = {
    name: 'command.run',
    version: '1',
    summary: 'Run an arbitrary command such as ffmpeg over inputs. Use {{in:0}} for the first input path and {{out:name}} for each declared output. Prefer the structured tools when one fits.',
    inputs: { in: { type: 'any', many: true, description: 'Input assets, referenced as {{in:0}}, {{in:1}}, …' } },
    params: {
      argv: { type: 'array', required: true, items: { type: 'string' }, description: 'The program and its arguments.' },
      outputs: {
        type: 'array', required: true,
        items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, mime: { type: 'string', required: true } } },
        description: 'Files the command writes, referenced as {{out:name}}.',
      },
    },
    outputs: [{ role: 'output', type: 'any' }],
    deterministic: false,
    cost: 'cpu',
    confirm: 'never',
    summarize: op => `ran ${(op.params['argv'] as string[] | undefined)?.join(' ').slice(0, 80) ?? 'command'}`,
    async execute(execution): Promise<ToolResult> {
      const argv = execution.params['argv']
      const outputs = execution.params['outputs']
      if (!Array.isArray(argv) || argv.length === 0) throw new Error('command.run needs a non-empty `argv`.')
      const result = await media.run({
        argv: argv.map(String),
        inputs: inputAssets(execution, 'in'),
        outputs: Array.isArray(outputs) ? (outputs as Array<{ name: string; mime: string }>) : [],
        producedBy: execution.op.id,
      })
      return { outputs: result.outputs, report: { stdout: result.stdout.slice(-2000), stderr: result.stderr.slice(-2000) } }
    },
  }

  return [clipTrim, mediaConcat, extractFrame, probe, commandRun]
}

export { text }
