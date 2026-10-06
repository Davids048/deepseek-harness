/**
 * Project deletion and renaming for the DreamVerse shell. Deletion is reversible by hand: the project's directory and
 * its side file (canvas layout) move to `<state root>/trash/<projectId>-<ms>/`, and the trash entry is
 * what hides the project from `GET /api/vh/workspaces`. The browser deletes the project's DSH Workspace registration,
 * because only the client reaches the Workspace service.
 *
 * Routes:
 * - `POST /api/vh/projects/delete` with `{project}` moves the project to the trash and drops its Workspace record.
 * - `POST /api/vh/projects/rename` with `{project, title}` stores a title that no other project has, appending ` 2`,
 *   ` 3`, … on a clash, and returns `{title}`.
 *
 * @module @video-harness/views/projects-admin
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type VhOpLog from '@video-harness/oplog'
import type { ProjectId } from '@video-harness/oplog'
import { projectIdOf } from './wire.ts'
import { TRASH_DIR, deletedProjectIds, readLinks, stateRoot, writeLinks } from './workspaces.ts'

/** The Fetch route paths. */
export const PROJECT_ADMIN_ROUTES = {
  delete: '/api/vh/projects/delete',
  rename: '/api/vh/projects/rename',
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
 * A title no other live project uses: the trimmed title, else the title with the smallest free ` N` suffix.
 * @param log - the operation log.
 * @param projectId - the project being titled, whose own title does not count as a clash.
 * @param wanted - the requested title.
 * @returns the unique title.
 */
export function uniqueProjectTitle(log: VhOpLog, projectId: string | null, wanted: string): string {
  const deleted = deletedProjectIds()
  const others = log.listProjects().filter(info => info.projectId !== projectId && !deleted.has(info.projectId))
  const taken = new Set(others.map(info => info.title))
  if (!taken.has(wanted)) return wanted
  let suffix = 2
  while (taken.has(`${wanted} ${String(suffix)}`)) suffix += 1
  return `${wanted} ${String(suffix)}`
}

/**
 * The project deletion and rename Fetch routes.
 * @param log - the operation log, for the project check and the stored titles.
 * @returns the routes.
 */
export function projectAdminRoutes(log: VhOpLog): ConnectionFetchRoute[] {
  const projectOf = (value: unknown): ProjectId => {
    const projectId = projectIdOf(value)
    if (projectId === null || deletedProjectIds().has(projectId)) throw new Error("'project' must name a project.")
    log.project(projectId)
    return projectId
  }
  const bodyOf = async (request: Request): Promise<Record<string, unknown>> => {
    const body: unknown = await request.json().catch(() => ({}))
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  }
  const remove = async (request: Request): Promise<Response> => {
    const projectId = projectOf((await bodyOf(request))['project'])
    const root = stateRoot()
    const trash = join(root, TRASH_DIR, `${projectId}-${String(Date.now())}`)
    mkdirSync(trash, { recursive: true })
    // The project directory and its side file keep their names inside the trash entry.
    const moves: Array<[string, string]> = [
      [join(root, 'projects', projectId), join(trash, 'project')],
      [join(root, 'canvas-layout', `${projectId}.json`), join(trash, 'canvas-layout.json')],
    ]
    for (const [from, to] of moves) if (existsSync(from)) renameSync(from, to)
    const { [projectId]: workspaceId, ...links } = readLinks()
    writeLinks(links)
    return json({ ok: true, workspaceId: workspaceId ?? null })
  }
  const rename = async (request: Request): Promise<Response> => {
    const body = await bodyOf(request)
    const projectId = projectOf(body['project'])
    const wanted = typeof body['title'] === 'string' ? body['title'].trim() : ''
    if (wanted.length === 0) return json({ error: "'title' must be a non-empty string." }, 400)
    const title = uniqueProjectTitle(log, projectId, wanted)
    const info = log.project(projectId)
    const file = join(root(), projectId, 'project.json')
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...info, title })}\n`)
    renameSync(`${file}.tmp`, file)
    // The log keeps the record it loaded; update it in place so listings show the title without a restart.
    ;(info as { title: string }).title = title
    return json({ title })
  }
  const root = (): string => join(stateRoot(), 'projects')
  const guard = (run: (request: Request) => Promise<Response>) => async (request: Request): Promise<Response> => {
    try {
      return await run(request)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  }
  return [
    { path: PROJECT_ADMIN_ROUTES.delete, methods: ['POST'], requestBody: 'buffered', fetch: guard(remove) },
    { path: PROJECT_ADMIN_ROUTES.rename, methods: ['POST'], requestBody: 'buffered', fetch: guard(rename) },
  ]
}
