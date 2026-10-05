/**
 * Composer support of the video harness as the `vhComposer` Cordis service:
 * - per-session composer modes (ask before every generation or not; quality or speed), stored in one JSON file;
 * - the approval cards: a generation the agent's ask mode holds back waits here until the user approves or skips it;
 * - an `agent/pre-step` listener that expands the composer's `vh:` references in new user messages into a context
 *   message with the concrete record and asset IDs.
 *
 * Routes (authenticated, below the Connection's `/api` channel):
 * - `GET /api/vh/composer/mode?session=<id>`, `POST /api/vh/composer/mode` `{session, confirm?, speed?}`;
 * - `GET /api/vh/composer/approvals?session=<id>`, `POST /api/vh/composer/approvals` `{session, id?, all?, action}`.
 *
 * @module @video-harness/mentions
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { ComposerApprovalRequest, ComposerChannel, ComposerMode } from '@video-harness/agent'
import type { AssetId, EntityId, ProjectId } from '@video-harness/oplog'
import { parseOutputRef } from '@video-harness/runtime'
import type {} from '@video-harness/tools'
import { expansionBlock, parseVhReferences, type ExpansionSources } from './expand.ts'

export { describeReference, expansionBlock, formatVhReference, parseVhReferences, type ExpansionSources, type VhReference } from './expand.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Composer modes, generation approvals, and `vh:` reference expansion. */
    vhComposer: VhComposer
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'vh-mentions': { kind: 'vh-mentions' } & ContextFormed
  }
}

/** The Fetch route paths. */
export const COMPOSER_ROUTES = {
  mode: '/api/vh/composer/mode',
  approvals: '/api/vh/composer/approvals',
} as const

/** The model name the approval cards show. */
const MODEL_LABEL = 'FastH3 Ref2AV'

/** One reference image or clip of a pending generation, as the card shows it. */
export interface ApprovalReference {
  role: string
  ref: string
  assetId: string | null
  url: string | null
}

/** One generation waiting for the user, as the approvals route returns it. */
export interface PendingApproval {
  id: string
  sessionId: string
  callId: string
  tool: string
  summary: string
  prompt: string
  durationSec: number | null
  model: string
  estimateGpuSeconds: number
  references: ApprovalReference[]
  createdAt: string
}

/** The stored composer choices before a session changes them. */
const DEFAULT_MODE: ComposerMode = { confirm: 'direct', speed: 'quality' }

/** The composer service. */
export default class VhComposer extends Service implements ComposerChannel {
  static inject = ['vhProject', 'vhOpLog', 'vhTools']

  private modes: Record<string, ComposerMode> | null = null
  private readonly pending = new Map<string, PendingApproval & { resolve: (approved: boolean) => void }>()

  constructor(ctx: Context) {
    super(ctx, 'vhComposer')
    ctx.inject(['vhAgent'], (child) => {
      child.effect(() => {
        child.vhAgent.setComposer(this)
        return () => { child.vhAgent.setComposer(null) }
      }, 'vhComposer channel')
    })
    ctx.inject(['connection'], (connected) => {
      for (const route of this.fetchRoutes()) {
        connected.effect(() => {
          const dispose = connected.connection.fetch.register(route)
          return () => { void dispose() }
        }, `vhComposer ${route.path}`)
      }
    })
    ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const context = this.expansionMessage(agent.id, decision.messages)
      return context === null ? decision : { ...decision, messages: [...decision.messages, context] }
    }, { prepend: true })
    ctx.effect(() => () => {
      for (const entry of this.pending.values()) entry.resolve(false)
      this.pending.clear()
    }, 'vhComposer pending approvals')
  }

  /**
   * @param sessionId - a chat session.
   * @returns the session's composer choices.
   */
  mode(sessionId: string): ComposerMode {
    return this.readModes()[sessionId] ?? DEFAULT_MODE
  }

  /**
   * Change a session's composer choices.
   * @param sessionId - a chat session.
   * @param patch - the choices to change.
   * @returns the choices afterwards.
   */
  setMode(sessionId: string, patch: Partial<ComposerMode>): ComposerMode {
    const modes = this.readModes()
    const next = { ...this.mode(sessionId), ...patch }
    modes[sessionId] = next
    const path = modesPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.tmp`, JSON.stringify(modes))
    renameSync(`${path}.tmp`, path)
    return next
  }

  /**
   * Hold a generation until the user approves or skips its card; an aborted turn skips it.
   * @param request - the generation.
   * @returns true when approved.
   */
  requestApproval(request: ComposerApprovalRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const id = randomUUID()
      const settle = (approved: boolean): void => {
        if (!this.pending.delete(id)) return
        request.signal.removeEventListener('abort', onAbort)
        resolve(approved)
      }
      const onAbort = (): void => { settle(false) }
      const duration = request.params['duration_sec']
      this.pending.set(id, {
        id, sessionId: request.sessionId, callId: request.callId, tool: request.tool, summary: request.summary,
        prompt: typeof request.params['prompt'] === 'string' ? request.params['prompt'] : '',
        durationSec: typeof duration === 'number' ? duration : null, model: MODEL_LABEL,
        estimateGpuSeconds: request.estimateGpuSeconds, references: this.referencesOf(request), createdAt: new Date().toISOString(),
        resolve: settle,
      })
      if (request.signal.aborted) settle(false)
      else request.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * @param sessionId - a chat session.
   * @returns the session's waiting generations, oldest first.
   */
  approvals(sessionId: string): PendingApproval[] {
    return [...this.pending.values()].filter(entry => entry.sessionId === sessionId).map(({ resolve: _resolve, ...entry }) => entry)
  }

  /**
   * Answer one card or every card of a session.
   * @param sessionId - a chat session.
   * @param target - one approval ID, or `all`.
   * @param approved - approve or skip.
   * @returns how many cards were answered.
   */
  answer(sessionId: string, target: string, approved: boolean): number {
    const entries = [...this.pending.values()].filter(entry => entry.sessionId === sessionId && (target === 'all' || entry.id === target))
    for (const entry of entries) entry.resolve(approved)
    return entries.length
  }

  /** @returns the Fetch routes. */
  fetchRoutes(): ConnectionFetchRoute[] {
    return [
      {
        path: COMPOSER_ROUTES.mode, methods: ['GET', 'POST'], requestBody: 'buffered',
        fetch: guarded(async (request) => {
          if (request.method === 'GET') return json(this.mode(sessionOf(new URL(request.url).searchParams.get('session'))))
          const body = await bodyOf(request)
          const patch: Partial<ComposerMode> = {}
          if (body['confirm'] === 'ask' || body['confirm'] === 'direct') patch.confirm = body['confirm']
          if (body['speed'] === 'quality' || body['speed'] === 'speed') patch.speed = body['speed']
          return json(this.setMode(sessionOf(body['session']), patch))
        }),
      },
      {
        path: COMPOSER_ROUTES.approvals, methods: ['GET', 'POST'], requestBody: 'buffered',
        fetch: guarded(async (request) => {
          if (request.method === 'GET') return json(this.approvals(sessionOf(new URL(request.url).searchParams.get('session'))))
          const body = await bodyOf(request)
          const target = body['all'] === true ? 'all' : typeof body['id'] === 'string' ? body['id'] : ''
          return json({ answered: this.answer(sessionOf(body['session']), target, body['action'] === 'approve') })
        }),
      },
    ]
  }

  /** The context message for the `vh:` references in this step's user messages, or null when they hold none. */
  private expansionMessage(sessionId: string, messages: readonly UserMessage[]): UserMessage | null {
    const text = messages.filter(message => message.source.kind === 'user')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      .join('\n')
    const block = expansionBlock(text, this.projectFor(sessionId, text), this.sources())
    if (block === null) return null
    return createUserMessage({
      content: [{ type: 'text', text: block }],
      source: { kind: 'vh-mentions', form: 'snapshot', sections: [{ name: 'vh-mentions', text: block }] },
    })
  }

  /** The session's bound project, else the newest project whose records produced a referenced asset. */
  private projectFor(sessionId: string, text: string): ProjectId | null {
    const bound = this.ctx.vhTools.sessionProject(sessionId)
    if (bound !== null) return bound
    const assets = parseVhReferences(text).flatMap(reference => reference.uri.split('/').slice(-1))
    const projects = this.ctx.vhOpLog.listProjects().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const match = projects.find((info) => {
      const producers = this.ctx.vhProject.fold(info.projectId).producers
      return assets.some(asset => producers[brandString<AssetId>(asset)] !== undefined)
    })
    return match?.projectId ?? projects[0]?.projectId ?? null
  }

  /** The runtime reads expansion needs. */
  private sources(): ExpansionSources {
    return {
      fold: projectId => this.ctx.vhProject.fold(projectId),
      op: (projectId, opId) => {
        try {
          return this.ctx.vhOpLog.get(projectId, opId)
        } catch {
          // An unknown record ID is reported in the expansion text, not as a failed step.
          return undefined
        }
      },
    }
  }

  /** The assets a generation's inputs stand for, with their URLs. */
  private referencesOf(request: ComposerApprovalRequest): ApprovalReference[] {
    const projectId = this.ctx.vhTools.sessionProject(request.sessionId)
    return request.inputs.map((input) => {
      const assetId = projectId === null ? null : this.assetOf(projectId, input.ref)
      return {
        role: input.role, ref: input.ref, assetId, url: assetId === null ? null : this.ctx.vhTools.assetUrl(brandString<AssetId>(assetId)),
      }
    })
  }

  /** The asset an input reference stands for: an asset ID, a record output, or an entity version's first image. */
  private assetOf(projectId: ProjectId, ref: string): string | null {
    const output = parseOutputRef(brandString<AssetId>(ref))
    if (output !== null) {
      try {
        return this.ctx.vhOpLog.get(projectId, output.op).outputs[output.index] ?? null
      } catch {
        // A reference to an unknown record has no thumbnail; the card shows the reference text.
        return null
      }
    }
    const at = ref.lastIndexOf('@')
    if (at > 0) {
      const versions = this.ctx.vhProject.fold(projectId).entities[brandString<EntityId>(ref.slice(0, at))] ?? []
      return versions.find(version => String(version.version) === ref.slice(at + 1))?.refs[0] ?? null
    }
    return ref
  }

  private readModes(): Record<string, ComposerMode> {
    if (this.modes !== null) return this.modes
    try {
      this.modes = JSON.parse(readFileSync(modesPath(), 'utf8')) as Record<string, ComposerMode>
    } catch {
      // No file yet, or an unreadable one: every session starts from the default choices.
      this.modes = {}
    }
    return this.modes
  }
}

/** The modes file: `$VH_STATE_ROOT/composer-modes.json`, else under the default state root. */
function modesPath(): string {
  return join(process.env['VH_STATE_ROOT'] ?? join(homedir(), '.local/state/video-harness'), 'composer-modes.json')
}

/** A required session ID from a query or body value. */
function sessionOf(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error('session is required')
  return value
}

/** The JSON object body of a request, or an empty object. */
async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json()
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  } catch {
    // A missing body is reported as a missing field by the route.
    return {}
  }
}

/** A route body whose thrown errors answer 400 with their message. */
function guarded(run: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      return await run(request)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  }
}

/** A JSON response with no caching. */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
