/**
 * Tools whose effect is a record and at most a small file: uploads, entity versions, plans, and sequence edits. The
 * fold interprets their params; `plan.create` stores the plan document as a JSON asset so the agent and the user can
 * read the same text before anything is generated.
 *
 * @module @video-harness/tools/specs-basic
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { PLAN_APPROVE_TOOL, SEQUENCE_TOOLS, type PlanDocument, type ToolResult } from '@video-harness/runtime'
import type { ToolSpec } from './types.ts'

/** A params field as text, or the fallback when it is absent or not a string. */
export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** A number or string field as display text, or the fallback for anything else. */
export function label(value: unknown, fallback = '?'): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : fallback
}

/** A params field as a finite number, or the fallback. */
export function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** A tool that writes nothing but its record. */
function recordOnly(spec: Omit<ToolSpec, 'version' | 'deterministic' | 'cost' | 'confirm' | 'outputs' | 'execute'>): ToolSpec {
  return { ...spec, version: '1', deterministic: true, cost: 'free', confirm: 'never', outputs: [], execute: () => Promise.resolve({ outputs: [] }) }
}

/** `asset.upload`: a file on disk, or inline base64 bytes, becomes an asset. */
export const assetUpload: ToolSpec = {
  name: 'asset.upload',
  version: '1',
  summary: 'Bring a file into the project: a path on this machine, or base64 bytes. Returns the asset ID to reference later.',
  inputs: {},
  params: {
    path: { type: 'string', description: 'Absolute path of the file to import.' },
    base64: { type: 'string', description: 'The file bytes as base64, when there is no path.' },
    mime: { type: 'string', required: true, description: 'MIME type, such as image/png or video/mp4.' },
    name: { type: 'string', description: 'Display name; defaults to the file name.' },
  },
  outputs: [{ role: 'asset', type: 'any' }],
  deterministic: true,
  cost: 'free',
  confirm: 'never',
  summarize: op => `uploaded ${text(op.params['name'], basename(text(op.params['path'], 'bytes')))}`,
  execute(execution): Promise<ToolResult> {
    const path = text(execution.params['path'])
    const base64 = text(execution.params['base64'])
    if (path === '' && base64 === '') throw new Error('asset.upload needs `path` or `base64`.')
    const bytes = path === '' ? Buffer.from(base64, 'base64') : readFileSync(path)
    const id = execution.assets.put(bytes, {
      mime: text(execution.params['mime'], 'application/octet-stream'),
      name: text(execution.params['name'], path === '' ? 'upload' : basename(path)),
      producedBy: execution.op.id,
    })
    return Promise.resolve({ outputs: [id] })
  },
}

/** `entity.<kind>.create` and `entity.<kind>.update` for one entity kind. */
export function entityTools(kind: 'character' | 'style' | 'location'): ToolSpec[] {
  const refsParam = { type: 'array', items: { type: 'string' }, description: 'Asset IDs of the reference images.' } as const
  return [
    recordOnly({
      name: `entity.${kind}.create`,
      summary: `Register a ${kind} that later shots refer to by name. Returns version 1; shots reference it as <entity>@1.`,
      inputs: {},
      params: {
        entity: { type: 'string', required: true, description: 'Short stable ID, such as c1.' },
        name: { type: 'string', required: true, description: 'Display name.' },
        description: { type: 'string', description: 'Appearance, wardrobe, mood, or style words carried into every prompt.' },
        refs: refsParam,
      },
      summarize: op => `${kind} ${text(op.params['name'], text(op.params['entity']))} created`,
    }),
    recordOnly({
      name: `entity.${kind}.update`,
      summary: `Change a ${kind}: new reference images or description. Produces the next version and marks everything made with the previous version as stale.`,
      inputs: {},
      params: {
        entity: { type: 'string', required: true, description: 'The entity ID.' },
        name: { type: 'string' },
        description: { type: 'string' },
        refs: refsParam,
      },
      summarize: op => `${kind} ${text(op.params['entity'])} updated`,
    }),
  ]
}

const SHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prompt: { type: 'string', required: true, description: 'The complete prompt of this shot.' },
    duration_sec: { type: 'integer', description: 'Seconds; defaults to the model minimum.' },
    references: { type: 'array', items: { type: 'string' }, description: 'Entity versions (c1@1) or asset IDs this shot uses instead of the plan references.' },
    seed: { type: 'integer' },
  },
} as const

const PLAN_PARAMS = {
  title: { type: 'string' },
  continuity: { type: 'string', enum: ['independent', 'chained'], description: 'chained: each shot starts from the previous shot\'s last frame.' },
  references: { type: 'array', items: { type: 'string' }, description: 'Entity versions (c1@1) or asset IDs every shot references.' },
  aspect_ratio: { type: 'string' },
  resolution: { type: 'string' },
  generation_mode: { type: 'string' },
  seed: { type: 'integer' },
  shots: { type: 'array', required: true, items: SHOT_SCHEMA },
} as const

/** Serialize a plan document from params. */
function planFrom(params: Record<string, unknown>): PlanDocument {
  const { shots, ...rest } = params
  return { ...rest, shots: Array.isArray(shots) ? shots as PlanDocument['shots'] : [] }
}

/** `plan.create`: the shots and settings as a JSON asset; nothing is generated until `plan.approve`. */
export const planCreate: ToolSpec = {
  name: 'plan.create',
  version: '1',
  summary: 'Propose a plan: the shots with prompts and durations, the references, and whether shots chain from each other. Nothing is generated until the user approves it with plan.approve.',
  inputs: {},
  params: PLAN_PARAMS,
  outputs: [{ role: 'plan', type: 'json' }],
  deterministic: true,
  cost: 'free',
  confirm: 'never',
  summarize: op => `plan with ${(op.params['shots'] as unknown[] | undefined)?.length ?? 0} shots`,
  execute(execution): Promise<ToolResult> {
    const plan = planFrom(execution.params)
    if (plan.shots.length === 0) throw new Error('plan.create needs at least one shot.')
    const id = execution.assets.put(Buffer.from(JSON.stringify(plan, null, 2)), { mime: 'application/json', name: 'plan.json', producedBy: execution.op.id })
    return Promise.resolve({ outputs: [id] })
  },
}

/** `plan.update`: a changed copy of an earlier plan, recorded with `base_op`. */
export const planUpdate: ToolSpec = {
  ...planCreate,
  name: 'plan.update',
  summary: 'Revise a proposed plan. Pass the earlier plan record as base_op; the revised document replaces it for approval.',
  summarize: op => `plan revised (${(op.params['shots'] as unknown[] | undefined)?.length ?? 0} shots)`,
}

/** `plan.approve`: the user's go-ahead; the runtime schedules one generation per shot after it. */
export const planApprove: ToolSpec = {
  ...recordOnly({
    name: PLAN_APPROVE_TOOL,
    summary: 'Record the user\'s approval of a plan and start generating its shots in order. Only call this after the user agreed to the plan you showed them.',
    inputs: {},
    params: { plan: { type: 'string', required: true, description: 'The plan.create or plan.update record ID.' } },
    summarize: op => `plan ${text(op.params['plan']).slice(0, 8)} approved`,
  }),
  confirm: 'always',
}

/** The `sequence` param every sequence tool takes: which video of the project it edits. */
const SEQUENCE_PARAM = {
  sequence: { type: 'string', description: 'The video to edit, such as v1 or v2 (see `sequences` in vh_project_state). Defaults to the first video.' },
} as const

/** The video a sequence record names, as display text. */
function videoOf(op: { params: Record<string, unknown> }): string {
  const id = text(op.params['sequence'])
  return id === '' ? '' : `${id} `
}

/** The nine `sequence.*` tools: each video's timeline is the fold of these records. */
export const sequenceTools: ToolSpec[] = [
  recordOnly({
    name: SEQUENCE_TOOLS.create,
    summary: 'Create a video (a timeline) from clips in order, or replace an existing video\'s clips. A project can hold several videos: pass a new `sequence` ID (v2, v3, ...) and a `title` to add one; pass an existing ID to replace its clips; omit it to replace the first video. An empty `assets` list makes an empty video.',
    inputs: { clip: { type: 'video', description: 'The clips in order, when the assets are outputs of scheduled records.', many: true } },
    params: {
      ...SEQUENCE_PARAM,
      title: { type: 'string', description: 'Display title of the video, such as 第 2 集.' },
      assets: { type: 'array', items: { type: 'string' }, description: 'Clip asset IDs in playback order.' },
    },
    summarize: op => `${videoOf(op)}sequence of ${(op.params['assets'] as unknown[] | undefined)?.length ?? op.inputs.length} clips`,
  }),
  recordOnly({
    name: SEQUENCE_TOOLS.replace,
    summary: 'Put a different clip in a slot of a video; the slot\'s in and out points reset.',
    inputs: {},
    params: { ...SEQUENCE_PARAM, slot: { type: 'integer', required: true }, asset: { type: 'string', required: true, description: 'The clip asset ID.' } },
    summarize: op => `${videoOf(op)}slot ${label(op.params['slot'])} replaced`,
  }),
  recordOnly({
    name: SEQUENCE_TOOLS.move,
    summary: 'Move a slot of a video to another position; the other slots shift.',
    inputs: {},
    params: { ...SEQUENCE_PARAM, from: { type: 'integer', required: true }, to: { type: 'integer', required: true } },
    summarize: op => `${videoOf(op)}slot ${label(op.params['from'])} moved to ${label(op.params['to'])}`,
  }),
  recordOnly({
    name: SEQUENCE_TOOLS.setRange,
    summary: 'Set the in and out points of a slot (seconds inside its clip) without changing the clip; this is a non-destructive trim.',
    inputs: {},
    params: { ...SEQUENCE_PARAM, slot: { type: 'integer', required: true }, inSec: { type: 'number' }, outSec: { type: 'number' } },
    summarize: op => `${videoOf(op)}slot ${label(op.params['slot'])} range set`,
  }),
  recordOnly({
    name: SEQUENCE_TOOLS.insert,
    summary: 'Insert a clip into a video at a position (1 = first); later slots shift. Use at = slot count + 1 to append.',
    inputs: {},
    params: { ...SEQUENCE_PARAM, at: { type: 'integer', required: true }, asset: { type: 'string', required: true } },
    summarize: op => `${videoOf(op)}clip inserted at ${label(op.params['at'])}`,
  }),
  recordOnly({
    name: SEQUENCE_TOOLS.remove,
    summary: 'Take a slot out of a video; later slots shift. The clip asset stays in the project.',
    inputs: {},
    params: { ...SEQUENCE_PARAM, slot: { type: 'integer', required: true } },
    summarize: op => `${videoOf(op)}slot ${label(op.params['slot'])} removed`,
  }),
  recordOnly({
    name: SEQUENCE_TOOLS.split,
    summary: 'Cut one slot of a video in two at a time inside its clip (seconds from the clip\'s start, not from the video\'s start). Both parts play the same clip: the first ends at atSec, the second starts there.',
    inputs: {},
    params: { ...SEQUENCE_PARAM, slot: { type: 'integer', required: true }, atSec: { type: 'number', required: true, description: 'Seconds inside the clip asset.' } },
    summarize: op => `${videoOf(op)}slot ${label(op.params['slot'])} split at ${label(op.params['atSec'])}s`,
  }),
  recordOnly({
    name: SEQUENCE_TOOLS.rename,
    summary: 'Change the display title of a video (an episode).',
    inputs: {},
    params: {
      sequence: { type: 'string', required: true, description: 'The video to rename, such as v1 or v2.' },
      title: { type: 'string', required: true, description: 'The new title.' },
    },
    summarize: op => `${videoOf(op)}renamed to ${label(op.params['title'])}`,
  }),
  recordOnly({
    name: SEQUENCE_TOOLS.delete,
    summary: 'Delete a whole video (an episode) from the project. Its clip assets stay in the project. Only call this when the user asked to delete the video.',
    inputs: {},
    params: { sequence: { type: 'string', required: true, description: 'The video to delete, such as v2.' } },
    summarize: op => `${videoOf(op)}deleted`,
  }),
]
