/**
 * The Shot plan component of DreamVerse as the `dvShotPlan` Cordis service: the plan of a video before anything is
 * rendered. It owns three operations:
 * - `plan.create`: the shots with prompts and durations, the references, and the continuity, stored as a JSON asset so
 *   the agent and the user read the same text;
 * - `plan.update`: a changed copy of an earlier plan, with that plan's record as `based_on`;
 * - `plan.approve`: the user's go-ahead; it schedules one `shot.render` per shot and one `timeline.create` of the
 *   rendered clips through `dvProject.run`, as the `system` actor.
 *
 * `dvProject` turns each operation into its agent tool (`dv_plan_create`, `dv_plan_update`, `dv_plan_approve`). The
 * reducer keeps the `plan` slice: every finished plan and the record that approved it.
 *
 * @module @dv/shot-plan
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import z from '@deepseek-ai/schemastery'
import type DvProject from '@dv/project'
import type { OperationContext, OperationResult, OperationSpec, ProjectId, ProjectState, RecordId, RunRequest } from '@dv/project'
import { planReducer } from './reducer.ts'
import type { Plan } from './types.ts'

export type { Plan, PlanState, PlanSummary, Shot } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Shot plan component: plans of shots and their approval. */
    dvShotPlan: DvShotPlan
  }
}

/** `dvShotPlan` plugin configuration: the component has no deployment-varying values. */
export type Config = Record<string, unknown>

/** Loader validation. */
export const Config: z<Config> = z.object({})

/** The operation that renders one shot; `plan.approve` schedules it by name. */
const SHOT_RENDER = 'shot.render'

/** The operation that lays out the rendered clips; `plan.approve` schedules it by name. */
const TIMELINE_CREATE = 'timeline.create'

/** The operations whose records store a plan. */
const PLAN_OPERATIONS: ReadonlySet<string> = new Set(['plan.create', 'plan.update'])

/** One shot of a plan as the tool params declare it. */
const SHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prompt: { type: 'string', required: true, description: 'The complete prompt of this shot.' },
    duration_sec: { type: 'integer', description: 'Seconds; defaults to the model minimum.' },
    references: {
      type: 'array', items: { type: 'string' },
      description: 'Character, location or style versions (c1@1) or asset IDs this shot uses instead of the plan references.',
    },
    seed: { type: 'integer' },
  },
} as const

/** The params of `plan.create` and `plan.update`: the fields of a `Plan`. */
const PLAN_PARAMS = {
  title: { type: 'string' },
  continuity: { type: 'string', enum: ['independent', 'chained'], description: 'chained: each shot starts from the previous shot\'s last still.' },
  references: { type: 'array', items: { type: 'string' }, description: 'Character, location or style versions (c1@1) or asset IDs every shot references.' },
  aspect_ratio: { type: 'string' },
  resolution: { type: 'string' },
  generation_mode: { type: 'string' },
  seed: { type: 'integer' },
  shots: { type: 'array', required: true, items: SHOT_SCHEMA },
} as const

/**
 * The plan that the params of a `plan.create` or `plan.update` call describe.
 * @param params - the validated params.
 * @returns the plan.
 */
function planOf(params: Record<string, unknown>): Plan {
  const { shots, ...rest } = params
  return { ...rest, shots: Array.isArray(shots) ? shots as Plan['shots'] : [] }
}

/** The number of shots in a plan record's params, for summaries. */
function shotCount(params: Record<string, unknown>): number {
  return Array.isArray(params['shots']) ? params['shots'].length : 0
}

/**
 * The `shot.render` params and reference inputs of every shot of a plan, in plan order, as `plan.approve` schedules
 * them; the chained `first_frame` input is added by the caller, because it names a record that does not exist yet.
 * @param plan - the plan.
 * @param planId - the record ID of the plan.
 * @param project - the Project service, which parses the references against the state.
 * @param state - the state the references resolve against.
 * @returns one request part per shot.
 * @throws Error when a reference names an unknown character, location or style version.
 */
function shotRenders(
  plan: Plan, planId: string, project: Pick<DvProject, 'parseInputs'>, state: ProjectState,
): Array<{ params: Record<string, unknown>; inputs: RunRequest['inputs'] }> {
  return plan.shots.map((shot, index) => {
    const references = shot.references ?? plan.references ?? []
    const inputs: RunRequest['inputs'] = references.length === 0 ? [] : project.parseInputs(SHOT_RENDER, { reference: references }, state)
    const params: Record<string, unknown> = { prompt: shot.prompt, plan: planId, shot: index + 1 }
    for (const [key, value] of Object.entries({
      duration_sec: shot.duration_sec, aspect_ratio: plan.aspect_ratio, resolution: plan.resolution,
      generation_mode: plan.generation_mode, seed: shot.seed ?? plan.seed,
    })) if (value !== undefined) params[key] = value
    return { params, inputs }
  })
}

/** The Shot plan service: the three operations, the reducer, and the methods the operations run. */
export default class DvShotPlan extends Service {
  static inject = ['dvProject']
  static Config = Config

  constructor(ctx: Context, _config: Config) {
    super(ctx, 'dvShotPlan')
    ctx.effect(() => ctx.dvProject.registerReducer('plan', planReducer), 'dvShotPlan reducer')
    for (const spec of this.operations()) ctx.effect(() => ctx.dvProject.registerOperation(spec), `dvShotPlan ${spec.name}`)
  }

  /**
   * Read the plan a finished `plan.create` or `plan.update` record stored.
   * @param project - the project.
   * @param plan - the record ID of the plan.
   * @returns the plan.
   * @throws ProjectError `unknown_record` for an unknown record; Error when the record stored no plan.
   */
  getPlan(project: ProjectId, plan: RecordId | string): Plan {
    const record = this.ctx.dvProject.getRecord(project, brandString<RecordId>(plan))
    if (record.operation === null || !PLAN_OPERATIONS.has(record.operation) || record.status !== 'done') {
      throw new Error(`Record '${plan}' stored no plan; pass the record of a finished dv_plan_create or dv_plan_update call.`)
    }
    return planOf(record.params)
  }

  /**
   * Schedule the renders of the plan that a running `plan.approve` call names: one `shot.render` per shot and one
   * `timeline.create` of their clips, written by the `system` actor in the approving record's surface, session and
   * turn. Chained continuity names each shot's predecessor last still (output 1) as its `first_frame` input, which also
   * orders the renders.
   * @param context - the running `plan.approve` call.
   * @returns the scheduled records: the shot renders in plan order, then the timeline.
   * @throws Error when the param names no plan or a reference names an unknown character, location or style version.
   */
  async approvePlan(context: OperationContext): Promise<RecordId[]> {
    const approve = context.record
    /* v8 ignore next -- plan.approve is not read-only, so it always runs with a record. */
    if (approve === null) throw new Error('plan.approve runs only with a record.')
    const planId = String(context.params['plan'])
    const plan = this.getPlan(context.project, planId)
    const project = this.ctx.dvProject
    const origin = { actor: 'system' as const, surface: approve.surface, session: approve.session, turn: approve.turn, tool_call: null }
    const shots: RecordId[] = []
    for (const [index, shot] of shotRenders(plan, planId, project, context.state).entries()) {
      const previous = shots.at(-1)
      if (plan.continuity === 'chained' && previous !== undefined) {
        shot.inputs.push({ role: 'first_frame', ref: { record: previous, output: 1 } })
      }
      const scheduled = await project.run({
        ...origin, project: context.project, operation: SHOT_RENDER, params: shot.params, inputs: shot.inputs,
        intent: `shot ${index + 1} of plan ${planId.slice(0, 8)}`, after: previous === undefined ? [] : [previous],
      })
      /* v8 ignore next -- a scheduled run always returns its pending record. */
      if (scheduled.record === null) throw new Error('A scheduled shot render returned no record.')
      shots.push(scheduled.record.id)
    }
    const timeline = await project.run({
      ...origin, project: context.project, operation: TIMELINE_CREATE, params: { plan: planId },
      inputs: shots.map(id => ({ role: 'clip', ref: { record: id, output: 0 } })), intent: `create timeline of plan ${planId.slice(0, 8)}`, after: shots,
    })
    return timeline.record === null ? shots : [...shots, timeline.record.id]
  }

  /**
   * Refuse a `plan.approve` call before its record when a shot it would schedule breaks the precondition of
   * `shot.render` (the reference-image rule): every shot is checked, and one error names all refused shots,
   * so the plan can be fixed at once. Without a registered `shot.render`, nothing is checked.
   * @param request - the `plan.approve` call.
   * @param state - the state of the working branch the call writes to.
   * @throws Error naming the refused shots, followed by the `shot.render` refusal; the error of an unknown plan record
   *   or an unknown character, location or style version.
   */
  private async precondition(request: RunRequest, state: ProjectState): Promise<void> {
    const project = this.ctx.dvProject
    const render = project.listOperations().find(spec => spec.name === SHOT_RENDER)
    if (render?.precondition === undefined) return
    const planId = String(request.params['plan'])
    const refused: Array<{ shot: number; error: unknown }> = []
    for (const [index, shot] of shotRenders(this.getPlan(request.project, planId), planId, project, state).entries()) {
      try {
        await render.precondition({ ...request, operation: SHOT_RENDER, params: shot.params, inputs: shot.inputs }, state)
      } catch (error: unknown) {
        refused.push({ shot: index + 1, error })
      }
    }
    const first = refused[0]
    if (first === undefined) return
    const reason = first.error instanceof Error ? first.error.message : String(first.error)
    const verb = refused.length === 1 ? 'has' : 'have'
    throw new Error(`Shot ${refused.map(entry => entry.shot).join(', ')} of the plan ${verb} no reference image. ${reason}`)
  }

  /** The three plan operations. */
  private operations(): OperationSpec[] {
    const create: OperationSpec = {
      name: 'plan.create',
      component: 'plan',
      version: '1',
      description: 'Propose a plan: the shots with prompts and durations, the references, and whether shots chain from each other. '
        + 'Nothing is rendered until the user approves it with dv_plan_approve.',
      inputs: {},
      params: PLAN_PARAMS,
      outputs: [{ role: 'plan', type: 'json' }],
      deterministic: true,
      resource: 'none',
      confirm: 'never',
      summarize: record => `plan with ${shotCount(record.params)} shots`,
      execute(context): Promise<OperationResult> {
        const plan = planOf(context.params)
        if (plan.shots.length === 0) throw new Error(`${context.record?.operation ?? 'plan.create'} needs at least one shot.`)
        const asset = context.importAsset(Buffer.from(JSON.stringify(plan, null, 2)), { mime: 'application/json', name: 'plan.json' })
        return Promise.resolve({ outputs: [asset] })
      },
    }
    return [
      create,
      {
        ...create,
        name: 'plan.update',
        description: 'Update a proposed plan. Pass the earlier plan record as based_on; the updated plan replaces it for approval.',
        summarize: record => `plan updated (${shotCount(record.params)} shots)`,
      },
      {
        name: 'plan.approve',
        component: 'plan',
        version: '1',
        description: 'Record the user\'s approval of a plan and start rendering its shots in order. '
          + 'Only call this after the user agreed to the plan you showed them.',
        inputs: {},
        params: { plan: { type: 'string', required: true, description: 'The dv_plan_create or dv_plan_update record ID.' } },
        outputs: [],
        deterministic: false,
        resource: 'none',
        confirm: 'agent_ask_first',
        summarize: record => `plan ${String(record.params['plan'] ?? '').slice(0, 8)} approved`,
        // The agent is refused before the question rule asks the user; every other caller is refused by the runner.
        prepareToolCall: call => this.precondition(call.request, call.state),
        precondition: (request, state) => this.precondition(request, state),
        execute: async (context): Promise<OperationResult> => {
          await this.approvePlan(context)
          return { outputs: [] }
        },
      },
    ]
  }
}
