/**
 * The DSH side of the structured tools. Each spec becomes one `vh_<name>` tool whose call is one operation record:
 * the `reason` argument is the record's intent, the `inputs` argument names assets, entity versions, or outputs of
 * earlier records by role, and the result names the record, its outputs with their URLs, and any records the runtime
 * scheduled after it. Image outputs also reach the model as image blocks through the attachment service.
 *
 * The bridge keeps one state per agent session: the project the agent works on, the open turn whose draft branch the
 * records go to, and an exploration branch when the agent switched to one. Management tools create and select
 * projects, accept or reject the open turn, undo, create and switch branches, and wait for scheduled records.
 *
 * @module @video-harness/tools/dsh
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ParameterSchemaSpec, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type VhAssets from '@video-harness/assets'
import type VhOpLog from '@video-harness/oplog'
import { MAIN_BRANCH, type AssetId, type InputRef, type Op, type OpId, type ProjectId, type TurnId } from '@video-harness/oplog'
import type VhProject from '@video-harness/runtime'
import { referenceImageLimit } from '@dreamverse/segment-generation'
import type {} from '@dreamverse/generation-client'
import { GENERATE_VIDEO_TOOL, PLAN_APPROVE_TOOL, parseEntityRef, parseOutputRef, type InvokeRequest, type PlanDocument, type ProjectState } from '@video-harness/runtime'
import type { ToolSpec } from './types.ts'

/** The branch a session's next record goes to: its open draft, else its exploration branch, else `main`. */
function sessionBranchOf(session: SessionState, project: VhProject): string {
  const open = session.turn === null ? undefined : project.openTurn(session.turn)
  return open?.branch ?? session.branch ?? MAIN_BRANCH
}

/** What the bridge remembers about one agent session. */
export interface SessionState {
  projectId: ProjectId | null
  /** The turn the session's records go to while it is open. */
  turn: TurnId | null
  /** The project the open turn belongs to. */
  turnProject: ProjectId | null
  /** An exploration branch the agent switched to; null means draft turns on `main`. */
  branch: string | null
  /** The agent loop's turn number the session is in, when the agent plugin reports it. */
  dshTurn: number | null
  /** The agent loop's turn number the open draft was opened in. */
  turnOpenedAt: number | null
}

/** What `settleTurn` did with a session's draft. */
export type TurnSettlement = 'accepted' | 'kept' | 'rejected' | 'none'

/** What the bridge needs to know to run a structured call with the design's confirmation table. */
export interface BridgeOptions {
  /** Directory of one JSON file per session with its project binding and open turn, so a restart continues the session. */
  sessionStateRoot: string
  /** Base of the asset URLs in results and cards, such as a tunnel origin; relative paths when empty. */
  publicBaseUrl: string
  /** Estimated GPU seconds a turn may spend on `confirm: cost` tools before the user must agree. */
  confirmGpuSecondsThreshold: number
  /** Estimated GPU seconds per generated video second, for the estimate before a shot runs. */
  gpuSecondsPerVideoSecond: number
}

/** A question the bridge asks when a call needs the user's agreement and no `user_approved` argument carried it. */
export interface ConfirmRequest {
  spec: ToolSpec
  /** The call's reason and params, for the question text. */
  summary: string
  /** The GPU seconds the call and the turn so far are estimated to cost. */
  estimateGpuSeconds: number
  exec: ToolRunContext
  /** The call's params and inputs, for an approval card that shows the prompt and the references. */
  params?: Record<string, unknown>
  inputs?: InvokeRequest['inputs']
  /** Whether a confirmation gate forced the question although the call would otherwise run unasked. */
  forced?: boolean
}

/**
 * Asks the user and answers whether the call may run; returns null when no interactive channel exists, so the bridge
 * falls back to the `user_approved` argument protocol.
 */
export type ConfirmPolicy = (request: ConfirmRequest) => Promise<boolean | null>

/** Answers whether a call must be confirmed even when its argument protocol or GPU budget would let it run. */
export type ConfirmGate = (spec: ToolSpec, exec: ToolRunContext) => boolean

/** The sessions key of a call without an agent: direct SDK calls. */
const ANONYMOUS_SESSION = 'anonymous'

/**
 * The key of the session state a call belongs to.
 * @param agent - the calling agent, when the call has one.
 * @returns the agent's session ID, or the shared anonymous key.
 */
/** Whether a parsed session state file has the fields of {@link SessionState}. */
function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const nullableString = (field: string): boolean => record[field] === null || typeof record[field] === 'string'
  const nullableNumber = (field: string): boolean => record[field] === null || typeof record[field] === 'number'
  return nullableString('projectId') && nullableString('turn') && nullableString('turnProject') && nullableString('branch')
    && nullableNumber('dshTurn') && nullableNumber('turnOpenedAt')
}

export function sessionKey(agent: { id: string } | undefined): string {
  return agent?.id ?? ANONYMOUS_SESSION
}

/** The raster formats that can reach the model as image blocks. */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** The recent records a state summary lists. */
const RECENT_RECORDS = 12

/**
 * The DSH name of a structured tool: dots become underscores because provider function names allow no dots.
 * @param name - the spec name, such as `generate.video`.
 * @returns the DSH tool name, such as `vh_generate_video`.
 */
export function dshToolName(name: string): string {
  return `vh_${name.replaceAll('.', '_')}`
}

/**
 * The URL of an asset's bytes on the harness web server.
 * @param id - the asset.
 * @returns the path of the `vhAssets` route.
 */
export function assetUrl(id: AssetId, base = ''): string {
  return `${base.replace(/\/+$/, '')}/vh/assets/${id}/content`
}

/** The value every structured tool call returns to the model. */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op_id: { type: 'string', required: true, description: 'The record of this call.' },
    status: { type: 'string', required: true, description: 'done, pending (scheduled behind records that have not finished), or failed.' },
    summary: { type: 'string', required: true },
    outputs: {
      type: 'array', required: true,
      items: { type: 'object', additionalProperties: false, properties: { role: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, mime: { type: 'string', required: true }, url: { type: 'string', required: true } } },
    },
    scheduled: { type: 'array', required: true, items: { type: 'string' }, description: 'Records the runtime queued because of this call, such as the shots of an approved plan.' },
    params: { type: 'json', required: true, description: 'The recorded params.' },
    report: { type: 'json', description: 'What the tool reported beyond its outputs: the seed it drew, probe results, the model answer.' },
    images: { type: 'array', items: { type: 'json' }, description: 'Attachment references of the image outputs, shown to you as images.' },
  },
} as const

/** The result value of a structured tool call; a type literal so a validated `JsonValue` can be asserted to it. */
export type ToolCallValue = {
  op_id: string
  status: string
  summary: string
  outputs: Array<{ role: string; asset_id: string; mime: string; url: string }>
  scheduled: string[]
  params: JsonValue
  report?: JsonValue
  images?: JsonValue[]
}

/** A project summary the agent can read. */
const STATE_SCHEMA = { type: 'json' } as const

/** The params every structured tool shares. */
function sharedParams(spec: ToolSpec): ParameterSchemaSpec {
  const roles = Object.entries(spec.inputs).map(([role, input]) => `${role}${input.required === true ? '' : '?'}: ${input.type}${input.many === true ? '[]' : ''}${input.entity === true ? ' (asset or entity@version)' : ''}`)
  return {
    reason: { type: 'string', required: true, description: 'Why you call this, in the user\'s words or your own summary; recorded as the intent of the record.' },
    project_id: { type: 'string', description: 'The project; defaults to the session project from vh_project_create or vh_project_use.' },
    ...Object.keys(spec.inputs).length === 0 ? {} : {
      inputs: {
        type: 'object', additionalProperties: true,
        description: `Input references by role: an asset ID, an entity version such as c1@1, or <record_id>#<index> for an output of an earlier record; a list for roles marked []. Roles: ${roles.join('; ')}.`,
      },
    },
    ...spec.name === GENERATE_VIDEO_TOOL ? { continue_from: { type: 'string', description: 'A shot record whose last frame (output #1) this shot starts from.' } } : {},
    replaces: { type: 'array', items: { type: 'string' }, description: 'Records whose outputs this call replaces, such as the shot a retake stands in for; their consumers become stale and deterministic ones are replayed.' },
    base_op: { type: 'string', description: 'The record this call is a changed copy of; takes of one shot share it.' },
    ...spec.confirm === 'always' ? { user_approved: { type: 'boolean', description: 'Set true only after the user agreed to this exact call in the conversation.' } } : {},
    ...spec.confirm === 'cost' ? { user_requested: { type: 'boolean', description: 'Set true when the user asked for this exact single change, which needs no further confirmation.' } } : {},
  }
}

/** The GPU seconds a call is estimated to cost before it runs. */
export function estimateGpuSeconds(
  spec: ToolSpec, params: Record<string, unknown>, perVideoSecond: number, minimumVideoSeconds: number,
): number {
  if (spec.cost !== 'gpu') return 0
  const duration = typeof params['duration_sec'] === 'number' && params['duration_sec'] > 0 ? params['duration_sec'] : minimumVideoSeconds
  return duration * perVideoSecond
}

/** A string argument, or undefined when absent. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Turn the `inputs` argument into record inputs, checking roles against the spec.
 * @param spec - the tool.
 * @param raw - the argument.
 * @returns the inputs in argument order.
 * @throws Error naming the role for an unknown role, a list on a single role, a non-string reference, or a missing required role.
 */
export function parseInputs(spec: ToolSpec, raw: unknown): InvokeRequest['inputs'] {
  const inputs: InvokeRequest['inputs'] = []
  if (raw !== undefined) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('inputs must be an object of role to reference(s).')
    for (const [role, value] of Object.entries(raw)) {
      const inputSpec = spec.inputs[role]
      if (inputSpec === undefined) throw new Error(`Unknown input role "${role}" for ${spec.name}; roles: ${Object.keys(spec.inputs).join(', ') || 'none'}.`)
      const refs: unknown[] = Array.isArray(value) ? value : [value]
      if (refs.length > 1 && inputSpec.many !== true) throw new Error(`Input "${role}" of ${spec.name} takes one reference.`)
      for (const ref of refs) {
        if (typeof ref !== 'string' || ref === '') throw new Error(`Input "${role}" of ${spec.name} must be an asset ID, entity@version, or record#index.`)
        inputs.push({ role, ref: ref as InputRef })
      }
    }
  }
  for (const [role, inputSpec] of Object.entries(spec.inputs)) {
    if (inputSpec.required === true && !inputs.some(input => input.role === role)) throw new Error(`${spec.name} needs input "${role}".`)
  }
  return inputs
}

/** A JSON copy of a record's params, report, or an attachment reference. */
function toJson(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Registers the structured tools and the management tools into a DSH tool registry. */
export class DshTools {
  private readonly sessions = new Map<string, SessionState>()
  private readonly disposers = new Map<string, () => void>()
  private policy: ConfirmPolicy | null = null
  private gate: ConfirmGate | null = null
  /** Chat image attachments still being recorded as assets, by session key; structured calls wait for them. */
  private readonly pendingImages = new Map<string, Promise<AssetId[]>>()

  constructor(
    private readonly ctx: Context,
    private readonly project: VhProject,
    private readonly log: VhOpLog,
    private readonly assets: VhAssets,
    private readonly options: BridgeOptions,
  ) {}

  /**
   * Install or remove the interactive confirmation channel.
   * @param policy - asks the user; null leaves only the argument protocol.
   */
  setConfirmPolicy(policy: ConfirmPolicy | null): void {
    this.policy = policy
  }

  /**
   * Install or remove the gate that forces a confirmation question.
   * @param gate - true for calls that must always ask; null asks only per the confirmation table.
   */
  setConfirmGate(gate: ConfirmGate | null): void {
    this.gate = gate
  }

  /**
   * Record which agent-loop turn a session is in, so a draft opened in an earlier turn is not silently extended.
   * @param key - the session key.
   * @param turn - the agent loop's turn number.
   */
  noteTurn(key: string, turn: number): void {
    this.stateOf(key).dshTurn = turn
    this.persist(key)
  }

  /**
   * Close the session's open draft at the end of an agent-loop turn. An empty draft or an aborted turn is rejected. A
   * completed draft whose every record is deterministic, read-only, or was asked for by name (`user_requested`), and
   * that holds no `confirm: always` tool, is accepted into `main` at once with the `system` actor: nothing in it needs
   * a second look, and the log does not claim the user accepted it. Any other completed draft, and every interrupted
   * draft with records, stays open for the user's decision.
   * @param key - the session key.
   * @param outcome - how the turn ended: the agent finished, the user or a limit interrupted it, or it was aborted.
   * @returns what happened to the draft.
   */
  settleTurn(key: string, outcome: 'completed' | 'interrupted' | 'aborted'): TurnSettlement {
    const state = this.stateOf(key)
    const open = state.turn === null ? undefined : this.project.openTurn(state.turn)
    if (open === undefined || state.turnProject === null) {
      state.turn = null
      this.persist(key)
      return 'none'
    }
    const records = this.project.fold(state.turnProject, open.branch).ops.filter(op => op.turn === open.turn && op.kind !== 'intent')
    if (outcome !== 'aborted' && records.length > 0) {
      if (outcome === 'interrupted' || !records.every(op => this.selfEvident(op))) return 'kept'
      try {
        this.project.acceptTurn(state.turnProject, open.turn, { actor: 'system', surface: 'chat' })
      } catch {
        // `main` moved while the agent worked (a view wrote to it): the draft waits for the user like any other.
        return 'kept'
      }
      state.turn = null
      this.persist(key)
      return 'accepted'
    }
    this.project.rejectTurn(state.turnProject, open.turn)
    state.turn = null
    this.persist(key)
    return 'rejected'
  }

  /**
   * Whether a draft record needs no acceptance step: deterministic work, failed records, read-only looks, and work the
   * user asked for by name (`user_requested`). A `confirm: always` tool never qualifies, whatever its arguments.
   * @param op - a record of the draft.
   * @returns true when the record may land on `main` without the user looking again.
   */
  private selfEvident(op: Op): boolean {
    const spec = op.tool === undefined ? undefined : this.specs.get(op.tool.name)
    if (spec?.confirm === 'always') return false
    // A failed record produced nothing the user could keep or discard.
    return op.deterministic || op.status === 'failed' || spec?.readOnly === true || op.params['user_requested'] === true
  }

  /**
   * Record the images a user attached to a chat message as assets of the session's project: one user turn on `main`
   * with an `asset.upload` per image, so the assets panel lists them like any upload. The session's next structured
   * call waits until the recording finished, so the agent's draft forks after it. A session without a project, or a
   * process without an attachment service, records nothing.
   * @param key - the session key.
   * @param refs - the image attachments of the user message.
   * @returns the recorded asset IDs.
   */
  recordChatImages(key: string, refs: readonly ImageAttachmentRef[]): Promise<AssetId[]> {
    const bound = this.stateOf(key).projectId
    const attachments = this.ctx.get('attachments')
    if (bound === null || attachments === undefined || refs.length === 0) return Promise.resolve([])
    const projectId = brandString<ProjectId>(bound)
    const previous = this.pendingImages.get(key) ?? Promise.resolve([])
    const recording = previous.catch(() => []).then(async () => {
      const open = this.project.beginTurn(projectId, { actor: 'user', surface: 'chat', intent: 'attach images in chat' })
      const ids: AssetId[] = []
      try {
        for (const ref of refs) {
          const stored = await attachments.readImage(ref)
          const name = ref.name ?? `image.${ref.mediaType.slice('image/'.length)}`
          const asset = this.assets.put(stored.data, { mime: ref.mediaType, name })
          const op = await this.project.invoke(projectId, {
            tool: 'asset.upload', inputs: [], params: { path: this.assets.path(asset), mime: ref.mediaType, name },
            actor: 'user', surface: 'chat', intent: `upload ${name}`, turn: open.turn,
          })
          ids.push(op.outputs[0] ?? asset)
        }
      } finally {
        this.project.acceptTurn(projectId, open.turn, { actor: 'user', surface: 'chat' })
      }
      return ids
    })
    this.pendingImages.set(key, recording)
    const settled = (): void => { if (this.pendingImages.get(key) === recording) this.pendingImages.delete(key) }
    recording.then(settled, settled)
    return recording
  }

  /** Wait for the session's chat images to be recorded; a failed recording does not fail the structured call. */
  private async imagesRecorded(key: string): Promise<void> {
    try {
      await this.pendingImages.get(key)
    } catch {
      // The agent layer reports the failed recording; the call still runs on the project as it is.
    }
  }

  /**
   * The project a session is bound to, for views that open beside a chat.
   * @param key - the session key.
   * @returns the project ID, or null while the session has none.
   */
  sessionProject(key: string): ProjectId | null {
    const id = this.stateOf(key).projectId
    return id === null ? null : brandString<ProjectId>(id)
  }

  /**
   * Bind a session to a project, as `vh_project_use` does, and save the binding.
   * @param key - the session key.
   * @param projectId - the project.
   */
  bindSession(key: string, projectId: ProjectId): void {
    this.stateOf(key).projectId = projectId
    this.persist(key)
  }

  /**
   * The state of a session by key, for the agent plugin and the prompt section.
   * @param key - the session key.
   * @returns the state, created empty on first use.
   */
  stateOf(key: string): SessionState {
    let state = this.sessions.get(key)
    if (state === undefined) {
      state = this.readState(key) ?? { projectId: null, turn: null, turnProject: null, branch: null, dshTurn: null, turnOpenedAt: null }
      this.sessions.set(key, state)
    }
    return state
  }

  /** The file a session's state is kept in. */
  private statePath(key: string): string {
    return join(this.options.sessionStateRoot, `${encodeURIComponent(key)}.json`)
  }

  /** The state an earlier process saved for the session, or undefined when there is none. */
  private readState(key: string): SessionState | undefined {
    const path = this.statePath(key)
    if (!existsSync(path)) return undefined
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isSessionState(parsed)) throw new Error(`Session state file ${path} is not a session state.`)
    return parsed
  }

  /** Save the session's state so the next process continues the same project and draft. */
  private persist(key: string): void {
    mkdirSync(this.options.sessionStateRoot, { recursive: true })
    writeFileSync(this.statePath(key), JSON.stringify(this.stateOf(key)))
  }

  /** @returns the asset URL under the configured public base. */
  url(id: AssetId): string {
    return assetUrl(id, this.options.publicBaseUrl)
  }

  /**
   * Register the DSH tool of one spec; an earlier tool of the same name is removed first.
   * @param spec - the structured tool.
   */
  add(spec: ToolSpec): void {
    this.remove(spec.name)
    this.specs.set(spec.name, spec)
    this.disposers.set(spec.name, this.ctx.tools.register(this.defineSpecTool(spec)))
  }

  /**
   * Remove the DSH tool of a spec.
   * @param name - the spec name.
   */
  remove(name: string): void {
    this.disposers.get(name)?.()
    this.disposers.delete(name)
    this.specs.delete(name)
  }

  /** Register the project, turn, branch, and wait tools. */
  addManagement(): void {
    for (const definition of this.managementTools()) {
      this.disposers.set(definition.name, this.ctx.tools.register(definition))
    }
  }

  /** Remove every registered tool. */
  dispose(): void {
    for (const name of [...this.disposers.keys()]) this.remove(name)
  }

  /**
   * The state of the session a call belongs to.
   * @param exec - the call.
   * @returns the state, created empty on first use.
   */
  session(exec: Pick<ToolRunContext, 'agent'>): SessionState {
    return this.stateOf(sessionKey(exec.agent))
  }

  /** The project a call works on: the argument, else the session project. */
  private projectOf(session: SessionState, projectId: unknown): ProjectId {
    const id = optionalString(projectId) ?? session.projectId
    if (id === null) throw new Error('No project selected: call vh_project_create or vh_project_use first, or pass project_id.')
    return brandString<ProjectId>(id)
  }

  /** The open turn of a session for a project, opened with the call's reason when none is open. */
  private turnOf(session: SessionState, projectId: ProjectId, reason: string, exec: Pick<ToolRunContext, 'agent'>): TurnId {
    if (session.turn !== null && session.turnProject === projectId && this.project.openTurn(session.turn) !== undefined) {
      if (session.dshTurn !== null && session.turnOpenedAt !== null && session.turnOpenedAt !== session.dshTurn) {
        throw new Error('The draft of your earlier turn is still open. Call vh_turn_accept if the user builds on it (or agreed to it), '
          + 'vh_turn_reject if not, then retry.')
      }
      return session.turn
    }
    const open = this.project.beginTurn(projectId, {
      actor: 'agent', surface: 'chat', intent: reason, ...session.branch === null ? {} : { branch: session.branch },
    })
    session.turn = open.turn
    session.turnProject = projectId
    session.turnOpenedAt = session.dshTurn
    this.persist(sessionKey(exec.agent))
    return open.turn
  }

  /** GPU seconds the open draft already spent, from the finished records' cost. */
  private spentGpuSeconds(session: SessionState): number {
    const open = session.turn === null ? undefined : this.project.openTurn(session.turn)
    if (open === undefined || session.turnProject === null) return 0
    return this.project.fold(session.turnProject, open.branch).ops
      .filter(op => op.turn === session.turn)
      .reduce((sum, op) => sum + (op.cost?.gpu_s ?? 0), 0)
  }

  /**
   * Apply the confirmation table: `never` runs; `always` needs the user's agreement; `cost` needs it only past the
   * turn's GPU budget and when the user did not ask for this exact change. Agreement comes from the `user_approved`
   * or `user_requested` argument, else from the interactive policy when one is installed.
   * A call the confirmation gate selects skips those shortcuts and always asks the policy.
   * @returns the approval summary when the gate forced the question and the user approved, else null.
   * @throws Error telling the model to ask the user first, or that the user declined.
   */
  private async confirm(
    spec: ToolSpec, args: Record<string, unknown>, params: Record<string, unknown>, session: SessionState, exec: ToolRunContext,
    inputs: InvokeRequest['inputs'], projectId: ProjectId,
  ): Promise<string | null> {
    const forced = this.gate?.(spec, exec) === true
    if (!forced && spec.confirm === 'never') return null
    if (!forced && spec.confirm === 'always' && args['user_approved'] === true) return null
    if (!forced && spec.confirm === 'cost' && args['user_requested'] === true) return null
    // A plan approval stands for every shot of the plan: the question shows the shots and their cost.
    const plan = spec.name === PLAN_APPROVE_TOOL ? this.planShots(projectId, params['plan']) : null
    const estimate = (plan === null ? estimateGpuSeconds(spec, params, this.options.gpuSecondsPerVideoSecond, 5) : plan.estimate)
      + this.spentGpuSeconds(session)
    if (!forced && spec.confirm === 'cost' && estimate <= this.options.confirmGpuSecondsThreshold) return null
    const summary = `${spec.name}: ${String(args['reason'])}`
    const answer = this.policy === null ? null : await this.policy({
      spec, summary, estimateGpuSeconds: estimate, exec, params: plan?.params ?? params, inputs: plan?.inputs ?? inputs, forced,
    })
    if (answer === true) return forced ? summary : null
    if (answer === false) throw new Error(`The user declined ${spec.name}. Do not retry it unchanged.`)
    const why = spec.confirm === 'always'
      ? 'needs the explicit agreement of the user'
      : `would bring this turn to about ${Math.round(estimate)} GPU seconds, above the ${this.options.confirmGpuSecondsThreshold} s budget`
    const flag = spec.confirm === 'always' ? 'user_approved: true' : 'user_requested: true'
    throw new Error(`${spec.name} ${why}. Describe what it will do and cost, wait for the user's answer in the conversation, then call again with ${flag}.`)
  }

  /**
   * What approving a plan will generate, for the approval question: one numbered line per shot as the prompt, the
   * total duration, the plan's references, and the GPU estimate of every shot.
   * @param projectId - the project.
   * @param plan - the `plan` param of the `plan.approve` call.
   * @returns the question details, or null when the param names no plan document.
   */
  private planShots(projectId: ProjectId, plan: unknown): { params: Record<string, unknown>; inputs: InvokeRequest['inputs']; estimate: number } | null {
    const document = this.planDocument(projectId, plan)
    if (document === null) return null
    const seconds = document.shots.map(shot => shot.duration_sec ?? 5)
    const prompt = document.shots.map((shot, index) => `${index + 1}. ${shot.prompt} (${seconds[index]} s)`).join('\n')
    const references = [...new Set(document.shots.flatMap(shot => shot.references ?? document.references ?? []))]
    const total = seconds.reduce((sum, value) => sum + value, 0)
    return {
      params: { prompt, duration_sec: total, plan },
      inputs: references.map(ref => ({ role: 'reference', ref })),
      estimate: total * this.options.gpuSecondsPerVideoSecond,
    }
  }

  /**
   * @param projectId - the project.
   * @param plan - the `plan` param of a `plan.approve` call.
   * @returns the plan document the record stored, or null when the param names no plan record with a document.
   */
  private planDocument(projectId: ProjectId, plan: unknown): PlanDocument | null {
    try {
      const asset = this.log.get(projectId, brandString<OpId>(String(plan))).outputs[0]
      if (asset === undefined) return null
      return JSON.parse(this.assets.read(asset).toString('utf8')) as PlanDocument
    } catch {
      // An unknown plan record fails the call itself when it runs; callers then use the call's own params.
      return null
    }
  }

  /**
   * Refuse a generation, or a plan approval that schedules generations, when the served model makes shots from
   * reference images and a shot names none: entity versions count their reference images, so a character registered
   * without pictures adds nothing. The refusal comes before any record, so no failed shots reach the project.
   * @throws Error telling the model to ask the user for a reference picture first.
   */
  private async requireReferences(
    projectId: ProjectId, branch: string, spec: ToolSpec, params: Record<string, unknown>, inputs: InvokeRequest['inputs'],
  ): Promise<void> {
    if (spec.name !== GENERATE_VIDEO_TOOL && spec.name !== PLAN_APPROVE_TOOL) return
    const generation = this.ctx.get('dreamverseGeneration')
    if (generation === undefined) return
    const facts = await generation.model()
    const needs = (mode: unknown): boolean => facts.generationModes[optionalString(mode) ?? Object.keys(facts.generationModes)[0] ?? ''] === 'reference_images'
    const state = this.project.fold(projectId, branch)
    const pictures = (refs: readonly string[]): number => refs.reduce((sum, ref) => {
      const entity = parseEntityRef(ref as InputRef)
      if (entity === null) return sum + 1
      return sum + (state.entities[entity.entity]?.find(version => version.version === entity.version)?.refs.length ?? 0)
    }, 0)
    let missing: string | null = null
    if (spec.name === GENERATE_VIDEO_TOOL) {
      const refs = inputs.filter(input => input.role === 'reference').map(input => input.ref)
      if (needs(params['generation_mode']) && pictures(refs) === 0) missing = 'this shot has none'
    } else {
      const plan = this.planDocument(projectId, params['plan'])
      const empty = plan === null || !needs(plan.generation_mode) ? [] : plan.shots
        .map((shot, index) => ({ index, refs: shot.references ?? plan.references ?? [] }))
        .filter(shot => pictures(shot.refs) === 0).map(shot => shot.index + 1)
      if (empty.length > 0) missing = `shot ${empty.join(', ')} of the plan ${empty.length === 1 ? 'has' : 'have'} none`
    }
    if (missing === null) return
    const limit = referenceImageLimit(facts, Object.keys(facts.generationModes).find(mode => needs(mode)) ?? '')
    throw new Error(`The video model makes every shot from 1 to ${limit} reference images, and ${missing}. Nothing was generated. `
      + 'Ask the user for a reference picture of the subject (they can attach one in the chat; it appears under Uploaded images), '
      + 'add it as a reference or to the character, update the plan if there is one, then call again.')
  }

  /** Whether an input names the output of a record that has not finished. */
  private waitsForProducer(projectId: ProjectId, inputs: InvokeRequest['inputs']): boolean {
    return inputs.some((input) => {
      const output = parseOutputRef(input.ref)
      return output !== null && this.log.get(projectId, output.op).status !== 'done'
    })
  }

  /** Attachment references of the image outputs, when an attachment service is mounted. */
  private async imagesOf(outputs: AssetId[]): Promise<ImageAttachmentRef[]> {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) return []
    const refs: ImageAttachmentRef[] = []
    for (const id of outputs) {
      const meta = this.assets.get(id)
      if (!IMAGE_MEDIA_TYPES.has(meta.mime)) continue
      refs.push(await attachments.saveImage({ data: this.assets.read(id), mediaType: meta.mime as ImageMediaType, name: meta.name }))
    }
    return refs
  }

  /** The result value of a record. */
  private async valueOf(spec: ToolSpec, op: Op, scheduled: OpId[]): Promise<ToolCallValue> {
    const images = op.status === 'done' ? await this.imagesOf(op.outputs) : []
    return {
      op_id: op.id,
      status: op.status,
      summary: op.status === 'done' ? spec.summarize(op) : `${spec.name} ${op.status}`,
      outputs: op.outputs.map((id, index) => ({ role: spec.outputs[index]?.role ?? `output_${index}`, asset_id: id, mime: this.assets.get(id).mime, url: this.url(id) })),
      scheduled,
      params: toJson(op.params),
      ...op.report === undefined ? {} : { report: toJson(op.report) },
      ...images.length === 0 ? {} : { images: images.map(toJson) },
    }
  }

  /** Run one structured tool call: resolve the project and turn, record the call, and describe the record. */
  private async call(spec: ToolSpec, args: Record<string, unknown>, exec: ToolRunContext): Promise<ToolCallValue> {
    const { reason, project_id, inputs: rawInputs, continue_from, replaces, base_op, user_approved, user_requested, ...params } = args
    await this.imagesRecorded(sessionKey(exec.agent))
    const session = this.session(exec)
    const projectId = this.projectOf(session, project_id)
    const intent = optionalString(reason) ?? spec.name
    const inputs = parseInputs(spec, rawInputs)
    await this.requireReferences(projectId, sessionBranchOf(session, this.project), spec, params, inputs)
    const approval = await this.confirm(spec, args, params, session, exec, inputs, projectId)
    if (user_approved === true || approval !== null) params['user_approved'] = true
    if (user_requested === true) params['user_requested'] = true
    const continueFrom = optionalString(continue_from)
    if (continueFrom !== undefined) inputs.push({ role: 'first_frame', ref: `${continueFrom}#1` })
    const supersedes = Array.isArray(replaces) ? replaces.map(String).map(id => brandString<OpId>(id)) : []
    const baseOp = optionalString(base_op)
    const turn = this.turnOf(session, projectId, intent, exec)
    if (approval !== null) this.recordApproval(projectId, turn, spec.name, approval)
    const request: InvokeRequest = {
      tool: spec.name, inputs, params, actor: 'agent', surface: 'chat', intent, turn,
      ...session.branch === null ? {} : { branch: session.branch },
      ...baseOp === undefined ? {} : { base_op: brandString<OpId>(baseOp) },
      ...supersedes.length === 0 ? {} : { supersedes },
    }
    const before = new Set(this.log.all(projectId).map(op => op.id))
    const op = this.waitsForProducer(projectId, inputs)
      ? this.project.schedule(projectId, request)
      : await this.project.invoke(projectId, request)
    const scheduled = this.log.all(projectId).filter(other => !before.has(other.id) && other.id !== op.id).map(other => other.id)
    return await this.valueOf(spec, op, scheduled)
  }

  /**
   * Append the user's approval of one call to the open draft. The params name the approved tool and carry no `turn`,
   * so the record never reads as the acceptance of the whole turn.
   */
  private recordApproval(projectId: ProjectId, turn: TurnId, tool: string, summary: string): void {
    const open = this.project.openTurn(turn)
    if (open === undefined) return
    this.log.append(projectId, {
      parents: [], turn, branch: open.branch, actor: 'user', surface: 'chat', intent: `approve ${tool}`,
      kind: 'approve', inputs: [], params: { approval_of: tool, summary }, outputs: [], status: 'done', deterministic: true,
    }, this.log.heads(projectId)[open.branch] ?? null)
  }

  /** The DSH tool of a spec. */
  private defineSpecTool(spec: ToolSpec) {
    const parameters: ParameterSchemaSpec = { ...spec.params, ...sharedParams(spec) }
    return defineTool({
      name: dshToolName(spec.name),
      description: `${spec.summary} Cost: ${spec.cost}${spec.deterministic ? ', deterministic (cached and replayed)' : ''}${spec.confirm === 'never' ? '' : `; ask the user before calling (${spec.confirm === 'always' ? 'always' : 'when the user has not approved the cost'})`}.`,
      parameters,
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => renderValue(value),
        presentationMeta: (_args, value) => ({ op_id: value.op_id, tool: spec.name, status: value.status, outputs: value.outputs }),
      },
      execute: (args, exec) => this.call(spec, args, exec),
    })
  }

  /** The summary of a project state the management tools return. */
  private stateSummary(projectId: ProjectId, state: ProjectState, session: SessionState): JsonValue {
    const specOf = (op: Op): ToolSpec | undefined => {
      const name = op.tool?.name
      return name === undefined ? undefined : this.specs.get(name)
    }
    return toJson({
      project_id: projectId,
      head: state.head,
      branch: session.branch ?? MAIN_BRANCH,
      open_turn: session.turnProject === projectId ? session.turn : null,
      branches: Object.keys(this.log.heads(projectId)),
      records: state.ops.length,
      entities: Object.entries(state.entities).map(([id, versions]) => {
        const current = versions.at(-1)
        return {
          id, kind: current?.kind, version: current?.version, name: current?.name, description: current?.description, refs: current?.refs,
        }
      }),
      sequence: state.sequence?.items.map(item => ({
        slot: item.slot, asset_id: item.assetId, url: this.url(item.assetId), in_sec: item.inSec, out_sec: item.outSec,
      })) ?? null,
      sequences: state.sequences.map(sequence => ({
        id: sequence.id, title: sequence.title,
        clips: sequence.items.map(item => ({ slot: item.slot, asset_id: item.assetId, in_sec: item.inSec, out_sec: item.outSec })),
      })),
      plans: state.plans,
      stale: Object.keys(state.stale),
      recent: state.ops.slice(-RECENT_RECORDS).filter(op => op.kind !== 'intent').map(op => ({
        op_id: op.id, tool: op.tool?.name ?? op.kind, status: op.status, intent: op.intent,
        summary: op.status === 'done' ? specOf(op)?.summarize(op) ?? op.kind : op.error ?? op.status,
        outputs: op.outputs.map(id => this.url(id)), report: op.report, base_op: op.base_op, supersedes: op.supersedes,
      })),
    })
  }

  /** The specs the structured tools were defined from, by name, for summaries. */
  private readonly specs = new Map<string, ToolSpec>()

  /** The project, turn, branch, and wait tools. */
  private managementTools() {
    const projectParam = { project_id: { type: 'string', description: 'Defaults to the session project.' } } as const
    const withSession = (exec: ToolRunContext, projectId: unknown): { session: SessionState; projectId: ProjectId } => {
      const session = this.session(exec)
      return { session, projectId: this.projectOf(session, projectId) }
    }
    const summary = (projectId: ProjectId, session: SessionState, head?: string): JsonValue => {
      const turn = session.turnProject === projectId ? session.turn : null
      const turnBranch = turn === null ? undefined : this.project.openTurn(turn)?.branch
      return this.stateSummary(projectId, this.project.fold(projectId, head ?? turnBranch ?? session.branch ?? MAIN_BRANCH), session)
    }
    const stateOutput = { schema: STATE_SCHEMA, render: (_args: unknown, value: JsonValue): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }] }
    return [
      defineTool({
        name: 'vh_project_create',
        description: 'Start a video project and make it the session project, only when the conversation has no project yet. Then upload references, register characters, propose a plan, and generate.',
        parameters: { title: { type: 'string', required: true } },
        output: stateOutput,
        execute: (args, exec) => {
          const session = this.session(exec)
          if (session.projectId !== null) throw new Error(boundProjectMessage(session.projectId))
          const projectId = this.project.createProject({ title: args.title, actor: 'agent', surface: 'chat' })
          session.projectId = projectId
          session.turn = null
          session.branch = null
          this.persist(sessionKey(exec.agent))
          return Promise.resolve(summary(projectId, session))
        },
      }),
      defineTool({
        name: 'vh_project_use',
        description: 'Make an existing project the session project and read its state, only when the conversation has no project yet.',
        parameters: { project_id: { type: 'string', required: true } },
        output: stateOutput,
        execute: (args, exec) => {
          const session = this.session(exec)
          const projectId = brandString<ProjectId>(args.project_id)
          if (session.projectId !== null && session.projectId !== projectId) throw new Error(boundProjectMessage(session.projectId))
          const value = summary(projectId, session)
          session.projectId = projectId
          session.turn = null
          session.branch = null
          this.persist(sessionKey(exec.agent))
          return Promise.resolve(value)
        },
      }),
      defineTool({
        name: 'vh_project_state',
        description: 'Read the project: entities with their versions, the timeline, plans, stale records, and recent records. Pass branch to read another branch.',
        parameters: { ...projectParam, branch: { type: 'string', description: 'A branch name or record ID; defaults to the branch you write to.' } },
        output: stateOutput,
        execute: (args, exec) => {
          const { session, projectId } = withSession(exec, args.project_id)
          return Promise.resolve(summary(projectId, session, args.branch))
        },
      }),
      defineTool({
        name: 'vh_turn_accept',
        description: 'Close your current turn and move main to its draft, making the draft records the project. Call it when the user is happy with the result.',
        parameters: projectParam,
        output: stateOutput,
        execute: (args, exec) => {
          const { session, projectId } = withSession(exec, args.project_id)
          if (session.turn === null || this.project.openTurn(session.turn) === undefined) {
            // The user may have closed the draft in a view already; forget the closed turn.
            session.turn = null
            this.persist(sessionKey(exec.agent))
            throw new Error('No open draft to accept: the user already accepted or discarded it, or nothing was recorded.')
          }
          this.project.acceptTurn(projectId, session.turn)
          session.turn = null
          this.persist(sessionKey(exec.agent))
          return Promise.resolve(summary(projectId, session))
        },
      }),
      defineTool({
        name: 'vh_turn_reject',
        description: 'Discard your current turn: main stays as it was and the draft records remain only in the log.',
        parameters: projectParam,
        output: stateOutput,
        execute: (args, exec) => {
          const { session, projectId } = withSession(exec, args.project_id)
          if (session.turn === null || this.project.openTurn(session.turn) === undefined) {
            // The user may have closed the draft in a view already; forget the closed turn.
            session.turn = null
            this.persist(sessionKey(exec.agent))
            throw new Error('No open draft to reject: the user already accepted or discarded it, or nothing was recorded.')
          }
          this.project.rejectTurn(projectId, session.turn)
          session.turn = null
          this.persist(sessionKey(exec.agent))
          return Promise.resolve(summary(projectId, session))
        },
      }),
      defineTool({
        name: 'vh_undo',
        description: 'Move main back to before its latest accepted turn. The records stay in the log; the state they built is no longer shown.',
        parameters: projectParam,
        output: stateOutput,
        execute: (args, exec) => {
          const { session, projectId } = withSession(exec, args.project_id)
          this.project.undoLatestTurn(projectId)
          return Promise.resolve(summary(projectId, session))
        },
      }),
      defineTool({
        name: 'vh_branch_create',
        description: 'Start an exploration branch at a record or branch head, and switch the session to it. Records then go to that branch directly, without drafts.',
        parameters: { ...projectParam, name: { type: 'string', required: true }, at: { type: 'string', description: 'A record ID or branch name; default main.' } },
        output: stateOutput,
        execute: (args, exec) => {
          const { session, projectId } = withSession(exec, args.project_id)
          this.project.createBranch(projectId, args.name, args.at ?? MAIN_BRANCH)
          session.branch = args.name
          session.turn = null
          this.persist(sessionKey(exec.agent))
          return Promise.resolve(summary(projectId, session))
        },
      }),
      defineTool({
        name: 'vh_branch_use',
        description: 'Switch the session to a branch; main returns to the draft-turn flow.',
        parameters: { ...projectParam, name: { type: 'string', required: true } },
        output: stateOutput,
        execute: (args, exec) => {
          const { session, projectId } = withSession(exec, args.project_id)
          if (this.log.heads(projectId)[args.name] === undefined) throw new Error(`Branch "${args.name}" does not exist; branches: ${Object.keys(this.log.heads(projectId)).join(', ')}.`)
          session.branch = args.name === MAIN_BRANCH ? null : args.name
          session.turn = null
          this.persist(sessionKey(exec.agent))
          return Promise.resolve(summary(projectId, session))
        },
      }),
      defineTool({
        name: 'vh_wait',
        description: 'Wait until every scheduled record of the project has finished or failed, then read the state.',
        parameters: projectParam,
        output: stateOutput,
        execute: async (args, exec) => {
          const { session, projectId } = withSession(exec, args.project_id)
          await this.project.whenIdle(projectId)
          return summary(projectId, session)
        },
      }),
    ]
  }
}

/**
 * The refusal a bound conversation gets when it tries to start or switch to another project: the user opened this
 * conversation inside one project, and every view beside the chat shows that project.
 * @param projectId - the project the conversation belongs to.
 * @returns the error text.
 */
function boundProjectMessage(projectId: string): string {
  return `This conversation belongs to project ${projectId}; keep all work in it. A new project starts from a new conversation on the home page.`
}

/**
 * The model-facing rendering of a structured tool result: one text block, then the image outputs.
 * @param value - the result.
 * @returns the content blocks.
 */
export function renderValue(value: ToolCallValue): ContentBlock[] {
  const lines = [`${value.status} ${value.op_id}: ${value.summary}`]
  for (const output of value.outputs) lines.push(`- ${output.role}: ${output.asset_id} (${output.mime}) ${output.url}`)
  if (value.scheduled.length > 0) lines.push(`scheduled: ${value.scheduled.join(', ')}`)
  lines.push(`params: ${JSON.stringify(value.params)}`)
  if (value.report !== undefined) lines.push(`report: ${JSON.stringify(value.report)}`)
  const images = (value.images ?? []).flatMap((image): ContentBlock[] => isImageRef(image) ? [{ type: 'image', attachment: image }] : [])
  return [{ type: 'text', text: lines.join('\n') }, ...images]
}

/** Whether a JSON value is an attachment reference. */
function isImageRef(value: JsonValue): value is JsonValue & ImageAttachmentRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value['attachmentId'] === 'string' && typeof value['mediaType'] === 'string'
}
