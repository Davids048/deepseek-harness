/**
 * The agent layer of the video harness as the `vhAgent` Cordis service. It ties the DSH agent loop to the project
 * runtime: each agent-loop turn is reported to the tool bridge so its records land on one draft, a draft is settled
 * when the turn ends, confirmation questions reach the user through the `userQuestions` service when one is mounted,
 * and a system-prompt section carries the project state the model needs to resolve references.
 *
 * @module @video-harness/agent
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { AssetId } from '@video-harness/oplog'
import { GENERATE_VIDEO_TOOL, PLAN_APPROVE_TOOL } from '@video-harness/runtime'
import type { ConfirmRequest, SessionState, TurnSettlement } from '@video-harness/tools'
import type {} from '@video-harness/views'
import { renderResolverBlock, sessionBranch } from './resolver.ts'

export { renderResolverBlock, sessionBranch, type ResolverInput } from './resolver.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The agent layer: turn wiring, confirmation channel, and the project prompt section. */
    vhAgent: VhAgent
  }
}

/** `vhAgent` plugin configuration. */
export interface Config {
  /** Order of the project section in the system prompt; before the tool SDK section at 5000. */
  promptSectionOrder: number
  /** The option label that approves a confirmation question. */
  approveLabel: string
  /** The option label that declines a confirmation question. */
  declineLabel: string
}

/** Loader validation. */
export const Config: z<Config> = z.object({
  promptSectionOrder: z.number().default(4900),
  approveLabel: z.string().default('Run it'),
  declineLabel: z.string().default('Not now'),
})

/** The name of the system-prompt section this plugin contributes. */
export const PROMPT_SECTION = 'video-harness:project'

/** The two composer choices of a chat session: ask before every generation or not, and quality or speed. */
export interface ComposerMode {
  confirm: 'ask' | 'direct'
  speed: 'quality' | 'speed'
}

/** One generation that waits for the user's approval card. */
export interface ComposerApprovalRequest {
  sessionId: string
  callId: string
  tool: string
  summary: string
  estimateGpuSeconds: number
  params: Record<string, unknown>
  inputs: Array<{ role: string; ref: string }>
  signal: AbortSignal
}

/** The composer plugin's face: per-session modes and the approval cards. */
export interface ComposerChannel {
  /**
   * @param sessionId - a chat session.
   * @returns the session's composer choices.
   */
  mode(sessionId: string): ComposerMode
  /**
   * Show an approval card and wait for the user's answer.
   * @param request - the generation.
   * @returns true when approved, false when skipped or aborted.
   */
  requestApproval(request: ComposerApprovalRequest): Promise<boolean>
}

/** The tools that start video generation, which the composer's ask mode puts behind an approval card. */
const GATED_TOOLS: ReadonlySet<string> = new Set([GENERATE_VIDEO_TOOL, PLAN_APPROVE_TOOL])

/** Turn-end reasons that stop the agent before it finished: the draft keeps its records and waits for the user. */
const INTERRUPTED_REASONS: ReadonlySet<string> = new Set(['blocked', 'max-tokens', 'interrupted', 'forked'])

/** Turn wiring, confirmation, and the prompt section over the tool bridge. */
export default class VhAgent extends Service {
  static inject = ['vhProject', 'vhTools']
  static Config = Config

  /** How each settled turn ended, by session, for tests and diagnostics. */
  readonly settled: Array<{ session: string; turn: number; outcome: TurnSettlement }> = []
  private composer: ComposerChannel | null = null

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'vhAgent')
    ctx.on('session/event', (session: Session, event: SessionEvent) => { this.onSessionEvent(session, event) })
    ctx.vhTools.setConfirmPolicy(request => this.confirm(request))
    ctx.effect(() => () => { ctx.vhTools.setConfirmPolicy(null) }, 'vhAgent confirm policy')
    // In the composer's ask mode every video generation of a root agent waits for an approval card, including the
    // shots an approved plan schedules: the plan approval itself asks once for all of them.
    ctx.vhTools.setConfirmGate((spec, exec) => GATED_TOOLS.has(spec.name) && this.asksFirst(exec.agent))
    ctx.effect(() => () => { ctx.vhTools.setConfirmGate(null) }, 'vhAgent confirm gate')
    ctx.inject(['systemPrompt'], (child) => {
      child.effect(() => child.systemPrompt.section({
        name: PROMPT_SECTION,
        order: config.promptSectionOrder,
        interpolate: false,
        text: context => this.promptBlock(context.agent?.id),
      }), 'vhAgent prompt section')
    })
  }

  /**
   * Install or remove the composer channel.
   * @param channel - the composer plugin's face; null when it unloads.
   */
  setComposer(channel: ComposerChannel | null): void {
    this.composer = channel
  }

  /** Whether a live root agent's session is in the composer's ask mode. */
  private asksFirst(agent: ConfirmRequest['exec']['agent']): boolean {
    const agents = this.ctx.get('agents')
    if (this.composer === null || agent === undefined || agents === undefined || !agents.roots().includes(agent)) return false
    return this.composer.mode(agent.id).confirm === 'ask'
  }

  /**
   * The project block for one session, as the prompt section renders it.
   * @param sessionId - the agent's session ID; undefined on diagnostics assemblies.
   * @returns the block text.
   */
  promptBlock(sessionId: string | undefined): string {
    const tools = this.ctx.vhTools
    const session = sessionId === undefined ? undefined : tools.sessionState(sessionId)
    const url = (id: string): string => tools.assetUrl(brandString<AssetId>(id))
    if (session === undefined) return renderResolverBlock({ session: emptySession(), projectId: null, state: null, branch: 'main', openDraft: false, draftFromEarlierTurn: false, url, selection: null })
    const preference = sessionId === undefined ? '' : this.preferenceLines(sessionId)
    const projectId = session.projectId
    const open = session.turn === null ? undefined : this.ctx.vhProject.openTurn(session.turn)
    const branch = sessionBranch(session, open?.branch)
    const state = projectId === null ? null : this.ctx.vhProject.fold(projectId, branch)
    const openDraft = open !== undefined && open.draft
    const draftFromEarlierTurn = openDraft && session.dshTurn !== null && session.turnOpenedAt !== null
      && session.turnOpenedAt !== session.dshTurn
    // What the user last clicked in the canvas or the timeline, when the views plugin is mounted beside this one.
    const selection = projectId === null ? null : this.ctx.get('vhViews')?.selection(projectId) ?? null
    return renderResolverBlock({ session, projectId, state, branch, openDraft, draftFromEarlierTurn, url, selection }) + preference
  }

  /** The composer choices of a session as prompt lines, or nothing without a composer. */
  private preferenceLines(sessionId: string): string {
    if (this.composer === null) return ''
    const mode = this.composer.mode(sessionId)
    const speed = mode.speed === 'speed'
      ? 'User preference: speed. Prefer the shortest durations and one take per shot.'
      : 'User preference: quality. Prefer careful prompts and longer durations where the shot needs them.'
    const confirm = mode.confirm === 'ask'
      ? ' Every vh_generate_video and vh_plan_approve call waits for the user\'s approval card: call it directly without asking in chat first; the card is the question.'
      : ''
    return `\n${speed}${confirm}`
  }

  /** Route turn boundaries of live sessions to the bridge. */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    const agents = this.ctx.get('agents')
    if (agents !== undefined) {
      const agent = agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
    }
    if (event.type === 'user/message') {
      this.recordChatImages(session.id, event.data)
      return
    }
    if (event.type === 'turn/start') {
      this.ctx.vhTools.noteTurn(session.id, event.data.turn)
      return
    }
    if (event.type !== 'turn/end') return
    const kind = event.data.reason.kind
    const outcome = this.ctx.vhTools.settleTurn(session.id, kind === 'completed' ? 'completed' : INTERRUPTED_REASONS.has(kind) ? 'interrupted' : 'aborted')
    this.settled.push({ session: session.id, turn: event.data.turn, outcome })
  }

  /**
   * Record the images a user attached to a chat message as project assets, so the assets panel lists them.
   * @param sessionId - the chat session.
   * @param message - the appended user message; only messages the user typed count.
   */
  private recordChatImages(sessionId: string, message: SessionEventMap['user/message']): void {
    if (message.source.kind !== 'user') return
    const refs = message.content.flatMap(block => block.type === 'image' ? [block.attachment] : [])
    if (refs.length === 0) return
    this.ctx.vhTools.recordChatImages(sessionId, refs).catch((error: unknown) => {
      this.ctx.logger('vhAgent').warn('could not record chat images of session %s as assets: %s', sessionId, error instanceof Error ? error.message : String(error))
    })
  }

  /**
   * Ask the user through the questions service when the calling agent is a live root agent; otherwise leave the
   * decision to the argument protocol by answering null.
   * @param request - the call that needs agreement.
   * @returns true to run, false when declined, null when no channel applies.
   */
  async confirm(request: ConfirmRequest): Promise<boolean | null> {
    if (request.forced === true && this.composer !== null && request.exec.agent !== undefined) {
      return this.composer.requestApproval({
        sessionId: request.exec.agent.id, callId: request.exec.callId, tool: request.spec.name, summary: request.summary,
        estimateGpuSeconds: request.estimateGpuSeconds, params: request.params ?? {},
        inputs: (request.inputs ?? []).map(input => ({ role: input.role, ref: input.ref })), signal: request.exec.signal,
      })
    }
    const questions = this.ctx.get('userQuestions')
    const agents = this.ctx.get('agents')
    const agent = request.exec.agent
    if (questions === undefined || agents === undefined || agent === undefined || !agents.roots().includes(agent)) return null
    const cost = request.estimateGpuSeconds > 0 ? ` Estimated GPU time for this turn: about ${Math.round(request.estimateGpuSeconds)} s.` : ''
    try {
      const answer = await questions.ask({
        questions: [{
          id: 'approve', header: 'Video harness', question: `${request.summary}.${cost} Run it?`,
          options: [{ label: this.config.approveLabel, description: 'Run the call and record the approval.' }, { label: this.config.declineLabel, description: 'Do not run it.' }],
        }],
        agent, signal: request.exec.signal,
      })
      return answer.answers.some(item => item.id === 'approve' && item.selected.includes(this.config.approveLabel))
    } catch (error: unknown) {
      // The question channel refused (delegated caller, aborted, or no UI): the bridge falls back to asking in chat.
      void error
      return null
    }
  }
}

/** The state of a session that never called a tool. */
function emptySession(): SessionState {
  return { projectId: null, turn: null, turnProject: null, branch: null, dshTurn: null, turnOpenedAt: null }
}
