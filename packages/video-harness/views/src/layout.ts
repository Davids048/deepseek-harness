/**
 * Canvas node positions per project, so a user's arrangement survives reloads. The positions are view state, not
 * project history: they live in one JSON file per project beside the state root and are never written as records.
 *
 * Route: `GET /api/vh/layout?project=<id>` returns the stored layout; `POST /api/vh/layout` with
 * `{project, positions?, viewport?}` merges the given node positions into the stored ones and replaces the viewport.
 *
 * @module @video-harness/views/layout
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type DvProject from '@dv/project'
import type { ProjectId } from '@dv/project'
import { projectIdOf } from './wire.ts'

/** The Fetch route path. */
export const LAYOUT_ROUTE = '/api/vh/layout'

/** Where a node sits on the canvas, in canvas units. */
export interface NodePosition {
  x: number
  y: number
}

/** The pan offset and zoom of the canvas. */
export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

/** The stored layout of one project. */
export interface CanvasLayout {
  positions: Record<string, NodePosition>
  viewport: CanvasViewport | null
}

/** The most node positions one project keeps; a larger request is refused. */
const MAX_POSITIONS = 5000

/** One project's layout file, as JSON on disk. */
export class CanvasLayoutStore {
  constructor(private readonly root: string) {}

  /**
   * @param projectId - a project.
   * @returns the stored layout, or an empty one.
   */
  read(projectId: ProjectId): CanvasLayout {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path(projectId), 'utf8'))
      return layoutOf(raw) ?? { positions: {}, viewport: null }
    } catch {
      // No file yet, or a file this version cannot read: start from an empty layout.
      return { positions: {}, viewport: null }
    }
  }

  /**
   * Merge positions and replace the viewport, then write atomically.
   * @param projectId - a project.
   * @param patch - the positions to set and the viewport, when given.
   * @returns the stored layout afterwards.
   */
  write(projectId: ProjectId, patch: Partial<CanvasLayout>): CanvasLayout {
    const current = this.read(projectId)
    const next: CanvasLayout = {
      positions: { ...current.positions, ...patch.positions },
      viewport: patch.viewport === undefined ? current.viewport : patch.viewport,
    }
    if (Object.keys(next.positions).length > MAX_POSITIONS) throw new LayoutRequestError(400, `A layout keeps at most ${String(MAX_POSITIONS)} positions.`)
    mkdirSync(this.root, { recursive: true })
    const target = this.path(projectId)
    writeFileSync(`${target}.tmp`, JSON.stringify(next))
    renameSync(`${target}.tmp`, target)
    return next
  }

  private path(projectId: ProjectId): string {
    return join(this.root, `${projectId}.json`)
  }
}

/** A layout request the route refuses, with its status. */
export class LayoutRequestError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message)
    this.name = 'LayoutRequestError'
  }
}

/**
 * The positions and viewport in a raw JSON value, keeping only finite numbers.
 * @param value - parsed JSON.
 * @returns the layout, or null when the value is not an object.
 */
export function layoutOf(value: unknown): CanvasLayout | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const positions: Record<string, NodePosition> = {}
  const rawPositions = record['positions']
  if (typeof rawPositions === 'object' && rawPositions !== null) {
    for (const [id, position] of Object.entries(rawPositions as Record<string, unknown>)) {
      if (typeof position !== 'object' || position === null) continue
      const { x, y } = position as Record<string, unknown>
      if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) positions[id] = { x, y }
    }
  }
  const rawViewport = record['viewport']
  let viewport: CanvasViewport | null = null
  if (typeof rawViewport === 'object' && rawViewport !== null) {
    const { x, y, zoom } = rawViewport as Record<string, unknown>
    if (typeof x === 'number' && typeof y === 'number' && typeof zoom === 'number' && [x, y, zoom].every(Number.isFinite) && zoom > 0) viewport = { x, y, zoom }
  }
  return { positions, viewport }
}

/**
 * The directory that holds layout files: `$VH_STATE_ROOT/canvas-layout`, else the default state root's.
 * @returns the directory.
 */
export function layoutRoot(): string {
  const stateRoot = process.env['VH_STATE_ROOT'] ?? join(homedir(), '.local/state/video-harness')
  return join(stateRoot, 'canvas-layout')
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
 * The layout Fetch route. GET reads, POST merges; both answer 404 for an unknown project.
 * @param project - the Project service, used to check that the project exists.
 * @param store - the layout files; defaults to {@link layoutRoot}.
 * @returns the route.
 */
export function layoutRoutes(project: Pick<DvProject, 'openProject'>, store: CanvasLayoutStore = new CanvasLayoutStore(layoutRoot())): ConnectionFetchRoute[] {
  const projectOf = (value: unknown): ProjectId => {
    const projectId = projectIdOf(value)
    if (projectId === null) throw new LayoutRequestError(400, "'project' must name a project.")
    try {
      project.openProject(projectId)
    } catch {
      // Project throws for an unknown project; the route reports it as 404.
      throw new LayoutRequestError(404, `Unknown project '${projectId}'.`)
    }
    return projectId
  }
  const handle = async (request: Request): Promise<Response> => {
    try {
      if (request.method === 'GET') return json(store.read(projectOf(new URL(request.url).searchParams.get('project'))))
      const body: unknown = await request.json().catch(() => ({}))
      const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
      const projectId = projectOf(record['project'])
      const parsed = layoutOf(record) ?? { positions: {}, viewport: null }
      return json(store.write(projectId, { positions: parsed.positions, ...record['viewport'] === undefined ? {} : { viewport: parsed.viewport } }))
    } catch (error) {
      if (error instanceof LayoutRequestError) return json({ error: error.message }, error.status)
      return json({ error: error instanceof Error ? error.message : String(error) }, 500)
    }
  }
  return [{ path: LAYOUT_ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handle }]
}
