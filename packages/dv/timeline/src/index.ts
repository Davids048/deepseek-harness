/**
 * The Timeline component of DreamVerse as the `dvTimeline` Cordis service: the timelines of a project (each one edited
 * video, shown by its name, or as 时间线 {n} for a timeline t<n> without one) and their clips (an asset with in and out
 * points). It owns ten operations, which change only records and never create a file:
 * - `timeline.create`, `timeline.update`, `timeline.rename`, `timeline.delete` act on a whole timeline;
 * - `timeline.clip_insert`, `timeline.clip_move`, `timeline.clip_remove`, `timeline.clip_split`, `timeline.clip_trim`,
 *   `timeline.clip_replace` edit its clips, each named by its ID (`cl1`, `cl2`, …) in the `clip` param.
 *
 * The operations that add clips assign the new clip IDs and store them in the record's `report.clips`; the `timeline`
 * reducer folds the records into the `timeline` slice. `timeline.create` and `timeline.update` declare the `clip` input
 * role in `pendingInputRoles`: a clip input may name a render that is not done, and the clip is a placeholder until
 * the render is done. `dvProject` turns each operation into its agent tool
 * (`dv_timeline_create`, `dv_timeline_clip_move`, ...). Exporting a timeline to a file belongs to Deliver.
 *
 * @module @dv/timeline
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OperationContext, OperationResult, OperationSpec, ProjectId, ProjectRecord } from '@dv/project'
import { addedClipCount, clipProblem, namedTimeline, OPERATIONS, reportedClips, timelineReducer } from './reducer.ts'
import type { ClipId } from './types.ts'

export type { Clip, ClipId, ClipStatus, Timeline, TimelineId, TimelineState } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Timeline component: the timelines of a project and their clips. */
    dvTimeline: DvTimeline
  }
}

/** `dvTimeline` plugin configuration; the component has no deployment-varying settings. */
export type Config = Record<string, unknown>

/** Loader validation. */
export const Config: z<Config> = z.object({})

/** The `timeline` param of `timeline.clip_insert`, which may omit it. */
const TIMELINE_PARAM = {
  timeline: { type: 'string', description: 'The timeline to edit, such as t1 (see `timelines` in dv_proj_state). Defaults to the first timeline.' },
} as const

/** The `clip` param: the clip's ID, which also names the timeline that holds it. */
const CLIP_PARAM = {
  clip: { type: 'string', required: true, description: 'The clip ID, such as cl3 (see `clips` of `timelines` in dv_proj_state).' },
} as const

/**
 * The params and the input role of `timeline.create` and `timeline.update`: the clips in playback order. The `clip` role
 * is a pending input role, so a clip may name a render that has not finished.
 */
const LAYOUT = {
  inputs: {
    clip: {
      type: 'video', many: true,
      description: 'The clips in order, as render outputs; a render that is not done yet becomes a placeholder clip until it is done.',
    },
  },
  pendingInputRoles: ['clip'],
  params: {
    assets: { type: 'array', items: { type: 'string' }, description: 'Clip asset IDs in playback order.' },
    plan: { type: 'string', description: 'The plan record whose shots the timeline holds.' },
  },
} as const

/** The timeline a record names, as a summary prefix such as `t2 `; empty when it names none. */
function prefix(record: ProjectRecord): string {
  const id = namedTimeline(record.params)
  return id === null ? '' : `${id} `
}

/** The number of clips a create or update record lays out, for summaries. */
function laidOut(record: ProjectRecord): number {
  return Array.isArray(record.params['assets']) ? record.params['assets'].length : record.inputs.length
}

/** The clip ID a finished insert record assigned, followed by a space; empty before the record finishes. */
function clipOf(record: ProjectRecord): string {
  const id = reportedClips(record)[0]
  return id === undefined ? '' : `${id} `
}

/** A params field as display text. */
function shown(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '?'
}

/**
 * One Timeline operation: a record-only edit that the service's `execute` validates. It is not `deterministic`: whether
 * a call applies depends on the state, and the clips it adds get new IDs, so the runner runs every call.
 * @param spec - the operation's own fields.
 * @param execute - the service's check and clip ID assignment.
 * @returns the operation spec.
 */
function edit(
  spec: Pick<OperationSpec, 'name' | 'description' | 'params' | 'summarize'>
    & Partial<Pick<OperationSpec, 'inputs' | 'version' | 'pendingInputRoles'>>,
  execute: OperationSpec['execute'],
): OperationSpec {
  return {
    inputs: {}, version: '2', ...spec, component: 'timeline', outputs: [], deterministic: false, resource: 'none', confirm: 'never',
    execute,
  }
}

/** The Timeline service: the reducer and the ten operations. */
export default class DvTimeline extends Service {
  static inject = ['dvProject']
  static Config = Config

  /** The highest clip number this service assigned per project, for calls whose records have not finished yet. */
  private readonly assigned = new Map<ProjectId, number>()

  constructor(ctx: Context) {
    super(ctx, 'dvTimeline')
    ctx.effect(() => ctx.dvProject.registerReducer('timeline', timelineReducer), 'dvTimeline reducer')
    for (const spec of this.operations()) ctx.effect(() => ctx.dvProject.registerOperation(spec), `dvTimeline ${spec.name}`)
  }

  /**
   * Assign new clip IDs in a project. The number after `cl` is one more than the highest number that any Timeline
   * record of the project stored in `report.clips`, on any branch (`main`, drafts, exploration branches, undone and
   * discarded records), and than any number this service assigned to a call still running. So no two clips of a project
   * ever share an ID, whichever branches they were added on.
   * @param project - the project.
   * @param count - how many IDs to assign.
   * @returns the IDs in order.
   */
  private assignClipIds(project: ProjectId, count: number): ClipId[] {
    let highest = this.assigned.get(project) ?? 0
    for (const entry of this.ctx.dvProject.listHistory({ project, component: 'timeline' })) {
      for (const id of reportedClips(entry.record)) highest = Math.max(highest, Number(/^cl(\d+)$/.exec(id)?.[1] ?? 0))
    }
    const ids = Array.from({ length: count }, (_, index) => brandString<ClipId>(`cl${String(highest + index + 1)}`))
    this.assigned.set(project, highest + count)
    return ids
  }

  /**
   * Check a call against the timeline it edits, and assign the IDs of the clips it adds; the record fails with the
   * reason when the call cannot apply. The edit itself is the record: the reducer applies it.
   * @param context - the running call.
   * @returns no outputs; `report.clips` holds the assigned clip IDs of a call that adds clips.
   * @throws Error with the reason a call cannot apply.
   */
  private execute(context: OperationContext): Promise<OperationResult> {
    const call = { operation: context.record?.operation ?? null, params: context.params, inputs: context.inputs }
    const problem = clipProblem(context.state.components.timeline, call)
    if (problem !== null) return Promise.reject(new Error(problem))
    const count = addedClipCount(call)
    const adds = [OPERATIONS.create, OPERATIONS.update, OPERATIONS.insert, OPERATIONS.split].includes(call.operation as never)
    return Promise.resolve(adds ? { outputs: [], report: { clips: this.assignClipIds(context.project, count) } } : { outputs: [] })
  }

  /** The ten operations, in the order the agent's tool list shows them. */
  private operations(): OperationSpec[] {
    const execute = (context: OperationContext): Promise<OperationResult> => this.execute(context)
    return [
      edit({
        name: OPERATIONS.create,
        description: 'Create a timeline (one edited video of the project) from clips in order. Pass a new `timeline` ID (t2, t3, ...) '
          + 'and a `name`; omit the ID for the project\'s first timeline, t1. To replace the clips of an existing timeline, call '
          + 'dv_timeline_update. An empty `assets` list makes an empty timeline.',
        inputs: LAYOUT.inputs,
        pendingInputRoles: [...LAYOUT.pendingInputRoles],
        params: {
          timeline: { type: 'string', description: 'The ID of the timeline to create, such as t2. Defaults to t1.' },
          name: { type: 'string', description: 'The name the interface shows, such as 片尾. Without a name the interface shows 时间线 2 for t2.' },
          ...LAYOUT.params,
        },
        summarize: record => `${prefix(record)}timeline of ${String(laidOut(record))} clips`,
      }, execute),
      edit({
        name: OPERATIONS.update,
        description: 'Replace all clips of an existing timeline with clips in order; its name stays. Every clip gets a new clip ID.',
        inputs: LAYOUT.inputs,
        pendingInputRoles: [...LAYOUT.pendingInputRoles],
        params: { timeline: { type: 'string', required: true, description: 'The timeline to update, such as t1.' }, ...LAYOUT.params },
        summarize: record => `${prefix(record)}timeline updated (${String(laidOut(record))} clips)`,
      }, execute),
      edit({
        name: OPERATIONS.rename,
        version: '1',
        description: 'Change the name of a timeline.',
        params: {
          timeline: { type: 'string', required: true, description: 'The timeline to rename, such as t1.' },
          name: { type: 'string', required: true, description: 'The name.' },
        },
        summarize: record => `${prefix(record)}renamed to ${shown(record.params['name'])}`,
      }, execute),
      edit({
        name: OPERATIONS.delete,
        version: '1',
        description: 'Delete a whole timeline from the project. Its clip assets stay in the project. Only call this when the user '
          + 'asked to delete the timeline.',
        params: { timeline: { type: 'string', required: true, description: 'The timeline to delete, such as t2.' } },
        summarize: record => `${prefix(record)}deleted`,
      }, execute),
      edit({
        name: OPERATIONS.insert,
        description: 'Insert an asset as a clip into a timeline at a position (1 = first); later clips shift. Use at = clip count + 1 '
          + 'to append. Inserting into a timeline that does not exist creates it. The clip gets a new clip ID.',
        params: {
          ...TIMELINE_PARAM,
          at: { type: 'integer', required: true, description: 'The position the clip takes.' },
          asset: { type: 'string', required: true, description: 'The asset ID.' },
        },
        summarize: record => `${prefix(record)}clip ${clipOf(record)}inserted at ${shown(record.params['at'])}`,
      }, execute),
      edit({
        name: OPERATIONS.move,
        description: 'Move a clip to another position on its timeline (1 = first); the other clips shift.',
        params: { ...CLIP_PARAM, to: { type: 'integer', required: true, description: 'The position the clip takes.' } },
        summarize: record => `clip ${shown(record.params['clip'])} moved to ${shown(record.params['to'])}`,
      }, execute),
      edit({
        name: OPERATIONS.remove,
        description: 'Take a clip out of its timeline; later clips shift. The asset stays in the project.',
        params: { ...CLIP_PARAM },
        summarize: record => `clip ${shown(record.params['clip'])} removed`,
      }, execute),
      edit({
        name: OPERATIONS.split,
        description: 'Split one clip in two at a time inside its asset (seconds from the asset\'s start, not from the timeline\'s '
          + 'start). Both parts play the same asset: the first keeps the clip ID and ends at at_sec, the second gets a new clip ID '
          + 'and starts there.',
        params: {
          ...CLIP_PARAM,
          at_sec: { type: 'number', required: true, description: 'Seconds inside the clip\'s asset, between its in and out points.' },
        },
        summarize: record => `clip ${shown(record.params['clip'])} split at ${shown(record.params['at_sec'])}s`,
      }, execute),
      edit({
        name: OPERATIONS.trim,
        description: 'Set the in and out points of a clip (seconds inside its asset) without changing the asset; no file is created. '
          + 'An omitted point plays from the asset\'s start or to its end.',
        params: {
          ...CLIP_PARAM,
          in_sec: { type: 'number', description: 'Where the clip starts inside its asset.' },
          out_sec: { type: 'number', description: 'Where the clip ends inside its asset.' },
        },
        summarize: record => `clip ${shown(record.params['clip'])} trimmed`,
      }, execute),
      edit({
        name: OPERATIONS.replace,
        description: 'Put a different asset in a clip; the clip keeps its ID and its in and out points reset.',
        params: { ...CLIP_PARAM, asset: { type: 'string', required: true, description: 'The asset ID.' } },
        summarize: record => `clip ${shown(record.params['clip'])} replaced`,
      }, execute),
    ]
  }
}
