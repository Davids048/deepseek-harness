/**
 * The agent tools of operations: the shared helper that turns each registered operation into its DSH tool
 * `dv_<operation name with _>`. A tool call is one `run` as the agent: the `reason` argument is the record's intent,
 * `inputs` names assets, character, location and style versions, or outputs of earlier records by role, and the
 * result names the record, its outputs with their URLs, and the records the call scheduled. Image outputs also reach
 * the model as image blocks through the attachment service.
 *
 * Calls the sessions module (project binding, turn, held work), the asset store (output types, bytes, URLs), and the
 * service's run, state, record and history reads through {@link AgentToolDeps}. Called by the service, which registers
 * and removes the tools while the DSH `tools` registry is mounted.
 *
 * @module @dv/project/agent-tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ParameterSchemaSpec, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Sessions } from './sessions.ts'
import type {
  AssetId, AssetStore, CharacterId, HistoryEntry, HistoryQuery, LocationId, OperationSpec, ProjectId, ProjectRecord, ProjectState,
  RecordId, RecordInputRef, RecordOrigin, RunRequest, RunResult, SessionId, StyleId, ToolCallCheck,
} from './types.ts'

/** What the agent tools read and call. */
export interface AgentToolDeps {
  sessions: Sessions
  /** The registered asset store; throws when none is registered. */
  assets(): AssetStore
  /** The registered tool call check, or null. */
  toolCallCheck(): ToolCallCheck | null
  /** The service's working-branch state read: the state of the branch `session` writes to. */
  workingState(project: ProjectId, session: SessionId): ProjectState
  /** The record that created a character, location or style version, or null for an unknown version. */
  versionCreatedBy(state: ProjectState, ref: RecordInputRef): RecordId | null
  run(request: RunRequest): Promise<RunResult>
  getRecord(project: ProjectId, record: RecordId): ProjectRecord
  listHistory(query: HistoryQuery): HistoryEntry[]
}

/** The session of a call without an agent: direct SDK calls. */
const ANONYMOUS_SESSION = 'anonymous'

/** The raster formats that can reach the model as image blocks. */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** The arguments every operation tool takes besides the operation's params; they never reach the run's params. */
const SHARED_ARGS = ['reason', 'project_id', 'inputs', 'supersedes', 'based_on'] as const

/** The value every operation tool returns to the model. */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    record: { type: 'string', required: true, description: 'The record of this call; empty for a read, which writes no record.' },
    status: { type: 'string', required: true, description: 'done, or pending (scheduled behind records that have not finished).' },
    summary: { type: 'string', required: true },
    outputs: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          role: { type: 'string', required: true }, asset_id: { type: 'string', required: true }, mime: { type: 'string', required: true },
          url: { type: 'string', required: true },
        },
      },
    },
    scheduled: {
      type: 'array', required: true, items: { type: 'string' },
      description: 'Records this call scheduled, such as the shots of an approved plan.',
    },
    params: { type: 'json', required: true, description: 'The recorded params.' },
    report: {
      type: 'json', description: 'What the operation found beyond its outputs: the seed it drew, the metadata it read, an answer.',
    },
    images: { type: 'array', items: { type: 'json' }, description: 'Attachment references of the image outputs, shown to you as images.' },
  },
} as const

/** The result value of an operation tool call; a type literal so a validated `JsonValue` can be asserted to it. */
export type OperationToolValue = {
  record: string
  status: string
  summary: string
  outputs: Array<{ role: string; asset_id: string; mime: string; url: string }>
  scheduled: string[]
  params: JsonValue
  report?: JsonValue
  images?: JsonValue[]
}

/**
 * The DSH tool name of an operation: dots become underscores because provider function names allow no dots.
 * @param spec - the operation.
 * @returns `dv_<name with _>`.
 */
export function toolNameOf(spec: Pick<OperationSpec, 'name'>): string {
  return `dv_${spec.name.replaceAll('.', '_')}`
}

/**
 * The chat session a tool call belongs to.
 * @param exec - the call.
 * @returns the calling agent's session ID, or the shared anonymous session for a call without an agent.
 */
export function sessionOf(exec: Pick<ToolRunContext, 'agent'>): SessionId {
  return brandString<SessionId>(exec.agent?.id ?? ANONYMOUS_SESSION)
}

/**
 * Turn one input reference text into a record input reference: `<record>#<n>` names output n of a record,
 * `<id>@<n>` names version n of a character, location or style, and anything else names an asset.
 * @param ref - the reference text.
 * @param state - the state the version is looked up in.
 * @param versionCreatedBy - the version lookup of the reducer that defines `createdBy`.
 * @returns the reference.
 * @throws Error for `<id>@<n>` that names no known character, location or style version.
 */
function parseInputRef(ref: string, state: ProjectState, versionCreatedBy: AgentToolDeps['versionCreatedBy']): RecordInputRef {
  const hash = ref.lastIndexOf('#')
  const output = hash > 0 ? Number(ref.slice(hash + 1)) : Number.NaN
  if (Number.isInteger(output) && output >= 0) return { record: brandString<RecordId>(ref.slice(0, hash)), output }
  const at = ref.lastIndexOf('@')
  const version = at > 0 ? Number(ref.slice(at + 1)) : Number.NaN
  if (!Number.isInteger(version)) return { asset: brandString<AssetId>(ref) }
  const id = ref.slice(0, at)
  const candidates: RecordInputRef[] = [
    { character: brandString<CharacterId>(id), version }, { location: brandString<LocationId>(id), version },
    { style: brandString<StyleId>(id), version },
  ]
  const found = candidates.find(candidate => versionCreatedBy(state, candidate) !== null)
  if (found === undefined) throw new Error(`Unknown character, location, or style version '${ref}'.`)
  return found
}

/**
 * Write one record input reference as the text that {@link parseInputRef} reads back.
 * @param ref - the reference.
 * @returns an asset ID, `<record>#<output>`, or `<id>@<version>` for a character, location or style version.
 */
export function formatInputRef(ref: RecordInputRef): string {
  if ('asset' in ref) return ref.asset
  if ('record' in ref) return `${ref.record}#${String(ref.output)}`
  const id = 'character' in ref ? ref.character : 'location' in ref ? ref.location : ref.style
  return `${id}@${String(ref.version)}`
}

/**
 * Turn the `inputs` argument of a tool call or a view request into run inputs, checking roles against the operation.
 * @param spec - the operation.
 * @param raw - role → reference text or a list of them; undefined for none.
 * @param state - the state the references are read against.
 * @param versionCreatedBy - the version lookup of the reducer that defines `createdBy`.
 * @param callerName - the name the error messages give the call: the tool name for an agent tool call, the operation
 *   name for a view request.
 * @returns the inputs in argument order.
 * @throws Error naming the role and `callerName` for an unknown role, a list on a single role, a non-string reference,
 *   or a missing required role; Error for an unknown character, location or style version.
 */
export function parseInputs(
  spec: OperationSpec, raw: unknown, state: ProjectState, versionCreatedBy: AgentToolDeps['versionCreatedBy'], callerName: string,
): RunRequest['inputs'] {
  const inputs: RunRequest['inputs'] = []
  if (raw !== undefined) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('inputs must be an object of role to reference(s).')
    for (const [role, value] of Object.entries(raw)) {
      const input = spec.inputs[role]
      if (input === undefined) {
        throw new Error(`Unknown input role "${role}" for ${callerName}; roles: ${Object.keys(spec.inputs).join(', ') || 'none'}.`)
      }
      const refs: unknown[] = Array.isArray(value) ? value : [value]
      if (refs.length > 1 && input.many !== true) throw new Error(`Input "${role}" of ${callerName} takes one reference.`)
      for (const ref of refs) {
        if (typeof ref !== 'string' || ref === '') {
          throw new Error(`Input "${role}" of ${callerName} must be <asset>, <record>#<output>, or <id>@<version>.`)
        }
        inputs.push({ role, ref: parseInputRef(ref, state, versionCreatedBy) })
      }
    }
  }
  for (const [role, input] of Object.entries(spec.inputs)) {
    if (input.required === true && !inputs.some(entry => entry.role === role)) throw new Error(`${callerName} needs input "${role}".`)
  }
  return inputs
}

/** A JSON copy of a record's params, report, a project summary, or an attachment reference. */
export function toJson(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** A string argument, or undefined when absent or empty. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The project a tool call works on.
 * @param argument - the call's `project_id` argument.
 * @param bound - the project the call's chat session is bound to, or null.
 * @returns the argument, else the bound project.
 * @throws Error telling the model to create or open a project first when neither names one.
 */
export function callProject(argument: unknown, bound: ProjectId | null): ProjectId {
  const id = optionalString(argument) ?? bound
  if (id === null) throw new Error('No project selected: call dv_proj_create or dv_proj_open first, or pass project_id.')
  return brandString<ProjectId>(id)
}

/**
 * The params every operation tool shares, as the model sees them.
 * @param spec - the operation.
 * @returns the shared params.
 */
function sharedParams(spec: OperationSpec): ParameterSchemaSpec {
  const roles = Object.entries(spec.inputs).map(([role, input]) => `${role}${input.required === true ? '' : '?'}: ${input.type}`
    + `${input.many === true ? '[]' : ''}${input.bible === true ? ' (<asset> or <id>@<version>)' : ''}`)
  return {
    reason: {
      type: 'string', required: true,
      description: 'Why you call this, in the user\'s words or your own summary; recorded as the intent of the record.',
    },
    project_id: {
      type: 'string', description: 'The project; defaults to this conversation\'s project from dv_proj_create or dv_proj_open.',
    },
    ...Object.keys(spec.inputs).length === 0 ? {} : {
      inputs: {
        type: 'object', additionalProperties: true,
        description: 'Input references by role: <asset> (an asset ID), <record>#<output> (an output of an earlier record), or '
          + `<id>@<version> (a character, location or style version such as c1@1); a list for roles marked []. Roles: ${roles.join('; ')}.`,
      },
    },
    ...spec.readOnly === true ? {} : {
      supersedes: {
        type: 'array', items: { type: 'string' },
        description: 'Records whose outputs this call replaces, such as an earlier take of the shot; their consumers become stale.',
      },
      based_on: { type: 'string', description: 'The record this call is a changed copy of; takes of one shot share it.' },
    },
  }
}

/**
 * The content blocks the model reads for an operation tool result: one text block, then the image outputs.
 * @param value - the result.
 * @returns the content blocks.
 */
export function formatToolResult(value: OperationToolValue): ContentBlock[] {
  const lines = [value.record === '' ? `${value.status}: ${value.summary}` : `${value.status} ${value.record}: ${value.summary}`]
  for (const output of value.outputs) lines.push(`- ${output.role}: ${output.asset_id} (${output.mime}) ${output.url}`)
  if (value.scheduled.length > 0) lines.push(`scheduled: ${value.scheduled.join(', ')}`)
  lines.push(`params: ${JSON.stringify(value.params)}`)
  if (value.report !== undefined) lines.push(`report: ${JSON.stringify(value.report)}`)
  const images = (value.images ?? []).flatMap((image): ContentBlock[] => isImageRef(image) ? [{ type: 'image', attachment: image }] : [])
  return [{ type: 'text', text: lines.join('\n') }, ...images]
}

/** Whether a JSON value is an attachment reference. */
function isImageRef(value: JsonValue): value is JsonValue & ImageAttachmentRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value['attachmentId'] === 'string'
    && typeof value['mediaType'] === 'string'
}

/** Builds the DSH tool of an operation and runs its calls. */
export class AgentTools {
  /**
   * @param ctx - the service context; the attachment service is read from it at call time.
   * @param deps - what the tools read and call.
   */
  constructor(private readonly ctx: Context, private readonly deps: AgentToolDeps) {}

  /**
   * The DSH tool of an operation.
   * @param spec - the operation.
   * @returns the tool definition.
   */
  define(spec: OperationSpec): ToolDefinition {
    const name = toolNameOf(spec)
    const parameters: ParameterSchemaSpec = {
      ...spec.params, ...spec.toolParams, ...this.deps.toolCallCheck()?.params(spec), ...sharedParams(spec),
    }
    // The description ends with where the operation runs and whether it writes a record or reuses earlier results.
    const hints = [
      spec.resource === 'gpu' ? 'Uses the GPU.' : spec.resource === 'cpu' ? 'Runs on the CPU.' : '',
      spec.readOnly === true ? 'A read that writes no record.'
        : spec.deterministic ? 'Repeating a call with the same inputs and params reuses the earlier result.' : '',
    ].filter(hint => hint !== '')
    return defineTool({
      name,
      description: [spec.description, ...hints].join(' '),
      parameters,
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => formatToolResult(value),
        presentationMeta: (_args, value) => ({ record: value.record, tool: spec.name, status: value.status, outputs: value.outputs }),
      },
      execute: (args, exec) => this.call(spec, args, exec),
    })
  }

  /**
   * Run one tool call: wait for the session's held work, resolve the project and the inputs against the session's
   * working branch, let the operation prepare the call and the registered check look at it, run it as the agent, and
   * describe the record.
   */
  private async call(spec: OperationSpec, args: Record<string, unknown>, exec: ToolRunContext): Promise<OperationToolValue> {
    const { sessions } = this.deps
    const session = sessionOf(exec)
    await sessions.ready(session)
    const project = callProject(args['project_id'], sessions.project(session))
    const turn = sessions.turn(session)
    const origin: RecordOrigin = {
      actor: 'agent', surface: 'chat', session, turn: turn?.turn ?? null, tool_call: exec.callId,
      intent: optionalString(args['reason']) ?? spec.name,
    }
    const state = this.deps.workingState(project, session)
    const check = this.deps.toolCallCheck()
    const toolOnly = new Set<string>([...SHARED_ARGS, ...Object.keys(spec.toolParams ?? {}), ...Object.keys(check?.params(spec) ?? {})])
    const params = Object.fromEntries(Object.entries(args).filter(([key]) => !toolOnly.has(key)))
    const basedOn = optionalString(args['based_on'])
    const supersedes = args['supersedes']
    const request: RunRequest = {
      ...origin, project, operation: spec.name, params,
      inputs: parseInputs(spec, args['inputs'], state, this.deps.versionCreatedBy, toolNameOf(spec)),
      signal: exec.signal,
      ...turn === undefined || turn.requestText === '' ? {} : { request_text: turn.requestText },
      ...basedOn === undefined ? {} : { based_on: brandString<RecordId>(basedOn) },
      ...Array.isArray(supersedes) ? { supersedes: supersedes.map(id => brandString<RecordId>(String(id))) } : {},
    }
    await spec.prepareToolCall?.({ args, request, state, exec })
    await check?.check(spec, { args, request, state, exec })
    if (this.waitsForProducer(project, request.inputs)) request.after = []
    const before = new Set(this.deps.listHistory({ project }).map(entry => entry.record.id))
    const result = await this.deps.run(request)
    const record = result.record
    // A read writes no record: its answer is the report.
    if (record === null) {
      return {
        record: '', status: 'done', summary: `${toolNameOf(spec)} answered`, outputs: [], scheduled: [], params: toJson(request.params),
        ...result.report === null ? {} : { report: toJson(result.report) },
      }
    }
    if (record.status === 'failed' || record.status === 'cancelled') throw failureOf(spec, record)
    // The records this call scheduled: `system` records of the same session that did not exist before the call.
    const scheduled = this.deps.listHistory({ project, actor: 'system', kind: 'operation' })
      .map(entry => entry.record).filter(other => !before.has(other.id) && other.session === session)
      .map(other => other.id).reverse()
    return await this.valueOf(spec, record, scheduled)
  }

  /** Whether an input names the output of a record that has not finished, so the call must be scheduled behind it. */
  private waitsForProducer(project: ProjectId, inputs: RunRequest['inputs']): boolean {
    return inputs.some((input) => {
      if (!('record' in input.ref)) return false
      try {
        return this.deps.getRecord(project, input.ref.record).status !== 'done'
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
    const assets = this.deps.assets()
    const refs: ImageAttachmentRef[] = []
    for (const id of outputs) {
      const meta = assets.get(id)
      if (!IMAGE_MEDIA_TYPES.has(meta.mime)) continue
      refs.push(await attachments.saveImage({ data: assets.read(id), mediaType: meta.mime as ImageMediaType, name: meta.name }))
    }
    return refs
  }

  /** The result value of a record. */
  private async valueOf(spec: OperationSpec, record: ProjectRecord, scheduled: RecordId[]): Promise<OperationToolValue> {
    const assets = this.deps.assets()
    const images = record.status === 'done' ? await this.imagesOf(record.outputs) : []
    return {
      record: record.id,
      status: record.status,
      summary: record.status === 'done' ? spec.summarize(record) : `${toolNameOf(spec)} ${record.status}`,
      outputs: record.outputs.map((id, index) => ({
        role: spec.outputs[index]?.role ?? `output_${index}`, asset_id: id, mime: assets.get(id).mime, url: assets.url(id),
      })),
      scheduled,
      params: toJson(record.params),
      ...record.report === undefined ? {} : { report: toJson(record.report) },
      ...images.length === 0 ? {} : { images: images.map(toJson) },
    }
  }
}

/**
 * The error a call reports when its record did not finish `done`: the failure message, or that the user skipped the
 * approval card, or that the turn was stopped.
 * @param spec - the operation.
 * @param record - the record in its final status.
 * @returns the error.
 */
function failureOf(spec: OperationSpec, record: ProjectRecord): Error {
  if (record.error?.code === 'skipped') return new Error(`The user declined ${toolNameOf(spec)}. Do not retry it unchanged.`)
  if (record.error?.code === 'stopped') return new Error(`${toolNameOf(spec)} was stopped before it finished.`)
  return new Error(record.error?.message ?? `${toolNameOf(spec)} ${record.status}`)
}
