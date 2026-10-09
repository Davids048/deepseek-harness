/**
 * The DreamVerse chat references as the `dvChatReferences` Cordis service: what a user points at in a chat message
 * reaches the project. The `dv:` mentions of new user messages expand at `agent/pre-step` into a context message with
 * the concrete record and asset IDs, read from the current state of the session's project; the images a user attaches
 * to a chat message are imported into the session's project as assets and put on its canvas, and the `dv:asset`
 * mentions a user sends put those assets on the canvas.
 *
 * @module @dv/chat-references
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import type {} from '@dv/asset-pool'
import type { AssetId, ProjectId, SessionId } from '@dv/project'
import { expansionBlock, parseMentions, type ExpansionSources } from './expand.ts'

export { describeMention, formatMention, parseMentions, type ExpansionSources, type Mention } from './expand.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The chat references: `dv:` mention expansion and chat image import. */
    dvChatReferences: DvChatReferences
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dv-mentions': { kind: 'dv-mentions' } & ContextFormed
  }
}

/** `dv:` mention expansion and chat image import. */
export default class DvChatReferences extends Service {
  static inject = ['dvProject', 'dvAssetPool']

  constructor(ctx: Context) {
    super(ctx, 'dvChatReferences')
    ctx.on('session/event', (session: Session, event: SessionEvent) => { this.onSessionEvent(session, event) })
    ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const context = this.expansionMessage(agent.id, decision.messages)
      return context === null ? decision : { ...decision, messages: [...decision.messages, context] }
    }, { prepend: true })
  }

  /**
   * The context message for the `dv:` mentions in one step's user messages, or null when they hold none.
   * @param sessionId - the chat session.
   * @param messages - the step's new messages.
   * @returns the message.
   */
  expansionMessage(sessionId: string, messages: readonly UserMessage[]): UserMessage | null {
    const text = messages.filter(message => message.source.kind === 'user')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      .join('\n')
    const session = brandString<SessionId>(sessionId)
    const block = expansionBlock(text, this.projectFor(session, text), this.expansionSources())
    if (block === null) return null
    return createUserMessage({
      content: [{ type: 'text', text: block }],
      source: { kind: 'dv-mentions', form: 'snapshot', sections: [{ name: 'dv-mentions', text: block }] },
    })
  }

  /** The session's bound project, else the newest project whose records produced a mentioned asset, else the newest project. */
  private projectFor(session: SessionId, text: string): ProjectId | null {
    const project = this.ctx.dvProject
    const bound = project.sessionProject(session)
    if (bound !== null) return bound
    const assets = parseMentions(text).flatMap(mention => mention.uri.startsWith('dv:asset/')
      ? [brandString<AssetId>(decodeURIComponent(mention.uri.slice('dv:asset/'.length)))]
      : [])
    const projects = project.listProjects().sort((a, b) => b.created_at.localeCompare(a.created_at))
    const match = projects.find((info) => {
      const createdBy = project.getState(info.id).components.proj.created_by
      return assets.some(asset => createdBy[asset] !== undefined)
    })
    return match?.id ?? projects[0]?.id ?? null
  }

  /** The Project reads expansion needs: mentions resolve against the project's current state. */
  private expansionSources(): ExpansionSources {
    const project = this.ctx.dvProject
    return {
      getState: projectId => project.getState(projectId),
      getRecord: (projectId, record) => {
        try {
          return project.getRecord(projectId, record)
        } catch {
          // An unknown record ID is reported in the expansion text, not as a failed step.
          return undefined
        }
      },
    }
  }

  /** Import the images of the messages a user typed in a live session. */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
    const agents = this.ctx.get('agents')
    if (agents !== undefined) {
      const agent = agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
    }
    this.recordChatImages(session.id, event.data)
    this.placeMentionedAssets(brandString<SessionId>(session.id), event.data)
  }

  /**
   * Put the assets a user message mentions (`dv:asset/<id>`) on the canvas of the session's project with one
   * `asset.place` by the user, in the chat. Only assets from a record of the current state and not on the canvas yet count; a
   * message without such a mention, or a session without a project, places nothing.
   * @param session - the chat session.
   * @param message - the appended user message, which the user typed.
   */
  private placeMentionedAssets(session: SessionId, message: SessionEventMap['user/message']): void {
    const project = this.ctx.dvProject
    const projectId = project.sessionProject(session)
    if (projectId === null) return
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const state = project.getState(projectId)
    const placed = new Set(state.components.asset.placed)
    const assets = [...new Set(parseMentions(text).flatMap(mention => mention.uri.startsWith('dv:asset/')
      ? [brandString<AssetId>(decodeURIComponent(mention.uri.slice('dv:asset/'.length)))]
      : []))].filter(asset => asset in state.components.proj.created_by && !placed.has(asset))
    if (assets.length === 0) return
    project.run({
      project: projectId, operation: 'asset.place', params: {}, inputs: assets.map(asset => ({ role: 'asset', ref: { asset } })),
      actor: 'user', surface: 'chat', session, turn: null, tool_call: null, intent: 'place mentioned assets',
    }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      this.ctx.logger('dvChatReferences').warn('could not place the mentioned assets of session %s: %s', session, reason)
    })
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
      this.ctx.logger('dvChatReferences').warn('could not import chat images of session %s as assets: %s', sessionId, reason)
    })
  }

  /**
   * Import chat images as assets of the session's project and put them on its canvas: one `asset.import` with `place`
   * per image by the user, in the chat, at the end of the project's history. The session's next tool call waits until the import finished
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
          project: projectId, operation: 'asset.import', inputs: [], params: { path: pool.path(asset), mime: ref.mediaType, name, place: true },
          actor: 'user', surface: 'chat', session, turn: null, tool_call: null, intent: `import ${name}`,
        })
        ids.push(result.outputs[0] ?? asset)
      }
      return ids
    })()
    project.holdToolCalls(session, importing)
    return importing
  }
}
