/**
 * Project's own agent tools, `dv_proj_*`: create and open projects, read state and history, accept or discard the
 * draft, undo and redo, accept a stale record, create and switch branches, and wait for scheduled records. Every tool
 * except `dv_proj_history_list` returns the project summary of a branch: Project's fields (head, branch, draft counts,
 * branches, record count, stale records, recent records) and the fields each component's reducer adds through
 * `Reducer.agentSummary`. `dv_proj_create` and `dv_proj_open` bind the chat session to its project.
 *
 * Calls the `dvProject` service's public methods and, through {@link ProjToolDeps}, the asset store and the reducers'
 * summaries. Called by the service, which registers the tools while the DSH `tools` registry is mounted.
 *
 * @module @dv/project/proj-tools
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { callProject, sessionOf, toJson } from './agent-tools.ts'
import type DvProject from './index.ts'
import { MAIN_BRANCH, ProjectError } from './shared.ts'
import type { AssetStore, ProjectId, ProjectRecord, ProjectState, RecordId, RecordOrigin } from './types.ts'

/** What the `dv_proj_*` tools read besides the service's public methods. */
export interface ProjToolDeps {
  /** The registered asset store; throws when none is registered. */
  assets(): AssetStore
  /** The `agentSummary` fields of every reducer that defines it, in component key order. */
  agentSummaries(state: ProjectState): Array<Record<string, JsonValue>>
}

/** The recent records a project summary lists. */
const RECENT_RECORDS = 12

/** The history entries `dv_proj_history_list` returns when the call names no limit. */
const HISTORY_LIMIT = 20

/** The prefix of exploration branch names. */
const EXPLORE_PREFIX = 'explore/'

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
 * Who makes a `dv_proj_*` tool's records: the agent, in the chat, in the call's session and current turn.
 * @param project - the service, for the session's turn.
 * @param exec - the call.
 * @param intent - why.
 * @returns the origin.
 */
function originOf(project: DvProject, exec: Pick<ToolRunContext, 'agent' | 'callId'>, intent: string): RecordOrigin {
  const session = sessionOf(exec)
  return { actor: 'agent', surface: 'chat', session, turn: project.sessionTurn(session), tool_call: exec.callId, intent }
}

/**
 * The project summary of a branch state: Project's fields, then each component's `agentSummary` fields, then the
 * stale and recent records.
 * @param project - the service.
 * @param deps - the asset store and the reducers' summaries.
 * @param projectId - the project.
 * @param state - the state of the branch.
 * @returns the summary. Throws `invalid_params` when two summaries use the same field name.
 */
function projectSummary(project: DvProject, deps: ProjToolDeps, projectId: ProjectId, state: ProjectState): JsonValue {
  const { proj } = state.components
  const assets = deps.assets()
  const branches = project.listBranches(projectId)
  const summary: Record<string, unknown> = {
    project_id: projectId,
    head: state.head,
    branch: state.branch,
    draft: branches.find(branch => branch.name === state.branch)?.counts ?? null,
    branches: branches.map(branch => branch.name),
    records: proj.records.length,
  }
  const stale = Object.keys(proj.stale)
  const recent = proj.records.filter(record => record.kind === 'operation').slice(-RECENT_RECORDS).map(record => ({
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
 * The `dv_proj_*` tools.
 * @param project - the service whose methods the tools call.
 * @param deps - the asset store and the reducers' summaries.
 * @returns the tool definitions.
 */
export function projTools(project: DvProject, deps: ProjToolDeps): ToolDefinition[] {
  const projectParam = { project_id: { type: 'string', description: 'Defaults to this conversation\'s project.' } } as const
  const projectOf = (exec: ToolRunContext, projectId: unknown): ProjectId => callProject(projectId, project.sessionProject(sessionOf(exec)))
  // The state of a branch, by default the branch the session works on.
  const summary = (exec: ToolRunContext, projectId: ProjectId, branch?: string): JsonValue => {
    const name = branch ?? project.workingBranch(projectId, sessionOf(exec)).name
    return projectSummary(project, deps, projectId, project.getState(projectId, name))
  }
  const stateOutput = {
    schema: STATE_SCHEMA, render: (_args: unknown, value: JsonValue): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
  }
  return [
    defineTool({
      name: 'dv_proj_create',
      description: 'Start a video project and make it this conversation\'s project, only when the conversation has no project yet. '
        + 'Then import references, create characters, propose a plan, and render.',
      parameters: { title: { type: 'string', required: true } },
      output: stateOutput,
      execute: async (args, exec) => {
        const bound = project.sessionProject(sessionOf(exec))
        if (bound !== null) throw new Error(boundProjectMessage(bound))
        const info = await project.createProject(args.title, originOf(project, exec, `create project ${args.title}`))
        project.bindSession(sessionOf(exec), info.id)
        return summary(exec, info.id)
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
        return Promise.resolve(summary(exec, projectId))
      },
    }),
    defineTool({
      name: 'dv_proj_state',
      description: 'Read the project: characters, locations and styles with their versions, the timelines, plans, stale records, '
        + 'recent records, and whether your draft is open. Pass branch to read another branch.',
      parameters: { ...projectParam, branch: { type: 'string', description: 'A branch name; defaults to the branch you write to.' } },
      output: stateOutput,
      execute: (args, exec) => Promise.resolve(summary(exec, projectOf(exec, args.project_id), args.branch)),
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
        const projectId = projectOf(exec, args.project_id)
        const entries = project.listHistory({
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
        const projectId = projectOf(exec, args.project_id)
        await project.acceptDraft(projectId, originOf(project, exec, 'accept the draft'))
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
        const projectId = projectOf(exec, args.project_id)
        const origin = originOf(project, exec, 'discard the draft')
        const counts = project.workingBranch(projectId, origin.session).counts
        if (counts === null) {
          throw new Error('No open draft to discard: the user already accepted or discarded it, or nothing was recorded.')
        }
        await project.discardDraft(projectId, origin, counts)
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
        const projectId = projectOf(exec, args.project_id)
        await project.undo(projectId, originOf(project, exec, 'undo'))
        return summary(exec, projectId)
      },
    }),
    defineTool({
      name: 'dv_proj_redo',
      description: 'Bring back the change the latest undo removed, while nothing else changed main since.',
      parameters: projectParam,
      output: stateOutput,
      execute: async (args, exec) => {
        const projectId = projectOf(exec, args.project_id)
        await project.redo(projectId, originOf(project, exec, 'redo'))
        return summary(exec, projectId)
      },
    }),
    defineTool({
      name: 'dv_proj_stale_accept',
      description: 'Accept a stale record as it is: its stale mark and the marks it passed to records made from it go away. '
        + 'Call it only when the user accepts an out-of-date result instead of rendering it again.',
      parameters: { ...projectParam, record: { type: 'string', required: true, description: 'The stale record ID.' } },
      output: stateOutput,
      execute: async (args, exec) => {
        const projectId = projectOf(exec, args.project_id)
        await project.acceptStale(projectId, brandString<RecordId>(args.record), originOf(project, exec, `accept ${args.record}`))
        return summary(exec, projectId)
      },
    }),
    defineTool({
      name: 'dv_proj_branch_create',
      description: 'Start an exploration branch at a record or branch head, and switch this conversation to it.',
      parameters: {
        ...projectParam, name: { type: 'string', required: true }, at: { type: 'string', description: 'A record ID or branch name; default main.' },
      },
      output: stateOutput,
      execute: async (args, exec) => {
        const projectId = projectOf(exec, args.project_id)
        const name = args.name.startsWith(EXPLORE_PREFIX) ? args.name : `${EXPLORE_PREFIX}${args.name}`
        const origin = originOf(project, exec, `explore ${name}`)
        await project.createBranch(projectId, name, args.at ?? MAIN_BRANCH, origin)
        await project.switchBranch(projectId, name, origin)
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
        const projectId = projectOf(exec, args.project_id)
        await project.switchBranch(projectId, args.name, originOf(project, exec, `switch to ${args.name}`))
        return summary(exec, projectId)
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
        return summary(exec, projectId)
      },
    }),
  ]
}
