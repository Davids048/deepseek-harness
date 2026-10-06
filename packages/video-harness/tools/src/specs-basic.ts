/**
 * Tools whose effect is a record and at most a small file: imports, character, location and style versions, plans,
 * and timeline edits. The bridge reducers interpret their params; `plan.create` stores the plan document as a JSON
 * asset so the agent and the user can read the same text before anything is rendered, and `plan.approve` schedules the
 * plan's shot renders through `dvProject.run`.
 *
 * @module @video-harness/tools/specs-basic
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type DvProject from '@dv/project'
import type { AssetId, OperationContext, OperationResult, ProjectState, RecordId, RecordInputRef, RunRequest } from '@dv/project'
import type VhAssets from '@video-harness/assets'
import { SEQUENCE_TOOLS } from './reducers.ts'
import type { PlanDocument, ToolSpec } from './types.ts'

/** The operation that approves a plan; its execute schedules the plan's shot renders. */
export const PLAN_APPROVE_TOOL = 'plan.approve'
/** The operation that renders one shot. */
export const GENERATE_VIDEO_TOOL = 'generate.video'

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
function recordOnly(
  spec: Omit<ToolSpec, 'version' | 'deterministic' | 'resource' | 'confirm' | 'outputs' | 'inputRoles' | 'execute'>,
): ToolSpec {
  return {
    ...spec, version: '1', deterministic: true, resource: 'none', confirm: 'never', outputs: [], inputRoles: Object.keys(spec.inputs),
    execute: () => Promise.resolve({ outputs: [] }),
  }
}

/**
 * Turn one string reference into a record input reference: `<record>#<n>` names output n of a record, `<id>@<n>`
 * version n of a character, location, or style (the kind comes from the `bible` slice of `state`), anything else an
 * asset ID.
 * @param ref - the reference text.
 * @param state - the state the reference is read against.
 * @returns the reference.
 * @throws Error when an `<id>@<n>` reference names an ID the state does not know.
 */
export function parseInputRef(ref: string, state: ProjectState): RecordInputRef {
  const hash = ref.lastIndexOf('#')
  const output = hash > 0 ? Number(ref.slice(hash + 1)) : Number.NaN
  if (Number.isInteger(output) && output >= 0) return { record: brandString<RecordId>(ref.slice(0, hash)), output }
  const at = ref.lastIndexOf('@')
  const version = at > 0 ? Number(ref.slice(at + 1)) : Number.NaN
  if (!Number.isInteger(version)) return { asset: brandString<AssetId>(ref) }
  const id = ref.slice(0, at)
  const kind = state.components.bible.entities[id]?.at(-1)?.kind
  if (kind === 'character') return { character: id, version }
  if (kind === 'location') return { location: id, version }
  if (kind === 'style') return { style: id, version }
  throw new Error(`Unknown character, location, or style version '${ref}'.`)
}

/** `asset.upload`: a file on disk, or inline base64 bytes, becomes an asset. */
export const assetUpload: ToolSpec = {
  name: 'asset.upload',
  component: 'asset',
  version: '1',
  summary: 'Bring a file into the project: a path on this machine, or base64 bytes. Returns the asset ID to reference later.',
  inputs: {},
  params: {
    path: { type: 'string', description: 'Absolute path of the file to import.' },
    base64: { type: 'string', description: 'The file bytes as base64, when there is no path.' },
    mime: { type: 'string', required: true, description: 'MIME type, such as image/png or video/mp4.' },
    name: { type: 'string', description: 'Display name; defaults to the file name.' },
  },
  inputRoles: [],
  outputs: [{ role: 'asset', type: 'any' }],
  deterministic: true,
  resource: 'none',
  confirm: 'never',
  summarize: record => `uploaded ${text(record.params['name'], basename(text(record.params['path'], 'bytes')))}`,
  execute(context): Promise<OperationResult> {
    const path = text(context.params['path'])
    const base64 = text(context.params['base64'])
    if (path === '' && base64 === '') throw new Error('asset.upload needs `path` or `base64`.')
    const bytes = path === '' ? Buffer.from(base64, 'base64') : readFileSync(path)
    const id = context.importAsset(bytes, {
      mime: text(context.params['mime'], 'application/octet-stream'),
      name: text(context.params['name'], path === '' ? 'upload' : basename(path)),
    })
    return Promise.resolve({ outputs: [id] })
  },
}

/**
 * The record that wrote the current version of a character, location, or style; an `entity.<kind>.update` call
 * supersedes it, so the records that read that version become stale.
 * @param params - the update's params; `entity` names the ID.
 * @param state - the state the update is written on.
 * @returns that record, or nothing for an unknown ID.
 */
function previousVersionRecord(params: Record<string, unknown>, state: ProjectState): RecordId[] {
  const current = state.components.bible.entities[text(params['entity'])]?.at(-1)
  return current === undefined ? [] : [current.updatedBy]
}

/** `entity.<kind>.create` and `entity.<kind>.update` for one entity kind. */
export function entityTools(kind: 'character' | 'style' | 'location'): ToolSpec[] {
  const refsParam = { type: 'array', items: { type: 'string' }, description: 'Asset IDs of the reference images.' } as const
  const update = recordOnly({
    name: `entity.${kind}.update`,
    component: 'bible',
    summary: `Change a ${kind}: new reference images or description. `
      + 'Produces the next version and marks everything made with the previous version as stale.',
    inputs: {},
    params: {
      entity: { type: 'string', required: true, description: 'The entity ID.' },
      name: { type: 'string' },
      description: { type: 'string' },
      refs: refsParam,
    },
    summarize: record => `${kind} ${text(record.params['entity'])} updated`,
  })
  return [
    recordOnly({
      name: `entity.${kind}.create`,
      component: 'bible',
      summary: `Register a ${kind} that later shots refer to by name. Returns version 1; shots reference it as <entity>@1.`,
      inputs: {},
      params: {
        entity: { type: 'string', required: true, description: 'Short stable ID, such as c1.' },
        name: { type: 'string', required: true, description: 'Display name.' },
        description: { type: 'string', description: 'Appearance, wardrobe, mood, or style words carried into every prompt.' },
        refs: refsParam,
      },
      summarize: record => `${kind} ${text(record.params['name'], text(record.params['entity']))} created`,
    }),
    {
      ...update,
      supersedes: previousVersionRecord,
      // An update of an unknown ID fails its record: there is no earlier version to change.
      execute(context: OperationContext): Promise<OperationResult> {
        const id = text(context.params['entity'])
        if (context.state.components.bible.entities[id] === undefined) throw new Error(`Unknown ${kind} '${id}'.`)
        return Promise.resolve({ outputs: [] })
      },
    },
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
  component: 'plan',
  version: '1',
  summary: 'Propose a plan: the shots with prompts and durations, the references, and whether shots chain from each other. Nothing is generated until the user approves it with plan.approve.',
  inputs: {},
  inputRoles: [],
  params: PLAN_PARAMS,
  outputs: [{ role: 'plan', type: 'json' }],
  deterministic: true,
  resource: 'none',
  confirm: 'never',
  summarize: record => `plan with ${(record.params['shots'] as unknown[] | undefined)?.length ?? 0} shots`,
  execute(context): Promise<OperationResult> {
    const plan = planFrom(context.params)
    if (plan.shots.length === 0) throw new Error('plan.create needs at least one shot.')
    const id = context.importAsset(Buffer.from(JSON.stringify(plan, null, 2)), { mime: 'application/json', name: 'plan.json' })
    return Promise.resolve({ outputs: [id] })
  },
}

/** `plan.update`: a changed copy of an earlier plan, recorded with `base_op`. */
export const planUpdate: ToolSpec = {
  ...planCreate,
  name: 'plan.update',
  summary: 'Revise a proposed plan. Pass the earlier plan record as base_op; the revised document replaces it for approval.',
  summarize: record => `plan revised (${(record.params['shots'] as unknown[] | undefined)?.length ?? 0} shots)`,
}

/**
 * Read the plan document a `plan.create` or `plan.update` record stored.
 * @param project - the Project service.
 * @param assets - the asset store.
 * @param projectId - the project.
 * @param plan - the plan record ID.
 * @returns the document.
 * @throws Error when the record is unknown or stored no plan document.
 */
export function readPlanDocument(project: DvProject, assets: VhAssets, projectId: OperationContext['project'], plan: string): PlanDocument {
  const record = project.getRecord(projectId, brandString<RecordId>(plan))
  const asset = record.outputs[0]
  if (record.operation === null || !record.operation.startsWith('plan.') || asset === undefined) {
    throw new Error(`Plan record '${plan}' stored no plan document.`)
  }
  return JSON.parse(assets.read(asset).toString('utf8')) as PlanDocument
}

/**
 * Schedule the shot renders of an approved plan: one `generate.video` per shot and one `sequence.create` of the
 * clips, written by the `system` actor in the approving record's session and turn. Chained continuity names each
 * shot's predecessor last frame (output 1) as its `first_frame` input, which also orders the renders.
 * @param project - the Project service.
 * @param context - the running `plan.approve` call.
 * @param plan - the plan record ID.
 * @param document - the plan document.
 */
async function schedulePlan(project: DvProject, context: OperationContext, plan: string, document: PlanDocument): Promise<void> {
  const approve = context.record
  /* v8 ignore next -- plan.approve is not read-only, so it always runs with a record. */
  if (approve === null) throw new Error('plan.approve runs only with a record.')
  const origin = { actor: 'system' as const, surface: approve.surface, session: approve.session, turn: approve.turn, tool_call: null }
  const shots: RecordId[] = []
  for (const [index, shot] of document.shots.entries()) {
    const inputs: RunRequest['inputs'] = (shot.references ?? document.references ?? [])
      .map(ref => ({ role: 'reference', ref: parseInputRef(ref, context.state) }))
    const previous = shots.at(-1)
    if (document.continuity === 'chained' && previous !== undefined) {
      inputs.push({ role: 'first_frame', ref: { record: previous, output: 1 } })
    }
    const params: Record<string, unknown> = { prompt: shot.prompt, plan, shot: index + 1 }
    for (const [key, value] of Object.entries({
      duration_sec: shot.duration_sec, aspect_ratio: document.aspect_ratio, resolution: document.resolution,
      generation_mode: document.generation_mode, seed: shot.seed ?? document.seed,
    })) if (value !== undefined) params[key] = value
    const scheduled = await project.run({
      ...origin, project: context.project, operation: GENERATE_VIDEO_TOOL, params, inputs,
      intent: `shot ${index + 1} of plan ${plan.slice(0, 8)}`, after: previous === undefined ? [] : [previous],
    })
    /* v8 ignore next -- a scheduled run always returns its pending record. */
    if (scheduled.record === null) throw new Error('A scheduled shot render returned no record.')
    shots.push(scheduled.record.id)
  }
  await project.run({
    ...origin, project: context.project, operation: SEQUENCE_TOOLS.create, params: { plan },
    inputs: shots.map(id => ({ role: 'clip', ref: { record: id, output: 0 } })), intent: `assemble plan ${plan.slice(0, 8)}`, after: shots,
  })
}

/**
 * `plan.approve`: the user's go-ahead; its execute schedules one shot render per shot and the assembly of the clips.
 * @param project - the Project service the renders are scheduled through.
 * @param assets - the asset store that holds the plan document.
 * @returns the spec.
 */
export function planApprove(project: DvProject, assets: VhAssets): ToolSpec {
  return {
    ...recordOnly({
      name: PLAN_APPROVE_TOOL,
      component: 'plan',
      summary: 'Record the user\'s approval of a plan and start generating its shots in order. '
        + 'Only call this after the user agreed to the plan you showed them.',
      inputs: {},
      params: { plan: { type: 'string', required: true, description: 'The plan.create or plan.update record ID.' } },
      summarize: record => `plan ${text(record.params['plan']).slice(0, 8)} approved`,
    }),
    deterministic: false,
    confirm: 'agent_ask_first',
    async execute(context): Promise<OperationResult> {
      const plan = text(context.params['plan'])
      await schedulePlan(project, context, plan, readPlanDocument(project, assets, context.project, plan))
      return { outputs: [] }
    },
  }
}

/** The `sequence` param every sequence tool takes: which video of the project it edits. */
const SEQUENCE_PARAM = {
  sequence: {
    type: 'string', description: 'The video to edit, such as v1 or v2 (see `sequences` in dv_proj_state). Defaults to the first video.',
  },
} as const

/** The video a sequence record names, as display text. */
function videoOf(record: { params: Record<string, unknown> }): string {
  const id = text(record.params['sequence'])
  return id === '' ? '' : `${id} `
}

/** The nine `sequence.*` tools: each video's timeline is the fold of these records. */
export const sequenceTools: ToolSpec[] = [
  recordOnly({
    component: 'timeline',
    name: SEQUENCE_TOOLS.create,
    summary: 'Create a video (a timeline) from clips in order, or replace an existing video\'s clips. A project can hold several videos: pass a new `sequence` ID (v2, v3, ...) and a `title` to add one; pass an existing ID to replace its clips; omit it to replace the first video. An empty `assets` list makes an empty video.',
    inputs: { clip: { type: 'video', description: 'The clips in order, when the assets are outputs of scheduled records.', many: true } },
    params: {
      ...SEQUENCE_PARAM,
      title: { type: 'string', description: 'Display title of the video, such as 第 2 集.' },
      assets: { type: 'array', items: { type: 'string' }, description: 'Clip asset IDs in playback order.' },
    },
    summarize: record =>
      `${videoOf(record)}sequence of ${(record.params['assets'] as unknown[] | undefined)?.length ?? record.inputs.length} clips`,
  }),
  recordOnly({
    component: 'timeline',
    name: SEQUENCE_TOOLS.replace,
    summary: 'Put a different clip in a slot of a video; the slot\'s in and out points reset.',
    inputs: {},
    params: { ...SEQUENCE_PARAM, slot: { type: 'integer', required: true }, asset: { type: 'string', required: true, description: 'The clip asset ID.' } },
    summarize: record => `${videoOf(record)}slot ${label(record.params['slot'])} replaced`,
  }),
  recordOnly({
    component: 'timeline',
    name: SEQUENCE_TOOLS.move,
    summary: 'Move a slot of a video to another position; the other slots shift.',
    inputs: {},
    params: { ...SEQUENCE_PARAM, from: { type: 'integer', required: true }, to: { type: 'integer', required: true } },
    summarize: record => `${videoOf(record)}slot ${label(record.params['from'])} moved to ${label(record.params['to'])}`,
  }),
  recordOnly({
    component: 'timeline',
    name: SEQUENCE_TOOLS.setRange,
    summary: 'Set the in and out points of a slot (seconds inside its clip) without changing the clip; this is a non-destructive trim.',
    inputs: {},
    params: { ...SEQUENCE_PARAM, slot: { type: 'integer', required: true }, inSec: { type: 'number' }, outSec: { type: 'number' } },
    summarize: record => `${videoOf(record)}slot ${label(record.params['slot'])} range set`,
  }),
  recordOnly({
    component: 'timeline',
    name: SEQUENCE_TOOLS.insert,
    summary: 'Insert a clip into a video at a position (1 = first); later slots shift. Use at = slot count + 1 to append.',
    inputs: {},
    params: { ...SEQUENCE_PARAM, at: { type: 'integer', required: true }, asset: { type: 'string', required: true } },
    summarize: record => `${videoOf(record)}clip inserted at ${label(record.params['at'])}`,
  }),
  recordOnly({
    component: 'timeline',
    name: SEQUENCE_TOOLS.remove,
    summary: 'Take a slot out of a video; later slots shift. The clip asset stays in the project.',
    inputs: {},
    params: { ...SEQUENCE_PARAM, slot: { type: 'integer', required: true } },
    summarize: record => `${videoOf(record)}slot ${label(record.params['slot'])} removed`,
  }),
  recordOnly({
    component: 'timeline',
    name: SEQUENCE_TOOLS.split,
    summary: 'Cut one slot of a video in two at a time inside its clip (seconds from the clip\'s start, not from the video\'s start). Both parts play the same clip: the first ends at atSec, the second starts there.',
    inputs: {},
    params: { ...SEQUENCE_PARAM, slot: { type: 'integer', required: true }, atSec: { type: 'number', required: true, description: 'Seconds inside the clip asset.' } },
    summarize: record => `${videoOf(record)}slot ${label(record.params['slot'])} split at ${label(record.params['atSec'])}s`,
  }),
  recordOnly({
    component: 'timeline',
    name: SEQUENCE_TOOLS.rename,
    summary: 'Change the display title of a video (an episode).',
    inputs: {},
    params: {
      sequence: { type: 'string', required: true, description: 'The video to rename, such as v1 or v2.' },
      title: { type: 'string', required: true, description: 'The new title.' },
    },
    summarize: record => `${videoOf(record)}renamed to ${label(record.params['title'])}`,
  }),
  recordOnly({
    component: 'timeline',
    name: SEQUENCE_TOOLS.delete,
    summary: 'Delete a whole video (an episode) from the project. Its clip assets stay in the project. Only call this when the user asked to delete the video.',
    inputs: {},
    params: { sequence: { type: 'string', required: true, description: 'The video to delete, such as v2.' } },
    summarize: record => `${videoOf(record)}deleted`,
  }),
]
