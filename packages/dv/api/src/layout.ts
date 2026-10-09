/**
 * Canvas node positions and the viewport per project, so a user's arrangement survives reloads. The layout is view
 * state, not project history: it lives in one JSON file per project under `<state root>/canvas-layout` and is never
 * written as records. The keys of `positions` are canvas node IDs. Which assets are on the canvas is project content:
 * the `asset` slice of the project state, written by `asset.place`, `asset.unplace` and `asset.import`.
 *
 * Route: `GET /api/dv/layout?project=<id>` returns the stored layout; `POST /api/dv/layout` with
 * `{project, positions?, viewport?}` merges the given node positions into the stored ones and replaces the viewport.
 * Errors use the body `{error, code}` of every `/api/dv` route: 400 `invalid_params` for a malformed project or too many
 * positions, 404 `unknown_project` for an unknown project.
 *
 * @module @dv/api/layout
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type DvProject from '@dv/project'
import type { ProjectId } from '@dv/project'
import { answer, ApiRequestError, requireProject } from './api.ts'

/** The Fetch route path. */
export const LAYOUT_ROUTE = '/api/dv/layout'

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

/** A change of one project's layout: positions to set and the viewport. */
export interface CanvasLayoutPatch {
  positions?: Record<string, NodePosition>
  viewport?: CanvasViewport | null
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
  write(projectId: ProjectId, patch: CanvasLayoutPatch): CanvasLayout {
    const current = this.read(projectId)
    const next: CanvasLayout = {
      positions: { ...current.positions, ...patch.positions },
      viewport: patch.viewport === undefined ? current.viewport : patch.viewport,
    }
    if (Object.keys(next.positions).length > MAX_POSITIONS) {
      throw new ApiRequestError(400, `A layout keeps at most ${String(MAX_POSITIONS)} positions.`, 'invalid_params')
    }
    mkdirSync(this.root, { recursive: true })
    const target = this.path(projectId)
    writeFileSync(`${target}.tmp`, JSON.stringify(next))
    renameSync(`${target}.tmp`, target)
    return next
  }

  /**
   * Delete a project's layout file and any partial write of it; a project without a layout file is left as it is.
   * @param projectId - a project.
   */
  delete(projectId: ProjectId): void {
    const target = this.path(projectId)
    rmSync(target, { force: true })
    rmSync(`${target}.tmp`, { force: true })
  }

  private path(projectId: ProjectId): string {
    return join(this.root, `${projectId}.json`)
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
 * The layout Fetch route. GET reads, POST merges; both answer 404 for an unknown project.
 * @param project - the Project service, used to check that the project exists.
 * @param store - the layout files.
 * @returns the route.
 */
export function layoutRoutes(project: Pick<DvProject, 'openProject'>, store: CanvasLayoutStore): ConnectionFetchRoute[] {
  const handle = (request: Request): Promise<Response> => answer(async () => {
    if (request.method === 'GET') return store.read(requireProject(project, new URL(request.url).searchParams.get('project')))
    const body: unknown = await request.json().catch(() => ({}))
    const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    const projectId: ProjectId = requireProject(project, record['project'])
    const parsed = layoutOf(record) ?? { positions: {}, viewport: null }
    return store.write(projectId, { positions: parsed.positions, ...record['viewport'] === undefined ? {} : { viewport: parsed.viewport } })
  })
  return [{ path: LAYOUT_ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handle }]
}
