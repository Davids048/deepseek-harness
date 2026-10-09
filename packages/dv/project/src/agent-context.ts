/**
 * The `dv:project` system-prompt section: what the agent of a chat session reads about its project at every step.
 * The section holds Project's general rules (the one history line, undo, confirmation, stale records, and how to name
 * records, assets, versions and clips), then the project summary of the current state: the same summary
 * that `dv_proj_state` returns, with the fields each component's reducer adds through `Reducer.agentSummary`. It holds
 * nothing that the user cannot see in the views or the conversation.
 *
 * Calls the `dvProject` service's public reads and the project summary of the `proj-tools` module. Called by the
 * service, which registers the section while the DSH `systemPrompt` service is mounted.
 *
 * @module @dv/project/agent-context
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type DvProject from './index.ts'
import { projectSummary, type ProjToolDeps } from './proj-tools.ts'
import type { SessionId } from './types.ts'

/** The name of the system-prompt section. */
export const PROMPT_SECTION = 'dv:project'

/** Project's rules, which apply whether or not a project is bound. */
const RULES = [
  'DreamVerse project rules:',
  '- The project has one history line. Every call of yours and every edit of the user is added at its end at once; '
    + 'the user does not accept changes, and nothing is removed from the history.',
  '- To roll back ("撤销 / 回到之前 / 撤销到… / 回到上一版 / roll back / go back to"), call dv_proj_undo: without to it undoes one step; '
    + 'with to = a record ID from dv_proj_history_list the project returns to its state just after that record. '
    + 'The undo is a new record at the end of the history, so a later change continues from the earlier state, and the user can '
    + 'still return to any record. Never rebuild an earlier state with new edits when the user asked to go back.',
  '- Name things by the IDs in the project summary: a record by its record ID, an output of a record as <record>#<n>, '
    + 'a character, location or style version as <id>@<version>, an asset by its asset ID, a clip by its clip ID. '
    + 'The user points at things with + → 引用 or dv: mentions, which reach you as these IDs. '
    + 'When the user\'s words fit more than one thing and no mention names it, ask which one instead of guessing.',
  '- When a tool refuses a call because it needs the user\'s agreement, show the user what the refusal says the call will do and '
    + 'cost, and ask in the conversation with the question in bold. Call again with user_approved: true or user_requested: true '
    + 'only after the user agreed. A change the user asked for by name (one retake, one trim) passes user_requested: true at once.',
  '- Stale records had an input replaced. Render one again only when the user agrees; call dv_proj_stale_accept when the user keeps it as it is.',
].join('\n')

/**
 * The section text for one chat session.
 * @param project - the service.
 * @param deps - the asset store and the reducers' summaries, for the project summary.
 * @param sessionId - the agent's session ID; undefined on assemblies without an agent.
 * @returns the rules, then the bound project and the summary of its current state.
 */
export function projectContext(project: DvProject, deps: ProjToolDeps, sessionId: string | undefined): string {
  const session = sessionId === undefined ? null : brandString<SessionId>(sessionId)
  const projectId = session === null ? null : project.sessionProject(session)
  if (projectId === null) return `${RULES}\n\nNo project is bound to this conversation yet: start the work with dv_proj_create.`
  const summary = projectSummary(project, deps, projectId, project.getState(projectId), null)
  return [
    RULES, '',
    `This conversation belongs to project ${projectId}: do all work in it and never call dv_proj_create or dv_proj_open.`,
    'Project summary of the current state, as dv_proj_state returns it:',
    JSON.stringify(summary, null, 1),
  ].join('\n')
}
