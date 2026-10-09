/**
 * Project's own agent tools, `dv_proj_*`: create and open projects, read state and history, undo and redo, accept a stale
 * record, and wait for scheduled records. Every tool except `dv_proj_history_list` returns the project summary of the
 * current state: Project's fields (head, record count, stale records, recent records) and the fields each component's reducer adds through
 * `Reducer.agentSummary`. A tool that writes records leads its summary with `record`, the newest record the call wrote, and
 * names that record in its presentation metadata (`{record}`), as the operation tools do; a read tool has no metadata.
 * `dv_proj_create` and `dv_proj_open` bind the chat session to its project.
 *
 * Calls the `dvProject` service's public methods and, through {@link ProjToolDeps}, the asset store, the reducers'
 * summaries and the turn of a call. Called by the service, which registers the tools while the DSH `tools` registry is mounted.
 *
 * @module @dv/project/proj-tools
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { callProject, sessionOf, toJson } from './agent-tools.ts'
import type DvProject from './index.ts'
import { ProjectError } from './shared.ts'
import type { AssetStore, ProjectId, ProjectRecord, ProjectState, RecordId, RecordOrigin, TurnId } from './types.ts'

/** What the `dv_proj_*` tools read besides the service's public methods. */
export interface ProjToolDeps {
  /** The registered asset store; throws when none is registered. */
  assets(): AssetStore
  /** The `agentSummary` fields of every reducer that defines it, in component key order. */
  agentSummaries(state: ProjectState): Array<Record<string, JsonValue>>
  /** The agent turn a tool call belongs to, or null outside any turn. */
  turnOf(exec: Pick<ToolRunContext, 'agent'>): TurnId | null
}

/** The recent records a project summary lists. */
const RECENT_RECORDS = 12

/** The history entries `dv_proj_history_list` returns when the call names no limit. */
const HISTORY_LIMIT = 20

/** A project summary the agent can read. */
const STATE_SCHEMA = { type: 'json' } as const

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
 * Who makes a `dv_proj_*` tool's records: the agent, in the chat, in the call's session and turn.
 * @param deps - the turn of a call.
 * @param exec - the call.
 * @param intent - why.
 * @returns the origin.
 */
function originOf(deps: ProjToolDeps, exec: Pick<ToolRunContext, 'agent' | 'callId'>, intent: string): RecordOrigin {
  return { actor: 'agent', surface: 'chat', session: sessionOf(exec), turn: deps.turnOf(exec), tool_call: exec.callId, intent }
}

/**
 * The project summary of a state: the record a write wrote, Project's fields, then each component's `agentSummary`
 * fields, then the stale and recent records.
 * @param project - the service.
 * @param deps - the asset store and the reducers' summaries.
 * @param projectId - the project.
 * @param state - the project state.
 * @param written - the record the tool call wrote, or null for a read.
 * @returns the summary. Throws `invalid_params` when two summaries use the same field name.
 */
export function projectSummary(
  project: DvProject, deps: ProjToolDeps, projectId: ProjectId, state: ProjectState, written: RecordId | null,
): JsonValue {
  const { proj } = state.components
  const assets = deps.assets()
  const summary: Record<string, unknown> = {
    ...written === null ? {} : { record: written },
    project_id: projectId,
    head: state.head,
    records: proj.records.length,
  }
  const stale = Object.keys(proj.stale)
  const recent = proj.records.slice(-RECENT_RECORDS).map(record => ({
    record: record.id, operation: record.operation, status: record.status, intent: record.intent,
    summary: record.status === 'done' ? summaryOf(project, record) : record.error?.message ?? record.status,
    outputs: record.outputs.map(id => assets.url(id)), report: record.report, based_on: record.based_on,
    supersedes: record.supersedes,
  }))
  // Component fields sit between the record count and the stale records; no field may name two things.
  for (const fields of [...deps.agentSummaries(state), { stale, recent }]) {
    for (const [name, value] of Object.entries(fields)) {
      if (Object.hasOwn(summary, name)) throw new ProjectError('invalid_params', `Two project summaries use the field ${name}.`)
      summary[name] = value
    }
  }
  return toJson(summary)
}

/** One line for a finished record: its operation's summary, else the operation name. */
function summaryOf(project: DvProject, record: ProjectRecord): string {
  const spec = project.listOperations().find(candidate => candidate.name === record.operation)
  return spec?.summarize(record) ?? record.operation ?? record.kind
}

/**
 * The presentation metadata of a write tool's summary: the record the call wrote.
 * @param value - the summary.
 * @returns `{record}`, with `record: ''` when the summary names no record.
 */
function writtenMeta(value: JsonValue): JsonValue {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value['record'] : undefined
  return { record: typeof record === 'string' ? record : '' }
}

/**
 * The `dv_proj_*` tools.
 * @param project - the service whose methods the tools call.
 * @param deps - the asset store and the reducers' summaries.
 * @returns the tool definitions.
 */
export function projTools(project: DvProject, deps: ProjToolDeps): ToolDefinition[] {
  const projectParam = { project_id: { type: 'string', description: 'Defaults to this conversation\'s project.' } } as const
  const projectOf = (exec: ToolRunContext, projectId: unknown): ProjectId => callProject(projectId, project.sessionProject(sessionOf(exec)))
  // The project's current state, led by the record a write wrote.
  const summary = (projectId: ProjectId, record: RecordId | null = null): JsonValue =>
    projectSummary(project, deps, projectId, project.getState(projectId), record)
  // The summary after a write, led by the newest record the call wrote.
  const written = (exec: ToolRunContext, projectId: ProjectId): JsonValue => {
    const [entry] = project.listHistory({ project: projectId, tool_call: exec.callId, limit: 1 })
    return summary(projectId, entry?.record.id ?? null)
  }
  const stateOutput = {
    schema: STATE_SCHEMA, render: (_args: unknown, value: JsonValue): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
  }
  const writeOutput = { ...stateOutput, presentationMeta: (_args: unknown, value: JsonValue): JsonValue => writtenMeta(value) }
  return [
    defineTool({
      name: 'dv_proj_create',
      description: 'Start a video project and make it this conversation\'s project, only when the conversation has no project yet. '
        + 'Then import references, create characters, propose a plan, and render.',
      parameters: { title: { type: 'string', required: true } },
      output: writeOutput,
      execute: async (args, exec) => {
        const bound = project.sessionProject(sessionOf(exec))
        if (bound !== null) throw new Error(boundProjectMessage(bound))
        const info = await project.createProject(args.title, originOf(deps, exec, `create project ${args.title}`))
        project.bindSession(sessionOf(exec), info.id)
        return written(exec, info.id)
      },
    }),
    defineTool({
      name: 'dv_proj_open',
      description: 'Make an existing project this conversation\'s project and read its state, '
        + 'only when the conversation has no project yet.',
      parameters: { project_id: { type: 'string', required: true } },
      output: stateOutput,
      execute: (args, exec) => {
        const bound = project.sessionProject(sessionOf(exec))
        const projectId = brandString<ProjectId>(args.project_id)
        if (bound !== null && bound !== projectId) throw new Error(boundProjectMessage(bound))
        project.openProject(projectId)
        project.bindSession(sessionOf(exec), projectId)
        return Promise.resolve(summary(projectId))
      },
    }),
    defineTool({
      name: 'dv_proj_state',
      description: 'Read the project: characters, locations and styles with their versions, the timelines, plans, stale records, '
        + 'and recent records.',
      parameters: projectParam,
      output: stateOutput,
      execute: (args, exec) => Promise.resolve(summary(projectOf(exec, args.project_id))),
    }),
    defineTool({
      name: 'dv_proj_history_list',
      description: 'List the project history, newest first: each step with its operation, status, intent, and place: current '
        + '(the state the project shows), before, or after (a step that dv_proj_redo or dv_proj_undo with to brings back).',
      parameters: {
        ...projectParam,
        limit: { type: 'integer', description: `At most this many records; default ${HISTORY_LIMIT}.` },
        operation: { type: 'string', description: 'Only records of this operation, such as plan.create.' },
      },
      output: stateOutput,
      execute: (args, exec) => {
        const projectId = projectOf(exec, args.project_id)
        const entries = project.listHistory({
          project: projectId, limit: args.limit ?? HISTORY_LIMIT, ...args.operation === undefined ? {} : { operation: args.operation },
        })
        return Promise.resolve(toJson(entries.map(({ record, place }) => ({
          record: record.id, place, operation: record.operation ?? record.kind, status: record.status, actor: record.actor,
          intent: record.intent, outputs: record.outputs,
        }))))
      },
    }),
    defineTool({
      name: 'dv_proj_undo',
      description: 'Move the project back to an earlier state. Without to, go back one step. With to, go to that step of '
        + 'dv_proj_history_list, before or after the current one: the project shows its state just after that step. A move adds '
        + 'no step. The steps after the current one stay until a new change is made; a new change discards them for good. '
        + 'When the user asks to roll back, return to an earlier version or undo several changes, use this tool; never rebuild '
        + 'the old state with new edits.',
      parameters: {
        ...projectParam,
        to: { type: 'string', description: 'A record ID from dv_proj_history_list to go to; omit to go back one step.' },
      },
      output: stateOutput,
      execute: async (args, exec) => {
        const projectId = projectOf(exec, args.project_id)
        await project.undo(projectId, args.to === undefined ? undefined : brandString<RecordId>(args.to))
        return summary(projectId)
      },
    }),
    defineTool({
      name: 'dv_proj_redo',
      description: 'Move the project one step forward again, after an undo. A move adds no step.',
      parameters: projectParam,
      output: stateOutput,
      execute: async (args, exec) => {
        const projectId = projectOf(exec, args.project_id)
        await project.redo(projectId)
        return summary(projectId)
      },
    }),
    defineTool({
      name: 'dv_proj_stale_accept',
      description: 'Accept a stale record as it is: its stale mark and the marks it passed to records made from it go away. '
        + 'Call it only when the user accepts an out-of-date result instead of rendering it again.',
      parameters: { ...projectParam, record: { type: 'string', required: true, description: 'The stale record ID.' } },
      output: writeOutput,
      execute: async (args, exec) => {
        const projectId = projectOf(exec, args.project_id)
        await project.acceptStale(projectId, brandString<RecordId>(args.record), originOf(deps, exec, `accept ${args.record}`))
        return written(exec, projectId)
      },
    }),
    defineTool({
      name: 'dv_proj_wait',
      description: 'Wait until every scheduled record of the project has finished or failed, then read the state.',
      parameters: projectParam,
      output: stateOutput,
      execute: async (args, exec) => {
        const projectId = projectOf(exec, args.project_id)
        await project.wait(projectId)
        return summary(projectId)
      },
    }),
  ]
}
