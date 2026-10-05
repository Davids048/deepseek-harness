/**
 * Tool sessions and asset uploads for the Tool mode and the assets panel. A Tool session is a named series of direct
 * generations in one project; its list lives in one JSON file per project under `$VH_STATE_ROOT/tool-sessions`, beside
 * the canvas layout files, and never enters the operation log. Each generation is a `generate.video` record with actor
 * `user`, surface `tool`, and `params.tool_session` set to the session ID, so the session's results and the assets
 * folder named after the session are both read back from the log.
 *
 * Routes (all JSON unless stated):
 * - `GET /api/vh/tool-sessions?project=<id>` lists the sessions, newest first.
 * - `POST /api/vh/tool-sessions` with `{project, title?}` returns the project's newest empty session (one without
 *   generation records), else creates a session; a reused session keeps its title.
 * - `POST /api/vh/tool-sessions/rename` with `{project, session, title}` renames one.
 * - `POST /api/vh/tool-sessions/delete` with `{project, session}` removes one from the list; its generation records and
 *   their assets stay in the log.
 * - `GET /api/vh/tool-sessions/results?project=<id>&session=<id>` lists the session's generation records, newest first.
 * - `POST /api/vh/tool-sessions/generate` with `{project, session, prompt, references?, duration_sec?, seed?}` schedules
 *   one generation and returns the pending record.
 * - `GET /api/vh/tool-sessions/capabilities` returns the served model's name, duration range, and reference limit.
 * - `POST /api/vh/assets/upload?project=<id>&name=<name>&mime=<type>` takes the raw file bytes as the body, stores them,
 *   and records an `asset.upload` user turn with surface `canvas`.
 *
 * @module @video-harness/views/tool-sessions
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type VhAssets from '@video-harness/assets'
import type { AssetId } from '@video-harness/assets'
import type VhOpLog from '@video-harness/oplog'
import type { Op, ProjectId } from '@video-harness/oplog'
import type VhProject from '@video-harness/runtime'
import type { InvokeRequest } from '@video-harness/runtime'
import { projectIdOf } from './wire.ts'

/** The Fetch route paths. */
export const TOOL_SESSION_ROUTES = {
  sessions: '/api/vh/tool-sessions',
  rename: '/api/vh/tool-sessions/rename',
  delete: '/api/vh/tool-sessions/delete',
  results: '/api/vh/tool-sessions/results',
  generate: '/api/vh/tool-sessions/generate',
  capabilities: '/api/vh/tool-sessions/capabilities',
  upload: '/api/vh/assets/upload',
} as const

/** The tool a Tool session runs. */
const GENERATE_TOOL = 'generate.video'

/** One Tool session of a project. */
export interface ToolSession {
  id: string
  title: string
  createdAt: string
}

/** What the Tool mode needs to know about the served model. */
export interface ToolCapabilities {
  available: boolean
  modelName: string
  minDurationSec: number
  maxDurationSec: number
  /** The most reference images one Tool generation accepts. */
  maxReferences: number
}

/** The model facts the capabilities route reads; a structural subset of the generation client's facts. */
export interface ToolModelFacts {
  name: string
  minSegmentDurationSec: number
  maxSegmentDurationSec: number
  maxReferenceImages: number
}

/** The services the routes read and write. */
export interface ToolSessionServices {
  project: VhProject
  log: VhOpLog
  assets: VhAssets
  /** Reads the served model's facts, or returns null while no generation backend is mounted. */
  model: () => Promise<ToolModelFacts> | null
}

/** A request the routes refuse, with its status. */
export class ToolSessionRequestError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message)
    this.name = 'ToolSessionRequestError'
  }
}

/** The session lists of every project, one JSON file per project. */
export class ToolSessionStore {
  constructor(private readonly root: string) {}

  /**
   * @param projectId - a project.
   * @returns the project's sessions in creation order.
   */
  list(projectId: ProjectId): ToolSession[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path(projectId), 'utf8'))
      if (!Array.isArray(raw)) return []
      return raw.filter((row): row is ToolSession => typeof row === 'object' && row !== null
        && typeof (row as ToolSession).id === 'string' && typeof (row as ToolSession).title === 'string' && typeof (row as ToolSession).createdAt === 'string')
    } catch {
      // No file yet, or a file this version cannot read: the project has no sessions.
      return []
    }
  }

  /**
   * Add a session.
   * @param projectId - a project.
   * @param title - the display title; empty picks "Tool 会话 N", N counting from the session count up to the first free title. Clients
   *   show that default title in the interface language.
   * @returns the created session.
   */
  create(projectId: ProjectId, title: string): ToolSession {
    const sessions = this.list(projectId)
    const titles = new Set(sessions.map(row => row.title))
    let number = sessions.length + 1
    while (titles.has(`Tool 会话 ${String(number)}`)) number += 1
    const session: ToolSession = {
      id: `ts-${randomUUID().slice(0, 8)}`,
      title: title.length > 0 ? title : `Tool 会话 ${String(number)}`,
      createdAt: new Date().toISOString(),
    }
    this.write(projectId, [...sessions, session])
    return session
  }

  /**
   * Change a session's title.
   * @param projectId - a project.
   * @param id - the session.
   * @param title - the title.
   * @returns the renamed session.
   * @throws ToolSessionRequestError when the session does not exist.
   */
  rename(projectId: ProjectId, id: string, title: string): ToolSession {
    const sessions = this.list(projectId)
    const target = sessions.find(row => row.id === id)
    if (target === undefined) throw new ToolSessionRequestError(404, `Unknown Tool session '${id}'.`)
    target.title = title
    this.write(projectId, sessions)
    return target
  }

  /**
   * Remove a session from the list.
   * @param projectId - a project.
   * @param id - the session.
   * @throws ToolSessionRequestError when the session does not exist.
   */
  delete(projectId: ProjectId, id: string): void {
    const sessions = this.list(projectId)
    if (!sessions.some(row => row.id === id)) throw new ToolSessionRequestError(404, `Unknown Tool session '${id}'.`)
    this.write(projectId, sessions.filter(row => row.id !== id))
  }

  /**
   * @param projectId - a project.
   * @param id - a session ID.
   * @returns the session.
   * @throws ToolSessionRequestError when the session does not exist.
   */
  require(projectId: ProjectId, id: string): ToolSession {
    const session = this.list(projectId).find(row => row.id === id)
    if (session === undefined) throw new ToolSessionRequestError(404, `Unknown Tool session '${id}'.`)
    return session
  }

  private write(projectId: ProjectId, sessions: ToolSession[]): void {
    mkdirSync(this.root, { recursive: true })
    const target = this.path(projectId)
    writeFileSync(`${target}.tmp`, JSON.stringify(sessions))
    renameSync(`${target}.tmp`, target)
  }

  private path(projectId: ProjectId): string {
    return join(this.root, `${projectId}.json`)
  }
}

/**
 * The directory that holds Tool session files: `$VH_STATE_ROOT/tool-sessions`, else the default state root's.
 * @returns the directory.
 */
export function toolSessionRoot(): string {
  const stateRoot = process.env['VH_STATE_ROOT'] ?? join(homedir(), '.local/state/video-harness')
  return join(stateRoot, 'tool-sessions')
}

/**
 * A JSON response with no caching.
 * @param value - the body.
 * @param status - the HTTP status.
 * @returns the response.
 */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

/**
 * @param value - a raw JSON value.
 * @returns the value when it is a plain object, else an empty object.
 */
function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * @param value - a raw value.
 * @param field - the field name for the error.
 * @returns the non-empty string.
 * @throws ToolSessionRequestError when the value is not a non-empty string.
 */
function stringOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ToolSessionRequestError(400, `'${field}' must be a non-empty string.`)
  return value.trim()
}

/**
 * The Tool session and asset-upload Fetch routes.
 * @param services - the runtime, the log, the asset store, and the model-facts reader.
 * @param store - the session files; defaults to {@link toolSessionRoot}.
 * @returns the routes.
 */
export function toolSessionRoutes(
  services: ToolSessionServices,
  store: ToolSessionStore = new ToolSessionStore(toolSessionRoot()),
): ConnectionFetchRoute[] {
  const projectOf = (value: unknown): ProjectId => {
    const projectId = projectIdOf(value)
    if (projectId === null) throw new ToolSessionRequestError(400, "'project' must name a project.")
    try {
      services.log.project(projectId)
    } catch {
      // The log throws for an unknown project; the routes report it as 404.
      throw new ToolSessionRequestError(404, `Unknown project '${projectId}'.`)
    }
    return projectId
  }
  const query = (request: Request, name: string): string | null => new URL(request.url).searchParams.get(name)
  const handle = (run: (request: Request) => unknown) => async (request: Request): Promise<Response> => {
    try {
      return json(await run(request))
    } catch (error) {
      if (error instanceof ToolSessionRequestError) return json({ error: error.message }, error.status)
      return json({ error: error instanceof Error ? error.message : String(error) }, 500)
    }
  }
  const bodyOf = async (request: Request): Promise<Record<string, unknown>> => objectOf(await request.json().catch(() => ({})))

  /** One accepted user turn on `main` around one record. */
  const userTurn = async (projectId: ProjectId, surface: Op['surface'], intent: string, write: (turn: InvokeRequest['turn']) => Op | Promise<Op>): Promise<Op> => {
    const open = services.project.beginTurn(projectId, { actor: 'user', surface, intent })
    try {
      return await write(open.turn)
    } finally {
      services.project.acceptTurn(projectId, open.turn, { actor: 'user', surface })
    }
  }

  return [
    {
      path: TOOL_SESSION_ROUTES.sessions, methods: ['GET', 'POST'], requestBody: 'buffered',
      fetch: handle(async (request) => {
        if (request.method === 'GET') return store.list(projectOf(query(request, 'project'))).reverse()
        const body = await bodyOf(request)
        const projectId = projectOf(body['project'])
        // Reuse an empty session so repeated "新建 Tool 会话" clicks do not pile up empty sessions.
        const used = new Set(services.log.all(projectId).filter(op => op.surface === 'tool').map(op => op.params['tool_session']))
        const empty = store.list(projectId).reverse().find(session => !used.has(session.id))
        return empty ?? store.create(projectId, typeof body['title'] === 'string' ? body['title'].trim() : '')
      }),
    },
    {
      path: TOOL_SESSION_ROUTES.rename, methods: ['POST'], requestBody: 'buffered',
      fetch: handle(async (request) => {
        const body = await bodyOf(request)
        return store.rename(projectOf(body['project']), stringOf(body['session'], 'session'), stringOf(body['title'], 'title'))
      }),
    },
    {
      path: TOOL_SESSION_ROUTES.delete, methods: ['POST'], requestBody: 'buffered',
      fetch: handle(async (request) => {
        const body = await bodyOf(request)
        const session = stringOf(body['session'], 'session')
        store.delete(projectOf(body['project']), session)
        return { deleted: session }
      }),
    },
    {
      path: TOOL_SESSION_ROUTES.results, methods: ['GET'], requestBody: 'buffered',
      fetch: handle((request) => {
        const projectId = projectOf(query(request, 'project'))
        const session = store.require(projectId, stringOf(query(request, 'session'), 'session')).id
        return services.log.all(projectId)
          .filter(op => op.surface === 'tool' && op.params['tool_session'] === session)
          .reverse()
      }),
    },
    {
      path: TOOL_SESSION_ROUTES.generate, methods: ['POST'], requestBody: 'buffered',
      fetch: handle(async (request) => {
        const body = await bodyOf(request)
        const projectId = projectOf(body['project'])
        const session = store.require(projectId, stringOf(body['session'], 'session'))
        const prompt = stringOf(body['prompt'], 'prompt')
        const references = Array.isArray(body['references']) ? body['references'].filter((ref): ref is string => typeof ref === 'string') : []
        for (const ref of references) {
          if (!services.assets.has(ref as AssetId)) throw new ToolSessionRequestError(404, `Unknown asset '${ref}'.`)
        }
        const params: Record<string, unknown> = { prompt, tool_session: session.id }
        if (typeof body['duration_sec'] === 'number') params['duration_sec'] = body['duration_sec']
        if (typeof body['seed'] === 'number') params['seed'] = body['seed']
        const intent = `Tool · ${session.title}: ${prompt.slice(0, 80)}`
        return await userTurn(projectId, 'tool', intent, turn => services.project.schedule(projectId, {
          tool: GENERATE_TOOL, inputs: references.map(ref => ({ role: 'reference', ref: ref as AssetId })), params,
          actor: 'user', surface: 'tool', intent, turn,
        }))
      }),
    },
    {
      path: TOOL_SESSION_ROUTES.capabilities, methods: ['GET'], requestBody: 'buffered',
      fetch: handle(async (): Promise<ToolCapabilities> => {
        const pending = services.model()
        if (pending === null) return { available: false, modelName: 'FastH3 Ref2AV', minDurationSec: 5, maxDurationSec: 15, maxReferences: 3 }
        const facts = await pending
        return {
          available: true, modelName: facts.name, minDurationSec: facts.minSegmentDurationSec, maxDurationSec: facts.maxSegmentDurationSec,
          // One request image slot stays free for a predecessor's last frame.
          maxReferences: Math.max(1, facts.maxReferenceImages - 1),
        }
      }),
    },
    {
      path: TOOL_SESSION_ROUTES.upload, methods: ['POST'], requestBody: 'buffered',
      fetch: handle(async (request) => {
        const projectId = projectOf(query(request, 'project'))
        const mime = stringOf(query(request, 'mime'), 'mime')
        const name = query(request, 'name') ?? 'upload'
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (bytes.length === 0) throw new ToolSessionRequestError(400, 'The upload body is empty.')
        // Store the bytes first so the record names the stored file by path instead of carrying base64 in its params.
        const stored = services.assets.put(bytes, { mime, name })
        const op = await userTurn(projectId, 'canvas', `upload ${name}`, turn => services.project.invoke(projectId, {
          tool: 'asset.upload', inputs: [], params: { path: services.assets.path(stored), mime, name },
          actor: 'user', surface: 'canvas', intent: `upload ${name}`, turn,
        }))
        return { assetId: op.outputs[0] ?? stored, op }
      }),
    },
  ]
}
