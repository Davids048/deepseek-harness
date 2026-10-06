/**
 * The composer half of the agent integration:
 * - per-session composer modes (ask before every render or not; quality or speed), stored in one JSON file;
 * - the approval cards: the pending `agent_ask_first` calls (a shot render or a plan approval) of a session in ask mode,
 *   each held until the user approves or skips its card;
 * - the composer Fetch routes and the context message that expands the `dv:` mentions of new user messages.
 *
 * Routes (authenticated, below the Connection's `/api` channel):
 * - `GET /api/dv/composer/mode?session=<id>`, `POST /api/dv/composer/mode` `{session, confirm?, speed?}`;
 * - `GET /api/dv/composer/approvals?session=<id>`, `POST /api/dv/composer/approvals` `{session, id?, all?, action}`.
 * Every route answers through `@dv/api`'s `answer`, so an error has the `{error, code}` body of the other `/api/dv` routes.
 *
 * @module @dv/agent-integration/composer
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import { answer, ApiRequestError } from '@dv/api'
import {
  formatInputRef, type AssetId, type PendingApproval, type ProjectId, type ProjectRecord, type RecordId, type SessionId,
} from '@dv/project'
import type {} from '@dv/asset-pool'
import type { PlanVersion } from '@dv/shot-plan'
import type { Character, CharacterId, Location, LocationId, Style, StyleId } from '@dv/story-bible'
import { expansionBlock, parseMentions, type ExpansionSources } from './expand.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dv-mentions': { kind: 'dv-mentions' } & ContextFormed
  }
}

/** The Fetch route paths of the composer. */
export const COMPOSER_ROUTES = {
  mode: '/api/dv/composer/mode',
  approvals: '/api/dv/composer/approvals',
} as const

/** The shot duration a plan card assumes for a shot that names none. */
const PLAN_SHOT_SECONDS = 5

/** The two composer choices of a chat session: ask before every render or not, and quality or speed. */
export interface ComposerMode {
  confirm: 'ask' | 'direct'
  speed: 'quality' | 'speed'
}

/** The stored composer choices before a session changes them. */
const DEFAULT_MODE: ComposerMode = { confirm: 'direct', speed: 'quality' }

/** One reference image or video of a pending call, as the card shows it. */
export interface ApprovalReference {
  role: string
  /** The reference text: `<asset>`, `<record>#<output>`, or `<id>@<version>`. */
  ref: string
  /** The asset the reference stands for, when known. */
  asset: AssetId | null
  url: string | null
}

/** One agent call waiting for the user, as the approvals route returns it. */
export interface ApprovalCard {
  id: string
  session: string
  tool_call: string
  /** The operation name of the pending record. */
  operation: string
  /** The pending record's intent. */
  summary: string
  prompt: string
  duration_sec: number | null
  gpu_seconds: number
  references: ApprovalReference[]
  /** ISO-8601 UTC of the request. */
  created_at: string
}

/** One reference of a pending call before its asset is looked up: the role, the reference text, and the known asset. */
interface CardInput {
  role: string
  ref: string
  asset: AssetId | null
}

/** The per-session composer choices, stored in one JSON file and cached after the first read. */
export class ComposerModes {
  private modes: Record<string, ComposerMode> | null = null

  constructor(private readonly path: string) {}

  /**
   * @param session - a chat session.
   * @returns the session's composer choices.
   */
  get(session: string): ComposerMode {
    return this.read()[session] ?? DEFAULT_MODE
  }

  /**
   * Change a session's composer choices and write the file atomically.
   * @param session - a chat session.
   * @param patch - the choices to change.
   * @returns the choices afterwards.
   */
  set(session: string, patch: Partial<ComposerMode>): ComposerMode {
    const modes = this.read()
    const next = { ...this.get(session), ...patch }
    modes[session] = next
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(`${this.path}.tmp`, JSON.stringify(modes))
    renameSync(`${this.path}.tmp`, this.path)
    return next
  }

  private read(): Record<string, ComposerMode> {
    if (this.modes !== null) return this.modes
    try {
      this.modes = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, ComposerMode>
    } catch {
      // No file yet, or an unreadable one: every session starts from the default choices.
      this.modes = {}
    }
    return this.modes
  }
}

/** The pending approval cards: each holds an agent's `agent_ask_first` call until the user answers it. */
export class ApprovalCards {
  private readonly pending = new Map<string, ApprovalCard & { resolve: (approved: boolean) => void }>()

  constructor(private readonly ctx: Context) {}

  /**
   * Hold an agent's pending call until the user approves or skips its card; an aborted turn skips it. A plan approval's
   * card shows the shots of the approved version that render, their total duration and references, and their GPU
   * estimate.
   * @param approval - the pending record and its estimate.
   * @returns true when approved.
   */
  request(approval: PendingApproval): Promise<boolean> {
    const { record, signal } = approval
    const plan = record.operation === 'plan.approve' ? this.planCard(approval.project, record) : null
    const params = plan?.params ?? record.params
    const inputs: CardInput[] = plan?.inputs ?? record.inputs.map(input => ({
      role: input.role, ref: formatInputRef(input.ref), asset: input.resolved_asset ?? ('asset' in input.ref ? input.ref.asset : null),
    }))
    return new Promise((resolve) => {
      const id = randomUUID()
      const settle = (approved: boolean): void => {
        if (!this.pending.delete(id)) return
        signal.removeEventListener('abort', onAbort)
        resolve(approved)
      }
      const onAbort = (): void => { settle(false) }
      const duration = params['duration_sec']
      this.pending.set(id, {
        id, session: record.session ?? '', tool_call: record.tool_call ?? '', operation: record.operation ?? '',
        summary: record.intent,
        prompt: typeof params['prompt'] === 'string' ? params['prompt'] : '',
        duration_sec: typeof duration === 'number' ? duration : null,
        gpu_seconds: plan?.estimate ?? approval.gpu_seconds, references: this.referencesOf(approval.project, inputs),
        created_at: new Date().toISOString(), resolve: settle,
      })
      if (signal.aborted) settle(false)
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * @param session - a chat session.
   * @returns the session's waiting calls, oldest first.
   */
  list(session: string): ApprovalCard[] {
    return [...this.pending.values()].filter(entry => entry.session === session).map(({ resolve: _resolve, ...entry }) => entry)
  }

  /**
   * Answer one card or every card of a session.
   * @param session - a chat session.
   * @param target - one approval ID, or `all`.
   * @param approved - approve or skip.
   * @returns how many cards were answered.
   */
  answer(session: string, target: string, approved: boolean): number {
    const entries = [...this.pending.values()].filter(entry => entry.session === session && (target === 'all' || entry.id === target))
    for (const entry of entries) entry.resolve(approved)
    return entries.length
  }

  /** Skip every pending card, when the plugin unloads. */
  skipAll(): void {
    for (const entry of this.pending.values()) entry.resolve(false)
    this.pending.clear()
  }

  /**
   * What a plan approval's card shows: one line per new or changed shot of the approved version as the prompt, numbered
   * by its shot position (shots that keep their takes are left out), their total duration and references, and the
   * estimate of rendering them.
   * @param projectId - the project.
   * @param record - the pending `plan.approve` record.
   * @returns the card fields, or null when the Shot plan component is not mounted or the record names no known plan
   *   version.
   */
  private planCard(
    projectId: ProjectId, record: ProjectRecord,
  ): { params: Record<string, unknown>; inputs: CardInput[]; estimate: number } | null {
    const shotPlan = this.ctx.get('dvShotPlan')
    if (shotPlan === undefined) return null
    const plan = String(record.params['plan'])
    const requested = typeof record.params['version'] === 'number' ? record.params['version'] : undefined
    let document: PlanVersion
    let render: number[]
    try {
      const state = this.ctx.dvProject.getState(projectId, record.branch)
      document = shotPlan.getPlan(state, plan, requested)
      render = shotPlan.shotsToRender(state, plan, requested)
    } catch {
      // An unreadable plan leaves the card with the record's own params; the call fails when it runs.
      return null
    }
    const shots = render.flatMap((position) => {
      const shot = document.shots[position - 1]
      return shot === undefined ? [] : [{ position, shot }]
    })
    const seconds = shots.map(entry => entry.shot.duration_sec ?? PLAN_SHOT_SECONDS)
    const total = seconds.reduce((sum, value) => sum + value, 0)
    const references = [...new Set(shots.flatMap(entry => entry.shot.references ?? document.references ?? []))]
    const renderSpec = this.ctx.dvProject.listOperations().find(spec => spec.name === 'shot.render')
    return {
      params: {
        prompt: shots.map((entry, index) => `${entry.position}. ${entry.shot.prompt} (${seconds[index]} s)`).join('\n'), duration_sec: total,
      },
      inputs: references.map(ref => ({ role: 'reference', ref, asset: null })),
      estimate: renderSpec?.estimate?.({ duration_sec: total }).gpu_seconds ?? 0,
    }
  }

  /** The assets a pending call's inputs stand for, with their URLs. */
  private referencesOf(projectId: ProjectId, inputs: readonly CardInput[]): ApprovalReference[] {
    return inputs.map((input) => {
      const asset = input.asset ?? this.assetOf(projectId, input.ref)
      return { role: input.role, ref: input.ref, asset, url: asset === null ? null : this.ctx.dvAssetPool.url(asset) }
    })
  }

  /** The asset a reference text stands for: an asset ID, a record output, or a character, location, or style version's first image. */
  private assetOf(projectId: ProjectId, ref: string): AssetId | null {
    const hash = ref.lastIndexOf('#')
    const output = hash > 0 ? Number(ref.slice(hash + 1)) : Number.NaN
    if (Number.isInteger(output)) {
      try {
        return this.ctx.dvProject.getRecord(projectId, brandString<RecordId>(ref.slice(0, hash))).outputs[output] ?? null
      } catch {
        // A reference to an unknown record has no thumbnail; the card shows the reference text.
        return null
      }
    }
    const at = ref.lastIndexOf('@')
    if (at > 0) {
      const { characters, locations, styles } = this.ctx.dvProject.getState(projectId).components.bible
      const id = ref.slice(0, at)
      const versions: ReadonlyArray<Character | Location | Style> = characters[brandString<CharacterId>(id)]
        ?? locations[brandString<LocationId>(id)] ?? styles[brandString<StyleId>(id)] ?? []
      return versions.find(version => String(version.version) === ref.slice(at + 1))?.references[0] ?? null
    }
    return brandString<AssetId>(ref)
  }
}

/** What the composer routes read and change. */
export interface ComposerRouteTarget {
  getComposerMode(session: string): ComposerMode
  updateComposerMode(session: string, patch: Partial<ComposerMode>): ComposerMode
  approvals(session: string): ApprovalCard[]
  answer(session: string, target: string, approved: boolean): number
}

/**
 * The composer Fetch routes.
 * @param target - the modes and the approval cards.
 * @returns the routes.
 */
export function composerRoutes(target: ComposerRouteTarget): ConnectionFetchRoute[] {
  const query = (request: Request): string | null => new URL(request.url).searchParams.get('session')
  return [
    {
      path: COMPOSER_ROUTES.mode, methods: ['GET', 'POST'], requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') return answer(() => target.getComposerMode(sessionOf(query(request))))
        const body = await bodyOf(request)
        return answer(() => {
          const patch: Partial<ComposerMode> = {}
          if (body['confirm'] === 'ask' || body['confirm'] === 'direct') patch.confirm = body['confirm']
          if (body['speed'] === 'quality' || body['speed'] === 'speed') patch.speed = body['speed']
          return target.updateComposerMode(sessionOf(body['session']), patch)
        })
      },
    },
    {
      path: COMPOSER_ROUTES.approvals, methods: ['GET', 'POST'], requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') return answer(() => target.approvals(sessionOf(query(request))))
        const body = await bodyOf(request)
        const card = body['all'] === true ? 'all' : typeof body['id'] === 'string' ? body['id'] : ''
        return answer(() => ({ answered: target.answer(sessionOf(body['session']), card, body['action'] === 'approve') }))
      },
    },
  ]
}

/**
 * The context message for the `dv:` mentions in one step's user messages, or null when they hold none.
 * @param ctx - the plugin context, for the Project reads.
 * @param sessionId - the chat session.
 * @param messages - the step's new messages.
 * @returns the message.
 */
export function expansionMessage(ctx: Context, sessionId: string, messages: readonly UserMessage[]): UserMessage | null {
  const text = messages.filter(message => message.source.kind === 'user')
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    .join('\n')
  const block = expansionBlock(text, projectFor(ctx, sessionId, text), expansionSources(ctx, brandString<SessionId>(sessionId)))
  if (block === null) return null
  return createUserMessage({
    content: [{ type: 'text', text: block }],
    source: { kind: 'dv-mentions', form: 'snapshot', sections: [{ name: 'dv-mentions', text: block }] },
  })
}

/** The session's bound project, else the newest project whose records produced a mentioned asset, else the newest project. */
function projectFor(ctx: Context, sessionId: string, text: string): ProjectId | null {
  const bound = ctx.dvProject.sessionProject(brandString<SessionId>(sessionId))
  if (bound !== null) return bound
  const assets = parseMentions(text).flatMap(mention => mention.uri.startsWith('dv:asset/')
    ? [brandString<AssetId>(decodeURIComponent(mention.uri.slice('dv:asset/'.length)))]
    : [])
  const projects = ctx.dvProject.listProjects().sort((a, b) => b.created_at.localeCompare(a.created_at))
  const match = projects.find((info) => {
    const createdBy = ctx.dvProject.getState(info.id).components.proj.created_by
    return assets.some(asset => createdBy[asset] !== undefined)
  })
  return match?.id ?? projects[0]?.id ?? null
}

/** The Project reads expansion needs: mentions resolve against the session's working branch. */
function expansionSources(ctx: Context, session: SessionId): ExpansionSources {
  return {
    getState: projectId => ctx.dvProject.getState(projectId, ctx.dvProject.workingBranch(projectId, session).name),
    getRecord: (projectId, record) => {
      try {
        return ctx.dvProject.getRecord(projectId, record)
      } catch {
        // An unknown record ID is reported in the expansion text, not as a failed step.
        return undefined
      }
    },
  }
}

/**
 * A required session ID from a query or body value.
 * @throws ApiRequestError `invalid_params` when the value is missing or empty.
 */
function sessionOf(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new ApiRequestError(400, "'session' must name a chat session.", 'invalid_params')
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
