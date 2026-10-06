/**
 * Project deletion and renaming for the DreamVerse shell, through `dvProject`. Deletion is reversible by hand:
 * `dvProject.deleteProject` moves the project's directory into the Project store's trash, after which the project is
 * no longer listed. The browser deletes the project's DSH Workspace registration, because only the client reaches the
 * Workspace service.
 *
 * Routes:
 * - `POST /api/vh/projects/delete` with `{project}` deletes the project and drops its Workspace record.
 * - `POST /api/vh/projects/rename` with `{project, title}` stores a title that no other project has, appending ` 2`,
 *   ` 3`, … on a clash, and returns `{title}`.
 *
 * @module @video-harness/views/projects-admin
 */
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type DvProject from '@dv/project'
import type { ProjectId } from '@dv/project'
import { projectIdOf } from './wire.ts'
import { readLinks, writeLinks } from './workspaces.ts'

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
 * A title no other project uses: the trimmed title, else the title with the smallest free ` N` suffix.
 * @param project - the Project service.
 * @param projectId - the project being titled, whose own title does not count as a clash.
 * @param wanted - the requested title.
 * @returns the unique title.
 */
export function uniqueProjectTitle(project: Pick<DvProject, 'listProjects'>, projectId: string | null, wanted: string): string {
  const taken = new Set(project.listProjects().filter(info => info.id !== projectId).map(info => info.title))
  if (!taken.has(wanted)) return wanted
  let suffix = 2
  while (taken.has(`${wanted} ${String(suffix)}`)) suffix += 1
  return `${wanted} ${String(suffix)}`
}

/**
 * The project deletion and rename Fetch routes.
 * @param project - the Project service, which owns the project files.
 * @returns the routes.
 */
export function projectAdminRoutes(project: DvProject): ConnectionFetchRoute[] {
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
  const remove = async (request: Request): Promise<Response> => {
    const projectId = projectOf((await bodyOf(request))['project'])
    await project.deleteProject(projectId)
    const { [projectId]: workspaceId, ...links } = readLinks()
    writeLinks(links)
    return json({ ok: true, workspaceId: workspaceId ?? null })
  }
  const rename = async (request: Request): Promise<Response> => {
    const body = await bodyOf(request)
    const projectId = projectOf(body['project'])
    const wanted = typeof body['title'] === 'string' ? body['title'].trim() : ''
    if (wanted.length === 0) return json({ error: "'title' must be a non-empty string." }, 400)
    const info = await project.renameProject(projectId, uniqueProjectTitle(project, projectId, wanted))
    return json({ title: info.title })
  }
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
