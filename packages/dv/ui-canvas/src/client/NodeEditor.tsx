/**
 * The editor a canvas node opens: a panel over a dimmed canvas that opens centered in the canvas (720 px wide at most,
 * about 80% of the canvas height). Dragging the header's title row moves the panel, the bottom-right corner and the
 * right and bottom edges resize it, and a double click on the title row puts it back at the centered default. The last
 * position and size are kept in `localStorage` for every node and fitted into the canvas when restored. Every node offers
 * "问 agent" (a `dv:compose` event that prefills the chat composer). A take shows a large player, the failure reason of a
 * failed take, its render mode, its prompt, reference chips (`ref2va` only), duration, and seed, and offers "渲染新版本"
 * (a user record of the take's render operation, `shot.render_ref2va` or `shot.render_t2va`, whose `based_on` is the
 * take). A character, location or style can replace its reference image. A plan switches between its versions (第 1 版,
 * 第 2 版, …) and shows the chosen version's approval status, its reference images, and one card per shot with exactly
 * what the plan holds: duration, render mode, reference images, whether the shot continues the previous shot, and the
 * full prompt with each `Picture N` drawn as its image. A stale node offers "仍然保留", which keeps its record as it is
 * (`proj.stale_accept`).
 */
import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { assetUrl } from '@dv/ui-kit/api.ts'
import type { DvClient } from '@dv/ui-kit/api.ts'
import { dispatchCompose, type DvComposeRef } from '@dv/ui-kit/compose.ts'
import { pictureParts, referenceImages, shotReferences } from '@dv/ui-kit/references.ts'
import { readStored, writeStored } from '@dv/ui-kit/storage.ts'
import { clockText } from '@dv/ui-kit/timeline.ts'
import type { PlanVersion, Shot, WireState } from '@dv/ui-kit/types.ts'
import { bibleItems, bibleVersions, referenceText } from './graph.ts'
import type { CanvasNode } from './graph.ts'
import { KIND_COLOR, kindLabel, mono, nodeTitle, planTotalSec } from './NodeCard.tsx'
import type { CanvasTranslate } from './NodeCard.tsx'

/** Props of {@link NodeEditor}. */
export interface NodeEditorProps {
  node: CanvasNode
  state: WireState
  client: DvClient
  project: string
  /** The chat session the canvas sits beside, recorded as the `session` of the editor's writes. */
  session: string | null
  t: CanvasTranslate
  onClose: () => void
  /** Run a write and report its failure. */
  run: (work: () => Promise<unknown>) => Promise<void>
  /** Take an asset off the project's canvas list; the asset stays in the asset pool. */
  onRemoveFromCanvas: (assetId: string) => void
}

/** The editor panel's position and size in px, relative to the canvas area's top-left corner. */
export interface EditorRect {
  x: number
  y: number
  width: number
  height: number
}

/** The size in px of the canvas area the editor panel sits in. */
export interface EditorArea {
  width: number
  height: number
}

/** The widest default panel, in px. */
const EDITOR_DEFAULT_WIDTH = 720
/** The space in px the default panel leaves on each side of the canvas area. */
const EDITOR_MARGIN = 24
/** The lowest panel height the default gives when the canvas area has room for it, in px. */
const EDITOR_DEFAULT_MIN_HEIGHT = 480
/** The smallest width a resize gives, in px; a narrower canvas area caps it at the area's width. */
const EDITOR_MIN_WIDTH = 480
/** The smallest height a resize gives, in px; a lower canvas area caps it at the area's height. */
const EDITOR_MIN_HEIGHT = 320
/** The length in px of the panel's header that a move keeps inside the canvas area, so the header stays draggable. */
const EDITOR_KEEP_VISIBLE = 48
/** The `localStorage` key of the last panel position and size, shared by every node. */
export const EDITOR_RECT_KEY = 'dv-canvas-editor-rect'

/**
 * Limit a number to a range; a range whose upper end is under its lower end yields the upper end.
 * @param value - the number.
 * @param low - the lower end.
 * @param high - the upper end.
 * @returns the limited number.
 */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

/**
 * The panel's default rectangle: centered in the canvas area, `min(720, width − 48)` wide, and about 80% of the area's
 * height but at least 480 px when the area has room for 480 px plus the 24 px margins.
 * @param area - the canvas area.
 * @returns the rectangle.
 */
export function defaultEditorRect(area: EditorArea): EditorRect {
  const width = Math.max(0, Math.min(EDITOR_DEFAULT_WIDTH, area.width - 2 * EDITOR_MARGIN))
  const height = Math.max(0, Math.min(area.height - 2 * EDITOR_MARGIN, Math.max(EDITOR_DEFAULT_MIN_HEIGHT, Math.round(area.height * 0.8))))
  return { x: Math.round((area.width - width) / 2), y: Math.round((area.height - height) / 2), width, height }
}

/**
 * Limit a panel size to the resize range: width between 480 px and the area's width, height between 320 px and the
 * area's height (an area smaller than the minimum caps the size at the area).
 * @param rect - the rectangle.
 * @param area - the canvas area.
 * @returns the rectangle with its size limited and its position unchanged.
 */
function limitSize(rect: EditorRect, area: EditorArea): EditorRect {
  return {
    ...rect,
    width: clamp(rect.width, Math.min(EDITOR_MIN_WIDTH, area.width), area.width),
    height: clamp(rect.height, Math.min(EDITOR_MIN_HEIGHT, area.height), area.height),
  }
}

/**
 * Limit a panel to the resize range and keep at least {@link EDITOR_KEEP_VISIBLE} px of its header inside the canvas
 * area: the top edge stays between the area's top and 48 px above its bottom, and 48 px of the width stay inside
 * horizontally.
 * @param rect - the rectangle.
 * @param area - the canvas area.
 * @returns the limited rectangle.
 */
export function clampEditorRect(rect: EditorRect, area: EditorArea): EditorRect {
  const sized = limitSize(rect, area)
  const keep = Math.min(EDITOR_KEEP_VISIBLE, sized.width)
  return {
    ...sized,
    x: clamp(sized.x, keep - sized.width, area.width - keep),
    y: clamp(sized.y, 0, Math.max(0, area.height - EDITOR_KEEP_VISIBLE)),
  }
}

/**
 * Fit a remembered panel into the canvas area: the size is limited to the resize range and the whole panel is moved
 * inside the area, so a rectangle stored under a larger window opens in full view.
 * @param rect - the remembered rectangle.
 * @param area - the canvas area.
 * @returns the fitted rectangle.
 */
export function fitEditorRect(rect: EditorRect, area: EditorArea): EditorRect {
  const sized = limitSize(rect, area)
  return { ...sized, x: clamp(sized.x, 0, area.width - sized.width), y: clamp(sized.y, 0, area.height - sized.height) }
}

/**
 * Move a panel by a pointer offset, keeping its header reachable (see {@link clampEditorRect}).
 * @param start - the rectangle when the move began.
 * @param dx - the horizontal pointer offset in px.
 * @param dy - the vertical pointer offset in px.
 * @param area - the canvas area.
 * @returns the moved rectangle.
 */
export function moveEditorRect(start: EditorRect, dx: number, dy: number, area: EditorArea): EditorRect {
  return clampEditorRect({ ...start, x: start.x + dx, y: start.y + dy }, area)
}

/**
 * Resize a panel from its right edge, its bottom edge, or both (the corner); the top-left corner stays in place. A
 * moving edge stops at the canvas edge so the corner handle stays visible, unless the minimum size needs more room.
 * @param start - the rectangle when the resize began.
 * @param dx - the width change in px; ignored when `edges` lacks the right edge.
 * @param dy - the height change in px; ignored when `edges` lacks the bottom edge.
 * @param edges - the edges that move.
 * @param area - the canvas area.
 * @returns the resized rectangle.
 */
export function resizeEditorRect(
  start: EditorRect, dx: number, dy: number, edges: { right: boolean; bottom: boolean }, area: EditorArea,
): EditorRect {
  return clampEditorRect({
    ...start,
    width: edges.right ? Math.min(start.width + dx, Math.max(EDITOR_MIN_WIDTH, area.width - start.x)) : start.width,
    height: edges.bottom ? Math.min(start.height + dy, Math.max(EDITOR_MIN_HEIGHT, area.height - start.y)) : start.height,
  }, area)
}

/**
 * The remembered panel rectangle, or null when there is none, it is malformed, or storage is unavailable.
 * @returns the rectangle.
 */
function readEditorRect(): EditorRect | null {
  const text = readStored('local', EDITOR_RECT_KEY)
  if (text === null) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    // A value another build wrote in a different format is ignored the same way.
    void error
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { x, y, width, height } = value as Partial<Record<keyof EditorRect, unknown>>
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') return null
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : null
}

/**
 * Remember the panel rectangle, or forget it when `rect` is null; a storage failure leaves the editor working.
 * @param rect - the rectangle, or null after a reset to the default.
 */
function writeEditorRect(rect: EditorRect | null): void {
  writeStored('local', EDITOR_RECT_KEY, rect === null ? null : JSON.stringify(rect))
}

/** The px a resize-handle arrow key adds to or takes from the panel's width or height. */
const RESIZE_STEP = 16

/** One pointer gesture on the panel: a move from the title row or a resize from a handle. */
interface PanelGesture {
  pointerId: number
  startX: number
  startY: number
  start: EditorRect
  /** Null for a move; the moving edges for a resize. */
  edges: { right: boolean; bottom: boolean } | null
}

// Editor styles draw on the `--dv-*` theme variables so the panel matches the app in the light and dark themes.
const panel: CSSProperties = {
  position: 'absolute', display: 'flex', flexDirection: 'column',
  overflow: 'hidden', background: 'var(--dv-surface-1)', color: 'var(--dv-text)', borderRadius: 'var(--dv-radius-xl)',
  boxShadow: '0 0 0 1px var(--dv-line-strong), var(--dv-shadow-2)', zIndex: 10, fontSize: 13, lineHeight: '20px',
}
const label: CSSProperties = { display: 'block', fontSize: 12, lineHeight: '16px', fontWeight: 500, color: 'var(--dv-text-2)', margin: '12px 0 4px' }
/** A reference image in a reference chip, and one that stands in a shot prompt for its Picture N token. */
const chipThumb: CSSProperties = { width: 24, height: 24, objectFit: 'cover', borderRadius: 'var(--dv-radius-sm)', flex: 'none' }
const promptThumb: CSSProperties = { height: '1.4em', width: 'auto', verticalAlign: 'middle', borderRadius: 3, margin: '0 2px' }
const field: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--dv-surface-2)', color: 'var(--dv-text)',
  border: '1px solid var(--dv-line-strong)', borderRadius: 'var(--dv-radius-md)', padding: '6px 8px', fontFamily: 'inherit', fontSize: 13, lineHeight: '20px',
}
const button: CSSProperties = {
  height: 32, border: 'none', borderRadius: 'var(--dv-radius-md)', padding: '0 12px', fontFamily: 'inherit', fontSize: 13, lineHeight: '20px', fontWeight: 500,
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}
/** A secondary button: 1px border, transparent fill (the `dv-canvas-btn` class paints the fill and the hover). */
const secondaryButton: CSSProperties = { ...button, border: '1px solid var(--dv-line-strong)', color: 'var(--dv-text)' }
const chip: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px 2px 2px', borderRadius: 14, background: 'var(--dv-surface-3)', fontSize: 13, lineHeight: '20px' }
const referenceImage: CSSProperties = { height: 220, borderRadius: 'var(--dv-radius-md)', background: 'var(--dv-surface-3)' }
/** A small rounded tag in the plan editor: the duration and render-mode chips of a shot. */
const tag: CSSProperties = { height: 22, padding: '0 8px', display: 'inline-flex', alignItems: 'center', fontSize: 12, lineHeight: '16px', background: 'var(--dv-surface-3)' }
/** The height a shot prompt is collapsed to until the reader expands it. */
const PROMPT_COLLAPSED_HEIGHT = 140

/**
 * The copy of a render mode.
 * @param mode - `ref2va` or `t2va`.
 * @param t - the canvas translate.
 * @returns 参考图生成 / From references or 文字生成 / From text.
 */
function modeLabel(mode: 'ref2va' | 't2va', t: CanvasTranslate): string {
  return mode === 't2va' ? t('mode.t2va') : t('mode.ref2va')
}

/** One input of the edited record. */
interface EditedInput {
  role: string
  ref: string
}

/**
 * The asset that shows a reference: the latest reference image of a character, location or style, or the asset itself.
 * @param state - the project state.
 * @param ref - reference text such as `hero@1` or an asset ID.
 * @returns the asset ID, or null.
 */
function refImage(state: WireState, ref: string): string | null {
  const bibleId = /^(.+)@\d+$/.exec(ref)?.[1]
  if (bibleId !== undefined) return bibleVersions(state, bibleId)?.at(-1)?.references[0] ?? null
  return state.assets.some(asset => asset.id === ref) ? ref : null
}

/**
 * A reference chip label: the name of the character, location or style, or the asset's name.
 * @param state - the project state.
 * @param ref - reference text.
 * @returns the label.
 */
function refName(state: WireState, ref: string): string {
  const bibleId = /^(.+)@\d+$/.exec(ref)?.[1]
  if (bibleId !== undefined) return bibleVersions(state, bibleId)?.at(-1)?.name ?? bibleId
  return state.assets.find(asset => asset.id === ref)?.name ?? ref
}

/**
 * Read a file as base64 without the data-URL prefix.
 * @param file - the file.
 * @returns the base64 text.
 */
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(String(reader.result).replace(/^data:[^,]*,/, '')) }
    reader.onerror = () => { reject(reader.error ?? new Error('read failed')) }
    reader.readAsDataURL(file)
  })
}

/** What {@link useEditorPlacement} gives the panel. */
interface EditorPlacement {
  /** Attach to the panel; its parent element is the canvas area that is measured. */
  panelRef: { current: HTMLElement | null }
  /** The rectangle on show. */
  rect: EditorRect
  /** Pointer handlers that start a move (`edges` null) or a resize, and follow and finish either. */
  begin: (edges: PanelGesture['edges']) => (event: ReactPointerEvent<HTMLElement>) => void
  follow: (event: ReactPointerEvent<HTMLElement>) => void
  finish: (event: ReactPointerEvent<HTMLElement>) => void
  /** Return to the default rectangle and forget the remembered one. */
  reset: () => void
  /** Resize from the corner by one arrow-key step. */
  resizeBy: (dx: number, dy: number) => void
}

/**
 * The panel's place in the canvas area and the gestures that change it. The area is the panel's parent element,
 * measured before paint and again whenever it changes size. The panel starts at the remembered rectangle fitted into
 * the area, else at the default; while the area is smaller than the panel, the panel shrinks and moves to stay usable,
 * and returns to its size when the area grows again. A finished move or resize, an arrow-key resize, and a reset
 * update the remembered rectangle.
 * @returns the panel ref, the rectangle on show, and the gesture handlers.
 */
function useEditorPlacement(): EditorPlacement {
  const panelRef = useRef<HTMLElement | null>(null)
  const [area, setArea] = useState<EditorArea>({ width: 0, height: 0 })
  // Null shows the default rectangle; a move, a resize, or a remembered rectangle replaces it.
  const [placed, setPlaced] = useState<EditorRect | null>(null)
  const gesture = useRef<PanelGesture | null>(null)
  useLayoutEffect(() => {
    const parent = panelRef.current?.parentElement
    if (parent === null || parent === undefined) return
    const measure = (): EditorArea => ({ width: parent.clientWidth, height: parent.clientHeight })
    const first = measure()
    setArea(first)
    const remembered = readEditorRect()
    if (remembered !== null) setPlaced(fitEditorRect(remembered, first))
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { setArea(measure()) })
    observer.observe(parent)
    return () => { observer.disconnect() }
  }, [])
  const rect = placed === null ? defaultEditorRect(area) : clampEditorRect(placed, area)
  /** The rectangle a gesture gives at a pointer position. */
  const gestureRect = (current: PanelGesture, event: ReactPointerEvent<HTMLElement>): EditorRect => {
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    return current.edges === null
      ? moveEditorRect(current.start, dx, dy, area)
      : resizeEditorRect(current.start, dx, dy, current.edges, area)
  }
  const begin = (edges: PanelGesture['edges']) => (event: ReactPointerEvent<HTMLElement>): void => {
    // The title row's buttons keep their clicks; only the row itself starts a move.
    if (event.button !== 0 || (edges === null && event.target instanceof Element && event.target.closest('button') !== null)) return
    event.preventDefault()
    gesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, start: rect, edges }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch (error) {
      // A synthetic pointer without an active pointer ID cannot be captured; the gesture still follows it over the panel.
      void error
    }
  }
  const follow = (event: ReactPointerEvent<HTMLElement>): void => {
    const current = gesture.current
    if (current !== null && current.pointerId === event.pointerId) setPlaced(gestureRect(current, event))
  }
  const finish = (event: ReactPointerEvent<HTMLElement>): void => {
    const current = gesture.current
    if (current === null || current.pointerId !== event.pointerId) return
    gesture.current = null
    // A press without movement (a click, or half of a double click) leaves the remembered rectangle alone.
    if (event.clientX === current.startX && event.clientY === current.startY) return
    const next = gestureRect(current, event)
    setPlaced(next)
    writeEditorRect(next)
  }
  const reset = (): void => {
    setPlaced(null)
    writeEditorRect(null)
  }
  const resizeBy = (dx: number, dy: number): void => {
    const next = resizeEditorRect(rect, dx, dy, { right: true, bottom: true }, area)
    setPlaced(next)
    writeEditorRect(next)
  }
  return { panelRef, rect, begin, follow, finish, reset, resizeBy }
}

/** The arrow keys of the resize handle and the width and height change each one makes. */
const RESIZE_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowRight: [RESIZE_STEP, 0], ArrowLeft: [-RESIZE_STEP, 0], ArrowDown: [0, RESIZE_STEP], ArrowUp: [0, -RESIZE_STEP],
}

/**
 * The editor: a header with the kind, the title, "问 agent" and close (and, for a plan, its version row), above the body
 * of the node's kind. The title row moves the panel and a double click on it resets the panel; the handles on the right
 * edge, the bottom edge, and the bottom-right corner resize it.
 * @param props - the node, the state it came from, and the write callbacks.
 * @returns the element.
 */
export function NodeEditor(props: NodeEditorProps): ReactNode {
  const { node, t, onClose } = props
  const title = nodeTitle(node, t)
  // A node without its own title is titled by its kind, so the label beside the kind dot would repeat the title.
  const kind = kindLabel(node, t)
  const staleRecord = node.flags.stale ? node.record : null
  // The plan version on show; the editor holds the choice so the header row and the shot list read the same version.
  const planVersions = node.kind === 'plan' ? props.state.components.plan.plans[node.planId ?? ''] ?? [] : []
  const [chosen, setChosen] = useState<number | null>(null)
  const plan = planVersions.find(version => version.version === chosen) ?? planVersions.at(-1)
  const placement = useEditorPlacement()
  const askAgent = (): void => {
    const shown = node.thumb ?? node.video ?? node.references[0] ?? null
    // An asset node without a record (`asset:<id>`) is referenced as the asset itself.
    const ref: DvComposeRef = node.kind === 'asset' && node.record === null && shown !== null
      ? { kind: 'asset', id: shown, label: title, assetId: shown }
      : { kind: node.bibleKind ?? 'record', id: node.bibleId ?? node.record?.id ?? node.id, label: title, ...shown === null ? {} : { assetId: shown } }
    dispatchCompose({ text: t('compose.text', { title }), refs: [ref] })
    onClose()
  }
  let body: ReactNode
  switch (node.kind) {
    case 'take': body = <TakeForm {...props} title={title} />; break
    case 'bible': body = <BibleForm {...props} />; break
    case 'plan': body = plan === undefined ? null : <PlanShots plan={plan} state={props.state} t={t} />; break
    case 'asset': body = <AssetPanel node={node} t={t} onRemoveFromCanvas={props.onRemoveFromCanvas} />; break
  }
  const { panelRef, rect, begin, follow, finish, reset, resizeBy } = placement
  const gestureHandlers = { onPointerMove: follow, onPointerUp: finish, onPointerCancel: finish }
  const onResizeKey = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const step = RESIZE_KEYS[event.key]
    if (step === undefined) return
    event.preventDefault()
    resizeBy(step[0], step[1])
  }
  return (
    <section
      ref={panelRef} style={{ ...panel, left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      role="dialog" aria-label={title} data-testid="dv-canvas-node-editor" data-dv-scroll-island="" onPointerDown={(event) => { event.stopPropagation() }}
    >
      <header style={{ flex: 'none', padding: '16px 16px 12px 20px', display: 'flex', flexDirection: 'column', gap: 12, borderBottom: '1px solid var(--dv-line)' }}>
        <div
          data-testid="dv-canvas-editor-title-row" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'move', touchAction: 'none', userSelect: 'none' }}
          onPointerDown={begin(null)} {...gestureHandlers}
          onDoubleClick={(event) => { if (!(event.target instanceof Element && event.target.closest('button') !== null)) reset() }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: '16px', color: 'var(--dv-text-2)' }}>
            <span style={{ width: 6, height: 6, borderRadius: 9999, background: KIND_COLOR[node.kind] }} />
            {kind === title ? null : kind}
          </span>
          <h2 style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</h2>
          <button type="button" className="dv-canvas-soft" style={button} onClick={askAgent}>{t('editor.askAgent')}</button>
          <button type="button" className="dv-canvas-btn" aria-label={t('editor.close')} title={t('editor.close')} style={{ ...button, width: 32, padding: 0, color: 'var(--dv-text-2)' }} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        {node.kind === 'plan' && plan !== undefined
          ? <PlanHeader versions={planVersions} plan={plan} state={props.state} t={t} onChoose={setChosen} />
          : null}
      </header>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: node.kind === 'plan' ? 12 : 16 }}>
        {staleRecord !== null
          ? (
            <p style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px', color: 'var(--dv-danger)' }}>
              {t('node.stale')}
              <button
                type="button" className="dv-canvas-btn" style={{ ...secondaryButton, height: 28 }}
                onClick={() => { void props.run(() => props.client.acceptStale(props.project, staleRecord.id, 'canvas', props.session)) }}
              >
                {t('editor.keepAnyway')}
              </button>
            </p>
          )
          : null}
        {body}
      </div>
      {/* Thin strips on the right and bottom edges resize one dimension; the corner button resizes both and takes arrow keys. */}
      <div aria-hidden="true" style={{ position: 'absolute', top: 0, right: 0, bottom: 16, width: 4, cursor: 'ew-resize', touchAction: 'none' }} onPointerDown={begin({ right: true, bottom: false })} {...gestureHandlers} />
      <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 16, bottom: 0, height: 4, cursor: 'ns-resize', touchAction: 'none' }} onPointerDown={begin({ right: false, bottom: true })} {...gestureHandlers} />
      <button
        type="button" className="dv-canvas-btn" aria-label={t('editor.resize')} title={t('editor.resize')} data-testid="dv-canvas-editor-resize"
        style={{ position: 'absolute', right: 2, bottom: 2, width: 16, height: 16, padding: 0, border: 'none', borderRadius: 'var(--dv-radius-sm)', color: 'var(--dv-text-3)', cursor: 'nwse-resize', touchAction: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onPointerDown={begin({ right: true, bottom: true })} {...gestureHandlers} onKeyDown={onResizeKey}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" aria-hidden="true"><path d="M9 3 3 9M9 6.5 6.5 9" /></svg>
      </button>
    </section>
  )
}

/**
 * The node's asset at full width: the video when there is one, else the image.
 * @param props - the node.
 * @returns the element.
 */
function Preview({ node }: { node: CanvasNode }): ReactNode {
  const style: CSSProperties = { width: '100%', maxHeight: 360, borderRadius: 'var(--dv-radius-lg)', background: 'var(--dv-media-bg)', display: 'block' }
  if (node.video !== null) {
    return (
      <video
        src={assetUrl(node.video)}
        poster={node.thumb === null ? undefined : assetUrl(node.thumb)}
        controls
        autoPlay
        muted
        loop
        style={style}
      />
    )
  }
  if (node.thumb !== null) return <img src={assetUrl(node.thumb)} alt={node.title} style={{ ...style, objectFit: 'contain' }} />
  return null
}

/**
 * An imported asset: its preview and "从画布移除", which takes it off the canvas list and leaves it in the asset pool.
 * @param props - the node, the canvas translate, and the removal callback.
 * @returns the element.
 */
function AssetPanel(
  { node, t, onRemoveFromCanvas }: { node: CanvasNode; t: CanvasTranslate; onRemoveFromCanvas: (assetId: string) => void },
): ReactNode {
  const assetId = node.thumb ?? node.video
  return (
    <>
      <Preview node={node} />
      {assetId === null
        ? null
        : (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" className="dv-canvas-btn" style={secondaryButton} onClick={() => { onRemoveFromCanvas(assetId) }}>{t('editor.removeFromCanvas')}</button>
          </div>
        )}
    </>
  )
}

/**
 * A rendered take: preview, the failure reason of a failed take, prompt, references, duration, seed, and "渲染新版本".
 * @param props - editor props plus the title used in the record intent.
 * @returns the element.
 */
function TakeForm(
  { node, state, client, project, session, t, onClose, run, title }: NodeEditorProps & { title: string },
): ReactNode {
  const record = node.record
  const [prompt, setPrompt] = useState(() => typeof record?.params['prompt'] === 'string' ? record.params['prompt'] : '')
  const [inputs, setInputs] = useState<EditedInput[]>(
    () => record?.inputs.map(input => ({ role: input.role, ref: referenceText(input.ref) })) ?? [],
  )
  const [duration, setDuration] = useState(() => typeof record?.params['duration_sec'] === 'number' ? String(record.params['duration_sec']) : '')
  const [seed, setSeed] = useState(() => typeof record?.params['seed'] === 'number' ? String(record.params['seed']) : '')
  const references = inputs.filter(input => input.role === 'reference')
  const candidates = [
    ...bibleItems(state).flatMap(({ id, versions }) => {
      const latest = versions.at(-1)
      return latest === undefined ? [] : [{ ref: `${id}@${String(latest.version)}`, name: latest.name || id }]
    }),
    ...state.assets.filter(asset => asset.mime.startsWith('image/')).map(asset => ({ ref: asset.id, name: asset.name })),
  ].filter(candidate => !references.some(input => input.ref === candidate.ref))
  const operation = record?.operation ?? null
  // A text render takes no reference images, so its editor has no reference chips.
  const textOnly = operation === 'shot.render_t2va'
  const renderTake = (): void => {
    if (record === null || operation === null) return
    const params: Record<string, unknown> = { ...record.params, prompt }
    delete params['duration_sec']
    delete params['seed']
    if (duration.trim() !== '' && Number.isFinite(Number(duration))) params['duration_sec'] = Number(duration)
    if (seed.trim() !== '' && Number.isInteger(Number(seed))) params['seed'] = Number(seed)
    void run(() => client.runOperation({
      project, operation, inputs, params, surface: 'canvas', intent: t('intent.renderTake', { title }), based_on: record.id,
      ...session === null ? {} : { session },
    })).then(onClose)
  }
  const failure = node.flags.failed ? record?.error?.message ?? null : null
  return (
    <div>
      <Preview node={node} />
      {failure === null
        ? null
        : <p role="note" style={{ margin: 0, padding: '8px 12px', borderRadius: 'var(--dv-radius-md)', background: 'var(--dv-danger-soft)', color: 'var(--dv-danger)' }}>{t('editor.failure', { message: failure })}</p>}
      <span style={label}>{t('editor.renderMode')}</span>
      <span data-testid="dv-canvas-render-mode">{modeLabel(textOnly ? 't2va' : 'ref2va', t)}</span>
      <label style={label} htmlFor="dv-canvas-editor-prompt">{t('editor.prompt')}</label>
      <textarea id="dv-canvas-editor-prompt" style={{ ...field, minHeight: 72, resize: 'vertical' }} value={prompt} onChange={(event) => { setPrompt(event.target.value) }} />
      {textOnly ? null : <><span style={label}>{t('editor.references')}</span><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {references.map((input) => {
          const image = refImage(state, input.ref)
          const name = refName(state, input.ref)
          return (
            <span key={input.ref} style={chip}>
              {image === null ? null : <img src={assetUrl(image)} alt="" style={{ width: 22, height: 22, borderRadius: 11, objectFit: 'cover' }} />}
              {name}
              <button type="button" aria-label={t('editor.removeReference', { name })} style={{ border: 'none', background: 'transparent', color: 'var(--dv-text-2)', cursor: 'pointer' }} onClick={() => { setInputs(inputs.filter(other => other !== input)) }}>×</button>
            </span>
          )
        })}
        {candidates.length > 0
          ? (
            <select aria-label={t('editor.addReference')} style={{ ...field, width: 'auto' }} value="" onChange={(event) => { if (event.target.value !== '') setInputs([...inputs, { role: 'reference', ref: event.target.value }]) }}>
              <option value="">{t('editor.addReference')}</option>
              {candidates.map(candidate => <option key={candidate.ref} value={candidate.ref}>{candidate.name}</option>)}
            </select>
          )
          : null}
      </div></>}
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={label} htmlFor="dv-canvas-editor-duration">{t('editor.duration')}</label>
          <input id="dv-canvas-editor-duration" type="number" min={1} step={1} style={field} value={duration} onChange={(event) => { setDuration(event.target.value) }} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={label} htmlFor="dv-canvas-editor-seed">{t('editor.seed')}</label>
          <input id="dv-canvas-editor-seed" type="number" step={1} style={field} placeholder={t('editor.seedRandom')} value={seed} onChange={(event) => { setSeed(event.target.value) }} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button type="button" className="dv-canvas-soft" disabled={operation === null} style={{ ...button, opacity: operation === null ? 0.5 : 1 }} onClick={renderTake}>{t('editor.renderTake')}</button>
      </div>
    </div>
  )
}

/**
 * A character, location or style: its reference images and description, and a control to replace the reference image.
 * @param props - editor props.
 * @returns the element.
 */
function BibleForm({ node, state, client, project, session, t, run }: NodeEditorProps): ReactNode {
  const bibleId = node.bibleId ?? ''
  const kind = node.bibleKind ?? 'character'
  const latest = bibleVersions(state, bibleId)?.at(-1)
  const images = state.assets.filter(asset => asset.mime.startsWith('image/'))
  const sessionField = session === null ? {} : { session }
  const replace = (assetId: string): void => {
    if (latest === undefined) return
    void run(() => client.runOperation({
      project, operation: `bible.${kind}_update`, params: { [kind]: bibleId }, inputs: [{ role: 'reference', ref: assetId }], surface: 'canvas',
      intent: t('intent.replaceRef', { name: latest.name || bibleId }), ...sessionField,
    }))
  }
  const importImage = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    if (file === undefined) return
    void run(async () => {
      const base64 = await base64Of(file)
      const record = await client.runOperation({ project, operation: 'asset.import', params: { base64, mime: file.type || 'image/png', name: file.name }, surface: 'canvas', intent: t('intent.import', { name: file.name }), ...sessionField })
      const assetId = record.outputs[0]
      if (assetId !== undefined) replace(assetId)
    })
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(latest?.references ?? []).map(reference => (
          <img key={reference} src={assetUrl(reference)} alt={reference} style={referenceImage} />
        ))}
      </div>
      {latest !== undefined && latest.description !== ''
        ? (<><span style={label}>{t('editor.description')}</span><p style={{ margin: 0 }}>{latest.description}</p></>)
        : null}
      <span style={label}>{t('editor.replaceRef')}</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select aria-label={t('editor.replaceRef')} style={{ ...field, width: 'auto' }} value="" onChange={(event) => { if (event.target.value !== '') replace(event.target.value) }}>
          <option value="">{t('editor.replaceRef')}</option>
          {images.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
        </select>
        <label className="dv-canvas-btn" style={secondaryButton}>
          {t('editor.import')}
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={importImage} />
        </label>
      </div>
    </div>
  )
}

/** One reference image of a plan or a shot, with the name of what it shows. */
interface NamedImage {
  asset: string
  name: string
}

/**
 * The reference images that reference texts stand for, in `Picture N` order (see `referenceImages`), each with the name
 * of the character, location or style version it belongs to, else the asset's name.
 * @param state - the branch state.
 * @param references - the reference texts, in input order.
 * @returns the images; position N - 1 is `Picture N`.
 */
function namedImages(state: WireState, references: readonly string[]): NamedImage[] {
  return references.flatMap((ref) => {
    const bible = /^(.+)@(\d+)$/.exec(ref)
    const bibleName = bible === null ? undefined : bibleVersions(state, bible[1] ?? '')?.find(version => version.version === Number(bible[2]))?.name
    return referenceImages(state, [ref]).map(asset => ({
      asset, name: bibleName || (state.assets.find(entry => entry.id === asset)?.name ?? asset),
    }))
  })
}

/**
 * One reference image as a chip: the thumbnail and "Picture N · name".
 * @param props - the image, its 1-based Picture number, and the canvas translate.
 * @returns the element.
 */
function PictureChip({ image, number, t }: { image: NamedImage; number: number; t: CanvasTranslate }): ReactNode {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px 0 4px', borderRadius: 'var(--dv-radius-md)', background: 'var(--dv-surface-3)', maxWidth: '100%' }}>
      <img src={assetUrl(image.asset)} alt="" style={chipThumb} draggable={false} />
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t('editor.picture', { number, name: image.name })}</span>
    </span>
  )
}

/**
 * The plan's second header row: the version switch, the chosen version's approval status, its shot count, total
 * duration and aspect ratio, and the plan's reference images. The status is approved, awaiting approval (the latest
 * version only), or replaced by the next version.
 * @param props - every version, the chosen one, the branch state, the canvas translate, and the version choice callback.
 * @returns the element.
 */
function PlanHeader(
  { versions, plan, state, t, onChoose }: {
    versions: PlanVersion[]
    plan: PlanVersion
    state: WireState
    t: CanvasTranslate
    onChoose: (version: number) => void
  },
): ReactNode {
  const approved = plan.approved_by !== null
  // A version that a later version replaced before anyone approved it never waits for approval again.
  const replaced = !approved && plan !== versions.at(-1)
  let status = t('editor.planPending')
  let tone = 'var(--dv-warn)'
  if (approved) { status = t('editor.planApproved'); tone = 'var(--dv-ok)' }
  else if (replaced) { status = t('editor.planReplaced', { version: plan.version + 1 }); tone = 'var(--dv-text-2)' }
  const total = planTotalSec(plan.shots)
  const summary = [t('node.planShots', { count: plan.shots.length }), ...total === null ? [] : [clockText(total)], ...plan.aspect_ratio === undefined ? [] : [plan.aspect_ratio]]
  const images = namedImages(state, plan.references ?? [])
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <div role="group" aria-label={t('editor.planVersions')} style={{ display: 'inline-flex', padding: 3, borderRadius: 'var(--dv-radius-md)', background: 'var(--dv-surface-3)' }}>
        {versions.map((version) => {
          const pressed = version === plan
          return (
            <button
              key={version.version} type="button" aria-pressed={pressed} onClick={() => { onChoose(version.version) }}
              className={pressed ? undefined : 'dv-canvas-btn'}
              style={{
                height: 24, padding: '0 10px', border: 'none', borderRadius: 'var(--dv-radius-sm)', fontFamily: 'inherit', fontSize: 12, lineHeight: '16px', cursor: 'pointer',
                ...pressed ? { background: 'var(--dv-surface-1)', color: 'var(--dv-text)', fontWeight: 500, boxShadow: '0 0 0 1px var(--dv-line-strong)' } : { color: 'var(--dv-text-2)' },
              }}
            >
              {t('node.planVersion', { version: version.version })}
            </button>
          )
        })}
      </div>
      <span
        data-testid="dv-canvas-plan-status"
        style={{ height: 22, padding: '0 8px', display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 9999, background: approved ? 'var(--dv-ok-soft)' : 'var(--dv-surface-3)', color: tone, fontSize: 12, lineHeight: '16px' }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 9999, background: tone }} />{status}
      </span>
      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--dv-text-2)' }}>{summary.join(' · ')}</span>
      <span style={{ flex: 1 }} />
      {images.length === 0
        ? null
        : (
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, lineHeight: '16px', color: 'var(--dv-text-2)' }}>
            {t('editor.planReferences')}
            {images.map((image, index) => (
              <span key={index} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <img src={assetUrl(image.asset)} alt="" style={{ ...chipThumb, boxShadow: '0 0 0 1px var(--dv-line-strong)' }} draggable={false} />
                <span style={{ color: 'var(--dv-text)' }}>{t('editor.picture', { number: index + 1, name: image.name })}</span>
              </span>
            ))}
          </span>
        )}
    </div>
  )
}

/**
 * The shots of one plan version as cards. Memoized, because a move or resize of the editor panel re-renders the editor
 * on every pointer move and the shot cards look up their reference images.
 * @param props - the version, the branch state, and the canvas translate.
 * @returns the element.
 */
const PlanShots = memo(function PlanShots({ plan, state, t }: { plan: PlanVersion; state: WireState; t: CanvasTranslate }): ReactNode {
  return (
    <ol aria-label={t('editor.shots')} style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {plan.shots.map((shot, index) => (
        <ShotCard key={index} number={index + 1} shot={shot} images={namedImages(state, shotReferences(plan, shot))} t={t} />
      ))}
    </ol>
  )
})

const term: CSSProperties = { fontSize: 12, lineHeight: '16px', color: 'var(--dv-text-2)' }

/**
 * One shot of a plan version as a card with exactly what the plan holds: number, duration, render mode, reference
 * images, whether it continues the previous shot, and the prompt.
 * @param props - the 1-based shot number, the shot, its reference images in `Picture N` order, and the canvas translate.
 * @returns the element.
 */
function ShotCard({ number, shot, images, t }: { number: number; shot: Shot; images: NamedImage[]; t: CanvasTranslate }): ReactNode {
  let references: ReactNode
  if (shot.mode === 't2va') references = <span style={{ color: 'var(--dv-text-2)' }}>{t('editor.textOnlyReferences')}</span>
  else if (images.length === 0) references = <span style={{ color: 'var(--dv-text-2)' }}>{t('editor.none')}</span>
  else references = <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{images.map((image, index) => <PictureChip key={index} image={image} number={index + 1} t={t} />)}</span>
  return (
    <li data-shot={number} style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12, borderRadius: 'var(--dv-radius-lg)', background: 'var(--dv-surface-2)', boxShadow: '0 0 0 1px var(--dv-line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 16, lineHeight: '24px', fontWeight: 500 }}>{t('node.shot', { shot: number })}</span>
        {shot.duration_sec === undefined
          ? null
          : <span style={{ ...tag, ...mono, borderRadius: 'var(--dv-radius-sm)', color: 'var(--dv-text-2)' }}>{t('editor.seconds', { seconds: shot.duration_sec })}</span>}
        <span data-testid="dv-canvas-shot-mode" style={{ ...tag, borderRadius: 9999, color: 'var(--dv-text)' }}>{modeLabel(shot.mode, t)}</span>
      </div>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr)', gap: '8px 12px', alignItems: 'center' }}>
        <dt style={term}>{t('editor.references')}</dt>
        <dd style={{ margin: 0, minWidth: 0 }}>{references}</dd>
        <dt style={term}>{t('editor.firstFrame')}</dt>
        <dd style={{ margin: 0, color: 'var(--dv-text-2)' }}>{shot.continue_previous === true ? t('editor.continuePrevious') : t('editor.firstFrameNone')}</dd>
        <dt style={{ ...term, alignSelf: 'start', paddingTop: 10 }}>{t('editor.prompt')}</dt>
        <dd style={{ margin: 0, minWidth: 0 }}><PromptBox prompt={shot.prompt} images={images} t={t} /></dd>
      </dl>
    </li>
  )
}

/**
 * A shot prompt in full, with each `Picture N` token drawn as that reference image. A prompt taller than
 * {@link PROMPT_COLLAPSED_HEIGHT} starts collapsed under a fade, with a toggle that shows all of it.
 * @param props - the prompt, the shot's reference images in `Picture N` order, and the canvas translate.
 * @returns the element.
 */
function PromptBox({ prompt, images, t }: { prompt: string; images: NamedImage[]; t: CanvasTranslate }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)
  // Measure after layout: only a prompt taller than the collapsed height gets the fade and the toggle.
  useLayoutEffect(() => {
    if (box.current !== null) setOverflows(box.current.scrollHeight > PROMPT_COLLAPSED_HEIGHT)
  }, [prompt])
  const collapsed = overflows && !expanded
  return (
    <>
      <div
        ref={box}
        style={{
          position: 'relative', maxHeight: expanded ? 'none' : PROMPT_COLLAPSED_HEIGHT, overflow: 'hidden', boxSizing: 'border-box', padding: '10px 12px',
          borderRadius: 'var(--dv-radius-md)', background: 'var(--dv-surface-1)', boxShadow: 'inset 0 0 0 1px var(--dv-line)',
        }}
      >
        <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {pictureParts(prompt).map((part, position) => {
            const image = 'picture' in part ? images[part.picture - 1] : undefined
            return image === undefined
              ? <span key={position}>{part.text}</span>
              : <img key={position} src={assetUrl(image.asset)} alt={part.text} title={part.text} style={promptThumb} draggable={false} />
          })}
        </p>
        {collapsed ? <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 40, background: 'linear-gradient(to bottom, transparent, var(--dv-surface-1))' }} /> : null}
      </div>
      {overflows
        ? (
          <button
            type="button" aria-expanded={expanded} onClick={() => { setExpanded(!expanded) }}
            style={{ marginTop: 6, padding: 0, border: 'none', background: 'transparent', color: 'var(--dv-accent-text)', fontFamily: 'inherit', fontSize: 12, lineHeight: '16px', cursor: 'pointer' }}
          >
            {expanded ? t('editor.collapsePrompt') : t('editor.expandPrompt')}
          </button>
        )
        : null}
    </>
  )
}
