/**
 * Media tools over `vhMedia`: deterministic trims, joins, frames, and probes.
 *
 * @module @video-harness/tools/specs-media
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId, OperationContext, OperationResult, ProjectRecord } from '@dv/project'
import type { PutOptions } from '@video-harness/assets'
import type VhMedia from '@video-harness/media'
import type { FrameAt } from '@video-harness/media'
import { label, number, text } from './specs-basic.ts'
import type { ToolSpec } from './types.ts'

/** The resolved assets of one input role, in order. */
export function inputAssets(context: Pick<OperationContext, 'inputs'>, role: string): AssetId[] {
  return context.inputs.filter(input => input.role === role)
    .map(input => input.resolved_asset)
    .filter((asset): asset is AssetId => asset !== null)
}

/** The single resolved asset of a role. */
export function requireInput(context: Pick<OperationContext, 'inputs'>, role: string): AssetId {
  const asset = inputAssets(context, role)[0]
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

/**
 * The asset store's producer ID of a running record, for the media service, which stores its outputs itself.
 * @param context - the running call.
 * @returns the record ID in the asset store's form.
 */
function producerOf(context: OperationContext): NonNullable<PutOptions['producedBy']> | null {
  return context.record === null ? null : brandString<NonNullable<PutOptions['producedBy']>>(context.record.id)
}

/** The asset an input of a finished record stood for, for summaries. */
function firstInput(record: ProjectRecord): string {
  return record.inputs[0]?.resolved_asset?.slice(0, 8) ?? 'asset'
}

export function mediaTools(media: VhMedia): ToolSpec[] {
  // `clip.trim` exists only for the timeline export, which trims each clip with an in or out point before the join. The
  // agent and the canvas do not get it.
  const clipTrim: ToolSpec = {
    name: 'clip.trim',
    component: 'deliver',
    version: '2',
    summary: 'Cut a range out of a clip into a new clip. Frame-accurate by default.',
    inputs: { clip: { type: 'video', required: true, description: 'The clip to cut.' } },
    inputRoles: ['clip'],
    params: {
      startSec: { type: 'number', required: true, description: 'Where the new clip starts, in seconds.' },
      endSec: { type: 'number', description: 'Where it ends; omitted keeps the rest of the clip.' },
      reencode: { type: 'boolean', description: 'false copies streams and cuts on the nearest keyframe; default true.' },
    },
    outputs: [{ role: 'clip', type: 'video' }],
    deterministic: true,
    resource: 'cpu',
    confirm: 'never',
    summarize: record => `trimmed from ${label(record.params['startSec'])}s`
      + `${record.params['endSec'] === undefined ? '' : ` to ${label(record.params['endSec'])}s`}`,
    async execute(context): Promise<OperationResult> {
      const clip = requireInput(context, 'clip')
      const endSec = context.params['endSec']
      const reencode = context.params['reencode']
      const output = await media.trim(clip, {
        startSec: number(context.params['startSec'], 0),
        ...typeof endSec === 'number' ? { endSec } : {},
        ...typeof reencode === 'boolean' ? { reencode } : {},
      }, producerOf(context))
      return { outputs: [output] }
    },
  }

  const mediaConcat: ToolSpec = {
    name: 'media.concat',
    component: 'deliver',
    version: '1',
    summary: 'Join clips in order into one video. Use the timeline order unless told otherwise.',
    inputs: { clip: { type: 'video', required: true, many: true, description: 'The clips in playback order.' } },
    inputRoles: ['clip'],
    params: {},
    outputs: [{ role: 'video', type: 'video' }],
    deterministic: true,
    resource: 'cpu',
    confirm: 'never',
    summarize: record => `joined ${record.inputs.length} clips`,
    async execute(context): Promise<OperationResult> {
      const clips = inputAssets(context, 'clip')
      if (clips.length === 0) throw new Error('media.concat needs at least one `clip` input.')
      return { outputs: [await media.concat(clips, producerOf(context))] }
    },
  }

  const extractFrame: ToolSpec = {
    name: 'media.extract_frame',
    component: 'asset',
    version: '1',
    summary: 'Take one frame of a clip as PNG, to look at it or to use it as a reference.',
    inputs: { clip: { type: 'video', required: true, description: 'The clip.' } },
    inputRoles: ['clip'],
    params: {
      at: { oneOf: [{ type: 'string' }, { type: 'number' }], description: "'first', 'last', or a time in seconds (a number, or a numeric string such as '6.3'); default last." },
    },
    outputs: [{ role: 'frame', type: 'image' }],
    deterministic: true,
    resource: 'cpu',
    confirm: 'never',
    summarize: record => `frame at ${label(record.params['at'], 'last')}`,
    async execute(context): Promise<OperationResult> {
      const clip = requireInput(context, 'clip')
      return { outputs: [await media.extractFrame(clip, frameAt(context.params['at']), producerOf(context))] }
    },
  }

  const probe: ToolSpec = {
    name: 'media.probe',
    component: 'inspect',
    version: '1',
    summary: 'Read duration, size, codec, and audio presence of a media asset.',
    inputs: { media: { type: 'any', required: true, description: 'The asset.' } },
    inputRoles: ['media'],
    params: {},
    outputs: [{ role: 'info', type: 'json' }],
    deterministic: true,
    resource: 'cpu',
    confirm: 'never',
    summarize: record => `probed ${firstInput(record)}`,
    async execute(context): Promise<OperationResult> {
      const asset = requireInput(context, 'media')
      const info = await media.probe(asset)
      const id = context.importAsset(Buffer.from(JSON.stringify(info)), { mime: 'application/json', name: 'probe.json' })
      return { outputs: [id], report: { ...info } }
    },
  }

  return [clipTrim, mediaConcat, extractFrame, probe]
}

export { text }
