/**
 * The Timeline component of DreamVerse as the `dvTimeline` Cordis service: the timelines of a project (each one edited
 * video, shown by its name such as 第 1 集) and their clips (an asset with in and out points). It owns nine
 * operations, which change only records and never create a file:
 * - `timeline.create`, `timeline.rename`, `timeline.delete` act on a whole timeline;
 * - `timeline.clip_insert`, `timeline.clip_move`, `timeline.clip_remove`, `timeline.clip_split`, `timeline.clip_trim`,
 *   `timeline.clip_replace` edit its clips, each named by its 1-based position in the `clip` param.
 *
 * The `timeline` reducer folds the records into the `timeline` slice. `dvProject` turns each operation into its agent
 * tool (`dv_timeline_create`, `dv_timeline_clip_move`, ...). Exporting a timeline to a file belongs to Deliver.
 *
 * @module @dv/timeline
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { OperationContext, OperationResult, OperationSpec, ProjectRecord } from '@dv/project'
import { clipProblem, namedTimeline, OPERATIONS, timelineReducer } from './reducer.ts'

export type { Clip, Timeline, TimelineId, TimelineState } from './types.ts'

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

/** The `timeline` param of the operations that may omit it. */
const TIMELINE_PARAM = {
  timeline: { type: 'string', description: 'The timeline to edit, such as t1 (see `timelines` in dv_proj_state). Defaults to the first timeline.' },
} as const

/** The `clip` param: a clip's 1-based position on its timeline. */
const CLIP_PARAM = { clip: { type: 'integer', required: true, description: 'The clip\'s position on the timeline, 1 = first.' } } as const

/** The timeline a record names, as a summary prefix such as `t2 `; empty when it names none. */
function prefix(record: ProjectRecord): string {
  const id = namedTimeline(record.params)
  return id === null ? '' : `${id} `
}

/** A params field as display text. */
function shown(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '?'
}

/**
 * Check a call against the timeline it edits; the record fails with the reason when the timeline or the clip does not
 * exist. The edit itself is the record: the reducer applies it.
 * @param context - the running call.
 * @returns no outputs.
 * @throws Error with the reason a call cannot apply.
 */
function checkCall(context: OperationContext): Promise<OperationResult> {
  const call = { operation: context.record?.operation ?? null, params: context.params, inputs: context.inputs }
  const problem = clipProblem(context.state.components.timeline, call)
  return problem === null ? Promise.resolve({ outputs: [] }) : Promise.reject(new Error(problem))
}

/**
 * One Timeline operation: a record-only edit that `checkCall` validates. It is not `deterministic`: whether a call
 * applies depends on the state, so the runner must run the check every time instead of reusing an earlier record.
 */
function edit(spec: Pick<OperationSpec, 'name' | 'description' | 'params' | 'summarize'> & Partial<Pick<OperationSpec, 'inputs'>>): OperationSpec {
  return {
    inputs: {}, ...spec, component: 'timeline', version: '1', outputs: [], deterministic: false, resource: 'none', confirm: 'never',
    execute: checkCall,
  }
}

/** The Timeline service: the reducer and the nine operations. */
export default class DvTimeline extends Service {
  static inject = ['dvProject']
  static Config = Config

  constructor(ctx: Context) {
    super(ctx, 'dvTimeline')
    ctx.effect(() => ctx.dvProject.registerReducer('timeline', timelineReducer), 'dvTimeline reducer')
    for (const spec of this.operations()) ctx.effect(() => ctx.dvProject.registerOperation(spec), `dvTimeline ${spec.name}`)
  }

  /** The nine operations, in the order the agent's tool list shows them. */
  private operations(): OperationSpec[] {
    return [
      edit({
        name: OPERATIONS.create,
        description: 'Create a timeline (one edited video of the project) from clips in order, or replace the clips of an existing '
          + 'timeline. Pass a new `timeline` ID (t2, t3, ...) and a `name` to add one; pass an existing ID to replace its clips; '
          + 'omit it to replace the first timeline. An empty `assets` list makes an empty timeline.',
        inputs: { clip: { type: 'video', many: true, description: 'The clips in order, when the assets are outputs of scheduled records.' } },
        params: {
          ...TIMELINE_PARAM,
          name: { type: 'string', description: 'The name the interface shows, such as 第 2 集.' },
          assets: { type: 'array', items: { type: 'string' }, description: 'Clip asset IDs in playback order.' },
          plan: { type: 'string', description: 'The plan record whose shots the timeline holds.' },
        },
        summarize: record => `${prefix(record)}timeline of ${String(Array.isArray(record.params['assets'])
          ? record.params['assets'].length
          : record.inputs.length)} clips`,
      }),
      edit({
        name: OPERATIONS.rename,
        description: 'Change the name of a timeline.',
        params: {
          timeline: { type: 'string', required: true, description: 'The timeline to rename, such as t1.' },
          name: { type: 'string', required: true, description: 'The name.' },
        },
        summarize: record => `${prefix(record)}renamed to ${shown(record.params['name'])}`,
      }),
      edit({
        name: OPERATIONS.delete,
        description: 'Delete a whole timeline from the project. Its clip assets stay in the project. Only call this when the user '
          + 'asked to delete the timeline.',
        params: { timeline: { type: 'string', required: true, description: 'The timeline to delete, such as t2.' } },
        summarize: record => `${prefix(record)}deleted`,
      }),
      edit({
        name: OPERATIONS.insert,
        description: 'Insert an asset as a clip into a timeline at a position (1 = first); later clips shift. Use at = clip count + 1 '
          + 'to append. Inserting into a timeline that does not exist creates it.',
        params: {
          ...TIMELINE_PARAM,
          at: { type: 'integer', required: true, description: 'The position the clip takes.' },
          asset: { type: 'string', required: true, description: 'The asset ID.' },
        },
        summarize: record => `${prefix(record)}clip inserted at ${shown(record.params['at'])}`,
      }),
      edit({
        name: OPERATIONS.move,
        description: 'Move a clip of a timeline to another position; the other clips shift.',
        params: { ...TIMELINE_PARAM, ...CLIP_PARAM, to: { type: 'integer', required: true, description: 'The position the clip takes.' } },
        summarize: record => `${prefix(record)}clip ${shown(record.params['clip'])} moved to ${shown(record.params['to'])}`,
      }),
      edit({
        name: OPERATIONS.remove,
        description: 'Take a clip out of a timeline; later clips shift. The asset stays in the project.',
        params: { ...TIMELINE_PARAM, ...CLIP_PARAM },
        summarize: record => `${prefix(record)}clip ${shown(record.params['clip'])} removed`,
      }),
      edit({
        name: OPERATIONS.split,
        description: 'Split one clip of a timeline in two at a time inside its asset (seconds from the asset\'s start, not from the '
          + 'timeline\'s start). Both parts play the same asset: the first ends at at_sec, the second starts there.',
        params: {
          ...TIMELINE_PARAM, ...CLIP_PARAM,
          at_sec: { type: 'number', required: true, description: 'Seconds inside the clip\'s asset, between its in and out points.' },
        },
        summarize: record => `${prefix(record)}clip ${shown(record.params['clip'])} split at ${shown(record.params['at_sec'])}s`,
      }),
      edit({
        name: OPERATIONS.trim,
        description: 'Set the in and out points of a clip (seconds inside its asset) without changing the asset; no file is created. '
          + 'An omitted point plays from the asset\'s start or to its end.',
        params: {
          ...TIMELINE_PARAM, ...CLIP_PARAM,
          in_sec: { type: 'number', description: 'Where the clip starts inside its asset.' },
          out_sec: { type: 'number', description: 'Where the clip ends inside its asset.' },
        },
        summarize: record => `${prefix(record)}clip ${shown(record.params['clip'])} trimmed`,
      }),
      edit({
        name: OPERATIONS.replace,
        description: 'Put a different asset in a clip of a timeline; the clip\'s in and out points reset.',
        params: { ...TIMELINE_PARAM, ...CLIP_PARAM, asset: { type: 'string', required: true, description: 'The asset ID.' } },
        summarize: record => `${prefix(record)}clip ${shown(record.params['clip'])} replaced`,
      }),
    ]
  }
}
