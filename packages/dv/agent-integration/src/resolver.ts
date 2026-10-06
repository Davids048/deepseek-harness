/**
 * The project context the agent reads at every step, so that "the second clip", "this person", or "a different
 * angle" resolve to concrete records, assets, and character, location and style versions. The text is rebuilt from the
 * state of the session's working branch, so it is as current as the project's records.
 *
 * @module @dv/agent-integration/resolver
 */
import type { ViewSelection } from '@dv/api'
import type { Branch, ProjectId, ProjectRecord, ProjectState } from '@dv/project'
import type {} from '@dv/shot-plan'
import type {} from '@dv/shot-render'
import type { Character, Location, Style } from '@dv/story-bible'
import type {} from '@dv/timeline'

/** The facts about one session the block is rendered from. */
export interface ResolverInput {
  projectId: ProjectId | null
  /** The state of the session's working branch; null when no project is bound. */
  state: ProjectState | null
  /** The session's working branch, with its draft counts when it is a draft; null when no project is bound. */
  branch: Branch | null
  /** Asset URL under the public base, for links in the block. */
  url(id: string): string
  /** What the user last selected in the canvas, the timeline or the asset pool, when a view reported one. */
  selection?: Pick<ViewSelection, 'kind' | 'id' | 'surface'> | null
}

/** The rules that apply whether or not a project is bound. */
const RULES = [
  'DreamVerse rules:',
  '- Create characters for people (dv_bible_character_create) before rendering.',
  '- Every shot is made from reference images: an imported image or a character created with reference images. When the user gave no reference image, ask for one (they can attach it in the chat) before planning; never plan or render without one.',
  '- Propose first: dv_plan_create records the plan; show the shots, durations, and estimated GPU seconds to the user; '
    + 'call dv_plan_approve with user_approved: true only after the user agreed in the conversation. Then dv_proj_wait, then read dv_proj_state.',
  '- A change the user asked for by name (one retake, one trim, one reorder) runs at once; pass user_requested: true on a dv_shot_render call. A change you want to make to an approved plan is proposed first.',
  '- To extend, shorten or change the story, call dv_plan_update on the existing plan (its plan ID from the project block, with every shot in order: a shot added after six shots is shot 7), then dv_plan_approve that version: '
    + 'only new or changed shots render, and the plan\'s timeline gets every shot. Create a new plan only for a separate story.',
  '- Every call of yours lands on this conversation\'s draft, which stays open across turns and holds the user\'s own edits too. '
    + 'Only the user accepts or discards it: call dv_proj_draft_accept or dv_proj_draft_discard only when the user asks you to. '
    + 'When the draft holds results the user has not judged yet, end your reply with "草稿待确认" and say what is waiting.',
  '- Resolve references from the project block below: "第N段 / clip N" is clip N of the first timeline, or of the timeline the user names (its clip ID, asset and producing record); the dv_timeline_clip_* tools name a clip by its clip ID; "这个人 / she / he" is a character; "换个角度 / again but …" is dv_shot_render with based_on = the producing record of that clip and supersedes = [that record]. When two candidates fit and nothing is selected, ask instead of guessing.',
  '- When you mention the model that makes the videos, call it "DreamVerse 视频模型" ("DreamVerse video model" in English replies). Never tell the user a model codename or model ID, such as the `model` parameter of render records.',
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
  lines.push(...importLines(state, id => input.url(id)))
  lines.push(...bibleLines(state))
  lines.push(...timelineLines(state, id => input.url(id)))
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
  return [`用户当前选中 / user selection in the ${selection.surface}: ${selection.kind} ${selection.id}. "这个 / this" refers to it unless the message says otherwise.`]
}

/** The newest imported images, such as pictures the user attached in the chat, so the agent can use them as references. */
function importLines(state: ProjectState, url: (id: string) => string): string[] {
  const imports = state.components.proj.records
    .filter(record => record.operation === 'asset.import' && record.status === 'done'
      && String(record.params['mime'] ?? '').startsWith('image/'))
    .slice(-IMPORT_LINES)
  if (imports.length === 0) return []
  const named = (record: ProjectRecord): string => {
    const name = record.params['name']
    return typeof name === 'string' && name !== '' ? ` "${name}"` : ''
  }
  const lines = imports.flatMap(record => record.outputs.slice(0, 1).map(id => `- asset ${id}${named(record)} ${url(id)}`))
  return ['Imported images (newest last):', ...lines]
}

/** How many imported images the block lists. */
const IMPORT_LINES = 8

/** One line per character, location and style: its current version, name, and reference images. */
function bibleLines(state: ProjectState): string[] {
  const { characters, locations, styles } = state.components.bible
  const kinds = [['character', characters], ['location', locations], ['style', styles]] as const
  const lines = kinds.flatMap(([kind, byId]) => Object.values(byId).flatMap((versions: ReadonlyArray<Character | Location | Style>) => {
    const current = versions.at(-1)
    if (current === undefined) return []
    return [`- ${current.id}@${current.version} ${kind} "${current.name}" references ${current.references.join(', ') || 'none'}`]
  }))
  return lines.length === 0 ? ['Characters, locations and styles: none.'] : ['Characters, locations and styles:', ...lines]
}

/**
 * Every timeline (with its name when it has one) with one line per clip, naming the clip's position, its clip ID, its
 * asset, and the record that produced it. A placeholder clip shows `rendering` or `render failed` and the render record
 * it waits for instead of an asset.
 */
function timelineLines(state: ProjectState, url: (id: string) => string): string[] {
  const timelines = state.components.timeline.timelines
  if (timelines.length === 0) return ['Timelines: none.']
  const { created_by: createdBy, stale, records } = state.components.proj
  return ['Timelines:', ...timelines.flatMap(timeline => [
    `- ${timeline.id}${timeline.name === '' ? '' : ` "${timeline.name}"`}: ${timeline.clips.length === 0 ? 'no clips' : `${String(timeline.clips.length)} clips`}`,
    ...timeline.clips.map((clip, index) => {
      const range = clip.in_sec === null && clip.out_sec === null ? '' : ` range ${clip.in_sec ?? 0}s-${clip.out_sec ?? 'end'}`
      if (clip.asset === null) {
        const status = records.find(record => record.id === clip.source?.record)?.status
        const progress = status === 'pending' || status === 'running' ? 'rendering' : 'render failed'
        return `  - clip ${String(index + 1)} ${clip.id}: ${progress}, record ${String(clip.source?.record)}${range}`
      }
      const producer = createdBy[clip.asset]
      const from = producer === undefined ? '' : ` from record ${producer}`
      const flag = producer !== undefined && stale[producer] !== undefined ? ' STALE' : ''
      return `  - clip ${String(index + 1)} ${clip.id}: asset ${clip.asset}${from}${range}${flag} ${url(clip.asset)}`
    }),
  ])]
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

/** Each plan once: its latest version, its latest approved version, and the shot count of the latest version. */
function planLines(state: ProjectState): string[] {
  const plans = Object.entries(state.components.plan.plans)
  if (plans.length === 0) return []
  return ['Plans:', ...plans.flatMap(([plan, versions]) => {
    const latest = versions.at(-1)
    if (latest === undefined) return []
    const approved = versions.findLast(version => version.approved_by !== null)
    const title = latest.title === undefined ? '' : ` "${latest.title}"`
    const approval = approved === undefined ? 'not approved yet' : `v${approved.version} approved`
    return [`- ${plan}${title}: latest v${latest.version} (${latest.shots.length} shots), ${approval}`]
  })]
}
