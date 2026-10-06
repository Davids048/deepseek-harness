/**
 * The project context the agent reads at every step, so that "the second clip", "this person", or "a different
 * angle" resolve to concrete records, assets, and character, location and style versions. The text is rebuilt from the
 * state of the session's working branch, so it is as current as the project's records.
 *
 * @module @video-harness/agent/resolver
 */
import type { Branch, ProjectId, ProjectRecord, ProjectState } from '@dv/project'
import type {} from '@video-harness/tools'

/** The facts about one session the block is rendered from. */
export interface ResolverInput {
  projectId: ProjectId | null
  /** The state of the session's working branch; null when no project is bound. */
  state: ProjectState | null
  /** The session's working branch, with its draft counts when it is a draft; null when no project is bound. */
  branch: Branch | null
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
  '- Propose first: vh_plan_create records the plan; show the shots, durations, and estimated GPU seconds to the user; '
    + 'call vh_plan_approve with user_approved: true only after the user agreed in the conversation. Then dv_proj_wait, then read dv_proj_state.',
  '- A change the user asked for by name (one retake, one trim, one reorder) runs at once; pass user_requested: true on a generate call. A change you want to make to an approved plan is proposed first.',
  '- Every call of yours lands on this conversation\'s draft, which stays open across turns and holds the user\'s own edits too. '
    + 'Only the user accepts or discards it: call dv_proj_draft_accept or dv_proj_draft_discard only when the user asks you to. '
    + 'When the draft holds results the user has not judged yet, end your reply with "草稿待确认" and say what is waiting.',
  '- Resolve references from the project block below: "第N段 / clip N" is timeline slot N (its asset and producing record); "这个人 / she / he" is a character entity; "换个角度 / again but …" is vh_generate_video with base_op = the producing record of that slot and replaces = [that record]. When two candidates fit and nothing is selected, ask instead of guessing.',
  '- When you mention the model that makes the videos, call it "DreamVerse 视频模型" ("DreamVerse video model" in English replies). Never tell the user a model codename or model ID, such as the `model` parameter of generation records.',
  '- The `video-directing` skill holds the shot-planning and prompt-writing procedure; `branching-story` the choose-your-own-path procedure.',
].join('\n')

/**
 * Render the agent-facing block.
 * @param input - the session, the folded state, and how to link assets.
 * @returns the text, or the rules alone when no project is bound.
 */
export function renderResolverBlock(input: ResolverInput): string {
  const { projectId, state, branch } = input
  if (projectId === null || state === null || branch === null) {
    return `${RULES}\n\nNo project is bound to this conversation yet: start the work with dv_proj_create.`
  }
  const lines = [RULES, '', `Project ${projectId} on branch ${branch.name}.`,
    'This conversation belongs to this project: do all work in it and never call dv_proj_create or dv_proj_open.']
  lines.push(draftLine(branch))
  lines.push(...selectionLines(input.selection))
  lines.push(...uploadLines(state, id => input.url(id)))
  lines.push(...entityLines(state))
  lines.push(...sequenceLines(state, id => input.url(id)))
  lines.push(...takeLines(state))
  lines.push(...staleLines(state))
  lines.push(...planLines(state))
  return lines.join('\n')
}

/** Whether the session's draft is open, with its counts, and who closes it. */
function draftLine(branch: Branch): string {
  if (branch.counts === null) return 'No draft is open.'
  return `Draft ${branch.name} is open with ${branch.counts.agent_changes} agent change(s) and ${branch.counts.human_edits} human edit(s). `
    + 'Only the user accepts or discards it; call dv_proj_draft_accept or dv_proj_draft_discard only when the user asks.'
}

/** The user's current selection in a view, when there is one: it resolves "this" and "这个" before anything else. */
function selectionLines(selection: ResolverInput['selection']): string[] {
  if (selection === null || selection === undefined) return []
  const slot = selection.slot === undefined ? '' : ` (timeline slot ${selection.slot})`
  return [`用户当前选中 / user selection in the ${selection.surface}: ${selection.kind} ${selection.id}${slot}. "这个 / this" refers to it unless the message says otherwise.`]
}

/** The newest uploaded images, such as pictures the user attached in the chat, so the agent can use them as references. */
function uploadLines(state: ProjectState, url: (id: string) => string): string[] {
  const uploads = state.components.proj.records
    .filter(record => record.operation === 'asset.upload' && record.status === 'done'
      && String(record.params['mime'] ?? '').startsWith('image/'))
    .slice(-UPLOAD_LINES)
  if (uploads.length === 0) return []
  const named = (record: ProjectRecord): string => {
    const name = record.params['name']
    return typeof name === 'string' && name !== '' ? ` "${name}"` : ''
  }
  const lines = uploads.flatMap(record => record.outputs.slice(0, 1).map(id => `- asset ${id}${named(record)} ${url(id)}`))
  return ['Uploaded images (newest last):', ...lines]
}

/** How many uploaded images the block lists. */
const UPLOAD_LINES = 8

/** One line per entity: its current version, name, and references. */
function entityLines(state: ProjectState): string[] {
  const entries = Object.entries(state.components.bible.entities)
  if (entries.length === 0) return ['Entities: none.']
  return ['Entities:', ...entries.map(([id, versions]) => {
    const current = versions.at(-1)
    return current === undefined ? `- ${id}: no version` : `- ${id}@${current.version} ${current.kind} "${current.name}" refs ${current.refs.join(', ') || 'none'}`
  })]
}

/** One line per timeline slot, naming the asset and the record that produced it. */
function sequenceLines(state: ProjectState, url: (id: string) => string): string[] {
  const timeline = state.components.timeline.sequence
  if (timeline === null || timeline.items.length === 0) return ['Timeline: empty.']
  const stale = state.components.proj.stale
  return ['Timeline:', ...timeline.items.map((item) => {
    const producer = state.components.proj.created_by[item.assetId]
    const range = item.inSec === null && item.outSec === null ? '' : ` range ${item.inSec ?? 0}s-${item.outSec ?? 'end'}`
    const flag = producer !== undefined && stale[producer] !== undefined ? ' STALE' : ''
    return `- slot ${item.slot}: asset ${item.assetId} from record ${producer ?? 'upload'}${range}${flag} ${url(item.assetId)}`
  })]
}

/** Open takes: the alternatives recorded for one shot. */
function takeLines(state: ProjectState): string[] {
  const entries = Object.entries(state.components.shot.takes).filter(([, takes]) => takes.length > 1)
  if (entries.length === 0) return []
  return ['Takes (alternatives of one shot, root first):', ...entries.map(([root, takes]) => `- ${root}: ${takes.join(', ')}`)]
}

/** Which records are stale and why, in one line each. */
function staleLines(state: ProjectState): string[] {
  const entries = Object.entries(state.components.proj.stale)
  if (entries.length === 0) return []
  const marks = entries.map(([id, because]) => `${id} (input replaced by ${because})`).join('; ')
  return [`Stale records (inputs were replaced; nothing is redone until the user agrees): ${marks}`]
}

/** Plans and whether each was approved. */
function planLines(state: ProjectState): string[] {
  const plans = state.components.plan.plans
  if (plans.length === 0) return []
  const status = (plan: (typeof plans)[number]): string => plan.approved ? `approved by ${plan.approvedBy ?? 'user'}` : 'proposed, waiting for the user'
  return ['Plans:', ...plans.map(plan => `- ${plan.op}: ${status(plan)}`)]
}
