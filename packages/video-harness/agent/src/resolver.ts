/**
 * The project context the agent reads at every step, so that "the second clip", "this person", or "a different
 * angle" resolve to concrete records, assets, and entity versions. The text is rebuilt from the folded state of the
 * branch the session writes to, so it is as current as the operation log.
 *
 * @module @video-harness/agent/resolver
 */
import { MAIN_BRANCH, type OpId, type ProjectId } from '@video-harness/oplog'
import type { ProjectState } from '@video-harness/runtime'
import type { SessionState } from '@video-harness/tools'

/** The facts about one session the block is rendered from. */
export interface ResolverInput {
  session: SessionState
  projectId: ProjectId | null
  /** The state of the branch the session writes to; null when no project is bound. */
  state: ProjectState | null
  /** The branch the state was folded from. */
  branch: string
  /** Whether the session's open turn is a draft (an agent turn on `main`) rather than direct writes to an exploration branch. */
  openDraft: boolean
  /** Whether the open draft was opened in an earlier agent-loop turn than the current one. */
  draftFromEarlierTurn: boolean
  /** Asset URL under the public base, for links in the block. */
  url(id: string): string
  /** What the user last selected in the canvas or the timeline, when a view reported one. */
  selection?: { kind: string; id: string; slot?: number; surface: string } | null
}

/** The rules that apply whether or not a project is bound. */
const RULES = [
  'Video harness rules:',
  '- Register people as characters (vh_entity_character_create) before generating.',
  '- Every shot is made from reference pictures: an uploaded image or a character registered with refs. When the user gave no picture, ask for one (they can attach it in the chat) before planning; never plan or generate without one.',
  '- Propose first: vh_plan_create records the plan; show the shots, durations, and estimated GPU seconds to the user; call vh_plan_approve with user_approved: true only after the user agreed in the conversation. Then vh_wait, then read vh_project_state.',
  '- A change the user asked for by name (one retake, one trim, one reorder) runs at once; pass user_requested: true on a generate call. A change you want to make to an approved plan is proposed first.',
  '- Every call of yours lands on a draft branch for this turn. A draft made only of deterministic work and changes the user asked for by name is accepted into main when your turn ends. A draft that holds generative work the user did not ask for by name stays open: end your reply with "草稿待确认" and say what is waiting; when the user is happy, or their next message builds on it, call vh_turn_accept first, when they reject it, vh_turn_reject.',
  '- Resolve references from the project block below: "第N段 / clip N" is timeline slot N (its asset and producing record); "这个人 / she / he" is a character entity; "换个角度 / again but …" is vh_generate_video with base_op = the producing record of that slot and replaces = [that record]. When two candidates fit and nothing is selected, ask instead of guessing.',
  '- When you mention the model that makes the videos, call it "DreamVerse 视频模型" ("DreamVerse video model" in English replies). Never tell the user a model codename or model ID, such as the `model` parameter of generation records.',
  '- Prefer the structured tools; vh_command_run only for what no tool covers. The `video-directing` skill holds the shot-planning and prompt-writing procedure; `branching-story` the choose-your-own-path procedure.',
].join('\n')

/**
 * Render the agent-facing block.
 * @param input - the session, the folded state, and how to link assets.
 * @returns the text, or the rules alone when no project is bound.
 */
export function renderResolverBlock(input: ResolverInput): string {
  const { session, projectId, state } = input
  if (projectId === null || state === null) return `${RULES}\n\nNo project is bound to this conversation yet: start the work with vh_project_create.`
  const lines = [RULES, '', `Project ${projectId} on branch ${input.branch}${session.branch === null ? '' : ' (exploration branch; records go there directly)'}.`,
    'This conversation belongs to this project: do all work in it and never call vh_project_create or vh_project_use.']
  lines.push(draftLine(session, state, input.openDraft, input.draftFromEarlierTurn))
  lines.push(...selectionLines(input.selection))
  lines.push(...uploadLines(state, id => input.url(id)))
  lines.push(...entityLines(state))
  lines.push(...sequenceLines(state, id => input.url(id)))
  lines.push(...takeLines(state))
  lines.push(...staleLines(state))
  lines.push(...planLines(state))
  return lines.join('\n')
}

/** Whether the session's draft is open, and what the agent must do about it. */
function draftLine(session: SessionState, state: ProjectState, openDraft: boolean, fromEarlierTurn: boolean): string {
  if (session.branch !== null) return 'Records go to the exploration branch directly; no draft to accept.'
  // The session may still name a turn the user already accepted or discarded in a view; only an open draft counts.
  if (session.turn === null || !openDraft) return 'No draft is open.'
  const records = state.ops.filter(op => op.turn === session.turn && op.kind !== 'intent')
  const summary = `Open draft ${session.turn} with ${records.length} record(s)`
  if (!fromEarlierTurn) return `${summary} from this turn.`
  return `${summary} from an earlier turn: call vh_turn_accept if the user builds on it or agreed to it, vh_turn_reject if not, before any other structured call.`
}

/** The user's current selection in a view, when there is one: it resolves "this" and "这个" before anything else. */
function selectionLines(selection: ResolverInput['selection']): string[] {
  if (selection === null || selection === undefined) return []
  const slot = selection.slot === undefined ? '' : ` (timeline slot ${selection.slot})`
  return [`用户当前选中 / user selection in the ${selection.surface}: ${selection.kind} ${selection.id}${slot}. "这个 / this" refers to it unless the message says otherwise.`]
}

/** The newest uploaded images, such as pictures the user attached in the chat, so the agent can use them as references. */
function uploadLines(state: ProjectState, url: (id: string) => string): string[] {
  const uploads = state.ops
    .filter(op => op.tool?.name === 'asset.upload' && op.status === 'done' && String(op.params['mime'] ?? '').startsWith('image/'))
    .slice(-UPLOAD_LINES)
  if (uploads.length === 0) return []
  const named = (op: ProjectState['ops'][number]): string => (typeof op.params['name'] === 'string' && op.params['name'] !== '' ? ` "${op.params['name']}"` : '')
  return ['Uploaded images (newest last):', ...uploads.flatMap(op => op.outputs.slice(0, 1).map(id => `- asset ${id}${named(op)} ${url(id)}`))]
}

/** How many uploaded images the block lists. */
const UPLOAD_LINES = 8

/** One line per entity: its current version, name, and references. */
function entityLines(state: ProjectState): string[] {
  const entries = Object.entries(state.entities)
  if (entries.length === 0) return ['Entities: none.']
  return ['Entities:', ...entries.map(([id, versions]) => {
    const current = versions.at(-1)
    return current === undefined ? `- ${id}: no version` : `- ${id}@${current.version} ${current.kind} "${current.name}" refs ${current.refs.join(', ') || 'none'}`
  })]
}

/** One line per timeline slot, naming the asset and the record that produced it. */
function sequenceLines(state: ProjectState, url: (id: string) => string): string[] {
  if (state.sequence === null || state.sequence.items.length === 0) return ['Timeline: empty.']
  return ['Timeline:', ...state.sequence.items.map((item) => {
    const producer = state.producers[item.assetId]
    const range = item.inSec === null && item.outSec === null ? '' : ` range ${item.inSec ?? 0}s-${item.outSec ?? 'end'}`
    const flag = producer !== undefined && state.stale[producer] !== undefined ? ' STALE' : ''
    return `- slot ${item.slot}: asset ${item.assetId} from record ${producer ?? 'upload'}${range}${flag} ${url(item.assetId)}`
  })]
}

/** Open takes: the alternatives recorded for one shot. */
function takeLines(state: ProjectState): string[] {
  const entries = Object.entries(state.takes).filter(([, takes]) => takes.length > 1)
  if (entries.length === 0) return []
  return ['Takes (alternatives of one shot, root first):', ...entries.map(([root, takes]) => `- ${root}: ${takes.join(', ')}`)]
}

/** Which records are stale and why, in one line each. */
function staleLines(state: ProjectState): string[] {
  const entries = Object.entries(state.stale)
  if (entries.length === 0) return []
  const why = (id: string, because: OpId): string => `${id} (input replaced by ${because})`
  return [`Stale records (inputs were replaced; generative ones are not redone until the user agrees): ${entries.map(([id, mark]) => why(id, mark.because)).join('; ')}`]
}

/** Plans and whether each was approved. */
function planLines(state: ProjectState): string[] {
  if (state.plans.length === 0) return []
  return ['Plans:', ...state.plans.map(plan => `- ${plan.op}: ${plan.approved ? `approved by ${plan.approvedBy ?? 'user'}` : 'proposed, waiting for the user'}`)]
}

/** The branch a session's structured calls fold from: the open draft, else the exploration branch, else main. */
export function sessionBranch(session: SessionState, openDraftBranch: string | undefined): string {
  return openDraftBranch ?? session.branch ?? MAIN_BRANCH
}
