/**
 * The link between DreamVerse projects and DSH Workspaces. A project's Workspace is the DSH Workspace whose directory
 * is the project's directory under `<state root>/projects`, so the chat sessions of a project are the sessions of that
 * Workspace. The browser creates the Workspace (only the client can), then links its ID to the project here; the links
 * live in one JSON file, `<state root>/workspaces.json`, and are never written as project records.
 *
 * Routes:
 * - `GET /api/dv/workspaces` returns `{entry_path, projects: [{id, title, created_at, path, workspace_id}], bindings}`,
 *   where `entry_path` is the directory of the Workspace that holds chats started before a project exists and
 *   `bindings` maps each saved agent session to its project.
 * - `POST /api/dv/workspaces` with `{project, workspace_id}` links the project to its Workspace.
 * - `POST /api/dv/workspaces/bind` with `{session, project}` binds an agent session to a project.
 * - `GET /api/dv/workspaces/sessions?project=<id>` lists the DSH sessions stored under the project's directory
 *   (`$DSH_HOME/sessions/<encoded cwd>/`) and the sessions bound to the project, newest first, as
 *   `[{session, updated_at, bytes}]`, so the browser can find a project's chats before its own session list has loaded
 *   them.
 *
 * Projects deleted through `@dv/api/projects-admin` are no longer listed by `dvProject`; the list omits them and their
 * bindings.
 *
 * @module @dv/api/workspaces
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
  workspaces: '/api/dv/workspaces',
  bind: '/api/dv/workspaces/bind',
  sessions: '/api/dv/workspaces/sessions',
} as const

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
 * The project → Workspace links, read from `<state root>/workspaces.json`.
 * @param stateRoot - the state directory.
 * @returns the links; empty when the file is missing or unreadable.
 */
export function readLinks(stateRoot: string): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(stateRoot, 'workspaces.json'), 'utf8'))
    return typeof raw === 'object' && raw !== null ? raw as Record<string, string> : {}
  } catch {
    // No file yet: no project has a linked Workspace.
    return {}
  }
}

/**
 * Replace `<state root>/workspaces.json` atomically.
 * @param stateRoot - the state directory.
 * @param links - the project → Workspace links.
 */
export function writeLinks(stateRoot: string, links: Record<string, string>): void {
  mkdirSync(stateRoot, { recursive: true })
  const target = join(stateRoot, 'workspaces.json')
  writeFileSync(`${target}.tmp`, JSON.stringify(links))
  renameSync(`${target}.tmp`, target)
}

/**
 * The DSH sessions stored for one project: the session directories under `$DSH_HOME/sessions/<encoded cwd>/`, where the
 * encoded project directory ends in `-<projectId>--`, plus the sessions bound to the project.
 * @param projectId - the project.
 * @param bindings - the saved session → project bindings.
 * @returns each session's ID, last-write time (ISO-8601 UTC), and log size in bytes (0 when unknown), newest first.
 */
function projectSessions(projectId: string, bindings: Record<string, string>): ProjectSession[] {
  const root = join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'sessions')
  const found = new Map<string, { session: string; mtimeMs: number; bytes: number }>()
  const addSession = (dir: string, session: string): void => {
    try {
      const log = readdirSync(join(dir, session)).find(name => name.startsWith('session.') && name !== 'session.lock')
      const stat = statSync(join(dir, session, log ?? ''))
      found.set(session, { session, mtimeMs: stat.mtimeMs, bytes: log === undefined ? 0 : stat.size })
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
    for (const name of names) if (own || bindings[name] === projectId) addSession(dir, name)
  }
  return [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(entry => ({ session: entry.session, updated_at: new Date(entry.mtimeMs).toISOString(), bytes: entry.bytes }))
}

/** One DSH session of a project, as the sessions route returns it. */
interface ProjectSession {
  session: string
  /** The last write of the session log, ISO-8601 UTC. */
  updated_at: string
  bytes: number
}

/**
 * The saved session → project bindings, read from the session binding files of `@dv/project`
 * (`<state root>/sessions/<encoded session>.json`, each `{"project": <ProjectId>}`).
 * @param stateRoot - the state directory.
 * @returns the bindings of every session that has a project.
 */
function readBindings(stateRoot: string): Record<string, string> {
  const dir = join(stateRoot, 'sessions')
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
      const projectId = typeof state === 'object' && state !== null ? (state as { project?: unknown }).project : null
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
 * @param stateRoot - the state directory.
 * @returns the routes.
 */
export function workspaceRoutes(project: DvProject, stateRoot: string): ConnectionFetchRoute[] {
  const projectsRoot = join(stateRoot, 'projects')
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
    const links = readLinks(stateRoot)
    const projects = project.listProjects()
    const live = new Set<string>(projects.map(info => info.id))
    const entryPath = join(stateRoot, 'entry')
    mkdirSync(entryPath, { recursive: true })
    return json({
      entry_path: entryPath,
      projects: projects.map(info => ({
        id: info.id, title: info.title, created_at: info.created_at,
        path: join(projectsRoot, info.id), workspace_id: links[info.id] ?? null,
      })),
      bindings: Object.fromEntries(Object.entries(readBindings(stateRoot)).filter(([, projectId]) => live.has(projectId))),
    })
  }
  const link = async (request: Request): Promise<Response> => {
    const body = await bodyOf(request)
    const projectId = projectOf(body['project'])
    if (typeof body['workspace_id'] !== 'string') return json({ error: "'workspace_id' must be a string." }, 400)
    writeLinks(stateRoot, { ...readLinks(stateRoot), [projectId]: body['workspace_id'] })
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
      fetch: guard(request => json(projectSessions(projectOf(new URL(request.url).searchParams.get('project')), readBindings(stateRoot)))),
    },
  ]
}
