/**
 * The project canvas as a standalone component: an infinite surface of entity, reference, plan, and clip nodes. Drag
 * empty space to pan, scroll to zoom around the cursor, drag a node to move it, click a node to open its floating
 * editor. Node positions and the viewport are stored per project through `/api/vh/layout`. An open agent draft is
 * overlaid with dashed nodes and a bar to accept or discard it. Colors come from the DSH theme tokens, so the canvas follows
 * the app's light and dark themes. Dropping a 素材 tile places that asset's node under the pointer; dropping image or
 * video files uploads them and places their nodes there.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { VhClient } from '@video-harness/ui-kit/api.ts'
import { useLanguage } from '@video-harness/ui-kit/locale.ts'
import { openDrafts } from '@video-harness/ui-kit/state.ts'
import { ToolApi } from '@video-harness/ui-kit/tool-api.ts'
import { VH_ASSET_DRAG_TYPE } from '@video-harness/ui-kit/workspace-events.ts'
import type { VhWorkspaceEventMap } from '@video-harness/ui-kit/workspace-events.ts'
import { useProjectState } from '@video-harness/ui-kit/useProject.ts'
import { buildCanvasGraph, NODE_WIDTH, overlayDraft, ROW, withUploadNames } from './graph.ts'
import type { CanvasEdge, CanvasNode } from './graph.ts'
import { loadLayout, saveLayout } from './layout-api.ts'
import type { CanvasViewport, NodePosition } from './layout-api.ts'
import { NodeCard } from './NodeCard.tsx'
import type { CanvasTranslate } from './NodeCard.tsx'
import { NodeEditor } from './NodeEditor.tsx'
import { en, zh } from './locales.ts'

/** Props of {@link CanvasView}. */
export interface CanvasViewProps {
  /** The project to draw. */
  projectId: string
  /** The branch to draw; `main` when omitted. A `draft/*` branch is drawn read-only. */
  branch?: string
  /** The API client; a same-origin client when omitted. */
  client?: VhClient
  /** The `vhCanvas` translate; when omitted, the dictionary of the DSH interface language that `<html lang>` names. */
  t?: CanvasTranslate
}

/** Approximate rendered node height, used for edge anchors. */
const NODE_HEIGHT = 260
/** The tallest a card grows (larger text at low zoom plus a badge row), used when fitting. */
const FIT_NODE_HEIGHT = ROW - 20
/** How far above the pointer a dropped node's top edge lands, in canvas units, so the pointer rests on its header. */
const DROP_OFFSET_Y = 40
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2
const DRAG_THRESHOLD = 4
const SAVE_DELAY_MS = 500

/** Edge stroke per kind, dark enough to read on the light canvas and bright enough on the dark one. */
const EDGE_COLOR: Record<CanvasEdge['kind'], string> = { ref: '#d0568f', frame: '#2fa66d', plan: '#e08a2e', take: 'var(--dsw-alias-label-tertiary)' }

/**
 * A translate over one `vhCanvas` dictionary, for hosts that mount the canvas without a locale binding.
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

// A `vh:canvas-focus` request usually arrives while the canvas is unmounted (the shell mounts it in response), so the
// module keeps the latest requested record until a mounted canvas consumes it.
let pendingFocus: string | null = null
const focusListeners = new Set<() => void>()
if (typeof window !== 'undefined') {
  window.addEventListener('vh:canvas-focus', (event) => {
    pendingFocus = (event as CustomEvent<VhWorkspaceEventMap['vh:canvas-focus']>).detail.opId
    for (const listener of focusListeners) listener()
  })
}

const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
const layoutFetch: typeof fetch = (input, init) => fetch(input, init)

/** An in-progress pointer gesture. */
type Gesture =
  | { kind: 'pan'; startX: number; startY: number; origin: CanvasViewport; moved: boolean }
  | { kind: 'node'; id: string; startX: number; startY: number; origin: NodePosition; moved: boolean }

/**
 * The canvas.
 * @param props - the project, branch, and optional client and translate.
 * @returns the element.
 */
export function CanvasView({ projectId, branch = 'main', client: given, t: givenT }: CanvasViewProps): ReactNode {
  const client = useMemo(() => given ?? new VhClient(), [given])
  const language = useLanguage()
  const t = givenT ?? translates[language]
  const readOnly = branch.startsWith('draft/')
  const base = useProjectState(client, projectId, branch)
  const draft = readOnly || base.value === null ? null : openDrafts(base.value).at(-1) ?? null
  const draftState = useProjectState(client, draft === null ? null : projectId, draft?.branch ?? branch)
  const graph = useMemo(() => {
    if (base.value === null) return null
    const overlay = draft === null ? null : draftState.value
    const known = new Set(base.value.ops.map(op => op.id))
    const draftOps = new Set((overlay?.ops ?? []).filter(op => !known.has(op.id)).map(op => op.id))
    const state = withUploadNames(overlayDraft(base.value, overlay))
    return { state, ...buildCanvasGraph(state, draftOps) }
  }, [base.value, draft, draftState.value])

  const [positions, setPositions] = useState<Record<string, NodePosition>>({})
  const [viewport, setViewport] = useState<CanvasViewport>({ x: 40, y: 40, zoom: 1 })
  const [layoutReady, setLayoutReady] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
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
  // Uploaded or dropped assets waiting for their node to appear, with the canvas point they were dropped at.
  const pendingDrops = useRef(new Map<string, NodePosition>())
  const [dragOver, setDragOver] = useState(false)
  // The node the user last dragged or dropped is drawn above the others.
  const [topNode, setTopNode] = useState<string | null>(null)
  const tools = useMemo(() => new ToolApi(), [])

  useEffect(() => {
    let live = true
    setLayoutReady(false)
    void loadLayout(layoutFetch, projectId).then((layout) => {
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
  }, [projectId])

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
      void saveLayout(layoutFetch, projectId, { positions: patch, viewport: viewportRef.current })
    }, SAVE_DELAY_MS)
  }, [projectId])

  const positionOf = useCallback((node: CanvasNode): NodePosition => positions[node.id] ?? { x: node.x, y: node.y }, [positions])

  /** Pan and zoom so every node is visible. */
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
    const zoom = clampZoom(Math.min((width - 80) / spanX, (height - 80) / spanY, 1.25))
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
    if (selected === null) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setSelected(null) }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [selected])

  // Open and center the node of a record that `vh:canvas-focus` asked for, once the layout and the graph are loaded.
  const [focusRequest, setFocusRequest] = useState(0)
  useEffect(() => {
    const listener = (): void => { setFocusRequest(count => count + 1) }
    focusListeners.add(listener)
    return () => { focusListeners.delete(listener) }
  }, [])
  useEffect(() => {
    if (pendingFocus === null || !layoutReady || graph === null) return
    const node = graph.nodes.find(candidate => candidate.id === pendingFocus)
    pendingFocus = null
    if (node === undefined) return
    const rect = container.current?.getBoundingClientRect()
    const position = positionsRef.current[node.id] ?? { x: node.x, y: node.y }
    autoFit.current = false
    setViewport(current => ({
      ...current,
      x: (rect?.width || 800) / 2 - (position.x + NODE_WIDTH / 2) * current.zoom,
      y: (rect?.height || 600) / 2 - (position.y + NODE_HEIGHT / 2) * current.zoom,
    }))
    setSelected(node.id)
  }, [focusRequest, layoutReady, graph])

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

  useEffect(() => {
    const element = container.current
    if (element === null) return
    /** Zoom around the cursor; registered natively because React's wheel listener is passive. */
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      autoFit.current = false
      setViewport((current) => {
        const zoom = clampZoom(current.zoom * Math.exp(-event.deltaY * 0.0015))
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
      select(current.id)
      return
    }
    // A click on empty canvas closes the floating editor.
    if (current.kind === 'pan' && !current.moved) {
      setSelected(null)
      return
    }
    if (current.kind === 'node') moved.current.add(current.id)
    scheduleSave()
  }
  const select = (id: string): void => {
    setSelected(id)
    const entity = id.startsWith('entity:')
    void client.select({ project: projectId, kind: entity ? 'entity' : 'op', id: entity ? id.slice('entity:'.length) : id, surface: 'canvas' }).catch(() => {})
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
  const accepts = (event: ReactDragEvent): boolean => event.dataTransfer.types.includes(VH_ASSET_DRAG_TYPE) || event.dataTransfer.types.includes('Files')
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
   * Place a dropped 素材 tile's node under the pointer, or upload dropped image and video files and place their nodes.
   * @param event - the drop event.
   */
  const onDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    setDragOver(false)
    if (!accepts(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (readOnly) { setNotice(t('drop.readOnly')); return }
    const rect = container.current?.getBoundingClientRect()
    const view = viewportRef.current
    const point = {
      x: (event.clientX - (rect?.left ?? 0) - view.x) / view.zoom - NODE_WIDTH / 2,
      y: (event.clientY - (rect?.top ?? 0) - view.y) / view.zoom - DROP_OFFSET_Y,
    }
    setNotice(null)
    const assetId = event.dataTransfer.getData(VH_ASSET_DRAG_TYPE)
    if (assetId !== '') {
      const id = graph?.assetNodes[assetId]
      if (id === undefined) setNotice(t('drop.noNode'))
      else placeNode(id, point)
      return
    }
    Array.from(event.dataTransfer.files).forEach((file, index) => {
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) { setNotice(t('drop.notMedia', { name: file.name })); return }
      const position = { x: point.x + index * 32, y: point.y + index * 32 }
      void run(async () => {
        pendingDrops.current.set(await tools.upload(projectId, file), position)
        placePending()
      })
    })
  }

  // The surface is the app background tinted one step darker (lighter in the dark theme), under a dot grid that pans and zooms.
  const grid = 24 * viewport.zoom
  const root: CSSProperties = {
    position: 'relative', width: '100%', height: '100%', minHeight: 320, overflow: 'hidden', backgroundColor: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    backgroundImage: 'radial-gradient(var(--dsw-alias-border-l3) 1.2px, transparent 1.2px), linear-gradient(var(--dsw-alias-interactive-bg-hover), var(--dsw-alias-interactive-bg-hover))',
    backgroundSize: `${String(grid)}px ${String(grid)}px, auto`, backgroundPosition: `${String(viewport.x)}px ${String(viewport.y)}px, 0 0`,
    cursor: gesture.current?.kind === 'pan' ? 'grabbing' : 'default', touchAction: 'none',
    boxShadow: dragOver ? 'inset 0 0 0 2px var(--dsw-alias-button-primary-fill)' : 'none',
  }
  const floating: CSSProperties = {
    background: 'var(--dsw-alias-bg-layer-3)', border: '1px solid var(--dsw-alias-border-l3)', boxShadow: '0 4px 14px rgba(0, 0, 0, 0.08)', zIndex: 5,
  }
  const toolButton: CSSProperties = { border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-primary)', padding: '6px 10px', cursor: 'pointer', font: 'inherit' }
  const primaryButton: CSSProperties = { ...toolButton, background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-inverted)', fontWeight: 600 }
  const secondaryButton: CSSProperties = { ...toolButton, background: 'var(--dsw-alias-interactive-bg-hover)' }
  const centered: CSSProperties = { position: 'absolute', inset: 0, margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', fontSize: 14, color: 'var(--dsw-alias-label-tertiary)' }
  let content: ReactNode = null
  if (graph === null) {
    content = <p style={centered}>{base.error !== null ? t('error', { message: base.error }) : t('loading')}</p>
  } else if (graph.nodes.length === 0) {
    content = <p style={{ ...centered, pointerEvents: 'none' }}>{t('canvas.empty')}</p>
  } else {
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    content = (
      <div style={{ position: 'absolute', left: 0, top: 0, transform: `translate(${String(viewport.x)}px, ${String(viewport.y)}px) scale(${String(viewport.zoom)})`, transformOrigin: '0 0' }}>
        <svg style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }} aria-hidden="true">
          {graph.edges.map((edge) => {
            const from = byId.get(edge.from)
            const to = byId.get(edge.to)
            if (from === undefined || to === undefined) return null
            const a = positionOf(from)
            const b = positionOf(to)
            const x1 = a.x + NODE_WIDTH
            const y1 = a.y + NODE_HEIGHT / 2
            const x2 = b.x
            const y2 = b.y + NODE_HEIGHT / 2
            const bend = Math.max(40, Math.abs(x2 - x1) / 2)
            return (
              <path
                key={`${edge.from}>${edge.to}`}
                d={`M ${String(x1)} ${String(y1)} C ${String(x1 + bend)} ${String(y1)}, ${String(x2 - bend)} ${String(y2)}, ${String(x2)} ${String(y2)}`}
                fill="none"
                style={{ stroke: EDGE_COLOR[edge.kind] }}
                strokeWidth={2.5}
                strokeDasharray={edge.kind === 'take' ? '6 5' : undefined}
                data-edge={`${edge.from}>${edge.to}`}
              />
            )
          })}
        </svg>
        {[...graph.nodes.filter(node => node.id !== topNode), ...graph.nodes.filter(node => node.id === topNode)].map((node) => {
          const position = positionOf(node)
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
            />
          )
        })}
      </div>
    )
  }
  const editing = graph?.nodes.find(node => node.id === selected) ?? null
  return (
    <div
      ref={container}
      style={root}
      data-testid="vh-canvas-view"
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
      {content}
      {draft !== null
        ? (
          <div style={{ ...floating, position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px 6px 12px', borderRadius: 10, border: '1px dashed var(--dsw-alias-label-tertiary)', fontSize: 13 }} onPointerDown={(event) => { event.stopPropagation() }}>
            <span>{t('draft.bar', { intent: draft.intent })}</span>
            <button type="button" style={primaryButton} onClick={() => { void run(() => client.turn(projectId, draft.turn, 'accept', 'canvas')) }}>{t('draft.accept')}</button>
            <button type="button" style={secondaryButton} onClick={() => { void run(() => client.turn(projectId, draft.turn, 'reject', 'canvas')) }}>{t('draft.reject')}</button>
          </div>
        )
        : null}
      {notice !== null ? <p role="alert" style={{ position: 'absolute', top: 56, left: '50%', transform: 'translateX(-50%)', margin: 0, padding: '6px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-3)', border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, zIndex: 6 }}>{notice}</p> : null}
      <div style={{ ...floating, position: 'absolute', left: 12, bottom: 12, display: 'flex', alignItems: 'center', gap: 2, padding: 3, borderRadius: 10, fontSize: 13 }} onPointerDown={(event) => { event.stopPropagation() }}>
        <button type="button" aria-label={t('canvas.zoomOut')} style={toolButton} onClick={() => { zoomBy(1 / 1.2) }}>−</button>
        <span style={{ minWidth: 44, textAlign: 'center' }}>{`${String(Math.round(viewport.zoom * 100))}%`}</span>
        <button type="button" aria-label={t('canvas.zoomIn')} style={toolButton} onClick={() => { zoomBy(1.2) }}>＋</button>
        <button type="button" style={toolButton} onClick={() => { autoFit.current = true; fit(); scheduleSave() }}>{t('canvas.fit')}</button>
      </div>
      {editing !== null && graph !== null
        ? (
          <NodeEditor
            key={editing.id}
            node={editing}
            state={graph.state}
            client={client}
            project={projectId}
            branch={branch}
            readOnly={readOnly}
            t={t}
            onClose={() => { setSelected(null) }}
            run={run}
          />
        )
        : null}
    </div>
  )
}
