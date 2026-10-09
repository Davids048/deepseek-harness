/**
 * The project canvas as a standalone component: an infinite surface of story bible, asset, plan, and take nodes. Drag
 * empty space to pan, scroll to zoom around the cursor, drag a node to move it, click a node to select it and open its
 * editor panel, which grows out of the node and shrinks back into it on close (`@dv/ui-kit/zoom.ts`). Closing the
 * editor keeps the node selected (the accent ring); a click on empty canvas with no editor open
 * clears the selection. A scroll over an overlay marked `data-dv-scroll-island`, such as the editor panel, scrolls that
 * overlay. Node positions and the viewport are stored per project through `/api/dv/layout`; a project without a stored
 * viewport opens at 100%, or fitted when its nodes do not fit the view at 100%. A node without a stored position gets the
 * first free spot at or below its automatic position, and that spot is stored, so a node that appears later never moves
 * or covers another. A render started from the take editor or a failed take's 重试 closes the editor once the new take's
 * node appears, then centers and selects that node. A finished take that the user has not opened in this browser shows
 * an accent dot; the opened takes are kept per project in `localStorage`, and a project opened for the first time in a
 * browser starts with every finished take counted as opened. The canvas draws the project's current state and
 * follows every change of it; its writes go after the current position of the project's history. Colors come from the
 * `--dv-*` theme variables that `@dv/ui-shell` defines, so the canvas follows the app's light and dark themes. An image
 * or video that no take or story bible node shows has a node only while it is on the project's canvas (the `asset`
 * slice's `placed`): dropping a 素材 tile on the canvas runs `asset.place` with its node under the pointer, dropping
 * image and video files imports them with `place`, and the asset node's "从画布移除" runs `asset.unplace`. Each of these
 * is a record, so History lists it and undo takes it back.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { DvClient } from '@dv/ui-kit/api.ts'
import { useLanguage } from '@dv/ui-kit/locale.ts'
import type { CanvasViewport, NodePosition, OperationRequest } from '@dv/ui-kit/types.ts'
import { DV_ASSET_DRAG_TYPE, DV_CANVAS_FOCUS_EVENT } from '@dv/ui-kit/workspace-events.ts'
import type { DvWorkspaceEventMap } from '@dv/ui-kit/workspace-events.ts'
import { useProjectState } from '@dv/ui-kit/useProject.ts'
import { useZoomPresence } from '@dv/ui-kit/zoom.ts'
import { buildCanvasGraph, freePositions, NODE_WIDTH, planShotFrames, referenceText, ROW } from './graph.ts'
import type { CanvasEdge, CanvasNode } from './graph.ts'
import { NodeCard, nodeHeight, nodeTitle } from './NodeCard.tsx'
import type { CanvasTranslate } from './NodeCard.tsx'
import { NodeEditor } from './NodeEditor.tsx'
import { en, zh } from './locales.ts'

/** Props of {@link CanvasView}. */
export interface CanvasViewProps {
  /** The project to draw. */
  projectId: string
  /** The API client; a same-origin client when omitted. */
  client?: DvClient
  /** The chat session the canvas sits beside, recorded as the `session` of the canvas's writes. */
  session?: string | null
  /** The `dvCanvas` translate; when omitted, the dictionary of the DSH interface language that `<html lang>` names. */
  t?: CanvasTranslate
}

/** The tallest a card grows (larger text at low zoom plus a badge row), used when fitting. */
const FIT_NODE_HEIGHT = ROW - 20
/** How far above the pointer a dropped node's top edge lands, in canvas units, so the pointer rests on its header. */
const DROP_OFFSET_Y = 40
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2
const DRAG_THRESHOLD = 4
const SAVE_DELAY_MS = 500

/** Edge stroke per kind: the kind color of the node the edge leaves (a reference leaves a character or an asset). */
const EDGE_COLOR: Record<CanvasEdge['kind'], string> = {
  reference: 'var(--dv-kind-character)', first_frame: 'var(--dv-kind-take)', plan: 'var(--dv-kind-plan)', take: 'var(--dv-kind-take)',
}
/** Canvas dot grid pitch at 100%, in canvas units. */
const GRID = 20

// Hover and focus states, which inline styles cannot express; scoped to the canvas by class name.
const CANVAS_CSS = `
.dv-canvas-btn { background: transparent; transition: background-color 120ms var(--dv-ease); }
.dv-canvas-btn:hover:not(:disabled) { background: var(--dv-surface-3); }
.dv-canvas-btn:focus-visible, .dv-canvas-soft:focus-visible, [data-node-id]:focus-visible { outline: 2px solid var(--dv-accent); outline-offset: 2px; }
.dv-canvas-soft { background: var(--dv-accent-soft); color: var(--dv-accent-text); }
@media (prefers-reduced-motion: reduce) { .dv-canvas-btn { transition: none; } }
`

/**
 * A translate over one `dvCanvas` dictionary, for hosts that mount the canvas without a locale binding.
 * @param dictionary - the Chinese or English dictionary.
 * @returns the translate.
 */
function dictionaryTranslate(dictionary: Record<string, string>): CanvasTranslate {
  return (key, params) => {
    let text = dictionary[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
}
const translates = { zh: dictionaryTranslate(zh), en: dictionaryTranslate(en) }

// A `dv:canvas-focus` request usually arrives while the canvas is unmounted (the shell mounts it in response), so the
// module keeps the latest requested record until a mounted canvas consumes it.
let pendingFocus: string | null = null
const focusListeners = new Set<() => void>()
if (typeof window !== 'undefined') {
  window.addEventListener(DV_CANVAS_FOCUS_EVENT, (event) => {
    pendingFocus = (event as CustomEvent<DvWorkspaceEventMap['dv:canvas-focus']>).detail.recordId
    for (const listener of focusListeners) listener()
  })
}

const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

/** Zoom change per pixel of a mouse wheel's deltaY: one notch (about 100 px) zooms by about 14%. */
const WHEEL_ZOOM_RATE = 0.0015
/**
 * Zoom change per pixel of a touchpad pinch's deltaY. Browsers report a pinch as wheel events with `ctrlKey` and
 * deltas of a few pixels each, so the pinch needs a larger rate than a mouse wheel to follow the fingers.
 */
const PINCH_ZOOM_RATE = 0.01
/** Pixels per line for wheel events that report `deltaMode` in lines (Firefox mouse wheels). */
const LINE_HEIGHT_PX = 16

/**
 * The factor one wheel event multiplies the canvas zoom by.
 * @param event - the wheel event's deltaY, deltaMode, and ctrlKey (set for a touchpad pinch).
 * @returns the zoom factor; above 1 zooms in.
 */
export function wheelZoomFactor(event: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey'>): number {
  const pixels = event.deltaMode === 1 ? event.deltaY * LINE_HEIGHT_PX : event.deltaY
  return Math.exp(-pixels * (event.ctrlKey ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE))
}

/** The `localStorage` key prefix of a project's opened takes, a JSON array of take node IDs. */
const SEEN_KEY = 'dv-canvas-seen:'

/**
 * @param node - a node.
 * @returns whether the node is a take whose render finished with an image or a video.
 */
function isFinishedTake(node: CanvasNode): boolean {
  return node.kind === 'take' && !node.flags.rendering && (node.video !== null || node.thumb !== null)
}

/**
 * @param projectId - the project.
 * @returns the take node IDs opened in this browser, or null when the project has none stored.
 */
function readSeen(projectId: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY + projectId)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch (error) {
    // Storage that is blocked or holds malformed JSON counts as none stored.
    void error
    return null
  }
}

/**
 * @param projectId - the project.
 * @param ids - the take node IDs opened in this browser.
 */
function writeSeen(projectId: string, ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(SEEN_KEY + projectId, JSON.stringify([...ids]))
  } catch (error) {
    // Blocked storage keeps the opened takes for this page only.
    void error
  }
}

/** A render whose new take the canvas waits for: the take it is based on and every node drawn before the request. */
interface AwaitedRender {
  basedOn: string
  known: ReadonlySet<string>
  resolve: () => void
}

/** An in-progress pointer gesture. */
type Gesture =
  | { kind: 'pan'; startX: number; startY: number; origin: CanvasViewport; moved: boolean }
  | { kind: 'node'; id: string; startX: number; startY: number; origin: NodePosition; moved: boolean }

/**
 * @param map - a map.
 * @param keys - the keys to drop.
 * @returns a copy of the map without those keys.
 */
function withoutKeys<V>(map: ReadonlyMap<string, V>, keys: readonly string[]): Map<string, V> {
  const next = new Map(map)
  for (const key of keys) next.delete(key)
  return next
}

/**
 * The canvas.
 * @param props - the project, chat session, and optional client and translate.
 * @returns the element.
 */
export function CanvasView({ projectId, client: given, session = null, t: givenT }: CanvasViewProps): ReactNode {
  const client = useMemo(() => given ?? new DvClient(), [given])
  const language = useLanguage()
  const t = givenT ?? translates[language]
  const base = useProjectState(client, projectId)
  // This view's placements whose record the project state does not show yet: asset ID → on the canvas.
  const [inFlight, setInFlight] = useState<ReadonlyMap<string, boolean>>(new Map())
  // The project's canvas, with this view's placements in flight already applied.
  const placed = useMemo(() => {
    const next = new Set(base.value?.components.asset.placed ?? [])
    for (const [assetId, on] of inFlight) {
      if (on) next.add(assetId)
      else next.delete(assetId)
    }
    return next
  }, [base.value, inFlight])
  // A placement leaves the in-flight map once the project state shows it.
  useEffect(() => {
    if (base.value === null || inFlight.size === 0) return
    const shown = new Set(base.value.components.asset.placed)
    const settled = [...inFlight].filter(([assetId, on]) => shown.has(assetId) === on)
    if (settled.length > 0) setInFlight(current => withoutKeys(current, settled.map(([assetId]) => assetId)))
  }, [base.value, inFlight])
  /**
   * Put an asset on the project's canvas or take it off: at once in this view, then through an `asset.place` or
   * `asset.unplace` record.
   * @param assetId - the asset.
   * @param on - true to place it, false to remove it.
   * @returns settles when the record is written; a refused write puts the canvas back as it was.
   */
  const changePlacement = (assetId: string, on: boolean): Promise<unknown> => {
    setInFlight(current => new Map(current).set(assetId, on))
    return client.placeOnCanvas(projectId, [assetId], on, session).catch((error: unknown) => {
      setInFlight(current => withoutKeys(current, [assetId]))
      throw error
    })
  }
  // The previous project's state stays loaded until the next project's arrives; the canvas draws only this project's.
  const graph = useMemo(() => {
    if (base.value === null || base.value.project.id !== projectId) return null
    return { state: base.value, ...buildCanvasGraph(base.value, placed) }
  }, [base.value, placed, projectId])
  // Each plan node's latest version and its shots' frames, for the plan card's version label, mini grid, and duration.
  // Memoized on the graph, because a pan or zoom re-renders the view on every pointer move.
  const plans = useMemo(() => new Map(graph === null ? [] : graph.nodes.flatMap((node) => {
    const latest = node.planId === undefined ? undefined : graph.state.components.plan.plans[node.planId]?.at(-1)
    if (latest === undefined || node.planId === undefined) return []
    return [[node.id, { latest, frames: planShotFrames(graph.nodes, node.planId, latest.shots.length) }] as const]
  })), [graph])

  const [positions, setPositions] = useState<Record<string, NodePosition>>({})
  const [viewport, setViewport] = useState<CanvasViewport>({ x: 40, y: 40, zoom: 1 })
  const [layoutReady, setLayoutReady] = useState(false)
  // The node with the accent ring, and the node whose editor is open; closing the editor keeps the ring.
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  // The take node IDs opened in this browser, for the project they belong to; null until the graph first loads.
  const [seen, setSeen] = useState<{ project: string; ids: ReadonlySet<string> } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const container = useRef<HTMLDivElement | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const positionsRef = useRef(positions)
  positionsRef.current = positions
  const moved = useRef(new Set<string>())
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const needsFit = useRef(false)
  // True while the viewport is an automatic fit; resizing the canvas refits until the user pans or zooms.
  const autoFit = useRef(false)
  // Imported or dropped assets waiting for their node to appear, with the canvas point they were dropped at.
  const pendingDrops = useRef(new Map<string, NodePosition>())
  const [dragOver, setDragOver] = useState(false)
  // The node the user last dragged or dropped is drawn above the others.
  const [topNode, setTopNode] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setLayoutReady(false)
    // A canvas without stored positions still works with the automatic layout, so a failed read counts as empty.
    void client.getLayout(projectId).catch(() => ({ positions: {}, viewport: null })).then((layout) => {
      if (!live) return
      setPositions(layout.positions)
      if (layout.viewport !== null) setViewport(layout.viewport)
      needsFit.current = layout.viewport === null
      setLayoutReady(true)
    })
    return () => {
      live = false
      if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    }
  }, [client, projectId])

  /** Store the moved positions and the viewport after the gesture settles. */
  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      const patch: Record<string, NodePosition> = {}
      for (const id of moved.current) {
        const position = positionsRef.current[id]
        if (position !== undefined) patch[id] = position
      }
      moved.current.clear()
      // The next save carries the viewport again; lost positions fall back to the automatic layout.
      void client.updateLayout(projectId, { positions: patch, viewport: viewportRef.current }).catch(() => null)
    }, SAVE_DELAY_MS)
  }, [client, projectId])

  const positionOf = useCallback((node: CanvasNode): NodePosition => positions[node.id] ?? { x: node.x, y: node.y }, [positions])

  /** Pan and zoom so every node is visible, at 100% at most: content that fits the view keeps its true size. */
  const fit = useCallback(() => {
    const element = container.current
    if (graph === null || graph.nodes.length === 0 || element === null) return
    const rect = element.getBoundingClientRect()
    const width = rect.width || 800
    const height = rect.height || 600
    const points = graph.nodes.map(positionOf)
    const minX = Math.min(...points.map(point => point.x))
    const minY = Math.min(...points.map(point => point.y))
    const spanX = Math.max(...points.map(point => point.x)) + NODE_WIDTH - minX
    const spanY = Math.max(...points.map(point => point.y)) + FIT_NODE_HEIGHT - minY
    const zoom = clampZoom(Math.min((width - 80) / spanX, (height - 80) / spanY, 1))
    setViewport({ x: (width - spanX * zoom) / 2 - minX * zoom, y: (height - spanY * zoom) / 2 - minY * zoom, zoom })
  }, [graph, positionOf])

  useEffect(() => {
    if (layoutReady && needsFit.current && graph !== null && graph.nodes.length > 0) {
      needsFit.current = false
      autoFit.current = true
      fit()
    }
  }, [layoutReady, graph, fit])

  // The canvas can change size after the first fit, for example when the right panel opens; keep the automatic fit.
  const fitRef = useRef(fit)
  fitRef.current = fit
  useEffect(() => {
    const element = container.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { if (autoFit.current) fitRef.current() })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  // Escape closes the floating editor wherever focus is.
  useEffect(() => {
    if (editing === null) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setEditing(null) }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [editing])

  /** Pan so a node sits at the center of the canvas, keeping the zoom. */
  const centerOn = useCallback((node: CanvasNode) => {
    const rect = container.current?.getBoundingClientRect()
    const position = positionsRef.current[node.id] ?? { x: node.x, y: node.y }
    autoFit.current = false
    setViewport(current => ({
      ...current,
      x: (rect?.width || 800) / 2 - (position.x + NODE_WIDTH / 2) * current.zoom,
      y: (rect?.height || 600) / 2 - (position.y + nodeHeight(node) / 2) * current.zoom,
    }))
  }, [])

  // Open and center the node of a record that `dv:canvas-focus` asked for, once the layout and the graph are loaded.
  const [focusRequest, setFocusRequest] = useState(0)
  useEffect(() => {
    const listener = (): void => { setFocusRequest(count => count + 1) }
    focusListeners.add(listener)
    return () => { focusListeners.delete(listener) }
  }, [])
  useEffect(() => {
    if (pendingFocus === null || !layoutReady || graph === null) return
    // The record's own node, else the story bible or plan node whose version it wrote, else the node of its first output.
    const recordId = pendingFocus
    const firstOutput = graph.state.components.proj.records.find(record => record.id === recordId)?.outputs[0]
    const outputNode = firstOutput === undefined ? undefined : graph.assetNodes[firstOutput]
    const node = graph.nodes.find(candidate => candidate.id === recordId)
      ?? graph.nodes.find(candidate => candidate.record?.id === recordId)
      ?? graph.nodes.find(candidate => graph.state.components.plan.plans[candidate.planId ?? '']?.some(version => version.created_by === recordId))
      ?? graph.nodes.find(candidate => candidate.id === outputNode)
    pendingFocus = null
    if (node === undefined) return
    centerOn(node)
    setSelected(node.id)
    setEditing(node.id)
  }, [focusRequest, layoutReady, graph, centerOn])

  /** Move a node to a canvas point and store the position. */
  const placeNode = useCallback((id: string, position: NodePosition) => {
    setPositions(all => ({ ...all, [id]: position }))
    setTopNode(id)
    moved.current.add(id)
    scheduleSave()
  }, [scheduleSave])

  // Place dropped assets whose nodes have appeared.
  const graphRef = useRef(graph)
  graphRef.current = graph
  const placePending = useCallback(() => {
    const current = graphRef.current
    if (current === null) return
    for (const [assetId, position] of pendingDrops.current) {
      const id = current.assetNodes[assetId]
      if (id === undefined) continue
      pendingDrops.current.delete(assetId)
      placeNode(id, position)
    }
  }, [placeNode])
  useEffect(() => { placePending() }, [graph, placePending])

  // Store a free spot for every node without a stored position. The ref is updated at once so that the reveal of a new
  // take below centers on the stored spot; an earlier queued position, such as a dropped asset's, wins over the free spot.
  useEffect(() => {
    if (!layoutReady || graph === null) return
    const added = freePositions(graph.nodes, positionsRef.current, node => nodeHeight(node, true))
    if (Object.keys(added).length === 0) return
    positionsRef.current = { ...added, ...positionsRef.current }
    setPositions(all => ({ ...added, ...all }))
    void client.updateLayout(projectId, { positions: added }).catch(() => null)
  }, [layoutReady, graph, client, projectId])

  // Reveal the take a render started: close the editor, center the new node, and select it.
  const awaitedRender = useRef<AwaitedRender | null>(null)
  const [retryingFrom, setRetryingFrom] = useState<string | null>(null)
  useEffect(() => {
    const awaited = awaitedRender.current
    if (awaited === null || graph === null) return
    const node = graph.nodes.find(candidate => candidate.kind === 'take' && candidate.record?.based_on === awaited.basedOn && !awaited.known.has(candidate.id))
    if (node === undefined) return
    awaitedRender.current = null
    setRetryingFrom(null)
    setEditing(null)
    setSelected(node.id)
    centerOn(node)
    awaited.resolve()
  }, [graph, centerOn])

  // Load the opened takes once the graph is there, and count the take an editor opens as opened.
  const seenIds = seen?.project === projectId ? seen.ids : null
  useEffect(() => {
    if (graph === null) return
    if (seenIds === null) {
      const ids = readSeen(projectId) ?? new Set(graph.nodes.filter(isFinishedTake).map(node => node.id))
      writeSeen(projectId, ids)
      setSeen({ project: projectId, ids })
      return
    }
    const opened = editing === null ? undefined : graph.nodes.find(node => node.id === editing)
    if (opened === undefined || !isFinishedTake(opened) || seenIds.has(opened.id)) return
    const ids = new Set(seenIds).add(opened.id)
    writeSeen(projectId, ids)
    setSeen({ project: projectId, ids })
  }, [graph, seenIds, editing, projectId])

  useEffect(() => {
    const element = container.current
    if (element === null) return
    /** Zoom around the cursor; registered natively because React's wheel listener is passive. */
    const onWheel = (event: WheelEvent): void => {
      // A wheel over a scroll island, such as the floating node editor, scrolls that overlay instead of the canvas.
      if (event.target instanceof Element && event.target.closest('[data-dv-scroll-island]') !== null) return
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      autoFit.current = false
      setViewport((current) => {
        const zoom = clampZoom(current.zoom * wheelZoomFactor(event))
        return { zoom, x: px - (px - current.x) / current.zoom * zoom, y: py - (py - current.y) / current.zoom * zoom }
      })
      scheduleSave()
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => { element.removeEventListener('wheel', onWheel) }
  }, [scheduleSave])

  const capture = (event: ReactPointerEvent): void => {
    const element = container.current
    if (element !== null && typeof element.setPointerCapture === 'function') {
      try {
        element.setPointerCapture(event.pointerId)
      } catch (error) {
        // A synthetic pointer without an active pointer ID cannot be captured; the gesture still works inside the canvas.
        void error
      }
    }
  }
  const onBackgroundDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    gesture.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, origin: viewportRef.current, moved: false }
    capture(event)
  }
  const onNodeDown = (node: CanvasNode) => (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    gesture.current = { kind: 'node', id: node.id, startX: event.clientX, startY: event.clientY, origin: positionOf(node), moved: false }
    capture(event)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = gesture.current
    if (current === null) return
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    if (!current.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
    if (!current.moved && current.kind === 'node') setTopNode(current.id)
    current.moved = true
    if (current.kind === 'pan') {
      autoFit.current = false
      setViewport({ ...current.origin, x: current.origin.x + dx, y: current.origin.y + dy })
      return
    }
    const zoom = viewportRef.current.zoom
    setPositions(all => ({ ...all, [current.id]: { x: current.origin.x + dx / zoom, y: current.origin.y + dy / zoom } }))
  }
  const onPointerUp = (): void => {
    const current = gesture.current
    gesture.current = null
    if (current === null) return
    if (current.kind === 'node' && !current.moved) {
      setSelected(current.id)
      setEditing(current.id)
      return
    }
    // A click on empty canvas closes the floating editor, or clears the selection when no editor is open.
    if (current.kind === 'pan' && !current.moved) {
      if (editing === null) setSelected(null)
      else setEditing(null)
      return
    }
    if (current.kind === 'node') moved.current.add(current.id)
    scheduleSave()
  }
  const zoomBy = (factor: number): void => {
    autoFit.current = false
    const element = container.current
    const rect = element?.getBoundingClientRect()
    const cx = (rect?.width ?? 800) / 2
    const cy = (rect?.height ?? 600) / 2
    setViewport((current) => {
      const zoom = clampZoom(current.zoom * factor)
      return { zoom, x: cx - (cx - current.x) / current.zoom * zoom, y: cy - (cy - current.y) / current.zoom * zoom }
    })
    scheduleSave()
  }
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setNotice(null)
    try {
      await work()
    } catch (error) {
      setNotice(t('error', { message: error instanceof Error ? error.message : String(error) }))
    }
  }
  /**
   * Start a render of a new take and wait for its node. The request itself returns when the render ends, so the canvas
   * reveals the new take as soon as the project state shows its node. When the request returns first, as for a take that
   * the canvas does not draw, the editor closes then.
   * @param request - the render request; its `based_on` is the take it renders again.
   * @returns settles once the new take is revealed; rejects with the error of a request that fails before that.
   */
  const startRender = (request: OperationRequest & { based_on: string }): Promise<void> => new Promise((resolve, reject) => {
    const known = new Set(graphRef.current?.nodes.map(node => node.id) ?? [])
    const awaited: AwaitedRender = { basedOn: request.based_on, known, resolve }
    awaitedRender.current = awaited
    setNotice(null)
    client.runOperation(request).then(() => {
      if (awaitedRender.current !== awaited) return
      awaitedRender.current = null
      setRetryingFrom(null)
      setEditing(null)
      resolve()
    }, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (awaitedRender.current !== awaited) { setNotice(t('error', { message })); return }
      awaitedRender.current = null
      setRetryingFrom(null)
      reject(new Error(message))
    })
  })
  /**
   * Render a failed take again: its own operation, inputs, and params, as a new take based on it. This is the request
   * the take editor's 渲染新版本 sends when nothing was edited.
   * @param node - the failed take's node.
   */
  const retryTake = (node: CanvasNode): void => {
    const record = node.record
    const operation = record?.operation ?? null
    if (record === null || operation === null) return
    setRetryingFrom(record.id)
    startRender({
      project: projectId, operation, inputs: record.inputs.map(input => ({ role: input.role, ref: referenceText(input.ref) })),
      params: record.params, surface: 'canvas', intent: t('intent.retryTake', { title: nodeTitle(node, t) }), based_on: record.id,
      ...session === null ? {} : { session },
    }).catch((error: unknown) => { setNotice(t('error', { message: error instanceof Error ? error.message : String(error) })) })
  }
  const accepts = (event: ReactDragEvent): boolean => event.dataTransfer.types.includes(DV_ASSET_DRAG_TYPE) || event.dataTransfer.types.includes('Files')
  // A drag the canvas accepts stops here, so the chat composer's document-level file listeners neither show their drop
  // overlay nor attach the dropped files.
  const onDragEnter = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!accepts(event)) return
    event.preventDefault()
    event.stopPropagation()
  }
  const onDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!accepts(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }
  /**
   * Place a dropped 素材 tile's asset on the canvas with its node under the pointer, or import dropped image and video
   * files and place their nodes there.
   * @param event - the drop event.
   */
  const onDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    setDragOver(false)
    if (!accepts(event)) return
    event.preventDefault()
    event.stopPropagation()
    const rect = container.current?.getBoundingClientRect()
    const view = viewportRef.current
    const point = {
      x: (event.clientX - (rect?.left ?? 0) - view.x) / view.zoom - NODE_WIDTH / 2,
      y: (event.clientY - (rect?.top ?? 0) - view.y) / view.zoom - DROP_OFFSET_Y,
    }
    setNotice(null)
    const assetId = event.dataTransfer.getData(DV_ASSET_DRAG_TYPE)
    if (assetId !== '') {
      const id = graph?.assetNodes[assetId]
      if (id !== undefined) { placeNode(id, point); return }
      // Any other asset of the asset pool panel goes on the canvas, with its node under the pointer.
      pendingDrops.current.set(assetId, point)
      void run(() => changePlacement(assetId, true))
      return
    }
    Array.from(event.dataTransfer.files).forEach((file, index) => {
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) { setNotice(t('drop.notMedia', { name: file.name })); return }
      const position = { x: point.x + index * 32, y: point.y + index * 32 }
      void run(async () => {
        // An import from the canvas also puts the asset on the canvas.
        const assetId = (await client.importAsset(projectId, file, 'canvas', session)).asset
        pendingDrops.current.set(assetId, position)
      })
    })
  }

  // The surface is the app background under a dot grid that pans and zooms with the nodes.
  const grid = GRID * viewport.zoom
  const root: CSSProperties = {
    position: 'relative', width: '100%', height: '100%', minHeight: 320, overflow: 'hidden', backgroundColor: 'var(--dv-bg)',
    color: 'var(--dv-text)', fontFamily: 'var(--dv-font-sans)', fontSize: 13, lineHeight: '20px',
    backgroundImage: 'radial-gradient(var(--dv-grid) 1px, transparent 1px)',
    backgroundSize: `${String(grid)}px ${String(grid)}px`, backgroundPosition: `${String(viewport.x)}px ${String(viewport.y)}px`,
    cursor: gesture.current?.kind === 'pan' ? 'grabbing' : 'default', touchAction: 'none',
    boxShadow: dragOver ? 'inset 0 0 0 2px var(--dv-accent)' : 'none',
  }
  const floating: CSSProperties = {
    background: 'var(--dv-surface-2)', boxShadow: '0 0 0 1px var(--dv-line-strong), var(--dv-shadow-1)', zIndex: 5,
  }
  const toolButton: CSSProperties = {
    height: 28, minWidth: 28, border: 'none', borderRadius: 'var(--dv-radius-sm)', color: 'var(--dv-text-2)', padding: '0 6px', cursor: 'pointer',
    fontFamily: 'inherit', fontSize: 12, lineHeight: '16px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  }
  const centered: CSSProperties = { position: 'absolute', inset: 0, margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', fontSize: 14, lineHeight: '22px', color: 'var(--dv-text-2)' }
  let content: ReactNode = null
  if (graph === null) {
    content = <p style={centered}>{base.error !== null ? t('error', { message: base.error }) : t('loading')}</p>
  } else if (graph.nodes.length === 0) {
    content = <p style={{ ...centered, pointerEvents: 'none' }}>{t('canvas.empty')}</p>
  } else {
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    const heightOf = (node: CanvasNode): number => nodeHeight(node, plans.get(node.id)?.frames.some(frame => frame !== null) === true)
    // The selected node's edges are drawn last, so they stay on top of the others.
    const touchesSelected = (edge: CanvasEdge): boolean => selected !== null && (edge.from === selected || edge.to === selected)
    const edges = [...graph.edges.filter(edge => !touchesSelected(edge)), ...graph.edges.filter(touchesSelected)]
    content = (
      <div style={{ position: 'absolute', left: 0, top: 0, transform: `translate(${String(viewport.x)}px, ${String(viewport.y)}px) scale(${String(viewport.zoom)})`, transformOrigin: '0 0' }}>
        <svg style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }} aria-hidden="true">
          {edges.map((edge) => {
            const from = byId.get(edge.from)
            const to = byId.get(edge.to)
            if (from === undefined || to === undefined) return null
            const a = positionOf(from)
            const b = positionOf(to)
            const x1 = a.x + NODE_WIDTH
            const y1 = a.y + heightOf(from) / 2
            const x2 = b.x
            const y2 = b.y + heightOf(to) / 2
            const bend = Math.max(40, Math.abs(x2 - x1) / 2)
            const highlighted = touchesSelected(edge)
            return (
              <path
                key={`${edge.from}>${edge.to}`}
                d={`M ${String(x1)} ${String(y1)} C ${String(x1 + bend)} ${String(y1)}, ${String(x2 - bend)} ${String(y2)}, ${String(x2)} ${String(y2)}`}
                fill="none"
                style={{ stroke: highlighted ? 'var(--dv-accent)' : EDGE_COLOR[edge.kind], strokeOpacity: highlighted ? 0.9 : 0.6 }}
                strokeWidth={highlighted ? 2 : 1.5}
                vectorEffect="non-scaling-stroke"
                strokeDasharray={edge.kind === 'take' ? '6 5' : undefined}
                data-edge={`${edge.from}>${edge.to}`}
              />
            )
          })}
        </svg>
        {[...graph.nodes.filter(node => node.id !== topNode), ...graph.nodes.filter(node => node.id === topNode)].map((node) => {
          const position = positionOf(node)
          const plan = plans.get(node.id)
          return (
            <NodeCard
              key={node.id}
              node={node}
              x={position.x}
              y={position.y}
              selected={node.id === selected}
              zoom={viewport.zoom}
              t={t}
              onPointerDown={onNodeDown(node)}
              {...plan === undefined ? {} : { plan: plan.latest, frames: plan.frames }}
              {...node.kind === 'take' && node.flags.failed ? { onRetry: () => { retryTake(node) }, retrying: retryingFrom === node.id } : {}}
              unseen={seenIds !== null && isFinishedTake(node) && !seenIds.has(node.id)}
            />
          )
        })}
      </div>
    )
  }
  // The editor on screen lags `editing` while it shrinks back into its node.
  const nodeCard = (id: string): Element | null =>
    [...container.current?.querySelectorAll('[data-node-id]') ?? []].find(card => card.getAttribute('data-node-id') === id) ?? null
  const editorZoom = useZoomPresence(editing, nodeCard)
  const editingNode = graph?.nodes.find(node => node.id === editorZoom.shown) ?? null
  return (
    <div
      ref={container}
      style={root}
      data-testid="dv-canvas-view"
      aria-label={t('canvas.aria')}
      onPointerDown={onBackgroundDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragOver(false) }}
      onDrop={onDrop}
    >
      <style>{CANVAS_CSS}</style>
      {content}
      {notice !== null ? <p role="alert" style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', margin: 0, padding: '6px 10px', borderRadius: 'var(--dv-radius-md)', background: 'var(--dv-surface-1)', border: '1px solid var(--dv-danger)', color: 'var(--dv-danger)', fontSize: 13, lineHeight: '20px', zIndex: 6 }}>{notice}</p> : null}
      <div role="toolbar" aria-label={t('canvas.zoom')} style={{ ...floating, position: 'absolute', left: 16, bottom: 16, display: 'flex', alignItems: 'center', gap: 2, padding: 4, borderRadius: 10 }} onPointerDown={(event) => { event.stopPropagation() }}>
        <button type="button" className="dv-canvas-btn" aria-label={t('canvas.zoomOut')} title={t('canvas.zoomOut')} style={toolButton} onClick={() => { zoomBy(1 / 1.2) }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
        </button>
        <span style={{ minWidth: 44, textAlign: 'center', fontFamily: 'var(--dv-font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 12, lineHeight: '16px', color: 'var(--dv-text-2)' }}>{`${String(Math.round(viewport.zoom * 100))}%`}</span>
        <button type="button" className="dv-canvas-btn" aria-label={t('canvas.zoomIn')} title={t('canvas.zoomIn')} style={toolButton} onClick={() => { zoomBy(1.2) }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <button type="button" className="dv-canvas-btn" style={{ ...toolButton, padding: '0 8px' }} onClick={() => { autoFit.current = true; fit(); scheduleSave() }}>{t('canvas.fit')}</button>
      </div>
      {editingNode !== null && graph !== null
        ? <div ref={editorZoom.fadeRef} aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'var(--dv-overlay)', zIndex: 9 }} />
        : null}
      {editingNode !== null && graph !== null
        ? (
          <NodeEditor
            key={editingNode.id}
            node={editingNode}
            zoomRef={editorZoom.targetRef}
            state={graph.state}
            client={client}
            project={projectId}
            session={session}
            t={t}
            onClose={() => { setEditing(null) }}
            run={run}
            onRender={startRender}
            onRemoveFromCanvas={(assetId) => {
              setEditing(null)
              setSelected(null)
              void run(() => changePlacement(assetId, false))
            }}
          />
        )
        : null}
    </div>
  )
}
