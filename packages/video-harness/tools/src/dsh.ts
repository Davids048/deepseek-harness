/**
 * The DSH side of the structured tools. Each spec becomes one `vh_<name>` tool whose call is one `dvProject.run`:
 * the `reason` argument is the record's intent, the `inputs` argument names assets, character, location and style
 * versions, or outputs of earlier records by role, and the result names the record, its outputs with their URLs, and
 * any records the call scheduled. Image outputs also reach the model as image blocks through the attachment service.
 *
 * The bridge keeps one state per agent session: the project the session is bound to, saved to a file so a restart
 * continues it. Records of the session go to its working branch, which `dvProject` owns: the first agent write opens
 * the session's draft, which spans turns until the user accepts or discards it. The registry tools (`dv_proj_*`)
 * create and open projects, read state and history, accept or discard the draft, undo and redo, create and switch
 * branches, and wait for scheduled records.
 *
 * @module @video-harness/tools/dsh
 */
import { randomUUID } from 'node:crypto'
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
import type DvProject from '@dv/project'
import {
  MAIN_BRANCH, type AssetId, type ProjectId, type ProjectRecord, type ProjectState, type RecordId, type RecordInputRef, type RecordOrigin,
  type RunRequest, type SessionId, type TurnId,
} from '@dv/project'
import type VhAssets from '@video-harness/assets'
import { referenceImageLimit } from '@dreamverse/segment-generation'
import type {} from '@dreamverse/generation-client'
import { GENERATE_VIDEO_TOOL, PLAN_APPROVE_TOOL, parseInputRef, readPlanDocument } from './specs-basic.ts'
import type { PlanDocument, ToolSpec } from './types.ts'

/** What the bridge remembers about one agent session. */
export interface SessionState {
  projectId: ProjectId | null
}

/** What the bridge needs to know to run a structured call with the design's confirmation table. */
export interface BridgeOptions {
  /** Directory of one JSON file per session with its project binding, so a restart continues the session. */
  sessionStateRoot: string
  /** Base of the asset URLs in results and cards, such as a tunnel origin; relative paths when empty. */
  publicBaseUrl: string
  /** Estimated GPU seconds a turn may spend on `cost` tools before the user must agree. */
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
  /** The call's params and inputs, for the question that shows the prompt and the references. */
  params?: Record<string, unknown>
  inputs?: RunRequest['inputs']
}

/**
 * Asks the user and answers whether the call may run; returns null when no interactive channel exists, so the bridge
 * falls back to the `user_approved` argument protocol.
 */
export type ConfirmPolicy = (request: ConfirmRequest) => Promise<boolean | null>

/**
 * The DSH question rule of the operations that need the user's agreement before the agent calls them: `always`
 * needs the `user_approved` argument or a yes from the question channel; `cost` needs it only past the turn's GPU
 * budget when the user did not ask for this exact change. The composer's approval card, which `dvProject` shows for
 * `confirm: agent_ask_first` operations, is separate.
 */
const QUESTION_RULES: Readonly<Record<string, 'cost' | 'always'>> = { [PLAN_APPROVE_TOOL]: 'always', [GENERATE_VIDEO_TOOL]: 'cost' }

/** The sessions key of a call without an agent: direct SDK calls. */
const ANONYMOUS_SESSION = 'anonymous'

/** Whether a parsed session state file has a project binding. */
function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== 'object' || value === null) return false
  const projectId = (value as Record<string, unknown>)['projectId']
  return projectId === null || typeof projectId === 'string'
}

/**
 * The key of the session state a call belongs to.
 * @param agent - the calling agent, when the call has one.
 * @returns the agent's session ID, or the shared anonymous key.
 */
export function sessionKey(agent: { id: string } | undefined): string {
  return agent?.id ?? ANONYMOUS_SESSION
}

/** The raster formats that can reach the model as image blocks. */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** The recent records a state summary lists. */
const RECENT_RECORDS = 12

/** The history entries `dv_proj_history_list` returns when the call names no limit. */
const HISTORY_LIMIT = 20

/** The prefix of exploration branch names. */
const EXPLORE_PREFIX = 'explore/'

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
    op_id: { type: 'string', required: true, description: 'The record of this call; empty for a read, which writes no record.' },
    status: { type: 'string', required: true, description: 'done, or pending (scheduled behind records that have not finished).' },
    summary: { type: 'string', required: true },
    outputs: {
      type: 'array', required: true,
      items: { type: 'object', additionalProperties: false, properties: { role: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, mime: { type: 'string', required: true }, url: { type: 'string', required: true } } },
    },
    scheduled: {
      type: 'array', required: true, items: { type: 'string' },
      description: 'Records this call scheduled, such as the shots of an approved plan.',
    },
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
  const rule = QUESTION_RULES[spec.name]
  return {
    reason: { type: 'string', required: true, description: 'Why you call this, in the user\'s words or your own summary; recorded as the intent of the record.' },
    project_id: { type: 'string', description: 'The project; defaults to the session project from dv_proj_create or dv_proj_open.' },
    ...Object.keys(spec.inputs).length === 0 ? {} : {
      inputs: {
        type: 'object', additionalProperties: true,
        description: `Input references by role: an asset ID, an entity version such as c1@1, or <record_id>#<index> for an output of an earlier record; a list for roles marked []. Roles: ${roles.join('; ')}.`,
      },
    },
    ...spec.name === GENERATE_VIDEO_TOOL ? { continue_from: { type: 'string', description: 'A shot record whose last frame (output #1) this shot starts from.' } } : {},
    replaces: {
      type: 'array', items: { type: 'string' },
      description: 'Records whose outputs this call replaces, such as the shot a retake stands in for; their consumers become stale.',
    },
    base_op: { type: 'string', description: 'The record this call is a changed copy of; takes of one shot share it.' },
    ...rule === 'always'
      ? { user_approved: { type: 'boolean', description: 'Set true only after the user agreed to this exact call in the conversation.' } }
      : {},
    ...rule === 'cost'
      ? {
        user_requested: {
          type: 'boolean', description: 'Set true when the user asked for this exact single change, which needs no further confirmation.',
        },
      }
      : {},
  }
}

/**
 * The GPU seconds a call is estimated to cost before it runs.
 * @param spec - the tool.
 * @param params - the call's params.
 * @param perVideoSecond - GPU seconds per rendered video second.
 * @param minimumVideoSeconds - the duration of a call that names none.
 * @returns the estimate; 0 for an operation that uses no GPU.
 */
export function estimateGpuSeconds(
  spec: ToolSpec, params: Record<string, unknown>, perVideoSecond: number, minimumVideoSeconds: number,
): number {
  if (spec.resource !== 'gpu') return 0
  const duration = typeof params['duration_sec'] === 'number' && params['duration_sec'] > 0 ? params['duration_sec'] : minimumVideoSeconds
  return duration * perVideoSecond
}

/** A string argument, or undefined when absent. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Turn the `inputs` argument into run inputs, checking roles against the spec.
 * @param spec - the tool.
 * @param raw - the argument: role → reference text or a list of them.
 * @param state - the state the references are read against (character, location, and style IDs).
 * @returns the inputs in argument order.
 * @throws Error naming the role for an unknown role, a list on a single role, a non-string reference, a missing
 *   required role, or an unknown character, location, or style.
 */
export function parseInputs(spec: ToolSpec, raw: unknown, state: ProjectState): RunRequest['inputs'] {
  const inputs: RunRequest['inputs'] = []
  if (raw !== undefined) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('inputs must be an object of role to reference(s).')
    for (const [role, value] of Object.entries(raw)) {
      const inputSpec = spec.inputs[role]
      if (inputSpec === undefined) throw new Error(`Unknown input role "${role}" for ${spec.name}; roles: ${Object.keys(spec.inputs).join(', ') || 'none'}.`)
      const refs: unknown[] = Array.isArray(value) ? value : [value]
      if (refs.length > 1 && inputSpec.many !== true) throw new Error(`Input "${role}" of ${spec.name} takes one reference.`)
      for (const ref of refs) {
        if (typeof ref !== 'string' || ref === '') throw new Error(`Input "${role}" of ${spec.name} must be an asset ID, entity@version, or record#index.`)
        inputs.push({ role, ref: parseInputRef(ref, state) })
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

/** The agent turn a session is in: the DSH turn number, the turn's record ID, and the human's words that started it. */
interface SessionTurn {
  number: number
  turn: TurnId
  requestText: string
}

/** Registers the structured tools and the registry tools into a DSH tool registry. */
export class DshTools {
  private readonly sessions = new Map<string, SessionState>()
  private readonly turns = new Map<string, SessionTurn>()
  private readonly disposers = new Map<string, () => void>()
  /** The specs the structured tools were defined from, by name, for summaries. */
  private readonly specs = new Map<string, ToolSpec>()
  private policy: ConfirmPolicy | null = null
  /** Chat image attachments still being imported as assets, by session key; structured calls wait for them. */
  private readonly pendingImages = new Map<string, Promise<AssetId[]>>()

  constructor(
    private readonly ctx: Context,
    private readonly project: DvProject,
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
   * Record which agent turn a session is in and the human's words that started it. A new turn number starts a new
   * turn ID; the same number with words updates the words of the turn.
   * @param key - the session key.
   * @param turn - the agent loop's turn number.
   * @param requestText - the human's words; empty when they are not known yet.
   */
  noteTurn(key: string, turn: number, requestText: string): void {
    const current = this.turns.get(key)
    if (current !== undefined && current.number === turn) {
      if (requestText !== '') current.requestText = requestText
      return
    }
    this.turns.set(key, { number: turn, turn: brandString<TurnId>(randomUUID()), requestText })
  }

  /**
   * Import the images a user attached to a chat message as assets of the session's project: one `asset.upload` per
   * image by the user, on the session's working branch, so the asset pool lists them. The session's next structured
   * call waits until the import finished. A session without a project, or a process without an attachment service,
   * imports nothing.
   * @param key - the session key.
   * @param refs - the image attachments of the user message.
   * @returns the imported asset IDs.
   */
  recordChatImages(key: string, refs: readonly ImageAttachmentRef[]): Promise<AssetId[]> {
    const projectId = this.stateOf(key).projectId
    const attachments = this.ctx.get('attachments')
    if (projectId === null || attachments === undefined || refs.length === 0) return Promise.resolve([])
    const previous = this.pendingImages.get(key) ?? Promise.resolve([])
    const importing = previous.catch(() => []).then(async () => {
      const ids: AssetId[] = []
      for (const ref of refs) {
        const stored = await attachments.readImage(ref)
        const name = ref.name ?? `image.${ref.mediaType.slice('image/'.length)}`
        const asset = this.assets.put(stored.data, { mime: ref.mediaType, name })
        const result = await this.project.run({
          project: projectId, operation: 'asset.upload', inputs: [], params: { path: this.assets.path(asset), mime: ref.mediaType, name },
          actor: 'user', surface: 'chat', session: brandString<SessionId>(key), turn: null, tool_call: null, intent: `import ${name}`,
        })
        ids.push(result.outputs[0] ?? asset)
      }
      return ids
    })
    this.pendingImages.set(key, importing)
    const settled = (): void => { if (this.pendingImages.get(key) === importing) this.pendingImages.delete(key) }
    importing.then(settled, settled)
    return importing
  }

  /** Wait for the session's chat images to be imported; a failed import does not fail the structured call. */
  private async imagesRecorded(key: string): Promise<void> {
    try {
      await this.pendingImages.get(key)
    } catch {
      // The agent layer reports the failed import; the call still runs on the project as it is.
    }
  }

  /**
   * The project a session is bound to, for views that open beside a chat.
   * @param key - the session key.
   * @returns the project ID, or null while the session has none.
   */
  sessionProject(key: string): ProjectId | null {
    return this.stateOf(key).projectId
  }

  /**
   * Bind a session to a project, as `dv_proj_open` does, and save the binding.
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
      state = this.readState(key) ?? { projectId: null }
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
    return { projectId: parsed.projectId === null ? null : brandString<ProjectId>(parsed.projectId) }
  }

  /** Save the session's state so the next process continues the same project. */
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

  /** Register the `dv_proj_*` registry tools. */
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
    if (id === null) throw new Error('No project selected: call dv_proj_create or dv_proj_open first, or pass project_id.')
    return brandString<ProjectId>(id)
  }

  /**
   * Who makes a call's records: the agent, in the chat, in the call's session and current turn.
   * @param exec - the call.
   * @param intent - why.
   * @returns the origin.
   */
  private originOf(exec: Pick<ToolRunContext, 'agent' | 'callId'>, intent: string): RecordOrigin {
    const key = sessionKey(exec.agent)
    return {
      actor: 'agent', surface: 'chat', session: brandString<SessionId>(key), turn: this.turns.get(key)?.turn ?? null,
      tool_call: exec.callId, intent,
    }
  }

  /** GPU seconds the current turn already spent on the working branch, from the finished records' cost. */
  private spentGpuSeconds(state: ProjectState, turn: TurnId | null): number {
    if (turn === null) return 0
    return state.components.proj.records.filter(record => record.turn === turn)
      .reduce((sum, record) => sum + (record.cost?.gpu_seconds ?? 0), 0)
  }

  /**
   * Apply the DSH question rule of the operation (see `QUESTION_RULES`): `always` needs the user's agreement; `cost`
   * needs it only past the turn's GPU budget and when the user did not ask for this exact change. Agreement comes from
   * the `user_approved` or `user_requested` argument, else from the interactive policy when one is installed.
   * @throws Error telling the model to ask the user first, or that the user declined.
   */
  private async confirm(
    spec: ToolSpec, args: Record<string, unknown>, params: Record<string, unknown>, state: ProjectState, turn: TurnId | null,
    exec: ToolRunContext, inputs: RunRequest['inputs'], projectId: ProjectId,
  ): Promise<void> {
    const rule = QUESTION_RULES[spec.name]
    if (rule === undefined) return
    if (rule === 'always' && args['user_approved'] === true) return
    if (rule === 'cost' && args['user_requested'] === true) return
    // A plan approval stands for every shot of the plan: the question shows the shots and their cost.
    const plan = spec.name === PLAN_APPROVE_TOOL ? this.planShots(projectId, state, params['plan']) : null
    const estimate = (plan === null ? estimateGpuSeconds(spec, params, this.options.gpuSecondsPerVideoSecond, 5) : plan.estimate)
      + this.spentGpuSeconds(state, turn)
    if (rule === 'cost' && estimate <= this.options.confirmGpuSecondsThreshold) return
    const summary = `${spec.name}: ${String(args['reason'])}`
    const answer = this.policy === null ? null : await this.policy({
      spec, summary, estimateGpuSeconds: estimate, exec, params: plan?.params ?? params, inputs: plan?.inputs ?? inputs,
    })
    if (answer === true) return
    if (answer === false) throw new Error(`The user declined ${spec.name}. Do not retry it unchanged.`)
    const why = rule === 'always'
      ? 'needs the explicit agreement of the user'
      : `would bring this turn to about ${Math.round(estimate)} GPU seconds, above the ${this.options.confirmGpuSecondsThreshold} s budget`
    const flag = rule === 'always' ? 'user_approved: true' : 'user_requested: true'
    throw new Error(`${spec.name} ${why}. Describe what it will do and cost, wait for the user's answer in the conversation, then call again with ${flag}.`)
  }

  /**
   * What approving a plan will render, for the approval question: one numbered line per shot as the prompt, the total
   * duration, the plan's references, and the GPU estimate of every shot.
   * @param projectId - the project.
   * @param state - the state of the session's working branch, which the plan's references are read against.
   * @param plan - the `plan` param of the `plan.approve` call.
   * @returns the question details, or null when the param names no plan document.
   */
  private planShots(
    projectId: ProjectId, state: ProjectState, plan: unknown,
  ): { params: Record<string, unknown>; inputs: RunRequest['inputs']; estimate: number } | null {
    const document = this.planDocument(projectId, plan)
    if (document === null) return null
    const seconds = document.shots.map(shot => shot.duration_sec ?? 5)
    const prompt = document.shots.map((shot, index) => `${index + 1}. ${shot.prompt} (${seconds[index]} s)`).join('\n')
    const references = [...new Set(document.shots.flatMap(shot => shot.references ?? document.references ?? []))]
    const total = seconds.reduce((sum, value) => sum + value, 0)
    return {
      params: { prompt, duration_sec: total, plan },
      inputs: references.flatMap((ref) => {
        try {
          return [{ role: 'reference', ref: parseInputRef(ref, state) }]
        } catch {
          // A reference to an unknown character leaves the question without it; the shot itself fails when it runs.
          return []
        }
      }),
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
      return readPlanDocument(this.project, this.assets, projectId, String(plan))
    } catch {
      // An unknown plan record fails the call itself when it runs; callers then use the call's own params.
      return null
    }
  }

  /**
   * How many reference pictures a reference stands for: one for an asset or a record output, the reference images of
   * a character, location, or style version.
   */
  private pictureCount(state: ProjectState, ref: RecordInputRef | string): number {
    let parsed: RecordInputRef
    try {
      parsed = typeof ref === 'string' ? parseInputRef(ref, state) : ref
    } catch {
      // An unknown character adds no picture; the shot fails on it when it runs.
      return 0
    }
    if ('asset' in parsed || 'record' in parsed) return 1
    const id = 'character' in parsed ? parsed.character : 'location' in parsed ? parsed.location : parsed.style
    return state.components.bible.entities[id]?.find(version => version.version === parsed.version)?.refs.length ?? 0
  }

  /**
   * Refuse a shot render, or a plan approval that schedules renders, when the served model makes shots from reference
   * images and a shot names none: character, location, and style versions count their reference images, so a character
   * registered without pictures adds nothing. The refusal comes before any record, so no failed shots reach the project.
   * @throws Error telling the model to ask the user for a reference picture first.
   */
  private async requireReferences(
    projectId: ProjectId, state: ProjectState, spec: ToolSpec, params: Record<string, unknown>, inputs: RunRequest['inputs'],
  ): Promise<void> {
    if (spec.name !== GENERATE_VIDEO_TOOL && spec.name !== PLAN_APPROVE_TOOL) return
    const generation = this.ctx.get('dreamverseGeneration')
    if (generation === undefined) return
    const facts = await generation.model()
    const needs = (mode: unknown): boolean => facts.generationModes[optionalString(mode) ?? Object.keys(facts.generationModes)[0] ?? ''] === 'reference_images'
    const pictures = (refs: ReadonlyArray<RecordInputRef | string>): number =>
      refs.reduce<number>((sum, ref) => sum + this.pictureCount(state, ref), 0)
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

  /** Whether an input names the output of a record that has not finished, so the call must be scheduled behind it. */
  private waitsForProducer(projectId: ProjectId, inputs: RunRequest['inputs']): boolean {
    return inputs.some((input) => {
      if (!('record' in input.ref)) return false
      try {
        return this.project.getRecord(projectId, input.ref.record).status !== 'done'
      } catch {
        // An unknown record is refused by the run itself, with its own message.
        return false
      }
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
  private async valueOf(spec: ToolSpec, record: ProjectRecord, scheduled: RecordId[]): Promise<ToolCallValue> {
    const images = record.status === 'done' ? await this.imagesOf(record.outputs) : []
    return {
      op_id: record.id,
      status: record.status,
      summary: record.status === 'done' ? spec.summarize(record) : `${spec.name} ${record.status}`,
      outputs: record.outputs.map((id, index) => ({
        role: spec.outputs[index]?.role ?? `output_${index}`, asset_id: id, mime: this.assets.get(id).mime, url: this.url(id),
      })),
      scheduled,
      params: toJson(record.params),
      ...record.report === undefined ? {} : { report: toJson(record.report) },
      ...images.length === 0 ? {} : { images: images.map(toJson) },
    }
  }

  /**
   * The error a call reports when its record did not finish `done`: the failure message, or that the user skipped the
   * approval card, or that the turn was stopped.
   */
  private failureOf(spec: ToolSpec, record: ProjectRecord): Error {
    if (record.error?.code === 'skipped') return new Error(`The user declined ${spec.name}. Do not retry it unchanged.`)
    if (record.error?.code === 'stopped') return new Error(`${spec.name} was stopped before it finished.`)
    return new Error(record.error?.message ?? `${spec.name} ${record.status}`)
  }

  /**
   * Run one structured tool call: resolve the project and the inputs against the session's working branch, apply the
   * question rule, run the operation through `dvProject`, and describe the record.
   */
  private async call(spec: ToolSpec, args: Record<string, unknown>, exec: ToolRunContext): Promise<ToolCallValue> {
    const { reason, project_id, inputs: rawInputs, continue_from, replaces, base_op, user_approved, user_requested, ...params } = args
    const key = sessionKey(exec.agent)
    await this.imagesRecorded(key)
    const projectId = this.projectOf(this.session(exec), project_id)
    const origin = this.originOf(exec, optionalString(reason) ?? spec.name)
    const state = this.project.getState(projectId, this.project.workingBranch(projectId, origin.session).name)
    const inputs = parseInputs(spec, rawInputs, state)
    await this.requireReferences(projectId, state, spec, params, inputs)
    await this.confirm(spec, args, params, state, origin.turn, exec, inputs, projectId)
    if (user_approved === true) params['user_approved'] = true
    if (user_requested === true) params['user_requested'] = true
    const continueFrom = optionalString(continue_from)
    if (continueFrom !== undefined) inputs.push({ role: 'first_frame', ref: { record: brandString<RecordId>(continueFrom), output: 1 } })
    const basedOn = optionalString(base_op)
    const requestText = this.turns.get(key)?.requestText ?? ''
    const before = new Set(this.project.listHistory({ project: projectId }).map(entry => entry.record.id))
    const result = await this.project.run({
      ...origin, project: projectId, operation: spec.name, params, inputs, signal: exec.signal,
      ...requestText === '' ? {} : { request_text: requestText },
      ...this.waitsForProducer(projectId, inputs) ? { after: [] } : {},
      ...basedOn === undefined ? {} : { based_on: brandString<RecordId>(basedOn) },
      ...Array.isArray(replaces) ? { supersedes: replaces.map(id => brandString<RecordId>(String(id))) } : {},
    })
    const record = result.record
    // A read writes no record: its answer is the report.
    if (record === null) {
      return {
        op_id: '', status: 'done', summary: `${spec.name} answered`, outputs: [], scheduled: [], params: toJson(params),
        ...result.report === null ? {} : { report: toJson(result.report) },
      }
    }
    if (record.status === 'failed' || record.status === 'cancelled') throw this.failureOf(spec, record)
    // The records this call scheduled: `system` records of the same session that did not exist before the call.
    const scheduled = this.project.listHistory({ project: projectId, actor: 'system', kind: 'operation' })
      .map(entry => entry.record).filter(other => !before.has(other.id) && other.session === origin.session)
      .map(other => other.id).reverse()
    return await this.valueOf(spec, record, scheduled)
  }

  /** The DSH tool of a spec. */
  private defineSpecTool(spec: ToolSpec) {
    const parameters: ParameterSchemaSpec = { ...spec.params, ...sharedParams(spec) }
    const rule = QUESTION_RULES[spec.name]
    const when = rule === 'always' ? 'always' : 'when the user has not approved the cost'
    const ask = rule === undefined ? '' : `; ask the user before calling (${when})`
    return defineTool({
      name: dshToolName(spec.name),
      description: `${spec.summary} Cost: ${spec.resource}${spec.deterministic ? ', deterministic (cached)' : ''}${ask}.`,
      parameters,
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => renderValue(value),
        presentationMeta: (_args, value) => ({ op_id: value.op_id, tool: spec.name, status: value.status, outputs: value.outputs }),
      },
      execute: (args, exec) => this.call(spec, args, exec),
    })
  }

  /** The summary of a branch state the registry tools return. */
  private stateSummary(projectId: ProjectId, state: ProjectState): JsonValue {
    const { proj, bible, timeline, plan } = state.components
    const branches = this.project.listBranches(projectId)
    return toJson({
      project_id: projectId,
      head: state.head,
      branch: state.branch,
      draft: branches.find(branch => branch.name === state.branch)?.counts ?? null,
      branches: branches.map(branch => branch.name),
      records: proj.records.length,
      entities: Object.entries(bible.entities).map(([id, versions]) => {
        const current = versions.at(-1)
        return {
          id, kind: current?.kind, version: current?.version, name: current?.name, description: current?.description, refs: current?.refs,
        }
      }),
      sequence: timeline.sequence?.items.map(item => ({
        slot: item.slot, asset_id: item.assetId, url: this.url(item.assetId), in_sec: item.inSec, out_sec: item.outSec,
      })) ?? null,
      sequences: timeline.sequences.map(sequence => ({
        id: sequence.id, title: sequence.title,
        clips: sequence.items.map(item => ({ slot: item.slot, asset_id: item.assetId, in_sec: item.inSec, out_sec: item.outSec })),
      })),
      plans: plan.plans,
      stale: Object.keys(proj.stale),
      recent: proj.records.filter(record => record.kind === 'operation').slice(-RECENT_RECORDS).map(record => ({
        op_id: record.id, tool: record.operation, status: record.status, intent: record.intent,
        summary: record.status === 'done' ? this.summaryOf(record) : record.error?.message ?? record.status,
        outputs: record.outputs.map(id => this.url(id)), report: record.report, base_op: record.based_on, supersedes: record.supersedes,
      })),
    })
  }

  /** One line for a finished record: its spec's summary, else the operation name. */
  private summaryOf(record: ProjectRecord): string {
    const spec = record.operation === null ? undefined : this.specs.get(record.operation)
    return spec?.summarize(record) ?? record.operation ?? record.kind
  }

  /** The `dv_proj_*` registry tools. */
  private managementTools() {
    const projectParam = { project_id: { type: 'string', description: 'Defaults to the session project.' } } as const
    const withSession = (exec: ToolRunContext, projectId: unknown): { session: SessionState; projectId: ProjectId } => {
      const session = this.session(exec)
      return { session, projectId: this.projectOf(session, projectId) }
    }
    // The state of a branch, by default the branch the session works on.
    const summary = (exec: ToolRunContext, projectId: ProjectId, branch?: string): JsonValue => {
      const name = branch ?? this.project.workingBranch(projectId, brandString<SessionId>(sessionKey(exec.agent))).name
      return this.stateSummary(projectId, this.project.getState(projectId, name))
    }
    const bind = (exec: ToolRunContext, projectId: ProjectId): void => {
      this.session(exec).projectId = projectId
      this.persist(sessionKey(exec.agent))
    }
    const stateOutput = { schema: STATE_SCHEMA, render: (_args: unknown, value: JsonValue): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }] }
    return [
      defineTool({
        name: 'dv_proj_create',
        description: 'Start a video project and make it the session project, only when the conversation has no project yet. '
          + 'Then import references, register characters, propose a plan, and generate.',
        parameters: { title: { type: 'string', required: true } },
        output: stateOutput,
        execute: async (args, exec) => {
          const session = this.session(exec)
          if (session.projectId !== null) throw new Error(boundProjectMessage(session.projectId))
          const info = await this.project.createProject(args.title, this.originOf(exec, `create project ${args.title}`))
          bind(exec, info.id)
          return summary(exec, info.id)
        },
      }),
      defineTool({
        name: 'dv_proj_open',
        description: 'Make an existing project the session project and read its state, only when the conversation has no project yet.',
        parameters: { project_id: { type: 'string', required: true } },
        output: stateOutput,
        execute: (args, exec) => {
          const session = this.session(exec)
          const projectId = brandString<ProjectId>(args.project_id)
          if (session.projectId !== null && session.projectId !== projectId) throw new Error(boundProjectMessage(session.projectId))
          this.project.openProject(projectId)
          bind(exec, projectId)
          return Promise.resolve(summary(exec, projectId))
        },
      }),
      defineTool({
        name: 'dv_proj_state',
        description: 'Read the project: characters, locations and styles with their versions, the timelines, plans, stale records, '
          + 'recent records, and whether your draft is open. Pass branch to read another branch.',
        parameters: { ...projectParam, branch: { type: 'string', description: 'A branch name; defaults to the branch you write to.' } },
        output: stateOutput,
        execute: (args, exec) => {
          const { projectId } = withSession(exec, args.project_id)
          return Promise.resolve(summary(exec, projectId, args.branch))
        },
      }),
      defineTool({
        name: 'dv_proj_history_list',
        description: 'List the project history, newest first: each record with its operation, status, intent, '
          + 'and mark (main, draft, undone, discarded, replayed, branch).',
        parameters: {
          ...projectParam,
          limit: { type: 'integer', description: `At most this many records; default ${HISTORY_LIMIT}.` },
          operation: { type: 'string', description: 'Only records of this operation, such as plan.create.' },
        },
        output: stateOutput,
        execute: (args, exec) => {
          const { projectId } = withSession(exec, args.project_id)
          const entries = this.project.listHistory({
            project: projectId, limit: args.limit ?? HISTORY_LIMIT, ...args.operation === undefined ? {} : { operation: args.operation },
          })
          return Promise.resolve(toJson(entries.map(({ record, mark }) => ({
            record: record.id, mark, operation: record.operation ?? record.kind, status: record.status, actor: record.actor,
            intent: record.intent,
            branch: record.branch, outputs: record.outputs,
          }))))
        },
      }),
      defineTool({
        name: 'dv_proj_draft_accept',
        description: 'Accept the draft of this conversation into main. Call it only when the user asks you to accept or keep the draft.',
        parameters: projectParam,
        output: stateOutput,
        execute: async (args, exec) => {
          const { projectId } = withSession(exec, args.project_id)
          await this.project.acceptDraft(projectId, this.originOf(exec, 'accept the draft'))
          return summary(exec, projectId)
        },
      }),
      defineTool({
        name: 'dv_proj_draft_discard',
        description: 'Discard the draft of this conversation, including the user\'s edits on it; main stays as it was. '
          + 'Call it only when the user asks you to discard the draft.',
        parameters: projectParam,
        output: stateOutput,
        execute: async (args, exec) => {
          const { projectId } = withSession(exec, args.project_id)
          const origin = this.originOf(exec, 'discard the draft')
          const counts = this.project.workingBranch(projectId, origin.session).counts
          if (counts === null) {
            throw new Error('No open draft to discard: the user already accepted or discarded it, or nothing was recorded.')
          }
          await this.project.discardDraft(projectId, origin, counts)
          return summary(exec, projectId)
        },
      }),
      defineTool({
        name: 'dv_proj_undo',
        description: 'Move main back by one accepted change: one accepted draft or one direct change. '
          + 'The records stay in the history; dv_proj_redo brings the change back.',
        parameters: projectParam,
        output: stateOutput,
        execute: async (args, exec) => {
          const { projectId } = withSession(exec, args.project_id)
          await this.project.undo(projectId, this.originOf(exec, 'undo'))
          return summary(exec, projectId)
        },
      }),
      defineTool({
        name: 'dv_proj_redo',
        description: 'Bring back the change the latest undo removed, while nothing else changed main since.',
        parameters: projectParam,
        output: stateOutput,
        execute: async (args, exec) => {
          const { projectId } = withSession(exec, args.project_id)
          await this.project.redo(projectId, this.originOf(exec, 'redo'))
          return summary(exec, projectId)
        },
      }),
      defineTool({
        name: 'dv_proj_stale_accept',
        description: 'Keep a stale record as it is: its stale mark and the marks it passed to records made from it go away. '
          + 'Call it only when the user wants to keep an out-of-date result instead of rendering it again.',
        parameters: { ...projectParam, record: { type: 'string', required: true, description: 'The stale record ID.' } },
        output: stateOutput,
        execute: async (args, exec) => {
          const { projectId } = withSession(exec, args.project_id)
          await this.project.acceptStale(projectId, brandString<RecordId>(args.record), this.originOf(exec, `keep ${args.record}`))
          return summary(exec, projectId)
        },
      }),
      defineTool({
        name: 'dv_proj_branch_create',
        description: 'Start an exploration branch at a record or branch head, and switch this conversation to it.',
        parameters: { ...projectParam, name: { type: 'string', required: true }, at: { type: 'string', description: 'A record ID or branch name; default main.' } },
        output: stateOutput,
        execute: async (args, exec) => {
          const { projectId } = withSession(exec, args.project_id)
          const name = args.name.startsWith(EXPLORE_PREFIX) ? args.name : `${EXPLORE_PREFIX}${args.name}`
          const origin = this.originOf(exec, `explore ${name}`)
          await this.project.createBranch(projectId, name, args.at ?? MAIN_BRANCH, origin)
          await this.project.switchBranch(projectId, name, origin)
          return summary(exec, projectId)
        },
      }),
      defineTool({
        name: 'dv_proj_branch_switch',
        description: 'Switch this conversation to main or an exploration branch. '
          + 'While a draft is open, the draft stays the branch you write to.',
        parameters: { ...projectParam, name: { type: 'string', required: true } },
        output: stateOutput,
        execute: async (args, exec) => {
          const { projectId } = withSession(exec, args.project_id)
          await this.project.switchBranch(projectId, args.name, this.originOf(exec, `switch to ${args.name}`))
          return summary(exec, projectId)
        },
      }),
      defineTool({
        name: 'dv_proj_wait',
        description: 'Wait until every scheduled record of the project has finished or failed, then read the state.',
        parameters: projectParam,
        output: stateOutput,
        execute: async (args, exec) => {
          const { projectId } = withSession(exec, args.project_id)
          await this.project.wait(projectId)
          return summary(exec, projectId)
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
  const lines = [value.op_id === '' ? `${value.status}: ${value.summary}` : `${value.status} ${value.op_id}: ${value.summary}`]
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
