/**
 * The project runtime as the `vhProject` Cordis service: the one place that writes operation records.
 *
 * `invoke` resolves entity versions to assets, appends a pending record on the right branch, runs the tool, and
 * records the outputs. `schedule` appends the record and lets the scheduler run it once the records its inputs name
 * have finished, under one concurrency limit per cost class; an approved plan is scheduled this way, one generation
 * per shot. `fold` turns any head into the state views show. Turns open a draft branch per agent turn and fast-forward
 * `main` when the user accepts; `undoLatestTurn` moves `main` back; `createBranch` starts an exploration. Deterministic
 * tools are served from a cache keyed by their inputs and params, and are replayed on the replacement when a record
 * they consumed is superseded.
 *
 * @module @video-harness/runtime
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import z from '@deepseek-ai/schemastery'
import type {} from '@video-harness/assets'
import {
  MAIN_BRANCH, type AssetId, type EntityId, type InputRef, type Op, type OpDraft, type OpId, type OpInput, type ProjectId, type TurnId,
} from '@video-harness/oplog'
import { builtinTools } from './builtins.ts'
import { foldChain, parseEntityRef, parseEntityTool, parseOutputRef } from './fold.ts'
import type {
  InvokeRequest, PlanDocument, ProjectState, ResolvedInput, RuntimeToolSpec, ScheduleOptions, ToolCost, ToolResult,
} from './types.ts'

export * from './types.ts'
export {
  DEFAULT_SEQUENCE_ID, ENTITY_CREATE_TOOL, ENTITY_UPDATE_TOOL, SEQUENCE_TOOLS, foldChain, inputAsset, parseEntityRef, parseEntityTool,
  parseOutputRef,
} from './fold.ts'
export { builtinTools, ffmpegAvailable } from './builtins.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The project runtime: invoke or schedule tools, fold state, manage turns, drafts, undo, and branches. */
    vhProject: VhProject
  }
}

/** `vhProject` plugin configuration. */
export interface Config {
  /** The ffmpeg binary for the built-in trim and placeholder generator. */
  ffmpegPath: string
  /** Mount the built-in tools; a profile that mounts its own `generate.video` may still keep them. */
  builtinTools: boolean
  /** Scheduled records of `gpu`-cost tools that may run at the same time. */
  gpuConcurrency: number
  /** Scheduled records of `cpu`-cost tools that may run at the same time; `free` tools are not limited. */
  cpuConcurrency: number
}

/** Loader validation. */
export const Config: z<Config> = z.object({
  ffmpegPath: z.string().required(),
  builtinTools: z.boolean().default(true),
  gpuConcurrency: z.number().default(1),
  cpuConcurrency: z.number().default(4),
})

/** A turn the runtime opened and has not yet accepted or rejected. */
export interface OpenTurn {
  turn: TurnId
  branch: string
  /** The record `main` pointed at when the turn opened; acceptance requires it to still be the head. */
  base: OpId
  /** Whether the branch is a draft that acceptance fast-forwards `main` to. */
  draft: boolean
}

/** The caller broke a runtime rule: unknown tool, unknown entity, a draft behind `main`, nothing to undo. */
export class RuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeError'
  }
}

/** The tool that approves a plan; the runtime schedules the plan's shots after it. */
export const PLAN_APPROVE_TOOL = 'plan.approve'
/** The tool the scheduler uses for each shot of an approved plan. */
export const GENERATE_VIDEO_TOOL = 'generate.video'
/** The tool the scheduler uses to assemble an approved plan's shots. */
const SEQUENCE_CREATE_TOOL = 'sequence.create'

/** Canonical JSON: sorted keys, so two equal params objects hash the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** A record the scheduler owns until it runs or fails. */
interface Queued {
  projectId: ProjectId
  opId: OpId
  tool: RuntimeToolSpec
  after: OpId[]
}

/** Writes every record; views and the agent are its clients. */
export default class VhProject extends Service {
  static inject = ['vhAssets', 'vhOpLog']
  static Config = Config

  private readonly tools = new Map<string, RuntimeToolSpec>()
  private readonly openTurns = new Map<TurnId, OpenTurn>()
  private readonly queue: Queued[] = []
  /** Records being executed, by the project they belong to. */
  private readonly running = new Map<OpId, ProjectId>()
  private readonly runningByCost: Record<ToolCost, number> = { free: 0, cpu: 0, gpu: 0 }
  private readonly idleWaiters: Array<() => void> = []
  private readonly limits: Record<ToolCost, number>
  /** Set when the plugin is disposed, so a record that finishes afterwards does not start the next one. */
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'vhProject')
    this.limits = { free: Number.POSITIVE_INFINITY, cpu: config.cpuConcurrency, gpu: config.gpuConcurrency }
    ctx.effect(() => () => { this.disposed = true }, 'vhProject stop scheduling')
    if (config.builtinTools) {
      for (const tool of builtinTools(config.ffmpegPath)) this.registerTool(tool)
    }
    for (const info of ctx.vhOpLog.listProjects()) this.recoverOpenTurns(info.projectId)
  }

  /** Reopen the draft turns an earlier process left open: a `draft/<turn>` head with no approve or reject record. */
  private recoverOpenTurns(projectId: ProjectId): void {
    const log = this.ctx.vhOpLog
    for (const [branch, head] of Object.entries(log.heads(projectId))) {
      if (!branch.startsWith('draft/')) continue
      const chain = log.ancestors(projectId, head)
      const fork = chain.find(op => op.kind === 'branch' && op.branch === branch)
      if (fork === undefined) continue
      // The accept and reject records carry the turn in their params; a `plan.approve` tool record is also kind `approve`.
      if (chain.some(op => (op.kind === 'approve' || op.kind === 'reject') && op.tool === undefined && op.params['turn'] === fork.turn)) continue
      this.openTurns.set(fork.turn, { turn: fork.turn, branch, base: brandString<OpId>(String(fork.params['at'])), draft: true })
    }
  }

  /**
   * Make a tool invokable; a later registration of the same name replaces the earlier one.
   * @param spec - the tool.
   * @returns a function that removes the registration.
   */
  registerTool(spec: RuntimeToolSpec): () => void {
    this.tools.set(spec.name, spec)
    return () => {
      if (this.tools.get(spec.name) === spec) this.tools.delete(spec.name)
    }
  }

  /** @returns the registered tool names. */
  toolNames(): string[] {
    return [...this.tools.keys()]
  }

  /**
   * @param name - a tool name.
   * @returns the registered tool, or undefined.
   */
  tool(name: string): RuntimeToolSpec | undefined {
    return this.tools.get(name)
  }

  /**
   * Create a project whose `main` branch starts with one `intent` record, so every later record has a parent.
   * @param init - the title and who created it.
   * @returns the project ID.
   */
  createProject(init: { title: string; actor?: Op['actor']; surface?: Op['surface'] }): ProjectId {
    const projectId = this.ctx.vhOpLog.createProject({ title: init.title })
    this.ctx.vhOpLog.append(projectId, {
      parents: [], turn: brandString<TurnId>(randomUUID()), branch: MAIN_BRANCH, actor: init.actor ?? 'user',
      surface: init.surface ?? 'api', intent: `create project "${init.title}"`, kind: 'intent', inputs: [], params: {},
      outputs: [], status: 'done', deterministic: true,
    }, null)
    return projectId
  }

  /**
   * Fold the records reachable from a head.
   * @param projectId - the project.
   * @param head - a branch name or a record ID; defaults to `main`.
   * @returns the state at that head.
   */
  fold(projectId: ProjectId, head: OpId | string = MAIN_BRANCH): ProjectState {
    const log = this.ctx.vhOpLog
    const heads = log.heads(projectId)
    const headId = heads[head] ?? brandString<OpId>(head)
    const chain = log.ancestors(projectId, headId)
    const mainHead = heads[MAIN_BRANCH]
    const mainChain = headId === mainHead || mainHead === undefined
      ? null
      : new Set(log.ancestors(projectId, mainHead).map(op => op.id))
    return foldChain(projectId, chain, mainChain)
  }

  /**
   * Open a turn. An agent turn gets a draft branch forked from `main`; a user turn writes to `main` directly; a turn
   * on a named exploration branch writes there without a draft. The intent is recorded as the turn's first record.
   * @param projectId - the project.
   * @param init - who, from where, the words or gesture, and optionally the exploration branch.
   * @returns the turn and the branch its records go to.
   */
  beginTurn(projectId: ProjectId, init: { actor: Op['actor']; surface: Op['surface']; intent: string; branch?: string }): OpenTurn {
    const log = this.ctx.vhOpLog
    const mainHead = this.branchHead(projectId, MAIN_BRANCH)
    const turn = brandString<TurnId>(randomUUID())
    const draft = init.branch === undefined && init.actor === 'agent'
    const branch = init.branch ?? (draft ? `draft/${turn}` : MAIN_BRANCH)
    const parent = draft ? log.createBranch(projectId, branch, mainHead, turn).id : this.branchHead(projectId, branch)
    log.append(projectId, {
      parents: [], turn, branch, actor: init.actor, surface: init.surface, intent: init.intent, kind: 'intent',
      inputs: [], params: {}, outputs: [], status: 'done', deterministic: true,
    }, parent)
    const open: OpenTurn = { turn, branch, base: mainHead, draft }
    this.openTurns.set(turn, open)
    return open
  }

  /**
   * @param turn - a turn ID.
   * @returns the open turn, or undefined once it was accepted or rejected.
   */
  openTurn(turn: TurnId): OpenTurn | undefined {
    return this.openTurns.get(turn)
  }

  /**
   * Accept an agent turn: append an `approve` record on its draft and fast-forward `main` to it. Refused when `main`
   * moved since the draft forked, because the draft would silently drop that work.
   * @param projectId - the project.
   * @param turn - an open agent turn.
   * @param by - who accepted; defaults to the user from chat.
   */
  acceptTurn(projectId: ProjectId, turn: TurnId, by: { actor?: Op['actor']; surface?: Op['surface'] } = {}): void {
    const open = this.requireOpenTurn(turn)
    const log = this.ctx.vhOpLog
    if (!open.draft) {
      this.openTurns.delete(turn)
      return
    }
    if (this.branchHead(projectId, MAIN_BRANCH) !== open.base) {
      throw new RuntimeError(`Cannot accept turn '${turn}': main moved since the draft forked.`)
    }
    const approve = log.append(projectId, {
      parents: [], turn, branch: open.branch, actor: by.actor ?? 'user', surface: by.surface ?? 'chat', intent: 'accept draft',
      kind: 'approve', inputs: [], params: { turn }, outputs: [], status: 'done', deterministic: true,
    }, this.branchHead(projectId, open.branch))
    log.moveHead(projectId, MAIN_BRANCH, approve.id)
    this.openTurns.delete(turn)
  }

  /**
   * Reject an agent turn: the draft stays in the log, `main` is untouched.
   * @param projectId - the project.
   * @param turn - an open agent turn.
   */
  rejectTurn(projectId: ProjectId, turn: TurnId): void {
    const open = this.requireOpenTurn(turn)
    const log = this.ctx.vhOpLog
    log.append(projectId, {
      parents: [], turn, branch: open.branch, actor: 'user', surface: 'chat', intent: 'reject draft', kind: 'reject',
      inputs: [], params: { turn }, outputs: [], status: 'done', deterministic: true,
    }, this.branchHead(projectId, open.branch))
    this.openTurns.delete(turn)
  }

  /**
   * Move `main` back to just before the latest turn on it. The turn's records stay in the log.
   * @param projectId - the project.
   * @returns the turn that was undone.
   */
  undoLatestTurn(projectId: ProjectId): TurnId {
    const log = this.ctx.vhOpLog
    const mainHead = this.branchHead(projectId, MAIN_BRANCH)
    const latest = log.get(projectId, mainHead)
    const chain = log.ancestors(projectId, mainHead)
    const first = chain.find(op => op.turn === latest.turn)
    const before = first?.parents[0]
    if (before === undefined) throw new RuntimeError('Cannot undo the record that created the project.')
    log.moveHead(projectId, MAIN_BRANCH, before)
    return latest.turn
  }

  /**
   * Start an exploration branch at a record or at a branch head.
   * @param projectId - the project.
   * @param name - the branch name.
   * @param at - a record ID or a branch name.
   * @returns the branch record.
   */
  createBranch(projectId: ProjectId, name: string, at: OpId | string): Op {
    const heads = this.ctx.vhOpLog.heads(projectId)
    return this.ctx.vhOpLog.createBranch(projectId, name, heads[at] ?? brandString<OpId>(at), brandString<TurnId>(randomUUID()))
  }

  /**
   * Run a tool now and record it. Every input must be resolvable: an asset, an entity version, or the output of a
   * finished record. Deterministic tools whose key matches an earlier successful record reuse its outputs.
   * @param projectId - the project.
   * @param request - the tool, its inputs and params, and the record fields.
   * @returns the finished record.
   */
  async invoke(projectId: ProjectId, request: InvokeRequest): Promise<Op> {
    const { tool, op, inputs } = this.record(projectId, request)
    if (inputs.some(input => input.resolved === null && parseOutputRef(input.ref) !== null)) {
      this.ctx.vhOpLog.update(projectId, op.id, { status: 'failed', finished_at: new Date().toISOString(), error: 'An input names a record that has not finished; schedule the call instead.' })
      throw new RuntimeError(`Cannot invoke '${request.tool}' now: an input names a record that has not finished.`)
    }
    return await this.run(projectId, op.id, tool)
  }

  /**
   * Record a tool call and run it once the records its inputs name, and any `after` records, have finished. The
   * record is appended at once, so the log order is the scheduling order whatever the execution order turns out to be.
   * @param projectId - the project.
   * @param request - the tool, its inputs and params, and the record fields.
   * @param options - extra records to wait for.
   * @returns the pending record.
   */
  schedule(projectId: ProjectId, request: InvokeRequest, options: ScheduleOptions = {}): Op {
    const { tool, op } = this.record(projectId, request)
    this.queue.push({ projectId, opId: op.id, tool, after: options.after ?? [] })
    this.pump()
    return op
  }

  /**
   * Wait until nothing is queued or running for a project.
   * @param projectId - the project.
   * @returns a promise that settles when the scheduler is idle for the project.
   */
  whenIdle(projectId: ProjectId): Promise<void> {
    if (!this.busy(projectId)) return Promise.resolve()
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.busy(projectId)) this.idleWaiters.push(check)
        else resolve()
      }
      this.idleWaiters.push(check)
    })
  }

  private busy(projectId: ProjectId): boolean {
    return this.queue.some(item => item.projectId === projectId) || [...this.running.values()].includes(projectId)
  }

  /** Append the pending record of a request with its inputs resolved as far as the log allows. */
  private record(projectId: ProjectId, request: InvokeRequest): { tool: RuntimeToolSpec; op: Op; inputs: ResolvedInput[] } {
    const tool = this.tools.get(request.tool)
    if (tool === undefined) throw new RuntimeError(`Unknown tool '${request.tool}'.`)
    const log = this.ctx.vhOpLog
    const branch = request.branch ?? this.openTurns.get(request.turn)?.branch ?? MAIN_BRANCH
    const parent = this.branchHead(projectId, branch)
    const state = this.fold(projectId, parent)
    const inputs = this.resolveInputs(projectId, request.inputs, state)
    const supersedes = this.implicitSupersedes(request, state)
    if (request.tool === PLAN_APPROVE_TOOL) this.planAsset(projectId, request.params['plan'])
    const draft: OpDraft = {
      parents: [], turn: request.turn, branch, actor: request.actor, surface: request.surface, intent: request.intent,
      kind: request.tool === PLAN_APPROVE_TOOL ? 'approve' : request.tool.startsWith('plan.') ? 'plan' : 'tool',
      tool: { name: tool.name, version: tool.version },
      inputs, params: request.params, outputs: [], status: 'pending', deterministic: tool.deterministic,
      ...request.base_op === undefined ? {} : { base_op: request.base_op },
      ...supersedes.length === 0 ? {} : { supersedes },
    }
    return { tool, op: log.append(projectId, draft, parent), inputs }
  }

  /** Start every queued record whose producers are done while its cost class has room. */
  private pump(): void {
    if (this.disposed) return
    for (const item of [...this.queue]) {
      const readiness = this.readiness(item)
      if (readiness === 'waiting') continue
      this.queue.splice(this.queue.indexOf(item), 1)
      if (readiness !== 'ready') {
        this.ctx.vhOpLog.update(item.projectId, item.opId, { status: 'failed', finished_at: new Date().toISOString(), error: readiness.error })
        continue
      }
      const cost = item.tool.cost ?? 'cpu'
      if (this.runningByCost[cost] >= this.limits[cost]) {
        this.queue.unshift(item)
        continue
      }
      this.runningByCost[cost] += 1
      this.running.set(item.opId, item.projectId)
      void this.run(item.projectId, item.opId, item.tool).then(() => undefined, () => undefined).finally(() => {
        this.runningByCost[cost] -= 1
        this.running.delete(item.opId)
        this.pump()
        for (const waiter of this.idleWaiters.splice(0)) waiter()
      })
    }
  }

  /** Whether a queued record may run: its producers and `after` records are done, failed, or still pending. */
  private readiness(item: Queued): 'ready' | 'waiting' | { error: string } {
    const log = this.ctx.vhOpLog
    const op = log.get(item.projectId, item.opId)
    const producers = op.inputs.flatMap((input) => {
      const output = parseOutputRef(input.ref)
      return output === null ? [] : [output.op]
    })
    for (const id of [...producers, ...item.after]) {
      const producer = log.get(item.projectId, id)
      if (producer.status === 'failed') return { error: `Upstream record '${id}' failed: ${String(producer.error)}` }
      if (producer.status !== 'done') return 'waiting'
    }
    return 'ready'
  }

  /** Run one recorded call: late-resolve output references, serve the cache, execute, record, then apply follow-ups. */
  private async run(projectId: ProjectId, opId: OpId, tool: RuntimeToolSpec): Promise<Op> {
    const done = await this.execute(projectId, opId, tool)
    this.afterDone(projectId, done, tool.name)
    return done
  }

  /** Execute one recorded call and record its outcome; any failure, including an unresolvable input, fails the record. */
  private async execute(projectId: ProjectId, opId: OpId, tool: RuntimeToolSpec): Promise<Op> {
    const log = this.ctx.vhOpLog
    let op = log.get(projectId, opId)
    let scratchDir: string | null = null
    try {
      const inputs = this.lateResolve(projectId, op.inputs)
      if (inputs.some((input, index) => input.resolved !== op.inputs[index]?.resolved)) op = log.update(projectId, opId, { inputs })
      const cached = tool.deterministic ? this.cachedOutputs(projectId, tool, inputs, op.params) : null
      if (cached !== null) {
        return log.update(projectId, op.id, { status: 'done', outputs: cached, finished_at: new Date().toISOString(), cost: { cached: true } })
      }
      log.update(projectId, op.id, { status: 'running' })
      /* v8 ignore next -- a tool record always follows the branch head it was appended after. */
      const state = this.fold(projectId, op.parents[0] ?? op.id)
      scratchDir = mkdtempSync(join(tmpdir(), 'vh-tool-'))
      const started = performance.now()
      const result: ToolResult = await tool.execute({
        projectId, op: log.get(projectId, op.id), inputs, params: op.params, assets: this.ctx.vhAssets, state, scratchDir,
      })
      const wall = (performance.now() - started) / 1000
      return log.update(projectId, op.id, {
        status: 'done', outputs: result.outputs, finished_at: new Date().toISOString(),
        cost: { wall_s: Math.round(wall * 1000) / 1000, ...result.cost },
        ...result.report === undefined ? {} : { report: result.report },
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      log.update(projectId, op.id, { status: 'failed', finished_at: new Date().toISOString(), error: message })
      throw error
    } finally {
      if (scratchDir !== null) rmSync(scratchDir, { recursive: true, force: true })
    }
  }

  /** The plan document asset a `plan.approve` record names. */
  private planAsset(projectId: ProjectId, plan: unknown): AssetId {
    const planOp = this.ctx.vhOpLog.get(projectId, brandString<OpId>(String(plan)))
    const planAsset = planOp.outputs[0]
    if (planAsset === undefined) throw new RuntimeError(`Plan record '${planOp.id}' stored no plan document.`)
    return planAsset
  }

  /** What a finished record triggers: an approved plan's shots, and replays of deterministic consumers it superseded. */
  private afterDone(projectId: ProjectId, op: Op, toolName: string): void {
    if (toolName === PLAN_APPROVE_TOOL) this.schedulePlan(projectId, op)
    if (op.supersedes !== undefined && op.supersedes.length > 0) this.replayConsumers(projectId, op, op.supersedes, toolName)
  }

  /**
   * Turn an approved plan into one `generate.video` record per shot plus one `sequence.create` of the clips. Chained
   * continuity names each shot's predecessor last frame as its `first_frame` input, which also orders the runs.
   */
  private schedulePlan(projectId: ProjectId, approve: Op): void {
    const planOp = this.ctx.vhOpLog.get(projectId, brandString<OpId>(String(approve.params['plan'])))
    const plan = JSON.parse(this.ctx.vhAssets.read(this.planAsset(projectId, planOp.id)).toString('utf8')) as PlanDocument
    const base = { actor: approve.actor, surface: approve.surface, turn: approve.turn, branch: approve.branch }
    const shots: OpId[] = []
    plan.shots.forEach((shot, index) => {
      const references = shot.references ?? plan.references ?? []
      const inputs: InvokeRequest['inputs'] = references.map(ref => ({ role: 'reference', ref }))
      const previous = shots.at(-1)
      if (plan.continuity === 'chained' && previous !== undefined) inputs.push({ role: 'first_frame', ref: `${previous}#1` })
      const params: Record<string, unknown> = { prompt: shot.prompt, plan: planOp.id, shot: index + 1 }
      for (const [key, value] of Object.entries({
        duration_sec: shot.duration_sec, aspect_ratio: plan.aspect_ratio, resolution: plan.resolution,
        generation_mode: plan.generation_mode, seed: shot.seed ?? plan.seed,
      })) if (value !== undefined) params[key] = value
      const scheduled = this.schedule(projectId, {
        ...base, tool: GENERATE_VIDEO_TOOL, inputs, params, intent: `shot ${index + 1} of plan ${planOp.id.slice(0, 8)}`,
      }, { after: previous === undefined ? [] : [previous] })
      shots.push(scheduled.id)
    })
    this.schedule(projectId, {
      ...base, tool: SEQUENCE_CREATE_TOOL, inputs: shots.map(id => ({ role: 'clip', ref: `${id}#0` })),
      params: { plan: planOp.id }, intent: `assemble plan ${planOp.id.slice(0, 8)}`,
    }, { after: shots })
  }

  /**
   * After a record replaced the outputs of earlier records, rerun every deterministic consumer that derived outputs
   * from a replaced asset on the replacement, and point sequence slots that showed a replaced asset at its replacement.
   * Record-only consumers, such as sequence edits, are never rerun. Replays supersede the records they replay, so their
   * own consumers follow in turn.
   */
  private replayConsumers(projectId: ProjectId, replacement: Op, supersedes: OpId[], toolName: string): void {
    const log = this.ctx.vhOpLog
    const state = this.fold(projectId, replacement.branch)
    const replaced = new Map<AssetId, AssetId>()
    for (const oldId of supersedes) {
      const old = log.get(projectId, oldId)
      old.outputs.forEach((asset, index) => {
        const substitute = replacement.outputs[index]
        if (substitute !== undefined) replaced.set(asset, substitute)
      })
    }
    if (replaced.size === 0) return
    const base = { actor: 'system' as const, surface: 'api' as const, turn: replacement.turn, branch: replacement.branch }
    for (const consumer of state.ops) {
      if (consumer.kind !== 'tool' || !consumer.deterministic || consumer.status !== 'done' || consumer.outputs.length === 0 || consumer.id in state.superseded) continue
      if (!consumer.inputs.some(input => input.resolved !== null && replaced.has(input.resolved))) continue
      if (consumer.tool === undefined || !this.tools.has(consumer.tool.name)) continue
      this.schedule(projectId, {
        ...base, tool: consumer.tool.name,
        inputs: consumer.inputs.map(input => ({ role: input.role, ref: this.substituteRef(input, replaced) })),
        params: { ...consumer.params, replayed_from: consumer.id },
        intent: `replay ${consumer.tool.name} after ${toolName}`,
        base_op: consumer.id, supersedes: [consumer.id],
      })
    }
    for (const sequence of state.sequences) {
      for (const item of sequence.items) {
        const substitute = replaced.get(item.assetId)
        if (substitute === undefined) continue
        this.schedule(projectId, {
          ...base, tool: 'sequence.replace', inputs: [],
          params: { sequence: sequence.id, slot: item.slot, asset: substitute, replayed_from: replacement.id },
          intent: `point ${sequence.id} slot ${String(item.slot)} at the replacement`,
        })
      }
    }
  }

  /** The reference a replayed input should carry: the substitute asset, or the same entity reference. */
  private substituteRef(input: OpInput, replaced: Map<AssetId, AssetId>): InputRef {
    const resolved = input.resolved
    /* v8 ignore next -- a finished consumer resolved every input to an asset. */
    if (resolved === null || parseEntityRef(input.ref) !== null) return input.ref
    return replaced.get(resolved) ?? resolved
  }

  /** The head of a branch, which every append and fold needs to exist. */
  private branchHead(projectId: ProjectId, branch: string): OpId {
    const head = this.ctx.vhOpLog.heads(projectId)[branch]
    if (head === undefined) throw new RuntimeError(`Branch '${branch}' does not exist in project '${projectId}'.`)
    return head
  }

  private requireOpenTurn(turn: TurnId): OpenTurn {
    const open = this.openTurns.get(turn)
    if (open === undefined) throw new RuntimeError(`Turn '${turn}' is not open.`)
    return open
  }

  /** Turn entity references into the assets of the referenced version; asset references must exist in the store. */
  private resolveInputs(projectId: ProjectId, inputs: InvokeRequest['inputs'], state: ProjectState): ResolvedInput[] {
    return inputs.flatMap((input): ResolvedInput[] => {
      const output = parseOutputRef(input.ref)
      if (output !== null) {
        const producer = this.ctx.vhOpLog.get(projectId, output.op)
        return [{ role: input.role, ref: input.ref, resolved: producer.status === 'done' ? producer.outputs[output.index] ?? null : null }]
      }
      const entityRef = parseEntityRef(input.ref)
      if (entityRef === null) {
        if (!this.ctx.vhAssets.has(input.ref as AssetId)) throw new RuntimeError(`Unknown asset '${input.ref}'.`)
        return [{ role: input.role, ref: input.ref, resolved: input.ref as AssetId }]
      }
      const versions = state.entities[entityRef.entity]
      const version = versions?.find(candidate => candidate.version === entityRef.version)
      if (version === undefined) throw new RuntimeError(`Unknown entity version '${input.ref}'.`)
      // One record input per referenced asset keeps staleness per asset while remembering the entity it came from.
      return version.refs.map(asset => ({ role: input.role, ref: input.ref, resolved: asset, entity: version }))
    })
  }

  /** Fill in output references whose producers finished after the record was appended. */
  private lateResolve(projectId: ProjectId, inputs: OpInput[]): ResolvedInput[] {
    return inputs.map((input) => {
      const output = parseOutputRef(input.ref)
      if (output === null || input.resolved !== null) return input
      const producer = this.ctx.vhOpLog.get(projectId, output.op)
      const resolved = producer.outputs[output.index]
      if (resolved === undefined) throw new RuntimeError(`Record '${output.op}' has no output ${output.index}.`)
      return { ...input, resolved }
    })
  }

  /** An entity update replaces the entity's previous version; the caller's own `supersedes` list comes first. */
  private implicitSupersedes(request: InvokeRequest, state: ProjectState): OpId[] {
    const explicit = request.supersedes ?? []
    if (parseEntityTool(request.tool)?.action !== 'update') return explicit
    const entity = brandString<EntityId>(String(request.params['entity']))
    const current = state.entities[entity]?.at(-1)
    if (current === undefined) throw new RuntimeError(`Unknown entity '${entity}'.`)
    return [...explicit, current.updatedBy]
  }

  /** Outputs of an earlier successful record with the same tool, params, and resolved inputs, else null. */
  private cachedOutputs(
    projectId: ProjectId, tool: RuntimeToolSpec, inputs: ResolvedInput[], params: Record<string, unknown>,
  ): AssetId[] | null {
    const key = this.cacheKey(tool, inputs.map(input => input.resolved), params)
    for (const op of this.ctx.vhOpLog.all(projectId)) {
      if (op.status !== 'done' || op.tool?.name !== tool.name || op.tool.version !== tool.version || op.cost?.cached === true) continue
      if (this.cacheKey(tool, op.inputs.map(input => input.resolved), op.params) === key) return op.outputs
    }
    return null
  }

  private cacheKey(tool: RuntimeToolSpec, resolved: Array<AssetId | null>, params: Record<string, unknown>): string {
    const { replayed_from: _replay, ...rest } = params
    return `${tool.name}@${tool.version}|${canonical(rest)}|${[...resolved].map(String).sort().join(',')}`
  }
}
