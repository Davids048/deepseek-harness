/**
 * The link between video projects and DSH Workspaces. A project's Workspace is the DSH Workspace whose directory is the
 * project's directory under the Project store root, so the chat sessions of a project are the sessions of that
 * Workspace. The browser creates the Workspace (only the client can), then records its ID here; the record is one JSON
 * file beside the canvas layout files and is never written as a project record.
 *
 * Routes:
 * - `GET /api/vh/workspaces` returns `{entryPath, projects: [{projectId, title, path, workspaceId}], bindings}`, where
 *   `entryPath` is the directory of the Workspace that holds chats started before a project exists and `bindings` maps
 *   each saved agent session to its project.
 * - `POST /api/vh/workspaces` with `{project, workspaceId}` records the project's Workspace.
 * - `POST /api/vh/workspaces/bind` with `{session, project}` binds an agent session to a project.
 * - `GET /api/vh/workspaces/sessions?project=<id>` lists the DSH sessions stored under the project's directory
 *   (`$DSH_HOME/sessions/<encoded cwd>/`) and the sessions bound to the project, newest first, so the browser can find
 *   a project's chats before its own session list has loaded them.
 *
 * Projects deleted through `@video-harness/views/projects-admin` are no longer listed by `dvProject`; the list omits
 * them and their bindings.
 *
 * @module @video-harness/views/workspaces
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { brandString } from '@deepseek-ai/dsh-brand'
import type DvProject from '@dv/project'
import type { ProjectId, SessionId } from '@dv/project'
import { projectIdOf } from './wire.ts'

/** The Fetch route paths. */
export const WORKSPACE_ROUTES = {
  workspaces: '/api/vh/workspaces',
  bind: '/api/vh/workspaces/bind',
  sessions: '/api/vh/workspaces/sessions',
} as const

/**
 * The state root the bundle configures: `$VH_STATE_ROOT`, else the default.
 * @returns the directory.
 */
export function stateRoot(): string {
  return process.env['VH_STATE_ROOT'] ?? join(homedir(), '.local/state/video-harness')
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
 * The project → Workspace records, read from `<state root>/workspaces.json`.
 * @returns the records; empty when the file is missing or unreadable.
 */
export function readLinks(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(stateRoot(), 'workspaces.json'), 'utf8'))
    return typeof raw === 'object' && raw !== null ? raw as Record<string, string> : {}
  } catch {
    // No file yet: no project has a recorded Workspace.
    return {}
  }
}

/**
 * Replace `<state root>/workspaces.json` atomically.
 * @param links - the project → Workspace records.
 */
export function writeLinks(links: Record<string, string>): void {
  mkdirSync(stateRoot(), { recursive: true })
  const target = join(stateRoot(), 'workspaces.json')
  writeFileSync(`${target}.tmp`, JSON.stringify(links))
  renameSync(`${target}.tmp`, target)
}

/**
 * The DSH sessions stored for one project: the session directories under `$DSH_HOME/sessions/<encoded cwd>/`, where the
 * encoded project directory ends in `-<projectId>--`, plus the sessions bound to the project.
 * @param projectId - the project.
 * @param bindings - the saved session → project bindings.
 * @returns each session's ID, last-write time in ms, and log size in bytes (0 when unknown), newest first.
 */
function projectSessions(
  projectId: string,
  bindings: Record<string, string>,
): Array<{ sessionId: string; updatedAt: number; bytes: number }> {
  const root = join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'sessions')
  const found = new Map<string, { sessionId: string; updatedAt: number; bytes: number }>()
  const record = (dir: string, sessionId: string): void => {
    try {
      const log = readdirSync(join(dir, sessionId)).find(name => name.startsWith('session.') && name !== 'session.lock')
      const stat = statSync(join(dir, sessionId, log ?? ''))
      found.set(sessionId, { sessionId, updatedAt: stat.mtimeMs, bytes: log === undefined ? 0 : stat.size })
    } catch {
      // A session directory removed while listing is skipped.
    }
  }
  let groups: string[] = []
  try {
    groups = readdirSync(root)
  } catch {
    // No DSH session store yet.
  }
  for (const group of groups) {
    const dir = join(root, group)
    const own = group.endsWith(`-${projectId}--`)
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      // A group directory removed while listing has no sessions.
      continue
    }
    for (const name of names) if (own || bindings[name] === projectId) record(dir, name)
  }
  return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * The saved session → project bindings, read from the tools' session state files.
 * @returns the bindings of every session that has a project.
 */
function readBindings(): Record<string, string> {
  const dir = join(stateRoot(), 'sessions')
  const bindings: Record<string, string> = {}
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    // No session has saved state yet.
    return bindings
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const state: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      const projectId = typeof state === 'object' && state !== null ? (state as { projectId?: unknown }).projectId : null
      if (typeof projectId === 'string') bindings[decodeURIComponent(name.slice(0, -'.json'.length))] = projectId
    } catch {
      // A file being rewritten is skipped; the next read sees it.
    }
  }
  return bindings
}

/**
 * The project ↔ Workspace Fetch routes.
 * @param project - the Project service, for the project list, the project check, and session bindings.
 * @returns the routes.
 */
export function workspaceRoutes(project: DvProject): ConnectionFetchRoute[] {
  const projectsRoot = join(stateRoot(), 'projects')
  const projectOf = (value: unknown): ProjectId => {
    const projectId = projectIdOf(value)
    if (projectId === null) throw new Error("'project' must name a project.")
    project.openProject(projectId)
    return projectId
  }
  const bodyOf = async (request: Request): Promise<Record<string, unknown>> => {
    const body: unknown = await request.json().catch(() => ({}))
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  }
  const list = (): Response => {
    const links = readLinks()
    const projects = project.listProjects()
    const live = new Set<string>(projects.map(info => info.id))
    const entryPath = join(stateRoot(), 'entry')
    mkdirSync(entryPath, { recursive: true })
    return json({
      entryPath,
      projects: projects.map(info => ({
        projectId: info.id, title: info.title, createdAt: info.created_at,
        path: join(projectsRoot, info.id), workspaceId: links[info.id] ?? null,
      })),
      bindings: Object.fromEntries(Object.entries(readBindings()).filter(([, projectId]) => live.has(projectId))),
    })
  }
  const link = async (request: Request): Promise<Response> => {
    const body = await bodyOf(request)
    const projectId = projectOf(body['project'])
    if (typeof body['workspaceId'] !== 'string') return json({ error: "'workspaceId' must be a string." }, 400)
    writeLinks({ ...readLinks(), [projectId]: body['workspaceId'] })
    return json({ ok: true })
  }
  const bind = async (request: Request): Promise<Response> => {
    const body = await bodyOf(request)
    const projectId = projectOf(body['project'])
    if (typeof body['session'] !== 'string' || body['session'].length === 0) return json({ error: "'session' must be a session ID." }, 400)
    project.bindSession(brandString<SessionId>(body['session']), projectId)
    return json({ ok: true })
  }
  const guard = (run: (request: Request) => Response | Promise<Response>) => async (request: Request): Promise<Response> => {
    try {
      return await run(request)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  }
  return [
    { path: WORKSPACE_ROUTES.workspaces, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: guard(request => request.method === 'GET' ? list() : link(request)) },
    { path: WORKSPACE_ROUTES.bind, methods: ['POST'], requestBody: 'buffered', fetch: guard(bind) },
    {
      path: WORKSPACE_ROUTES.sessions, methods: ['GET'], requestBody: 'buffered',
      fetch: guard(request => json(projectSessions(projectOf(new URL(request.url).searchParams.get('project')), readBindings()))),
    },
  ]
}
