/**
 * The Shot plan component of DreamVerse as the `dvShotPlan` Cordis service: the plan of a video before anything is
 * rendered. A plan has a `PlanId` (`p1`, `p2`, …) and numbered versions. It owns three operations:
 * - `plan.create`: version 1 of a new plan (the shots with their render modes, prompts and durations, and the
 *   references), stored as a JSON asset so the agent and the user read the same text; the assigned PlanId goes in
 *   `report.plan`;
 * - `plan.update`: the next version of the plan its `plan` param names;
 * - `plan.approve`: the user's go-ahead for one version; through `dvProject.run` as the `system` actor, it schedules one
 *   render per new or changed shot with the Shot render operation of the shot's render mode (`shot.render_<mode>`), and
 *   one `timeline.update` of the plan's timeline with every shot's take, or a `timeline.create` of a new timeline when
 *   the plan has none.
 *
 * `plan.create` and `plan.update` refuse a shot whose render mode has no registered Shot render operation, so a plan
 * names only render modes the deployment serves.
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
import type { Plan, PlanId, PlanVersion, Shot } from './types.ts'

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

/** The render modes a shot can name. */
const RENDER_MODES: ReadonlyArray<Shot['mode']> = ['ref2va', 't2va']

/** The render modes whose shots take reference images; a shot of another mode ignores the plan's references. */
const REFERENCE_MODES: ReadonlySet<Shot['mode']> = new Set(['ref2va'])

/** The render modes whose shots can start from the previous shot's last still (`continue_previous`). */
const CONTINUE_MODES: ReadonlySet<Shot['mode']> = new Set(['ref2va'])

/**
 * The Shot render operation that renders a shot of a render mode; `plan.approve` schedules it by name.
 * @param mode - the render mode.
 * @returns the operation name, such as `shot.render_ref2va`.
 */
function renderOperation(mode: Shot['mode']): string {
  return `shot.render_${mode}`
}

/** The operations that lay out the rendered clips on a timeline; `plan.approve` schedules one of them by name. */
const TIMELINE_CREATE = 'timeline.create'
const TIMELINE_UPDATE = 'timeline.update'

/** One shot of a plan as the tool params declare it. */
const SHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: {
      type: 'string', enum: [...RENDER_MODES], required: true,
      description: 'The render mode. ref2va: from reference images (at least one) and the prompt; t2va: from the prompt alone. '
        + 'Use only a mode whose tool (dv_shot_render_ref2va, dv_shot_render_t2va) you have.',
    },
    prompt: { type: 'string', required: true, description: 'The complete prompt of this shot, written for its render mode.' },
    duration_sec: { type: 'integer', description: 'Seconds; defaults to the model minimum.' },
    references: {
      type: 'array', items: { type: 'string' },
      description: 'ref2va only: character, location or style versions (c1@1) or asset IDs this shot uses instead of the plan references.',
    },
    continue_previous: {
      type: 'boolean',
      description: 'ref2va only, not on shot 1: the shot starts from the last frame of the previous shot. Omit it for a shot that '
        + 'does not continue the previous one.',
    },
    seed: { type: 'integer' },
  },
} as const

/** The params of `plan.create`: the fields of a `Plan`. */
const PLAN_PARAMS = {
  title: { type: 'string' },
  references: {
    type: 'array', items: { type: 'string' },
    description: 'Character, location or style versions (c1@1) or asset IDs every ref2va shot references unless it names its own.',
  },
  aspect_ratio: { type: 'string' },
  resolution: { type: 'string' },
  seed: { type: 'integer' },
  shots: { type: 'array', required: true, items: SHOT_SCHEMA },
} as const

/** The render params that tell where a plan's take came from; a reused take differs from its shot only in them. */
const PLAN_RENDER_PARAMS: ReadonlySet<string> = new Set(['plan', 'plan_version', 'shot'])

/** What approving a plan version renders: one line per shot, the number of shots it renders, and their GPU estimate. */
interface RenderCost {
  shots: string[]
  rendered: number
  gpu_seconds: number
}

/** How many characters of a shot's prompt the approval summary shows. */
const PROMPT_PREVIEW = 80

/** The number of shots in a plan record's params, for summaries. */
function shotCount(params: Record<string, unknown>): number {
  return Array.isArray(params['shots']) ? params['shots'].length : 0
}

/**
 * The problems of a plan's shots that no render can fix: a render mode without a registered Shot render operation, a
 * `t2va` shot with references, and `continue_previous` on shot 1 or on a mode that cannot continue.
 * @param shots - the shots, in order.
 * @param operations - the names of the registered operations.
 * @returns one sentence per problem, empty when the shots are valid.
 */
function shotProblems(shots: readonly Shot[], operations: ReadonlySet<string>): string[] {
  const served = RENDER_MODES.filter(mode => operations.has(renderOperation(mode)))
  return shots.flatMap((shot, index) => {
    const n = String(index + 1)
    const problems: string[] = []
    if (!operations.has(renderOperation(shot.mode))) {
      problems.push(`Shot ${n} uses render mode ${shot.mode}, which this project cannot render (there is no dv_shot_render_${shot.mode} `
        + `tool); render modes available: ${served.join(', ') || 'none'}.`)
    }
    if (!REFERENCE_MODES.has(shot.mode) && (shot.references?.length ?? 0) > 0) {
      problems.push(`Shot ${n} uses render mode ${shot.mode}, which takes no reference images; remove its references or use ref2va.`)
    }
    if (shot.continue_previous === true && !CONTINUE_MODES.has(shot.mode)) {
      problems.push(`Shot ${n} uses render mode ${shot.mode}, which cannot start from the previous shot; continue_previous needs ref2va.`)
    } else if (shot.continue_previous === true && index === 0) {
      problems.push('Shot 1 has no previous shot to continue; remove its continue_previous.')
    }
    return problems
  })
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

/**
 * One shot of an approval: the render operation of its mode and the request part, whether it starts from the previous
 * shot's last still, and the done take it reuses, or null when it renders.
 */
interface ApprovalShot {
  operation: string
  params: Record<string, unknown>
  inputs: RunRequest['inputs']
  continuePrevious: boolean
  reuse: RecordId | null
}

/**
 * The render operation, params and reference inputs of every shot of a plan version, in shot order, as `plan.approve`
 * schedules them, and the take each unchanged shot reuses. A `ref2va` shot carries its own references, else the plan's;
 * a `t2va` shot carries none. A shot is unchanged when a done record of the shot's render operation for the same plan on
 * the approving branch has the same params (apart from `plan`, `plan_version` and `shot`), the same reference inputs,
 * and the same `first_frame` input: none for a shot without `continue_previous`, else the reused take of the previous
 * shot, so a continuing shot after a rendered shot renders too. The newest such take is reused. The `first_frame` input
 * of a rendered continuing shot is added by the caller, because it can name a record that does not exist yet.
 * @param version - the plan version.
 * @param plan - the PlanId.
 * @param project - the Project service, which parses the references against the state.
 * @param state - the state of the approving branch.
 * @returns one entry per shot.
 * @throws Error when a reference names an unknown character, location or style version.
 */
function approvalShots(
  version: Plan & { version: number }, plan: string, project: Pick<DvProject, 'parseInputs'>, state: ProjectState,
): ApprovalShot[] {
  const takes = state.components.proj.records.filter(record => record.status === 'done' && record.params['plan'] === plan).reverse()
  const ownParams = (params: Record<string, unknown>): string =>
    canonical(Object.fromEntries(Object.entries(params).filter(([key]) => !PLAN_RENDER_PARAMS.has(key))))
  const shots: ApprovalShot[] = []
  for (const [index, shot] of version.shots.entries()) {
    const operation = renderOperation(shot.mode)
    const references = REFERENCE_MODES.has(shot.mode) ? shot.references ?? version.references ?? [] : []
    const inputs: RunRequest['inputs'] = references.length === 0 ? [] : project.parseInputs(operation, { reference: references }, state)
    const params: Record<string, unknown> = { prompt: shot.prompt, plan, plan_version: version.version, shot: index + 1 }
    for (const [key, value] of Object.entries({
      duration_sec: shot.duration_sec, aspect_ratio: version.aspect_ratio, resolution: version.resolution, seed: shot.seed ?? version.seed,
    })) if (value !== undefined) params[key] = value
    // The take a continuing shot starts from; a continuing shot after a rendered shot has none to match.
    const previous = shots.at(-1)
    const continuePrevious = shot.continue_previous === true && previous !== undefined
    const firstFrame = continuePrevious
      ? (previous.reuse === null ? null : canonical([{ record: previous.reuse, output: 1 }]))
      : canonical([])
    const wanted = canonical(inputs.map(input => input.ref))
    const reuse = firstFrame === null ? undefined : takes.find(take => take.operation === operation
      && ownParams(take.params) === ownParams(params)
      && canonical(take.inputs.filter(input => input.role === 'reference').map(input => input.ref)) === wanted
      && canonical(take.inputs.filter(input => input.role === 'first_frame').map(input => input.ref)) === firstFrame)
    shots.push({ operation, params, inputs, continuePrevious, reuse: reuse?.id ?? null })
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
   * latest version): one call of the shot's render operation (`shot.render_<mode>`) per shot that is new or changed (see
   * `approvalShots`; an unchanged shot reuses its done take), and one `timeline.update` of the plan's timeline with every
   * shot's take in shot order, or a `timeline.create` of a new timeline when the plan has none (see `timelineCall`),
   * written by the `system` actor in the approving record's surface, session and turn. A rendered shot with
   * `continue_previous` names its predecessor's last still (output 1) as its `first_frame` input; each render waits for
   * the render scheduled before it. The timeline call runs at once:
   * its `clip` inputs name each shot's render output or kept take (`{record, output: 0}`), and a clip whose render is
   * not done is a placeholder until it is.
   * @param context - the running `plan.approve` call.
   * @returns the approved version, and the records it wrote: the scheduled shot renders in shot order, then the timeline.
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
      if (shot.continuePrevious && previousTake !== undefined) {
        shot.inputs.push({ role: 'first_frame', ref: { record: previousTake, output: 1 } })
      }
      const previous = scheduled.at(-1)
      const run = await project.run({
        ...origin, project: context.project, operation: shot.operation, params: shot.params, inputs: shot.inputs,
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
      intent: `${verb} timeline ${layout.timeline} of plan ${plan}`,
    })
    return { version: version.version, scheduled: timeline.record === null ? scheduled : [...scheduled, timeline.record.id] }
  }

  /**
   * Refuse a `plan.create` or `plan.update` call before its record when a shot names a render mode that has no
   * registered Shot render operation, a `t2va` shot names references, or `continue_previous` is set on shot 1 or on a
   * mode that cannot continue (see `shotProblems`), or when a `ref2va` shot's references (its own, else the plan's)
   * name an unknown character, location or style version, so the report's GPU estimate can be computed.
   * @param plan - the plan of the call's params.
   * @param state - the state of the current branch the call writes to.
   * @throws Error with one sentence per problem, or the error of the unknown reference.
   */
  private checkPlan(plan: Plan, state: ProjectState): void {
    const project = this.ctx.dvProject
    const problems = shotProblems(plan.shots, new Set(project.listOperations().map(spec => spec.name)))
    if (problems.length > 0) throw new Error(`The plan cannot be rendered as written. ${problems.join(' ')}`)
    for (const shot of plan.shots) {
      const references = REFERENCE_MODES.has(shot.mode) ? shot.references ?? plan.references ?? [] : []
      if (references.length > 0) project.parseInputs(renderOperation(shot.mode), { reference: references }, state)
    }
  }

  /**
   * Refuse a `plan.approve` call before its record when the plan or version is unknown, when a shot names a render mode
   * that has no registered Shot render operation (see `checkPlan`), or when a shot it would render breaks the
   * precondition of its render operation (for `shot.render_ref2va`, the reference-image rule): every rendered shot is
   * checked, and one error names all refused shots, so the plan can be fixed at once.
   * @param request - the `plan.approve` call.
   * @param state - the state of the current branch the call writes to.
   * @throws Error naming the unknown plan or version, the shots and their problems, or the refused shots followed by the
   *   first render refusal; the error of an unknown character, location or style version.
   */
  private async precondition(request: RunRequest, state: ProjectState): Promise<void> {
    const plan = String(request.params['plan'])
    const requested = request.params['version']
    const version = versionIn(state, plan, typeof requested === 'number' ? requested : undefined)
    this.checkPlan(version, state)
    const project = this.ctx.dvProject
    const operations = project.listOperations()
    const refused: number[] = []
    let reason = ''
    for (const shot of approvalShots(version, plan, project, state)) {
      const render = operations.find(spec => spec.name === shot.operation)
      if (shot.reuse !== null || render?.precondition === undefined) continue
      try {
        await render.precondition({ ...request, operation: shot.operation, params: shot.params, inputs: shot.inputs }, state)
      } catch (error: unknown) {
        refused.push(Number(shot.params['shot']))
        if (reason === '') reason = error instanceof Error ? error.message : String(error)
      }
    }
    if (refused.length === 0) return
    const verb = refused.length === 1 ? 'is' : 'are'
    throw new Error(`Shot ${refused.join(', ')} of the plan ${verb} refused by its render operation. ${reason}`)
  }

  /**
   * What approving a plan version renders and costs: one line per shot (its render mode, duration, whether it continues
   * the previous shot, and the start of its prompt, or that it keeps its take), the number of shots it renders, and the
   * sum of the render operations' GPU estimates for those shots. `plan.create` and `plan.update` report it, and the
   * `confirmSummary` of `plan.approve` repeats it.
   * @param version - the plan version, which need not be in the state yet.
   * @param plan - the PlanId.
   * @param state - the state of the branch the approval would run on.
   * @returns the shot lines, the rendered shot count, and the GPU seconds.
   * @throws Error when a reference names an unknown character, location or style version.
   */
  private renderCost(version: Plan & { version: number }, plan: string, state: ProjectState): RenderCost {
    const operations = this.ctx.dvProject.listOperations()
    let gpuSeconds = 0
    const shots = approvalShots(version, plan, this.ctx.dvProject, state)
    const lines = shots.map((shot, index) => {
      const planned = version.shots[index]
      if (shot.reuse !== null || planned === undefined) return `shot ${String(index + 1)}: keeps its take`
      gpuSeconds += operations.find(spec => spec.name === shot.operation)?.estimate?.(shot.params).gpu_seconds ?? 0
      const duration = planned.duration_sec === undefined ? '' : `, ${String(planned.duration_sec)} s`
      const continues = shot.continuePrevious ? ', continues from the previous shot' : ''
      const prompt = planned.prompt.length > PROMPT_PREVIEW ? `${planned.prompt.slice(0, PROMPT_PREVIEW)}…` : planned.prompt
      return `shot ${String(index + 1)} (${planned.mode}${duration}${continues}): ${prompt}`
    })
    return { shots: lines, rendered: shots.filter(shot => shot.reuse === null).length, gpu_seconds: gpuSeconds }
  }

  /**
   * The `confirmSummary` of `plan.approve`: the head line and the shot lines of `renderCost`, and its GPU seconds.
   * @param request - the `plan.approve` call.
   * @param state - the state of the project's current branch.
   * @returns the text and the GPU seconds.
   */
  private approvalSummary(request: RunRequest, state: ProjectState): { text: string; gpu_seconds: number } {
    const plan = String(request.params['plan'])
    const requested = request.params['version']
    const version = versionIn(state, plan, typeof requested === 'number' ? requested : undefined)
    const cost = this.renderCost(version, plan, state)
    const title = version.title === undefined ? '' : ` "${version.title}"`
    const head = `Approve plan ${plan} v${String(version.version)}${title}: render ${String(cost.rendered)} of ${String(cost.shots.length)} `
      + 'shots and lay every shot on the plan\'s timeline.'
    return { text: [head, ...cost.shots.map(line => `- ${line}`)].join('\n'), gpu_seconds: cost.gpu_seconds }
  }

  /** The three plan operations. */
  private operations(): OperationSpec[] {
    const create: OperationSpec = {
      name: 'plan.create',
      component: 'plan',
      version: '1',
      description: 'Propose a new plan for a separate story: for each shot its render mode, its prompt written for that mode, its '
        + 'duration, and its inputs (references; continue_previous to start from the previous shot\'s last frame). The report names '
        + 'the new plan ID (p1, p2, …), one line per shot, and gpu_seconds, the GPU estimate of approving it; show them to the user. '
        + 'To extend, shorten or change an existing plan, call dv_plan_update instead. Nothing is rendered until the user agrees in '
        + 'the conversation and you call dv_plan_approve.',
      inputs: {},
      params: PLAN_PARAMS,
      outputs: [{ role: 'plan', type: 'json' }],
      deterministic: true,
      resource: 'none',
      confirm: 'never',
      summarize: record => `plan with ${shotCount(record.params)} shots`,
      precondition: (request, state) => {
        this.checkPlan(planOf(request.params), state)
        return Promise.resolve()
      },
      execute: (context): Promise<OperationResult> => {
        const plan = planOf(context.params)
        if (plan.shots.length === 0) throw new Error('plan.create needs at least one shot.')
        const id = this.assignPlanId(context.project)
        const { shots, gpu_seconds: gpuSeconds } = this.renderCost({ ...plan, version: 1 }, id, context.state)
        const asset = context.importAsset(Buffer.from(JSON.stringify(plan, null, 2)), { mime: 'application/json', name: 'plan.json' })
        return Promise.resolve({ outputs: [asset], report: { plan: id, version: 1, shots, gpu_seconds: gpuSeconds } })
      },
    }
    return [
      create,
      {
        ...create,
        name: 'plan.update',
        description: 'Write the next version of an existing plan: pass its plan ID and the complete plan (every shot, in order; '
          + 'a shot added after six shots is shot 7). Use it to extend, shorten or change the story. The report names the version, '
          + 'one line per shot (the new or changed shots, and the shots that keep their takes), and gpu_seconds, the GPU estimate of '
          + 'approving it. Approving the version renders only the new or changed shots and updates the plan\'s timeline.',
        params: { plan: { type: 'string', required: true, description: 'The plan ID (p1, p2, …).' }, ...PLAN_PARAMS },
        summarize: record => `plan updated (${shotCount(record.params)} shots)`,
        precondition: (request, state) => {
          versionIn(state, String(request.params['plan']))
          this.checkPlan(planOf(request.params), state)
          return Promise.resolve()
        },
        execute: (context): Promise<OperationResult> => {
          const plan = String(context.params['plan'])
          const latest = versionIn(context.state, plan)
          const version = planOf(context.params)
          if (version.shots.length === 0) throw new Error('plan.update needs at least one shot.')
          const number = latest.version + 1
          const { shots, gpu_seconds: gpuSeconds } = this.renderCost({ ...version, version: number }, plan, context.state)
          const asset = context.importAsset(Buffer.from(JSON.stringify(version, null, 2)), { mime: 'application/json', name: 'plan.json' })
          return Promise.resolve({ outputs: [asset], report: { plan, version: number, shots, gpu_seconds: gpuSeconds } })
        },
      },
      {
        name: 'plan.approve',
        component: 'plan',
        version: '1',
        description: 'Record the user\'s approval of a plan version and render its new or changed shots in order, each with the '
          + 'tool of its render mode; unchanged shots keep their takes, and the plan\'s timeline gets every shot. Call it only after '
          + 'you showed the plan and the user agreed in the conversation. Then call dv_proj_wait and read dv_proj_state.',
        inputs: {},
        params: {
          plan: { type: 'string', required: true, description: 'The plan ID (p1, p2, …).' },
          version: { type: 'integer', description: 'The version to approve; defaults to the latest.' },
        },
        outputs: [],
        deterministic: false,
        resource: 'none',
        confirm: 'always',
        confirmSummary: call => this.approvalSummary(call.request, call.state),
        summarize: (record) => {
          const version = record.params['version'] ?? record.report?.['version']
          return `plan ${String(record.params['plan'] ?? '')}${typeof version === 'number' ? ` v${version}` : ''} approved`
        },
        // The agent is refused before Project asks it to get the user's agreement; every other caller is refused by the runner.
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
