/**
 * The timeline editor: one tab per timeline of the project, a viewer that plays the selected timeline across its
 * clips, a toolbar, a ruler, the V1 track with clip thumbnails sized by duration, and a display-only A1 track. Every edit
 * is one `/api/dv/operation` call of a `timeline.*` operation with `surface: 'timeline'`; the clip operations name the
 * clip by its clip ID, and every edit goes at the end of the project's history, after the state the editor shows. A selected
 * stale clip offers "仍然保留", which keeps the record that made its asset (`proj.stale_accept`). A
 * placeholder clip, whose render is still running (渲染中…) or failed (渲染失败), keeps its place and its planned length on
 * the track; it cannot be trimmed or split, playback skips it, and export waits until every clip is ready.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { assetUrl } from '@dv/ui-kit/api.ts'
import type { DvClient } from '@dv/ui-kit/api.ts'
import { publishCurrentTimeline, useCurrentTimeline } from '@dv/ui-kit/current-timeline.ts'
import { timelineName } from '@dv/ui-kit/timeline.ts'
import { assetIndex, videoAssets } from '@dv/ui-kit/state.ts'
import type { OperationRequest, WireState } from '@dv/ui-kit/types.ts'
import { DV_ASSET_DRAG_TYPE, DV_TIMELINE_FOCUS_EVENT, type DvWorkspaceEventMap } from '@dv/ui-kit/workspace-events.ts'
import { useFirstFrames } from './first-frame.ts'
import { useTimelinePlayer } from './player.ts'
import { clipIndexAt, dropPosition, nextTimelineId, placeTimeline, timecode, timelinesOf } from './timelines.ts'
import type { TrackClip } from './timelines.ts'
import type { DvTimelineKey } from './locales.ts'

/** The editor's inputs: the project it shows, the chat session it writes for, the state, and the write runner. */
export interface TimelineEditorProps {
  client: DvClient
  t: Translate<DvTimelineKey>
  project: string
  /** The chat session the editor sits beside, recorded as the `session` of the editor's writes. */
  session?: string | null
  /** The project's current state. */
  state: WireState
  /** Run one write and refetch the state; resolves to whether the write succeeded. */
  run: (work: () => Promise<unknown>) => Promise<boolean>
}

/** The fields of an operation request a gesture fills in. */
export type Gesture = Omit<OperationRequest, 'project' | 'surface' | 'session'>

/**
 * The operation request of one gesture.
 * @param project - the project.
 * @param session - the chat session the editor sits beside, recorded as the record's `session`; null for none.
 * @param gesture - the operation, inputs, params, and intent.
 * @returns the request body.
 */
export function request(project: string, session: string | null, gesture: Gesture): OperationRequest {
  return { project, surface: 'timeline', ...session === null ? {} : { session }, ...gesture }
}

/** An edge or body drag on a clip, in progress. */
interface ClipDrag {
  kind: 'move' | 'trimStart' | 'trimEnd'
  position: number
  startX: number
  dx: number
}

/** Width of the track-label column, in pixels. */
const GUTTER = 36
/** Default zoom, in pixels per second. */
const DEFAULT_PX = 40

// The editor follows the DSH theme tokens, so it is light in the light app and dark in the dark app.
const palette = {
  bg: 'var(--dsw-alias-bg-base, #ffffff)',
  panel: 'var(--dsw-alias-bg-layer-3, #ffffff)',
  line: 'var(--dsw-alias-border-l3, #d9d9de)',
  text: 'var(--dsw-alias-label-primary, #1f1f24)',
  muted: 'var(--dsw-alias-label-tertiary, #85858c)',
  accent: 'var(--dsw-alias-button-primary-fill, #2f5fae)',
  onAccent: 'var(--dsw-alias-label-primary-inverted, #ffffff)',
  hover: 'var(--dsw-alias-interactive-bg-hover, #ececf0)',
  clip: '#2f5fae',
  audio: '#2f7a57',
  playhead: 'var(--dsw-alias-state-error-primary, #e5484d)',
}

const button: CSSProperties = {
  background: 'transparent', color: palette.text, border: `1px solid ${palette.line}`, borderRadius: 6, padding: '3px 9px', fontSize: 12, cursor: 'pointer',
}

/**
 * A toolbar button style that looks inactive when the button is disabled.
 * @param disabled - whether the button is disabled.
 * @param extra - style overrides.
 * @returns the style.
 */
function buttonStyle(disabled: boolean, extra: CSSProperties = {}): CSSProperties {
  return { ...button, ...extra, ...disabled ? { opacity: 0.4, cursor: 'default' } : {} }
}

// A `dv:timeline-focus` request usually arrives while the editor is unmounted (the shell shows the timeline view in
// response), so the module keeps the latest requested clip until an editor showing that timeline consumes it.
let pendingClipFocus: DvWorkspaceEventMap['dv:timeline-focus'] | null = null
const clipFocusListeners = new Set<() => void>()
if (typeof window !== 'undefined') {
  window.addEventListener(DV_TIMELINE_FOCUS_EVENT, (event) => {
    pendingClipFocus = (event as CustomEvent<DvWorkspaceEventMap['dv:timeline-focus']>).detail
    for (const listener of clipFocusListeners) listener()
  })
}

/**
 * The clip the user selected: its timeline, its position when selected, and its clip ID, so neither an edit elsewhere
 * nor a timeline switch can move the selection onto another clip, and a placeholder clip stays selected when its render
 * finishes.
 */
interface SelectedClip {
  timelineId: string | null
  position: number
  clip: string
}

/**
 * The position of the selected clip in the clips shown now: the position of the clip with the selected clip ID, else
 * none.
 * @param clips - the placed clips.
 * @param timelineId - the shown timeline.
 * @param chosen - the selected clip, or null.
 * @returns the position, or null.
 */
function resolveSelection(clips: TrackClip[], timelineId: string | null, chosen: SelectedClip | null): number | null {
  if (chosen === null || chosen.timelineId !== timelineId) return null
  return clips.find(clip => clip.clip === chosen.clip)?.position ?? null
}

/**
 * Capture the pointer on the event's element so moves outside it still arrive.
 * @param event - the pointer-down event.
 */
function capture(event: PointerEvent<HTMLElement>): void {
  try {
    event.currentTarget.setPointerCapture(event.pointerId)
  } catch (error: unknown) {
    // jsdom has no pointer capture; the drag then only follows moves over the element.
    void error
  }
}

/**
 * Round a time to hundredths of a second for recorded params.
 * @param seconds - the time.
 * @returns the rounded time.
 */
function round(seconds: number): number {
  return Math.round(seconds * 100) / 100
}

/**
 * The ruler's tick step for a zoom level.
 * @param px - pixels per second.
 * @returns seconds between ticks.
 */
function tickStep(px: number): number {
  if (px >= 60) return 1
  if (px >= 20) return 5
  return 10
}

/**
 * The timeline editor.
 * @param props - the client, copy, project, state, and write runner.
 * @returns the element.
 */
export function TimelineEditor({ client, t, project, session = null, state, run }: TimelineEditorProps): ReactNode {
  const timelines = useMemo(() => timelinesOf(state), [state])
  // The selected timeline is shared on `window`, so the shell can keep it in the URL and restore it.
  const activeId = useCurrentTimeline(project)
  const setActiveId = (id: string): void => { publishCurrentTimeline(project, id) }
  // A timeline created here is selected before the refetched state lists it.
  const pendingTimeline = useRef<string | null>(null)
  const timeline = timelines.find(entry => entry.id === activeId) ?? timelines[0] ?? null
  const { clips, total } = useMemo(() => placeTimeline(state, timeline), [state, timeline])
  const assets = useMemo(() => assetIndex(state), [state])
  // A clip without a still image repeats its video's first frame across its width.
  const unstilled = clips.flatMap(clip => clip.thumbnail === null && clip.assetId !== null ? [assetUrl(clip.assetId)] : [])
  const frames = useFirstFrames(unstilled)
  const candidates = useMemo(() => videoAssets(state), [state])
  const timelineId = timeline?.id ?? null
  const player = useTimelinePlayer(timelineId, clips, total)
  const [px, setPx] = useState(DEFAULT_PX)
  const [chosenClip, setChosenClip] = useState<SelectedClip | null>(null)
  const selected = resolveSelection(clips, timelineId, chosenClip)
  const setSelected = (position: number | null): void => {
    const clip = clips.find(placed => placed.position === position)
    setChosenClip(position === null || clip === undefined ? null : { timelineId, position, clip: clip.clip })
  }
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [dropNotice, setDropNotice] = useState(false)
  const [drag, setDrag] = useState<ClipDrag | null>(null)
  const [picking, setPicking] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const lane = useRef<HTMLDivElement | null>(null)
  const scrubbing = useRef(false)

  // The clip selection, the asset picker, the tab menu, the rename box, and the export link belong to one timeline.
  useEffect(() => {
    setChosenClip(null); setPicking(false); setExported(null); setMenu(null); setRenaming(null)
  }, [timelineId])

  // Publish the timeline shown when the shared value names none or a timeline this project no longer has.
  useEffect(() => {
    if (activeId !== null && activeId === pendingTimeline.current) {
      if (timelines.some(entry => entry.id === activeId)) pendingTimeline.current = null
      return
    }
    if (timelineId !== activeId) publishCurrentTimeline(project, timelineId)
  }, [project, activeId, timelineId, timelines])

  // Select the clip that `dv:timeline-focus` asked for and seek to its start, once this editor shows its timeline.
  const [clipFocusRequest, setClipFocusRequest] = useState(0)
  useEffect(() => {
    const listener = (): void => { setClipFocusRequest(count => count + 1) }
    clipFocusListeners.add(listener)
    return () => { clipFocusListeners.delete(listener) }
  }, [])
  useEffect(() => {
    const focus = pendingClipFocus
    if (focus === null || focus.timelineId !== timelineId) return
    pendingClipFocus = null
    const clip = clips.find(placed => placed.clip === focus.clipId)
    if (clip === undefined) return
    setChosenClip({ timelineId, position: clip.position, clip: clip.clip })
    player.seek(clip.startSec)
  }, [clipFocusRequest, timelineId, clips])

  // Keep the stored selection on the position it resolved to after an edit elsewhere.
  useEffect(() => {
    if (chosenClip === null || selected === chosenClip.position) return
    setChosenClip(selected === null ? null : { ...chosenClip, position: selected })
  }, [chosenClip, selected])

  // The file-drop notice disappears after a few seconds.
  useEffect(() => {
    if (!dropNotice) return
    const timer = setTimeout(() => { setDropNotice(false) }, 4000)
    return () => { clearTimeout(timer) }
  }, [dropNotice])

  // A click outside the tab menu or Escape closes it.
  useEffect(() => {
    if (menu === null) return
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !(event.target instanceof Node && menuRef.current?.contains(event.target) === true)) setMenu(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', close)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close) }
  }, [menu])

  // A timeline without a stored name shows the numbered default name of its ID in the interface language.
  const numbered = (n: number): string => t('tabs.defaultTitle', { n })
  const nameOf = (index: number): string => {
    const entry = timelines[index]
    return entry === undefined ? '' : timelineName(entry, numbered)
  }
  const shownName = timeline === null ? '' : nameOf(timelines.indexOf(timeline))
  // An insert names the shown timeline; the other clip operations name the clip by its clip ID, which names its timeline.
  const runOperation = (operation: string, params: Record<string, unknown>, intent: string): Promise<boolean> => {
    const scoped = timeline === null || operation !== 'timeline.clip_insert' ? params : { timeline: timeline.id, ...params }
    return run(() => client.runOperation(request(project, session, { operation, params: scoped, intent })))
  }

  // A created timeline stores no name; `nameOf` shows the numbered default name of its ID.
  const createTimeline = (): void => {
    const id = nextTimelineId(timelines)
    const name = timelineName({ id, name: '' }, numbered)
    pendingTimeline.current = id
    setActiveId(id)
    void run(() => client.runOperation(request(project, session, { operation: 'timeline.create', params: { timeline: id, assets: [] }, intent: t('intent.create', { name }) })))
      .then((ok) => {
        if (ok) return
        pendingTimeline.current = null
        publishCurrentTimeline(project, timelineId)
      })
  }
  const startRename = (id: string): void => {
    setMenu(null)
    setRenaming({ id, name: nameOf(timelines.findIndex(entry => entry.id === id)) })
  }
  const commitRename = (): void => {
    if (renaming === null) return
    setRenaming(null)
    const index = timelines.findIndex(entry => entry.id === renaming.id)
    const name = renaming.name.trim()
    if (index === -1 || name === '' || name === nameOf(index)) return
    void run(() => client.runOperation(request(project, session, { operation: 'timeline.rename', params: { timeline: renaming.id, name }, intent: t('intent.rename', { name }) })))
  }
  const deleteTimeline = (id: string): void => {
    setMenu(null)
    const name = nameOf(timelines.findIndex(entry => entry.id === id))
    if (!window.confirm(t('tabs.deleteConfirm', { name }))) return
    void run(() => client.runOperation(request(project, session, { operation: 'timeline.delete', params: { timeline: id }, intent: t('intent.delete', { name }) })))
  }
  // Undo and redo move the whole project's current position one step, whichever view made the step.
  const undo = (): void => { void run(() => client.undo(project)) }
  const redo = (): void => { void run(() => client.redo(project)) }
  const canRedo = state.head !== state.tip
  const remove = (position: number): void => {
    const clip = clips.find(placed => placed.position === position)
    if (clip === undefined) return
    void runOperation('timeline.clip_remove', { clip: clip.clip }, t('intent.remove', { position })).then((ok) => { if (ok) setSelected(null) })
  }
  const insert = (at: number, asset: string): void => {
    void runOperation('timeline.clip_insert', { at, asset }, t('intent.insert', { at }))
  }
  // The record behind the selected clip's asset, while it is stale: the record "keep anyway" accepts.
  const selectedClip = clips.find(placed => placed.position === selected)
  const staleRecord = selectedClip?.stale === true && selectedClip.assetId !== null
    ? state.components.proj.created_by[selectedClip.assetId] ?? null
    : null
  const keepStale = (): void => {
    if (staleRecord !== null) void run(() => client.acceptStale(project, staleRecord, 'timeline', session))
  }
  // The clip under the playhead; a placeholder there blanks the viewer and cannot be split.
  const playheadClip = clips[clipIndexAt(clips, player.position)]
  const splitAtPlayhead = (): void => {
    const clip = playheadClip
    if (clip === undefined || clip.status !== 'ready') return
    const atSec = round(clip.inSec + player.position - clip.startSec)
    if (atSec <= clip.inSec + 0.05 || atSec >= clip.outSec - 0.05) return
    void runOperation('timeline.clip_split', { clip: clip.clip, at_sec: atSec }, t('intent.split', { position: clip.position, at: atSec }))
  }

  // Export is one `deliver.timeline_export` call: Deliver trims the clips with an in or out point and joins all clips.
  // It waits while any clip is a placeholder; the toolbar names those clips.
  const waiting = clips.filter(clip => clip.status !== 'ready').map(clip => clip.position)
  const exportTimeline = (): void => {
    if (timelineId === null || waiting.length > 0) return
    setExporting(true)
    setExported(null)
    void run(async () => {
      const exported = await client.runOperation(request(project, session, {
        operation: 'deliver.timeline_export', params: { timeline: timelineId }, intent: t('intent.export', { name: shownName }),
      }))
      setExported(exported.outputs[0] ?? null)
    }).finally(() => { setExporting(false) })
  }

  const seekFromPointer = (event: PointerEvent<HTMLElement>): void => {
    const box = lane.current?.getBoundingClientRect()
    if (box === undefined) return
    player.seek((event.clientX - box.left) / px)
  }

  // A pointer-up ends a clip drag: a body drag reorders (or selects when it did not move); an edge drag trims.
  const finishDrag = (clip: TrackClip, current: ClipDrag): void => {
    setDrag(null)
    const moved = Math.abs(current.dx) > 3
    const deltaSec = current.dx / px
    if (current.kind === 'move') {
      if (!moved) {
        setSelected(clip.position)
        return
      }
      const to = dropPosition(clips, clip.startSec + clip.seconds / 2 + deltaSec, clip.position)
      if (to !== clip.position) {
        void runOperation('timeline.clip_move', { clip: clip.clip, to }, t('intent.move', { from: clip.position, to }))
          .then((ok) => { if (ok) setChosenClip({ timelineId, position: to, clip: clip.clip }) })
      }
      return
    }
    if (!moved || clip.status !== 'ready') return
    const inSec = current.kind === 'trimStart' ? round(Math.max(0, Math.min(clip.inSec + deltaSec, clip.outSec - 0.1))) : clip.rawIn
    const outSec = current.kind === 'trimEnd' ? round(Math.max(clip.inSec + 0.1, Math.min(clip.outSec + deltaSec, clip.assetSeconds))) : clip.rawOut
    // An unset end of the range is left out: the operation reads a missing in or out point as the asset's own end.
    const range = { ...inSec === null ? {} : { in_sec: inSec }, ...outSec === null ? {} : { out_sec: outSec } }
    void runOperation('timeline.clip_trim', { clip: clip.clip, ...range }, t('intent.trim', { position: clip.position }))
  }

  const clipHandlers = (clip: TrackClip, kind: ClipDrag['kind']) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      event.stopPropagation()
      capture(event)
      setDrag({ kind, position: clip.position, startX: event.clientX, dx: 0 })
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (drag === null || drag.position !== clip.position || drag.kind !== kind) return
      setDrag({ ...drag, dx: event.clientX - drag.startX })
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      if (drag === null || drag.position !== clip.position || drag.kind !== kind) return
      event.stopPropagation()
      finishDrag(clip, { ...drag, dx: event.clientX - drag.startX })
    },
  })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== null) {
      event.preventDefault()
      remove(selected)
    } else if (event.key === ' ' && event.target === event.currentTarget) {
      event.preventDefault()
      if (player.playing) player.pause()
      else player.play()
    }
  }

  const fit = (): void => {
    const width = (scroller.current?.clientWidth ?? 0) - GUTTER - 60
    if (width > 0 && total > 0) setPx(Math.round(Math.max(5, Math.min(200, width / total))))
  }
  // Each timeline opens fitted to the track width once it has clips, and stays fitted while the panel resizes until the
  // user picks a zoom with the slider.
  const fittedTimeline = useRef<string | null>(null)
  const autoFit = useRef(true)
  const fitLatest = useRef(fit)
  fitLatest.current = fit
  useEffect(() => {
    if (fittedTimeline.current === timelineId || total <= 0) return
    fittedTimeline.current = timelineId
    autoFit.current = true
    fit()
  }, [timelineId, total])
  useEffect(() => {
    const element = scroller.current
    if (element === null || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => { if (autoFit.current) fitLatest.current() })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  const step = tickStep(px)
  const laneWidth = Math.max(total * px + 80, 200)
  const ticks = Array.from({ length: Math.floor(laneWidth / px / step) + 1 }, (_, i) => i * step)

  /** One clip block on V1 or A1, with the live offset of a drag applied. */
  const blockGeometry = (clip: TrackClip): CSSProperties => {
    let left = clip.startSec * px
    let width = clip.seconds * px
    let transform: string | undefined
    if (drag !== null && drag.position === clip.position) {
      if (drag.kind === 'move') transform = `translateX(${String(drag.dx)}px)`
      if (drag.kind === 'trimStart') { const dx = Math.max(-clip.inSec * px, Math.min(drag.dx, width - 4)); left += dx; width -= dx }
      if (drag.kind === 'trimEnd') width = Math.max(4, Math.min(width + drag.dx, (clip.assetSeconds - clip.inSec) * px))
    }
    return { position: 'absolute', top: 0, bottom: 0, left, width, ...transform === undefined ? {} : { transform, zIndex: 3, opacity: 0.85 } }
  }

  // Timeline tabs: click selects, double-click renames in place, right-click opens a menu with rename and delete.
  const tabs = (
    <div role="tablist" aria-label={t('tabs.aria')} style={{ display: 'flex', gap: 4, padding: '6px 8px', borderBottom: `1px solid ${palette.line}`, alignItems: 'center', flexWrap: 'wrap' }}>
      {timelines.map((entry, index) => renaming?.id === entry.id ? (
        <input
          key={entry.id} autoFocus value={renaming.name} aria-label={t('tabs.renameAria')}
          onChange={(event) => { setRenaming({ id: entry.id, name: event.target.value }) }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') commitRename()
            if (event.key === 'Escape') setRenaming(null)
          }}
          onBlur={commitRename}
          style={{ ...button, width: 120, background: palette.panel, cursor: 'text' }}
        />
      ) : (
        <button
          key={entry.id} type="button" role="tab" aria-selected={entry === timeline} data-timeline={entry.id}
          onClick={() => { setActiveId(entry.id) }}
          onDoubleClick={() => { startRename(entry.id) }}
          onContextMenu={(event) => {
            event.preventDefault()
            const box = event.currentTarget.getBoundingClientRect()
            setMenu({ id: entry.id, x: box.left, y: box.bottom })
          }}
          style={{ ...button, border: 'none', background: entry === timeline ? palette.hover : 'transparent', fontWeight: entry === timeline ? 600 : 400 }}
        >
          {nameOf(index)}
        </button>
      ))}
      <button type="button" onClick={createTimeline} style={{ ...button, border: 'none', color: palette.muted }}>{t('tabs.new')}</button>
      {menu !== null ? (
        <div ref={menuRef} role="menu" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 20, background: palette.panel, border: `1px solid ${palette.line}`, borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0, 0, 0, 0.16)', minWidth: 120 }}>
          <button type="button" role="menuitem" onClick={() => { startRename(menu.id) }} style={{ ...button, border: 'none', display: 'block', width: '100%', textAlign: 'left' }}>{t('tabs.rename')}</button>
          <button type="button" role="menuitem" onClick={() => { deleteTimeline(menu.id) }} style={{ ...button, border: 'none', display: 'block', width: '100%', textAlign: 'left', color: palette.playhead }}>{t('tabs.delete')}</button>
        </div>
      ) : null}
    </div>
  )

  const viewer = (
    <div style={{ position: 'relative', flex: '1 1 45%', minHeight: 140, background: '#000' }} data-testid="dv-timeline-viewer">
      {[0, 1].map(which => (
        <video
          key={which} ref={player.elements[which as 0 | 1]} muted={false} playsInline preload="auto"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', visibility: player.front === which && playheadClip?.status === 'ready' ? 'visible' : 'hidden' }}
        />
      ))}
      {clips.length === 0 ? <p data-testid="dv-timeline-viewer-empty" style={{ position: 'absolute', inset: 0, margin: 'auto', height: 20, textAlign: 'center', color: palette.muted }}>{t(timeline === null ? 'viewer.noTimelines' : 'viewer.empty')}</p> : null}
      {playheadClip !== undefined && playheadClip.status !== 'ready' ? (
        <p data-testid="dv-timeline-viewer-placeholder" style={{ position: 'absolute', inset: 0, margin: 'auto', height: 20, textAlign: 'center', color: palette.muted }}>
          {t('viewer.placeholder', { position: playheadClip.position, status: t(playheadClip.status === 'failed' ? 'track.renderFailed' : 'track.rendering') })}
        </p>
      ) : null}
    </div>
  )

  const toolbar = (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 8px', borderTop: `1px solid ${palette.line}`, borderBottom: `1px solid ${palette.line}`, flexWrap: 'wrap' }}>
      <button type="button" style={button} onClick={undo}>{t('tool.undo')}</button>
      <button type="button" style={buttonStyle(!canRedo)} disabled={!canRedo} onClick={redo}>{t('tool.redo')}</button>
      <button type="button" style={buttonStyle(playheadClip?.status !== 'ready')} disabled={playheadClip?.status !== 'ready'} onClick={splitAtPlayhead}>{t('tool.split')}</button>
      {staleRecord !== null
        ? <button type="button" style={{ ...button, color: palette.playhead }} onClick={keepStale}>{t('tool.keepAnyway')}</button>
        : null}
      <span style={{ flex: 1 }} />
      <button type="button" style={buttonStyle(!clips.some(clip => clip.status === 'ready'))} disabled={!clips.some(clip => clip.status === 'ready')} aria-label={player.playing ? t('tool.pause') : t('tool.play')} onClick={() => { if (player.playing) player.pause(); else player.play() }}>
        {player.playing ? '❚❚' : '▶'}
      </button>
      <span data-testid="dv-timeline-time" style={{ fontVariantNumeric: 'tabular-nums', color: palette.muted }}>{`${timecode(player.position)} / ${timecode(total)}`}</span>
      <span style={{ flex: 1 }} />
      <label style={{ display: 'flex', gap: 4, alignItems: 'center', color: palette.muted }}>
        {t('tool.zoom')}
        <input type="range" min={5} max={200} value={px} onChange={(event) => { autoFit.current = false; setPx(Number(event.target.value)) }} style={{ width: 80 }} />
      </label>
      <button type="button" style={button} onClick={() => { autoFit.current = true; fit() }}>{t('tool.fit')}</button>
      {waiting.length > 0 ? <span data-testid="dv-timeline-export-waiting" style={{ color: palette.muted }}>{t('tool.exportWaiting', { positions: waiting.join(', ') })}</span> : null}
      <button type="button" style={buttonStyle(exporting || clips.length === 0 || waiting.length > 0, { background: palette.accent, borderColor: palette.accent, color: palette.onAccent })} disabled={exporting || clips.length === 0 || waiting.length > 0} onClick={exportTimeline}>
        {exporting ? t('tool.exporting') : t('tool.export')}
      </button>
      {exported !== null ? <a href={assetUrl(exported)} target="_blank" rel="noreferrer" data-testid="dv-timeline-exported" style={{ color: palette.accent }}>{t('tool.exported')}</a> : null}
    </div>
  )

  const playheadLeft = player.position * px
  const tracks = (
    <div ref={scroller} style={{ flex: '1 1 35%', minHeight: 120, overflow: 'auto', position: 'relative' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `${String(GUTTER)}px ${String(laneWidth)}px`, gridTemplateRows: '22px 64px 28px', minWidth: GUTTER + laneWidth }}>
        <span />
        <div
          ref={lane} data-testid="dv-timeline-ruler" style={{ position: 'relative', borderBottom: `1px solid ${palette.line}`, cursor: 'ew-resize' }}
          onPointerDown={(event) => { capture(event); scrubbing.current = true; seekFromPointer(event) }}
          onPointerMove={(event) => { if (scrubbing.current) seekFromPointer(event) }}
          onPointerUp={() => { scrubbing.current = false }}
        >
          {ticks.map(sec => (
            <span key={sec} style={{ position: 'absolute', left: sec * px, top: 0, bottom: 0, borderLeft: `1px solid ${palette.line}`, paddingLeft: 3, fontSize: 10, color: palette.muted }}>{timecode(sec).replace(/\.\d$/, '')}</span>
          ))}
        </div>
        <span style={{ color: palette.muted, alignSelf: 'center', paddingLeft: 8 }}>{t('track.video')}</span>
        <div
          role="list" aria-label={t('track.aria')} style={{ position: 'relative', margin: '4px 0' }}
          onDragOver={(event) => { if (event.dataTransfer.types.includes(DV_ASSET_DRAG_TYPE)) event.preventDefault() }}
          onDrop={(event) => {
            const asset = event.dataTransfer.getData(DV_ASSET_DRAG_TYPE)
            const box = lane.current?.getBoundingClientRect()
            if (asset.length === 0) return
            event.preventDefault()
            event.stopPropagation()
            insert(dropPosition(clips, box === undefined ? total : (event.clientX - box.left) / px, null), asset)
          }}
        >
          {clips.map((clip) => {
            const ready = clip.assetId !== null
            const statusText = clip.status === 'failed' ? t('track.renderFailed') : t('track.rendering')
            const name = clip.assetId === null ? statusText : assets.get(clip.assetId)?.name ?? clip.assetId
            // Trim handles take at most a quarter of the clip each, so a short clip keeps a body to select and drag.
            const handle = Math.max(2, Math.min(7, Math.floor(clip.seconds * px / 4)))
            const caption = `${String(clip.position)} · ${clip.seconds.toFixed(1)}s${ready ? '' : ` · ${statusText}`}`
              + `${clip.stale ? ` · ${t('track.stale')}` : ''}`
            // A placeholder clip is striped in the track color, red when its render failed.
            const placeholderFill = `repeating-linear-gradient(135deg, ${clip.status === 'failed' ? palette.playhead : palette.clip} 0 8px, ${palette.panel} 8px 16px)`
            // The still image of the clip, else its video's first frame once read, repeated across the clip.
            const firstFrame = clip.assetId === null ? null : frames.get(assetUrl(clip.assetId)) ?? null
            const frame = clip.thumbnail !== null ? assetUrl(clip.thumbnail) : firstFrame
            return (
              <div
                key={clip.clip} role="listitem" aria-label={t('track.clipAria', { position: clip.position, name })} aria-pressed={selected === clip.position}
                data-clip={clip.clip} data-clip-position={clip.position} data-clip-status={clip.status} data-clip-stale={clip.stale} title={caption} {...clipHandlers(clip, 'move')}
                style={{
                  ...blockGeometry(clip), boxSizing: 'border-box', borderRadius: 4, overflow: 'hidden', cursor: 'grab', touchAction: 'none',
                  background: !ready ? placeholderFill : frame === null ? palette.clip : `${palette.clip} url("${frame}") left center / auto 100% repeat-x`,
                  // A border in the track color keeps a visible gap between neighboring clips.
                  border: `2px solid ${selected === clip.position ? palette.text : clip.stale ? palette.playhead : palette.bg}`,
                }}
              >
                {frame === null && clip.assetId !== null ? <video src={assetUrl(clip.assetId)} preload="metadata" muted style={{ height: '100%', pointerEvents: 'none' }} /> : null}
                <span style={{ position: 'absolute', left: handle + 2, right: handle + 2, bottom: 2, fontSize: 10, color: '#fff', textShadow: '0 0 3px #000', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none' }}>
                  {caption}
                </span>
                {ready ? (
                  <>
                    <span aria-label={t('track.trimStart', { position: clip.position })} data-trim="start" {...clipHandlers(clip, 'trimStart')} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: handle, cursor: 'col-resize', background: 'rgba(255,255,255,0.35)' }} />
                    <span aria-label={t('track.trimEnd', { position: clip.position })} data-trim="end" {...clipHandlers(clip, 'trimEnd')} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: handle, cursor: 'col-resize', background: 'rgba(255,255,255,0.35)' }} />
                  </>
                ) : null}
              </div>
            )
          })}
          {timeline === null ? null : (
            <button
              type="button" aria-label={t('track.add')} onClick={() => { setPicking(!picking) }}
              style={{ ...button, position: 'absolute', left: total * px + 8, top: 14, width: 32, height: 32, padding: 0, fontSize: 16 }}
            >
              ＋
            </button>
          )}
        </div>
        <span style={{ color: palette.muted, alignSelf: 'center', paddingLeft: 8 }}>{t('track.audio')}</span>
        <div style={{ position: 'relative', margin: '3px 0' }} aria-hidden>
          {clips.map(clip => (
            <div
              key={clip.clip}
              style={{ ...blockGeometry(clip), boxSizing: 'border-box', borderRadius: 3, border: `1px solid ${palette.bg}`, background: `repeating-linear-gradient(90deg, ${palette.audio} 0 2px, transparent 2px 4px), ${palette.panel}`, opacity: 0.8 }}
            />
          ))}
        </div>
      </div>
      <div
        aria-label={t('track.playhead')} data-testid="dv-timeline-playhead"
        style={{ position: 'absolute', top: 0, height: 22 + 64 + 28, left: GUTTER + playheadLeft, width: 0, borderLeft: `2px solid ${palette.playhead}`, pointerEvents: 'none', zIndex: 4 }}
      >
        <span style={{ position: 'absolute', top: 0, left: -7, width: 12, height: 10, background: palette.playhead, borderRadius: '0 0 6px 6px' }} />
      </div>
      {picking ? (
        <div role="dialog" aria-label={t('track.pick')} style={{ position: 'absolute', right: 8, top: 4, maxHeight: 220, overflow: 'auto', background: palette.panel, border: `1px solid ${palette.line}`, borderRadius: 8, padding: 6, zIndex: 5, minWidth: 180 }}>
          <p style={{ margin: '0 0 4px', color: palette.muted }}>{t('track.pick')}</p>
          {candidates.length === 0 ? <p style={{ margin: 0 }}>{t('track.noAssets')}</p> : candidates.map(entry => (
            <button
              key={entry.id} type="button" style={{ ...button, display: 'block', width: '100%', textAlign: 'left', marginTop: 4 }}
              onClick={() => { setPicking(false); insert(clips.length + 1, entry.id) }}
            >
              {entry.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )

  // File and asset drags stop at the editor, so the chat composer's document-level drop listener never attaches a file
  // dropped here. Only asset tiles can land on the track; a dropped file gets a notice.
  const ownsDrag = (event: DragEvent<HTMLDivElement>): boolean => event.dataTransfer.types.includes('Files') || event.dataTransfer.types.includes(DV_ASSET_DRAG_TYPE)
  const holdDrag = (event: DragEvent<HTMLDivElement>): void => {
    if (!ownsDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
  }
  const dropOutside = (event: DragEvent<HTMLDivElement>): void => {
    if (!ownsDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes(DV_ASSET_DRAG_TYPE)) setDropNotice(true)
  }

  return (
    <div
      onDragEnter={holdDrag} onDragOver={holdDrag} onDrop={dropOutside}
      tabIndex={0} onKeyDown={onKeyDown} data-testid="dv-timeline-editor"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: palette.bg, color: palette.text, fontSize: 12, outline: 'none' }}
    >
      {tabs}
      {dropNotice ? <p role="status" style={{ margin: 0, padding: '4px 8px', color: palette.muted }}>{t('track.fileDrop')}</p> : null}
      {viewer}
      {toolbar}
      {tracks}
    </div>
  )
}
