/**
 * The DreamVerse agent integration as the `dvAgentIntegration` Cordis service. It ties the DSH agent loop to the
 * Project service: each agent turn and the human's words that started it are reported to `dvProject`, so the turn's
 * records carry the turn and its request record; the images a user attaches in a chat are imported into the asset
 * pool; the DSH question rule of `plan.approve` and `shot.render` is registered with `dvProject` as its tool call
 * check, and its questions reach the user through the `userQuestions` service when one is mounted; a system-prompt
 * section carries the state of the session's working branch, which the model needs to resolve references. The
 * composer half keeps each session's composer modes, holds ask-first agent calls behind approval cards as
 * `dvProject`'s approval channel, serves the composer routes while a Connection is mounted, and expands the `dv:`
 * mentions of new user messages into record and asset IDs. Drafts belong to the chat session and span turns: this
 * plugin never accepts or discards one.
 *
 * @module @dv/agent-integration
 */
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { Session, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@dv/asset-pool'
import type {} from '@dv/api'
import type { ApprovalChannel, AssetId, PendingApproval, ProjectId, SessionId } from '@dv/project'
import type { Plan } from '@dv/shot-plan'
import {
  ApprovalCards, ComposerModes, composerRoutes, expansionMessage, type ApprovalCard, type ComposerMode,
} from './composer.ts'
import { questionRule, type ConfirmRequest } from './question-rule.ts'
import { renderResolverBlock } from './resolver.ts'

export { COMPOSER_ROUTES, type ApprovalCard, type ApprovalReference, type ComposerMode } from './composer.ts'
export { describeMention, formatMention, parseMentions, type Mention } from './expand.ts'
export type { ConfirmRequest } from './question-rule.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The agent integration: turn wiring, the question rule, the composer, mentions, and the project prompt section. */
    dvAgentIntegration: DvAgentIntegration
  }
}

/** `dvAgentIntegration` plugin configuration. */
export interface Config {
  /** Order of the project section in the system prompt; before the tool SDK section at 5000. */
  promptSectionOrder: number
  /** The option label that approves a confirmation question. */
  approveLabel: string
  /** The option label that declines a confirmation question. */
  declineLabel: string
  /** Estimated GPU seconds a turn may spend on `shot.render` calls before the user must agree. */
  confirmGpuSecondsThreshold: number
  /** The state directory; the composer modes live in `<stateRoot>/composer-modes.json`. */
  stateRoot: string
}

/** Loader validation. */
export const Config: z<Config> = z.object({
  promptSectionOrder: z.number().default(4900),
  approveLabel: z.string().default('Run it'),
  declineLabel: z.string().default('Not now'),
  confirmGpuSecondsThreshold: z.number().default(60),
  stateRoot: z.string().required(),
})

/** The name of the system-prompt section this plugin contributes. */
export const PROMPT_SECTION = 'dv:project'

/** Turn wiring, chat-image import, the question rule, the composer, mentions, and the prompt section. */
export default class DvAgentIntegration extends Service implements ApprovalChannel {
  static inject = ['dvProject', 'dvAssetPool']
  static Config = Config

  /** The agent turn number each live session is in, so a user message is noted on its turn. */
  private readonly turns = new Map<string, number>()
  private readonly modes: ComposerModes
  private readonly cards: ApprovalCards

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'dvAgentIntegration')
    this.modes = new ComposerModes(join(config.stateRoot, 'composer-modes.json'))
    this.cards = new ApprovalCards(ctx)
    ctx.on('session/event', (session: Session, event: SessionEvent) => { this.onSessionEvent(session, event) })
    ctx.effect(() => ctx.dvProject.registerToolCallCheck(questionRule({
      project: ctx.dvProject, planOf: (project, plan) => this.planOf(project, plan),
      confirmGpuSecondsThreshold: config.confirmGpuSecondsThreshold, ask: request => this.confirm(request),
    })), 'dvAgentIntegration question rule')
    ctx.effect(() => ctx.dvProject.registerApprovalChannel(this), 'dvAgentIntegration approval channel')
    ctx.effect(() => () => { this.cards.skipAll() }, 'dvAgentIntegration pending approvals')
    ctx.inject(['systemPrompt'], (child) => {
      child.effect(() => child.systemPrompt.section({
        name: PROMPT_SECTION,
        order: config.promptSectionOrder,
        interpolate: false,
        text: context => this.promptBlock(context.agent?.id),
      }), 'dvAgentIntegration prompt section')
    })
    ctx.inject(['connection'], (connected) => {
      for (const route of this.fetchRoutes()) {
        connected.effect(() => {
          const dispose = connected.connection.fetch.register(route)
          return () => { void dispose() }
        }, `dvAgentIntegration ${route.path}`)
      }
    })
    ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const context = expansionMessage(ctx, agent.id, decision.messages)
      return context === null ? decision : { ...decision, messages: [...decision.messages, context] }
    }, { prepend: true })
  }

  /**
   * @param sessionId - a chat session.
   * @returns the session's composer choices.
   */
  getComposerMode(sessionId: string): ComposerMode {
    return this.modes.get(sessionId)
  }

  /**
   * Change a session's composer choices.
   * @param sessionId - a chat session.
   * @param patch - the choices to change.
   * @returns the choices afterwards.
   */
  updateComposerMode(sessionId: string, patch: Partial<ComposerMode>): ComposerMode {
    return this.modes.set(sessionId, patch)
  }

  /**
   * @param session - a chat session.
   * @returns whether the session's composer asks before the agent's shot renders and plan approvals.
   */
  asksFirst(session: SessionId): boolean {
    return this.getComposerMode(session).confirm === 'ask'
  }

  /**
   * Hold an agent's pending call behind an approval card until the user approves or skips it.
   * @param approval - the pending record and its estimate.
   * @returns true when approved.
   */
  requestApproval(approval: PendingApproval): Promise<boolean> {
    return this.cards.request(approval)
  }

  /**
   * @param sessionId - a chat session.
   * @returns the session's waiting calls, oldest first.
   */
  approvals(sessionId: string): ApprovalCard[] {
    return this.cards.list(sessionId)
  }

  /**
   * Answer one card or every card of a session.
   * @param sessionId - a chat session.
   * @param target - one approval ID, or `all`.
   * @param approved - approve or skip.
   * @returns how many cards were answered.
   */
  answer(sessionId: string, target: string, approved: boolean): number {
    return this.cards.answer(sessionId, target, approved)
  }

  /** @returns the composer Fetch routes. */
  fetchRoutes(): ConnectionFetchRoute[] {
    return composerRoutes(this)
  }

  /** Whether a live root agent's session is in the composer's ask mode, where `dvProject` shows the approval card. */
  private agentAsksFirst(agent: ConfirmRequest['exec']['agent']): boolean {
    const agents = this.ctx.get('agents')
    if (agent === undefined || agents === undefined || !agents.roots().includes(agent)) return false
    return this.getComposerMode(agent.id).confirm === 'ask'
  }

  /**
   * The project block for one session, as the prompt section renders it.
   * @param sessionId - the agent's session ID; undefined on diagnostics assemblies.
   * @returns the block text.
   */
  promptBlock(sessionId: string | undefined): string {
    const projectId = sessionId === undefined ? null : this.ctx.dvProject.sessionProject(brandString<SessionId>(sessionId))
    const url = (id: string): string => this.ctx.dvAssetPool.url(brandString<AssetId>(id))
    if (sessionId === undefined || projectId === null) {
      return renderResolverBlock({ projectId: null, state: null, branch: null, url, selection: null })
    }
    // The session's working branch: its draft when one is open, else the branch it switched to, else main.
    const branch = this.ctx.dvProject.workingBranch(projectId, brandString<SessionId>(sessionId))
    const state = this.ctx.dvProject.getState(projectId, branch.name)
    // What the user last clicked in the canvas or the timeline, when the API plugin is mounted beside this one.
    const selection = this.ctx.get('dvApi')?.selection(projectId) ?? null
    return renderResolverBlock({ projectId, state, branch, url, selection }) + this.preferenceLines(sessionId)
  }

  /** The composer choices of a session as prompt lines. */
  private preferenceLines(sessionId: string): string {
    const mode = this.getComposerMode(sessionId)
    const speed = mode.speed === 'speed'
      ? 'User preference: speed. Prefer the shortest durations and one take per shot.'
      : 'User preference: quality. Prefer careful prompts and longer durations where the shot needs them.'
    const confirm = mode.confirm === 'ask'
      ? ' Every dv_shot_render and dv_plan_approve call waits for the user\'s approval card: call it directly without asking in chat first; the card is the question.'
      : ''
    return `\n${speed}${confirm}`
  }

  /** Report turn starts and the human's words of live sessions to `dvProject`, and import chat images. */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    const agents = this.ctx.get('agents')
    if (agents !== undefined) {
      const agent = agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
    }
    if (event.type === 'turn/start') {
      this.turns.set(session.id, event.data.turn)
      this.ctx.dvProject.noteTurn(brandString<SessionId>(session.id), event.data.turn, '')
      return
    }
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
    // The agent loop appends the user's message after it opened the turn the message starts.
    const turn = this.turns.get(session.id)
    const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (turn !== undefined && text !== '') this.ctx.dvProject.noteTurn(brandString<SessionId>(session.id), turn, text)
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
    this.importChatImages(brandString<SessionId>(sessionId), refs).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      this.ctx.logger('dvAgentIntegration').warn('could not import chat images of session %s as assets: %s', sessionId, reason)
    })
  }

  /**
   * Import chat images as assets of the session's project: one `asset.import` per image by the user, in the chat, on
   * the session's working branch. The session's next tool call waits until the import finished
   * (`dvProject.holdToolCalls`). A session without a project, or a process without an attachment service, imports
   * nothing.
   * @param session - the chat session.
   * @param refs - the image attachments of the user message.
   * @returns the imported asset IDs.
   */
  private importChatImages(session: SessionId, refs: readonly ImageAttachmentRef[]): Promise<AssetId[]> {
    const project = this.ctx.dvProject
    const pool = this.ctx.dvAssetPool
    const projectId = project.sessionProject(session)
    const attachments = this.ctx.get('attachments')
    if (projectId === null || attachments === undefined) return Promise.resolve([])
    const importing = (async () => {
      const ids: AssetId[] = []
      for (const ref of refs) {
        const stored = await attachments.readImage(ref)
        const name = ref.name ?? `image.${ref.mediaType.slice('image/'.length)}`
        const asset = pool.importAsset(stored.data, { mime: ref.mediaType, name }, null)
        const result = await project.run({
          project: projectId, operation: 'asset.import', inputs: [], params: { path: pool.path(asset), mime: ref.mediaType, name },
          actor: 'user', surface: 'chat', session, turn: null, tool_call: null, intent: `import ${name}`,
        })
        ids.push(result.outputs[0] ?? asset)
      }
      return ids
    })()
    project.holdToolCalls(session, importing)
    return importing
  }

  /**
   * The plan a `plan.approve` call names, for the approval question.
   * @param projectId - the project.
   * @param plan - the call's `plan` param.
   * @returns the plan, or null when the Shot plan component is not mounted or the param names no finished plan record.
   */
  private planOf(projectId: ProjectId, plan: unknown): Plan | null {
    try {
      return this.ctx.get('dvShotPlan')?.getPlan(projectId, String(plan)) ?? null
    } catch (error: unknown) {
      // An unknown plan record is refused by the approval's precondition; the question then uses the call's params.
      void error
      return null
    }
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
    if (request.spec.confirm === 'agent_ask_first' && this.agentAsksFirst(request.exec.agent)) return true
    const questions = this.ctx.get('userQuestions')
    const agents = this.ctx.get('agents')
    const agent = request.exec.agent
    if (questions === undefined || agents === undefined || agent === undefined || !agents.roots().includes(agent)) return null
    const cost = request.gpuSeconds > 0 ? ` Estimated GPU time for this turn: about ${Math.round(request.gpuSeconds)} s.` : ''
    try {
      const answer = await questions.ask({
        questions: [{
          id: 'approve', header: 'DreamVerse', question: `${request.summary}.${cost} Run it?`,
          options: [{ label: this.config.approveLabel, description: 'Run the call and record the approval.' }, { label: this.config.declineLabel, description: 'Do not run it.' }],
        }],
        agent, signal: request.exec.signal,
      })
      return answer.answers.some(item => item.id === 'approve' && item.selected.includes(this.config.approveLabel))
    } catch (error: unknown) {
      // The question channel refused (delegated caller, aborted, or no UI): the rule falls back to asking in chat.
      void error
      return null
    }
  }
}
