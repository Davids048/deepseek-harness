/**
 * The Shot plan component of DreamVerse as the `dvShotPlan` Cordis service: the plan of a video before anything is
 * rendered. A plan has a `PlanId` (`p1`, `p2`, …) and numbered versions. It owns three operations:
 * - `plan.create`: version 1 of a new plan (the shots with prompts and durations, the references, and the continuity),
 *   stored as a JSON asset so the agent and the user read the same text; the assigned PlanId goes in `report.plan`;
 * - `plan.update`: the next version of the plan its `plan` param names;
 * - `plan.approve`: the user's go-ahead for one version; through `dvProject.run` as the `system` actor, it schedules one
 *   `shot.render` per new or changed shot and one `timeline.update` of the plan's timeline with every shot's take, or a
 *   `timeline.create` of a new timeline when the plan has none.
 *
 * `dvProject` turns each operation into its agent tool (`dv_plan_create`, `dv_plan_update`, `dv_plan_approve`). The
 * reducer keeps the `plan` slice: every version of every plan and the record that approved it.
 *
 * @module @dv/shot-plan
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import z from '@deepseek-ai/schemastery'
import type DvProject from '@dv/project'
import type { OperationContext, OperationResult, OperationSpec, ProjectId, ProjectState, RecordId, RunRequest } from '@dv/project'
import type {} from '@dv/timeline'
import { planOf, planReducer, reportedPlan } from './reducer.ts'
import type { PlanId, PlanVersion } from './types.ts'

export type { Plan, PlanId, PlanState, PlanVersion, Shot } from './types.ts'

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

/** The operations that lay out the rendered clips on a timeline; `plan.approve` schedules one of them by name. */
const TIMELINE_CREATE = 'timeline.create'
const TIMELINE_UPDATE = 'timeline.update'

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

/** The params of `plan.create`: the fields of a `Plan`. */
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

/** The params of `shot.render` that tell where a plan's take came from; a reused take differs from its shot only in them. */
const PLAN_RENDER_PARAMS: ReadonlySet<string> = new Set(['plan', 'plan_version', 'shot'])

/** The number of shots in a plan record's params, for summaries. */
function shotCount(params: Record<string, unknown>): number {
  return Array.isArray(params['shots']) ? params['shots'].length : 0
}

/**
 * One version of a plan in a state.
 * @param state - the state of the branch.
 * @param plan - the PlanId.
 * @param version - the version number; the latest version when omitted.
 * @returns the version.
 * @throws Error naming the unknown plan or version.
 */
function versionIn(state: ProjectState, plan: string, version?: number): PlanVersion {
  const versions = state.components.plan.plans[brandString<PlanId>(plan)]
  if (versions === undefined) throw new Error(`Unknown plan '${plan}'; pass the plan ID (p1, p2, …) that dv_plan_create reported.`)
  const found = version === undefined ? versions.at(-1) : versions[version - 1]
  if (found === undefined) throw new Error(`Plan '${plan}' has no version ${String(version)}; it has ${versions.length}.`)
  return found
}

/** A JSON text of a value with sorted object keys, so equal params compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
    : entry)
}

/** One shot of an approval: the `shot.render` request part, and the done take it reuses, or null when it renders. */
interface ApprovalShot {
  params: Record<string, unknown>
  inputs: RunRequest['inputs']
  reuse: RecordId | null
}

/**
 * The `shot.render` params and reference inputs of every shot of a plan version, in shot order, as `plan.approve`
 * schedules them, and the take each unchanged shot reuses. A shot is unchanged when a done `shot.render` record of the
 * same plan on the approving branch has the same params (apart from `plan`, `plan_version` and `shot`), the same
 * reference inputs, and the same `first_frame` input: none for an independent or first shot, the reused take of the
 * previous shot for a chained shot, so a chained shot after a rendered shot renders too. The newest such take is
 * reused. The chained `first_frame` input of a rendered shot is added by the caller, because it can name a record that
 * does not exist yet.
 * @param version - the plan version.
 * @param plan - the PlanId.
 * @param project - the Project service, which parses the references against the state.
 * @param state - the state of the approving branch.
 * @returns one entry per shot.
 * @throws Error when a reference names an unknown character, location or style version.
 */
function approvalShots(
  version: PlanVersion, plan: string, project: Pick<DvProject, 'parseInputs'>, state: ProjectState,
): ApprovalShot[] {
  const takes = state.components.proj.records
    .filter(record => record.operation === SHOT_RENDER && record.status === 'done' && record.params['plan'] === plan).reverse()
  const ownParams = (params: Record<string, unknown>): string =>
    canonical(Object.fromEntries(Object.entries(params).filter(([key]) => !PLAN_RENDER_PARAMS.has(key))))
  const shots: ApprovalShot[] = []
  for (const [index, shot] of version.shots.entries()) {
    const references = shot.references ?? version.references ?? []
    const inputs: RunRequest['inputs'] = references.length === 0 ? [] : project.parseInputs(SHOT_RENDER, { reference: references }, state)
    const params: Record<string, unknown> = { prompt: shot.prompt, plan, plan_version: version.version, shot: index + 1 }
    for (const [key, value] of Object.entries({
      duration_sec: shot.duration_sec, aspect_ratio: version.aspect_ratio, resolution: version.resolution,
      generation_mode: version.generation_mode, seed: shot.seed ?? version.seed,
    })) if (value !== undefined) params[key] = value
    // The take a chained shot starts from; a chained shot after a rendered shot has none to match.
    const previous = shots.at(-1)
    const chained = version.continuity === 'chained' && previous !== undefined
    const firstFrame = chained ? (previous.reuse === null ? null : canonical([{ record: previous.reuse, output: 1 }])) : canonical([])
    const wanted = canonical(inputs.map(input => input.ref))
    const reuse = firstFrame === null ? undefined : takes.find(take => ownParams(take.params) === ownParams(params)
      && canonical(take.inputs.filter(input => input.role === 'reference').map(input => input.ref)) === wanted
      && canonical(take.inputs.filter(input => input.role === 'first_frame').map(input => input.ref)) === firstFrame)
    shots.push({ params, inputs, reuse: reuse?.id ?? null })
  }
  return shots
}

/**
 * The timeline an approval of a plan lays the takes on, and the operation that does it. The plan's timeline is the
 * timeline whose latest finished `timeline.create` or `timeline.update` record names the plan in `params.plan`; the
 * approval replaces its clips with `timeline.update`. Without one, it creates a timeline with the next free ID (`t<n>`
 * after the highest number in use, `t1` in a project without timelines) with `timeline.create`.
 * @param state - the state the approval runs on.
 * @param plan - the PlanId.
 * @returns the operation and the timeline ID.
 */
function timelineCall(state: ProjectState, plan: string): { operation: string; timeline: string } {
  // The plan named by the latest create or update record of each timeline; a create without an ID created `t1`.
  const latestPlan = new Map<string, unknown>()
  for (const record of state.components.proj.records) {
    if (record.status !== 'done' || (record.operation !== TIMELINE_CREATE && record.operation !== TIMELINE_UPDATE)) continue
    latestPlan.set(typeof record.params['timeline'] === 'string' ? record.params['timeline'] : 't1', record.params['plan'])
  }
  const timelines = state.components.timeline.timelines
  const own = timelines.find(timeline => latestPlan.get(timeline.id) === plan)
  if (own !== undefined) return { operation: TIMELINE_UPDATE, timeline: own.id }
  const highest = Math.max(0, ...timelines.map(timeline => Number(/^t(\d+)$/.exec(timeline.id)?.[1] ?? 0)))
  return { operation: TIMELINE_CREATE, timeline: `t${String(highest + 1)}` }
}

/** The Shot plan service: the three operations, the reducer, and the methods the operations run. */
export default class DvShotPlan extends Service {
  static inject = ['dvProject']
  static Config = Config

  /** The highest plan number this service assigned per project, for calls whose records have not finished yet. */
  private readonly assigned = new Map<ProjectId, number>()

  constructor(ctx: Context, _config: Config) {
    super(ctx, 'dvShotPlan')
    ctx.effect(() => ctx.dvProject.registerReducer('plan', planReducer), 'dvShotPlan reducer')
    for (const spec of this.operations()) ctx.effect(() => ctx.dvProject.registerOperation(spec), `dvShotPlan ${spec.name}`)
  }

  /**
   * Read one version of a plan.
   * @param state - the state of the branch the plan is read on.
   * @param plan - the PlanId.
   * @param version - the version number; the latest version when omitted.
   * @returns the version.
   * @throws Error naming the unknown plan or version.
   */
  getPlan(state: ProjectState, plan: PlanId | string, version?: number): PlanVersion {
    return versionIn(state, plan, version)
  }

  /**
   * The shots that approving a plan version would render: the new and changed shots (see `approvalShots`); the others
   * keep their done takes.
   * @param state - the state of the branch the approval runs on.
   * @param plan - the PlanId.
   * @param version - the version number; the latest version when omitted.
   * @returns the 1-based shot positions, in shot order.
   * @throws Error naming the unknown plan or version, or an unknown character, location or style version.
   */
  shotsToRender(state: ProjectState, plan: PlanId | string, version?: number): number[] {
    return approvalShots(versionIn(state, plan, version), plan, this.ctx.dvProject, state)
      .flatMap((shot, index) => shot.reuse === null ? [index + 1] : [])
  }

  /**
   * Assign a new PlanId in a project. The number after `p` is one more than the highest number that any Shot plan
   * record of the project stored in `report.plan`, on any branch, and than any number this service assigned to a call
   * still running, so no two plans of a project share an ID.
   * @param project - the project.
   * @returns the PlanId.
   */
  private assignPlanId(project: ProjectId): PlanId {
    let highest = this.assigned.get(project) ?? 0
    for (const entry of this.ctx.dvProject.listHistory({ project, component: 'plan' })) {
      highest = Math.max(highest, Number(/^p(\d+)$/.exec(reportedPlan(entry.record) ?? '')?.[1] ?? 0))
    }
    this.assigned.set(project, highest + 1)
    return brandString<PlanId>(`p${String(highest + 1)}`)
  }

  /**
   * Schedule the renders of the plan version that a running `plan.approve` call names (its `version` param, else the
   * latest version): one `shot.render` per shot that is new or changed (see `approvalShots`; an unchanged shot reuses
   * its done take), and one `timeline.update` of the plan's timeline with every shot's take in shot order, or a
   * `timeline.create` of a new timeline when the plan has none (see `timelineCall`), written by the `system` actor in the
   * approving record's surface, session and turn. A rendered chained shot names its predecessor's last still (output 1)
   * as its `first_frame` input; each render waits for the render scheduled before it.
   * @param context - the running `plan.approve` call.
   * @returns the approved version, and the scheduled records: the shot renders in shot order, then the timeline.
   * @throws Error when the param names no known plan or version, or a reference names an unknown character, location
   *   or style version.
   */
  async approvePlan(context: OperationContext): Promise<{ version: number; scheduled: RecordId[] }> {
    const approve = context.record
    /* v8 ignore next -- plan.approve is not read-only, so it always runs with a record. */
    if (approve === null) throw new Error('plan.approve runs only with a record.')
    const plan = String(context.params['plan'])
    const requested = context.params['version']
    const version = versionIn(context.state, plan, typeof requested === 'number' ? requested : undefined)
    const project = this.ctx.dvProject
    const origin = { actor: 'system' as const, surface: approve.surface, session: approve.session, turn: approve.turn, tool_call: null }
    const scheduled: RecordId[] = []
    const takes: RecordId[] = []
    for (const shot of approvalShots(version, plan, project, context.state)) {
      if (shot.reuse !== null) {
        takes.push(shot.reuse)
        continue
      }
      const previousTake = takes.at(-1)
      if (version.continuity === 'chained' && previousTake !== undefined) {
        shot.inputs.push({ role: 'first_frame', ref: { record: previousTake, output: 1 } })
      }
      const previous = scheduled.at(-1)
      const run = await project.run({
        ...origin, project: context.project, operation: SHOT_RENDER, params: shot.params, inputs: shot.inputs,
        intent: `shot ${String(shot.params['shot'])} of plan ${plan} v${version.version}`, after: previous === undefined ? [] : [previous],
      })
      /* v8 ignore next -- a scheduled run always returns its pending record. */
      if (run.record === null) throw new Error('A scheduled shot render returned no record.')
      scheduled.push(run.record.id)
      takes.push(run.record.id)
    }
    const layout = timelineCall(context.state, plan)
    const verb = layout.operation === TIMELINE_CREATE ? 'create' : 'update'
    const timeline = await project.run({
      ...origin, project: context.project, operation: layout.operation, params: { timeline: layout.timeline, plan },
      inputs: takes.map(id => ({ role: 'clip', ref: { record: id, output: 0 } })),
      intent: `${verb} timeline ${layout.timeline} of plan ${plan}`, after: scheduled,
    })
    return { version: version.version, scheduled: timeline.record === null ? scheduled : [...scheduled, timeline.record.id] }
  }

  /**
   * Refuse a `plan.approve` call before its record when the plan or version is unknown, or when a shot it would render
   * breaks the precondition of `shot.render` (the reference-image rule): every rendered shot is checked, and one error
   * names all refused shots, so the plan can be fixed at once. Without a registered `shot.render`, only the plan is
   * checked.
   * @param request - the `plan.approve` call.
   * @param state - the state of the working branch the call writes to.
   * @throws Error naming the unknown plan or version, or the refused shots followed by the `shot.render` refusal; the
   *   error of an unknown character, location or style version.
   */
  private async precondition(request: RunRequest, state: ProjectState): Promise<void> {
    const plan = String(request.params['plan'])
    const requested = request.params['version']
    const version = versionIn(state, plan, typeof requested === 'number' ? requested : undefined)
    const project = this.ctx.dvProject
    const render = project.listOperations().find(spec => spec.name === SHOT_RENDER)
    if (render?.precondition === undefined) return
    const refused: number[] = []
    let reason = ''
    for (const shot of approvalShots(version, plan, project, state)) {
      if (shot.reuse !== null) continue
      try {
        await render.precondition({ ...request, operation: SHOT_RENDER, params: shot.params, inputs: shot.inputs }, state)
      } catch (error: unknown) {
        refused.push(Number(shot.params['shot']))
        if (reason === '') reason = error instanceof Error ? error.message : String(error)
      }
    }
    if (refused.length === 0) return
    const verb = refused.length === 1 ? 'has' : 'have'
    throw new Error(`Shot ${refused.join(', ')} of the plan ${verb} no reference image. ${reason}`)
  }

  /** The three plan operations. */
  private operations(): OperationSpec[] {
    const create: OperationSpec = {
      name: 'plan.create',
      component: 'plan',
      version: '1',
      description: 'Propose a new plan for a separate story: the shots with prompts and durations, the references, and whether shots '
        + 'chain from each other. The report names the new plan ID (p1, p2, …). To extend, shorten or change an existing plan, call '
        + 'dv_plan_update instead. Nothing is rendered until the user approves it with dv_plan_approve.',
      inputs: {},
      params: PLAN_PARAMS,
      outputs: [{ role: 'plan', type: 'json' }],
      deterministic: true,
      resource: 'none',
      confirm: 'never',
      summarize: record => `plan with ${shotCount(record.params)} shots`,
      execute: (context): Promise<OperationResult> => {
        const plan = planOf(context.params)
        if (plan.shots.length === 0) throw new Error('plan.create needs at least one shot.')
        const asset = context.importAsset(Buffer.from(JSON.stringify(plan, null, 2)), { mime: 'application/json', name: 'plan.json' })
        return Promise.resolve({ outputs: [asset], report: { plan: this.assignPlanId(context.project), version: 1 } })
      },
    }
    return [
      create,
      {
        ...create,
        name: 'plan.update',
        description: 'Write the next version of an existing plan: pass its plan ID and the complete plan (every shot, in order; '
          + 'a shot added after six shots is shot 7). Use it to extend, shorten or change the story. Approving the version '
          + 'renders only the new or changed shots and updates the plan\'s timeline.',
        params: { plan: { type: 'string', required: true, description: 'The plan ID (p1, p2, …).' }, ...PLAN_PARAMS },
        summarize: record => `plan updated (${shotCount(record.params)} shots)`,
        precondition: (request, state) => {
          versionIn(state, String(request.params['plan']))
          return Promise.resolve()
        },
        execute(context): Promise<OperationResult> {
          const plan = String(context.params['plan'])
          const latest = versionIn(context.state, plan)
          const version = planOf(context.params)
          if (version.shots.length === 0) throw new Error('plan.update needs at least one shot.')
          const asset = context.importAsset(Buffer.from(JSON.stringify(version, null, 2)), { mime: 'application/json', name: 'plan.json' })
          return Promise.resolve({ outputs: [asset], report: { plan, version: latest.version + 1 } })
        },
      },
      {
        name: 'plan.approve',
        component: 'plan',
        version: '1',
        description: 'Record the user\'s approval of a plan version and render its new or changed shots in order; unchanged shots keep '
          + 'their takes, and the plan\'s timeline gets every shot. Only call this after the user agreed to the plan you showed them.',
        inputs: {},
        params: {
          plan: { type: 'string', required: true, description: 'The plan ID (p1, p2, …).' },
          version: { type: 'integer', description: 'The version to approve; defaults to the latest.' },
        },
        outputs: [],
        deterministic: false,
        resource: 'none',
        confirm: 'agent_ask_first',
        summarize: (record) => {
          const version = record.params['version'] ?? record.report?.['version']
          return `plan ${String(record.params['plan'] ?? '')}${typeof version === 'number' ? ` v${version}` : ''} approved`
        },
        // The agent is refused before the question rule asks the user; every other caller is refused by the runner.
        prepareToolCall: call => this.precondition(call.request, call.state),
        precondition: (request, state) => this.precondition(request, state),
        execute: async (context): Promise<OperationResult> => {
          const { version, scheduled } = await this.approvePlan(context)
          return { outputs: [], report: { plan: String(context.params['plan']), version, scheduled } }
        },
      },
    ]
  }
}
