/**
 * Client of `/api/vh/layout`, the per-project store of canvas node positions and viewport.
 */

/** Where a node sits, in canvas units. */
export interface NodePosition {
  x: number
  y: number
}

/** The canvas pan offset, in screen pixels, and zoom. */
export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

/** A project's stored layout. */
export interface CanvasLayout {
  positions: Record<string, NodePosition>
  viewport: CanvasViewport | null
}

const PATH = '/api/vh/layout'

/**
 * Read a project's layout; an empty layout when the route fails.
 * @param fetchImpl - the fetch to use.
 * @param project - the project ID.
 * @returns the layout.
 */
export async function loadLayout(fetchImpl: typeof fetch, project: string): Promise<CanvasLayout> {
  try {
    const response = await fetchImpl(`${PATH}?project=${encodeURIComponent(project)}`, { credentials: 'same-origin' })
    if (!response.ok) return { positions: {}, viewport: null }
    const body = await response.json() as Partial<CanvasLayout>
    return { positions: body.positions ?? {}, viewport: body.viewport ?? null }
  } catch {
    // A canvas without stored positions still works with the automatic layout.
    return { positions: {}, viewport: null }
  }
}

/**
 * Merge positions and store the viewport. Failures are ignored: the layout is a convenience.
 * @param fetchImpl - the fetch to use.
 * @param project - the project ID.
 * @param patch - the positions moved since the last save, and the viewport.
 */
export async function saveLayout(fetchImpl: typeof fetch, project: string, patch: CanvasLayout): Promise<void> {
  try {
    await fetchImpl(PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, ...patch }) })
  } catch {
    // The next save carries the viewport again; lost positions fall back to the automatic layout.
  }
}
