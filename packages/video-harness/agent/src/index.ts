/**
 * The agent layer of the video harness as the `vhAgent` Cordis service. It ties the DSH agent loop to the Project
 * service: each agent turn and the human's words that started it are reported to the tool bridge, so the turn's
 * records carry the turn and its request record; confirmation questions reach the user through the `userQuestions`
 * service when one is mounted; and a system-prompt section carries the state of the session's working branch, which
 * the model needs to resolve references. Drafts belong to the chat session and span turns: this plugin never accepts
 * or discards one.
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
import type { AssetId, SessionId } from '@dv/project'
import type { ConfirmRequest } from '@video-harness/tools'
import type {} from '@video-harness/views'
import { renderResolverBlock } from './resolver.ts'

export { renderResolverBlock, type ResolverInput } from './resolver.ts'

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

/** The composer plugin's face: per-session modes. Its approval cards reach `dvProject` as the approval channel. */
export interface ComposerChannel {
  /**
   * @param sessionId - a chat session.
   * @returns the session's composer choices.
   */
  mode(sessionId: string): ComposerMode
}

/** Turn wiring, confirmation, and the prompt section over the tool bridge. */
export default class VhAgent extends Service {
  static inject = ['dvProject', 'vhTools']
  static Config = Config

  private composer: ComposerChannel | null = null
  /** The agent turn number each live session is in, so a user message is noted on its turn. */
  private readonly turns = new Map<string, number>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'vhAgent')
    ctx.on('session/event', (session: Session, event: SessionEvent) => { this.onSessionEvent(session, event) })
    ctx.vhTools.setConfirmPolicy(request => this.confirm(request))
    ctx.effect(() => () => { ctx.vhTools.setConfirmPolicy(null) }, 'vhAgent confirm policy')
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

  /** Whether a live root agent's session is in the composer's ask mode, where `dvProject` shows the approval card. */
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
    if (sessionId === undefined || session === undefined || session.projectId === null) {
      return renderResolverBlock({ projectId: null, state: null, branch: null, url, selection: null })
    }
    const projectId = session.projectId
    // The session's working branch: its draft when one is open, else the branch it switched to, else main.
    const branch = this.ctx.dvProject.workingBranch(projectId, brandString<SessionId>(sessionId))
    const state = this.ctx.dvProject.getState(projectId, branch.name)
    // What the user last clicked in the canvas or the timeline, when the views plugin is mounted beside this one.
    const selection = this.ctx.get('vhViews')?.selection(projectId) ?? null
    return renderResolverBlock({ projectId, state, branch, url, selection }) + this.preferenceLines(sessionId)
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

  /** Report turn starts and the human's words of live sessions to the bridge, and import chat images. */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    const agents = this.ctx.get('agents')
    if (agents !== undefined) {
      const agent = agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
    }
    if (event.type === 'turn/start') {
      this.turns.set(session.id, event.data.turn)
      this.ctx.vhTools.noteTurn(session.id, event.data.turn, '')
      return
    }
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
    // The agent loop appends the user's message after it opened the turn the message starts.
    const turn = this.turns.get(session.id)
    const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (turn !== undefined && text !== '') this.ctx.vhTools.noteTurn(session.id, turn, text)
    this.recordChatImages(session.id, event.data)
  }

  /**
   * Import the images a user attached to a chat message as project assets, so the asset pool lists them.
   * @param sessionId - the chat session.
   * @param message - the appended user message, which the user typed.
   */
  private recordChatImages(sessionId: string, message: SessionEventMap['user/message']): void {
    const refs = message.content.flatMap(block => block.type === 'image' ? [block.attachment] : [])
    if (refs.length === 0) return
    this.ctx.vhTools.recordChatImages(sessionId, refs).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      this.ctx.logger('vhAgent').warn('could not import chat images of session %s as assets: %s', sessionId, reason)
    })
  }

  /**
   * Answer a call that needs agreement. In the composer's ask mode an `agent_ask_first` operation runs: `dvProject`
   * holds its record behind the approval card, which is the question. Otherwise ask the user through the questions
   * service when the calling agent is a live root agent, else leave the decision to the argument protocol by answering
   * null.
   * @param request - the call that needs agreement.
   * @returns true to run, false when declined, null when no channel applies.
   */
  async confirm(request: ConfirmRequest): Promise<boolean | null> {
    if (request.spec.confirm === 'agent_ask_first' && this.asksFirst(request.exec.agent)) return true
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
