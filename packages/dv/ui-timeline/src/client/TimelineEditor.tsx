/**
 * The timeline editor: one tab per timeline of the project, a 16:9 preview that fills the free height and plays the
 * selected timeline across its clips (with skip, play, playback-speed, and full-screen controls under it), a toolbar,
 * a ruler, the 视频 track with filmstrip clips sized by duration, and a display-only 原声 track with one block per clip
 * that shows the waveform of the clip's own audio once it decodes. A drag handle above the track area sets the track
 * area's height, which each browser remembers. Every edit
 * is one `/api/dv/operation` call of a `timeline.*` operation with `surface: 'timeline'`; the clip operations name the
 * clip by its clip ID. The working-branch bar on top names the branch these edits go to and accepts or discards the open
 * draft; a selected stale clip offers "仍然保留", which keeps the record that made its asset (`proj.stale_accept`). A
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
import { WorkingBranchBar } from '@dv/ui-kit/WorkingBranchBar.tsx'
import { useTimelinePlayer } from './player.ts'
import { clipPeaks, useAudioEnvelope } from './waveform.ts'
import { clipIndexAt, dropPosition, nextTimelineId, placeTimeline, timecode, timelinesOf } from './timelines.ts'
import type { TrackClip } from './timelines.ts'
import type { DvTimelineKey } from './locales.ts'

/** The editor's inputs: the project and branch it shows, the chat session it writes for, the state, and the write runner. */
export interface TimelineEditorProps {
  client: DvClient
  t: Translate<DvTimelineKey>
  project: string
  branch: string
  /** The chat session the editor sits beside; its edits go to that session's working branch (its open draft). */
  session?: string | null
  state: WireState
  /** The `main` state while a draft is shown, to tell the draft's clips apart. */
  baseState?: WireState | null
  /** Whether the editor shows a draft without writing to it. */
  readOnly: boolean
  /** Run one write and refetch the state; resolves to whether the write succeeded. */
  run: (work: () => Promise<unknown>) => Promise<boolean>
}

/** The fields of an operation request a gesture fills in. */
export type Gesture = Omit<OperationRequest, 'project' | 'surface' | 'session'>

/**
 * The operation request of one gesture.
 * @param project - the project.
 * @param session - the chat session the editor sits beside, whose working branch the record goes to; null for `main`.
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

/** Width of the track-header column, in pixels. */
const GUTTER = 96
/** Default zoom, in pixels per second. */
const DEFAULT_PX = 40
/** Row heights of the track area, in pixels: the ruler, the video track, and the audio track. */
const RULER_HEIGHT = 26
const VIDEO_HEIGHT = 56
const AUDIO_HEIGHT = 36
/** Vertical gap between the rows of the track area, in pixels. */
const ROW_GAP = 6
/** Bottom padding of the scrolling track rows, in pixels; it keeps the horizontal scrollbar off the audio track. */
const TRACK_PADDING = 14
/** The smallest preview height the track-area drag handle leaves, in pixels. */
const MIN_PREVIEW_HEIGHT = 160
/** Pixels one ArrowUp or ArrowDown press on the focused drag handle adds to or takes from the track area. */
const RESIZE_STEP = 16
/** `localStorage` key of the track area's height in pixels, remembered per browser. */
const TRACK_HEIGHT_KEY = 'dv-timeline-track-height'
/** Seconds the skip-back and skip-forward buttons (and J, L, Shift+←, Shift+→) move the playhead. */
const SKIP_SECONDS = 5
/** Playback speeds the speed button cycles through. */
const PLAYBACK_RATES = [0.5, 1, 1.5, 2] as const
/** `sessionStorage` key of the playback speed, kept for the browser tab's session. */
const PLAYBACK_RATE_KEY = 'dv-timeline-playback-rate'
/** Width of one waveform bar and of the gap after it, in pixels. */
const WAVE_BAR = 2
const WAVE_GAP = 1

// The editor reads the DreamVerse theme variables that `@dv/ui-shell` defines for the light and the dark theme.
const palette = {
  bg: 'var(--dv-bg)',
  panel: 'var(--dv-surface-1)',
  fill: 'var(--dv-surface-3)',
  line: 'var(--dv-line)',
  lineStrong: 'var(--dv-line-strong)',
  fg: 'var(--dv-text)',
  muted: 'var(--dv-text-2)',
  faint: 'var(--dv-text-3)',
  accent: 'var(--dv-accent)',
  accentFg: 'var(--dv-accent-text)',
  danger: 'var(--dv-danger)',
  dangerSoft: 'var(--dv-danger-soft)',
  take: 'var(--dv-kind-take)',
  audio: 'var(--dv-kind-audio)',
  audioSoft: 'var(--dv-kind-audio-soft)',
  media: 'var(--dv-media-bg)',
  mono: 'var(--dv-font-mono)',
}

// Hover fills, focus rings, and the trim-handle highlight need pseudo-classes, which inline styles cannot express. A
// `.dv-tl-btn` element gets its transparent fill here, so its inline style must not set `background`.
const EDITOR_CSS = `
.dv-tl-editor .dv-tl-btn { background: transparent; transition: background-color 120ms var(--dv-ease); }
.dv-tl-editor .dv-tl-btn:not(:disabled):hover { background: var(--dv-surface-3); }
.dv-tl-editor :focus-visible { outline: 2px solid var(--dv-accent); outline-offset: 1px; }
.dv-tl-editor .dv-tl-trim { background: var(--dv-line-strong); transition: background-color 120ms var(--dv-ease); }
.dv-tl-editor .dv-tl-trim:hover { background: var(--dv-accent); }
.dv-tl-editor input[type="range"] { accent-color: var(--dv-accent); }
.dv-tl-editor .dv-tl-resize { background: var(--dv-line); transition: background-color 120ms var(--dv-ease); }
.dv-tl-editor .dv-tl-resize::before { content: ""; position: absolute; left: 0; right: 0; top: -4px; bottom: -4px; }
.dv-tl-editor .dv-tl-resize:hover, .dv-tl-editor .dv-tl-resize[data-dragging="true"] { background: var(--dv-accent); }
@media (prefers-reduced-motion: reduce) {
  .dv-tl-editor .dv-tl-btn, .dv-tl-editor .dv-tl-trim, .dv-tl-editor .dv-tl-resize { transition: none; }
}
`

/** A secondary button: 28 px high with a 1 px border; pair it with the `dv-tl-btn` class for its fill. */
const button: CSSProperties = {
  boxSizing: 'border-box', height: 28, padding: '0 10px', display: 'inline-flex', alignItems: 'center', gap: 6,
  color: palette.fg, border: `1px solid ${palette.lineStrong}`, borderRadius: 'var(--dv-radius-md)', font: 'inherit', fontSize: 13, lineHeight: '20px', cursor: 'pointer',
}
/** A 32 px icon-only button with no border. */
const iconButton: CSSProperties = { width: 32, height: 32, padding: 0, justifyContent: 'center', border: 'none', color: palette.muted }
/** A text-only button. */
const textButton: CSSProperties = { border: 'none', color: palette.muted }

/**
 * A toolbar button style that looks inactive when the button is disabled.
 * @param disabled - whether the button is disabled.
 * @param extra - style overrides.
 * @returns the style.
 */
function buttonStyle(disabled: boolean, extra: CSSProperties = {}): CSSProperties {
  return { ...button, ...extra, ...disabled ? { opacity: 0.4, cursor: 'default' } : {} }
}

/** Stroke paths of the editor's 16 px icons, in a 24-unit box. */
const ICON_PATHS = {
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'm15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
  split: 'M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12',
  delete: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  skipBack: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  skipForward: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  export: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  add: 'M12 5v14M5 12h14',
}

/**
 * A 16 px stroke icon in the current text color.
 * @param props - the icon's name.
 * @returns the element.
 */
function Icon({ name }: { name: keyof typeof ICON_PATHS }): ReactNode {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}

/**
 * An icon-only toolbar button; its label is both the accessible name and the hover tooltip.
 * @param props - the icon, the label, whether the button is disabled, and the click handler.
 * @returns the element.
 */
function IconButton(
  { icon, label, disabled, onClick }: { icon: keyof typeof ICON_PATHS; label: string; disabled: boolean; onClick: () => void },
): ReactNode {
  return (
    <button type="button" className="dv-tl-btn" aria-label={label} title={label} disabled={disabled} onClick={onClick} style={buttonStyle(disabled, iconButton)}>
      <Icon name={icon} />
    </button>
  )
}

/**
 * The track area's height after a resize: the requested height, lowered so the preview keeps at least
 * `MIN_PREVIEW_HEIGHT`, and raised to the height the toolbar and track rows need. The track rows' minimum wins when the
 * editor is too short for both.
 * @param requested - the height the drag or key press asks for, in pixels.
 * @param available - the height the preview and the track area share, in pixels.
 * @param minTrack - the height the toolbar and the track rows need, in pixels.
 * @returns the height to apply, in pixels.
 */
export function clampTrackHeight(requested: number, available: number, minTrack: number): number {
  return Math.round(Math.max(minTrack, Math.min(requested, available - MIN_PREVIEW_HEIGHT)))
}

/**
 * The track area's height this browser remembers.
 * @returns the height in pixels, or null when none is stored or storage is unavailable.
 */
function readTrackHeight(): number | null {
  try {
    const stored = Number(window.localStorage.getItem(TRACK_HEIGHT_KEY))
    return Number.isFinite(stored) && stored > 0 ? stored : null
  } catch (error: unknown) {
    // Storage can throw in a private window or with blocked site data; the track area then keeps its natural height.
    void error
    return null
  }
}

/**
 * Remember the track area's height in this browser.
 * @param height - the height in pixels.
 */
function storeTrackHeight(height: number): void {
  try {
    window.localStorage.setItem(TRACK_HEIGHT_KEY, String(height))
  } catch (error: unknown) {
    // Storage can throw in a private window or with blocked site data; the height then lasts until the editor unmounts.
    void error
  }
}

/**
 * The playback speed of this browser tab's session.
 * @returns a speed of `PLAYBACK_RATES`; 1 when none is stored or storage is unavailable.
 */
function readPlaybackRate(): number {
  try {
    const stored = Number(window.sessionStorage.getItem(PLAYBACK_RATE_KEY))
    return PLAYBACK_RATES.find(rate => rate === stored) ?? 1
  } catch (error: unknown) {
    // Storage can throw in a private window or with blocked site data; playback then starts at normal speed.
    void error
    return 1
  }
}

/**
 * Keep the playback speed for this browser tab's session.
 * @param rate - the speed.
 */
function storePlaybackRate(rate: number): void {
  try {
    window.sessionStorage.setItem(PLAYBACK_RATE_KEY, String(rate))
  } catch (error: unknown) {
    // Storage can throw in a private window or with blocked site data; the speed then lasts until the editor unmounts.
    void error
  }
}

/**
 * The waveform of one clip on the 原声 track: one bar per `WAVE_BAR + WAVE_GAP` pixels of the clip's width, each the
 * peak of the clip's audio over that slice of its played range. It draws nothing while the audio decodes or when the
 * asset has no decodable audio, so the block stays plain.
 * @param props - the clip's asset, its in and out points, and its width and height in pixels.
 * @returns the element, or null.
 */
function AudioWaveform(
  { assetId, inSec, outSec, width, height }: { assetId: string; inSec: number; outSec: number; width: number; height: number },
): ReactNode {
  const envelope = useAudioEnvelope(assetId)
  const bars = Math.max(1, Math.floor(width / (WAVE_BAR + WAVE_GAP)))
  const peaks = useMemo(() => envelope === null ? null : clipPeaks(envelope, inSec, outSec, bars), [envelope, inSec, outSec, bars])
  if (peaks === null) return null
  // Bars are mirrored around the middle and at least 1 px tall, so a silent stretch still shows a center line.
  const path = peaks.map((peak, bar) => {
    const barHeight = Math.max(1, peak * (height - 4))
    return `M${String(bar * (WAVE_BAR + WAVE_GAP))} ${String((height - barHeight) / 2)}h${String(WAVE_BAR)}v${String(barHeight)}h-${String(WAVE_BAR)}z`
  }).join('')
  return (
    <svg
      data-testid="dv-timeline-waveform" viewBox={`0 0 ${String(bars * (WAVE_BAR + WAVE_GAP))} ${String(height)}`} preserveAspectRatio="none" aria-hidden
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      <path d={path} fill={palette.audio} />
    </svg>
  )
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
 * The ruler's steps for a zoom level: a tick every second while ticks stay at least 8 px apart, and a time label every
 * 5 s while labels stay at least 48 px apart, else every 10, 30, or 60 s.
 * @param px - pixels per second.
 * @returns seconds between ticks and seconds between labels.
 */
function rulerSteps(px: number): { tick: number; label: number } {
  return { tick: px >= 8 ? 1 : 5, label: [5, 10, 30].find(step => step * px >= 48) ?? 60 }
}

/**
 * The timeline editor.
 * @param props - the client, copy, project, branch, state, and write runner.
 * @returns the element.
 */
export function TimelineEditor(
  { client, t, project, branch, session = null, state, baseState = null, readOnly, run }: TimelineEditorProps,
): ReactNode {
  const timelines = useMemo(() => timelinesOf(state), [state])
  // The selected timeline is shared on `window`, so the shell can keep it in the URL and restore it.
  const activeId = useCurrentTimeline(project)
  const setActiveId = (id: string): void => { publishCurrentTimeline(project, id) }
  // A timeline created here is selected before the refetched state lists it.
  const pendingTimeline = useRef<string | null>(null)
  const timeline = timelines.find(entry => entry.id === activeId) ?? timelines[0] ?? null
  const baseClips = useMemo(
    () => baseState === null || timeline === null ? [] : timelinesOf(baseState).find(entry => entry.id === timeline.id)?.clips ?? [],
    [baseState, timeline],
  )
  const { clips, total } = useMemo(() => placeTimeline(state, timeline, branch, baseClips), [state, timeline, branch, baseClips])
  const assets = useMemo(() => assetIndex(state), [state])
  const candidates = useMemo(() => videoAssets(state), [state])
  const timelineId = timeline?.id ?? null
  const [playbackRate, setPlaybackRate] = useState(readPlaybackRate)
  const player = useTimelinePlayer(timelineId, clips, total, playbackRate)
  const cycleRate = (): void => {
    const next = PLAYBACK_RATES[(PLAYBACK_RATES.findIndex(rate => rate === playbackRate) + 1) % PLAYBACK_RATES.length] ?? 1
    setPlaybackRate(next)
    storePlaybackRate(next)
  }
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
  const frame = useRef<HTMLDivElement | null>(null)
  const scrubbing = useRef(false)
  const root = useRef<HTMLDivElement | null>(null)
  const viewerBox = useRef<HTMLElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const rows = useRef<HTMLDivElement | null>(null)
  // The track area's height in pixels; null keeps its natural height.
  const [trackHeight, setTrackHeight] = useState<number | null>(readTrackHeight)
  const [resizing, setResizing] = useState<{ startY: number; startHeight: number } | null>(null)

  // The clip selection, the asset picker, the tab menu, the rename box, and the export link belong to one timeline.
  useEffect(() => { setChosenClip(null); setPicking(false); setExported(null); setMenu(null); setRenaming(null) }, [timelineId])

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
    if (readOnly) return
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
    if (readOnly || !window.confirm(t('tabs.deleteConfirm', { name }))) return
    void run(() => client.runOperation(request(project, session, { operation: 'timeline.delete', params: { timeline: id }, intent: t('intent.delete', { name }) })))
  }
  // Undo and redo step the chat session's working branch, the branch this editor shows, through its history, whichever
  // view made the step; redo is offered while the branch has steps to bring back.
  const canRedo = state.redo_steps.length > 0
  const undo = (): void => { void run(() => client.undo(project, 'timeline', session)) }
  const redo = (): void => { void run(() => client.redo(project, 'timeline', session)) }
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
  // The bar names the intent of the latest record among the shown draft's own records that states one.
  const draftIntent = useMemo(() => {
    if (baseState === null) return ''
    const known = new Set(baseState.components.proj.records.map(record => record.id))
    return state.components.proj.records.filter(record => !known.has(record.id) && record.intent !== '').at(-1)?.intent ?? ''
  }, [state, baseState])
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
    if (!moved || readOnly || clip.status !== 'ready') return
    const inSec = current.kind === 'trimStart' ? round(Math.max(0, Math.min(clip.inSec + deltaSec, clip.outSec - 0.1))) : clip.rawIn
    const outSec = current.kind === 'trimEnd' ? round(Math.max(clip.inSec + 0.1, Math.min(clip.outSec + deltaSec, clip.assetSeconds))) : clip.rawOut
    // An unset end of the range is left out: the operation reads a missing in or out point as the asset's own end.
    const range = { ...inSec === null ? {} : { in_sec: inSec }, ...outSec === null ? {} : { out_sec: outSec } }
    void runOperation('timeline.clip_trim', { clip: clip.clip, ...range }, t('intent.trim', { position: clip.position }))
  }

  const clipHandlers = (clip: TrackClip, kind: ClipDrag['kind']) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (kind !== 'move' && readOnly) return
      event.stopPropagation()
      capture(event)
      setDrag({ kind, position: clip.position, startX: event.clientX, dx: 0 })
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (drag === null || drag.position !== clip.position || drag.kind !== kind) return
      if (kind === 'move' && readOnly) return
      setDrag({ ...drag, dx: event.clientX - drag.startX })
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      if (drag === null || drag.position !== clip.position || drag.kind !== kind) return
      event.stopPropagation()
      finishDrag(clip, { ...drag, dx: event.clientX - drag.startX })
    },
  })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== null && !readOnly) {
      event.preventDefault()
      remove(selected)
    } else if (event.key === ' ' && event.target === event.currentTarget) {
      event.preventDefault()
      if (player.playing) player.pause()
      else player.play()
    } else if (event.target === event.currentTarget && (event.key === 'j' || event.key === 'l' || (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')))) {
      event.preventDefault()
      player.skip(event.key === 'j' || event.key === 'ArrowLeft' ? -SKIP_SECONDS : SKIP_SECONDS)
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

  // The bounds of a track-area resize, read from the laid-out editor: the preview and the track area share the height
  // from the preview's top to the editor's bottom, less the 1 px drag handle; the track area needs its toolbar, its
  // horizontal scrollbar, and its rows with their padding. Null before layout (or under jsdom, which lays out nothing).
  const resizeBounds = (): { available: number; minTrack: number } | null => {
    const editorElement = root.current
    const viewerElement = viewerBox.current
    const panelElement = panel.current
    const scrollElement = scroller.current
    const rowsElement = rows.current
    if (editorElement === null || viewerElement === null || panelElement === null) return null
    if (scrollElement === null || rowsElement === null) return null
    const available = editorElement.getBoundingClientRect().bottom - viewerElement.getBoundingClientRect().top - 1
    if (available <= 0) return null
    const minTrack = panelElement.offsetHeight - scrollElement.clientHeight + rowsElement.offsetHeight + TRACK_PADDING
    return { available, minTrack }
  }
  const resizeTo = (requested: number): number => {
    const bounds = resizeBounds()
    const height = bounds === null ? Math.round(requested) : clampTrackHeight(requested, bounds.available, bounds.minTrack)
    setTrackHeight(height)
    return height
  }
  // A remembered or dragged height is clamped again whenever the editor resizes, so a shorter window keeps the preview.
  useEffect(() => {
    const element = root.current
    if (element === null || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => {
      const bounds = resizeBounds()
      if (bounds !== null) setTrackHeight(height => height === null ? null : clampTrackHeight(height, bounds.available, bounds.minTrack))
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])
  // Dragging the handle up makes the track area taller; ArrowUp and ArrowDown on the focused handle step it. Each
  // finished change is remembered for this browser.
  const resizeHandle = (
    <div
      role="separator" aria-orientation="horizontal" aria-label={t('track.resize')} title={t('track.resize')} tabIndex={0}
      {...trackHeight === null ? {} : { 'aria-valuenow': trackHeight }}
      className="dv-tl-resize" data-dragging={resizing !== null} data-testid="dv-timeline-resize"
      onPointerDown={(event) => {
        event.preventDefault()
        capture(event)
        setResizing({ startY: event.clientY, startHeight: panel.current?.offsetHeight ?? 0 })
      }}
      onPointerMove={(event) => { if (resizing !== null) resizeTo(resizing.startHeight - (event.clientY - resizing.startY)) }}
      onPointerUp={(event) => {
        if (resizing === null) return
        setResizing(null)
        storeTrackHeight(resizeTo(resizing.startHeight - (event.clientY - resizing.startY)))
      }}
      onPointerCancel={() => {
        setResizing(null)
        if (trackHeight !== null) storeTrackHeight(trackHeight)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        event.stopPropagation()
        const from = trackHeight ?? panel.current?.offsetHeight ?? 0
        storeTrackHeight(resizeTo(from + (event.key === 'ArrowUp' ? RESIZE_STEP : -RESIZE_STEP)))
      }}
      style={{ flex: 'none', position: 'relative', zIndex: 6, height: 1, cursor: 'row-resize', touchAction: 'none' }}
    />
  )

  // The preview frame, with both video elements, goes full screen; a refused request leaves the preview inline.
  const toggleFullscreen = (): void => {
    const element = frame.current
    if (element === null) return
    const change = document.fullscreenElement === element ? document.exitFullscreen() : element.requestFullscreen()
    void change.catch((error: unknown) => { void error })
  }

  const steps = rulerSteps(px)
  const laneWidth = Math.max(total * px + 80, 200)
  const ticks = Array.from({ length: Math.floor(laneWidth / px / steps.tick) + 1 }, (_, i) => i * steps.tick)

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
    <div role="tablist" aria-label={t('tabs.aria')} style={{ display: 'flex', gap: 4, padding: '6px 12px', borderBottom: `1px solid ${palette.line}`, background: palette.panel, alignItems: 'center', flexWrap: 'wrap' }}>
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
          className="dv-tl-btn"
          style={{
            ...button, ...textButton,
            ...entry === timeline ? { background: palette.fill, color: palette.fg, fontWeight: 500 } : {},
          }}
        >
          {nameOf(index)}
        </button>
      ))}
      <button type="button" className="dv-tl-btn" disabled={readOnly} onClick={createTimeline} style={buttonStyle(readOnly, textButton)}>{t('tabs.new')}</button>
      {menu !== null ? (
        <div ref={menuRef} role="menu" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 20, background: palette.panel, border: `1px solid ${palette.line}`, borderRadius: 'var(--dv-radius-xl)', padding: 6, boxShadow: 'var(--dv-shadow-2)', minWidth: 140 }}>
          <button type="button" role="menuitem" className="dv-tl-btn" disabled={readOnly} onClick={() => { startRename(menu.id) }} style={buttonStyle(readOnly, { border: 'none', display: 'flex', width: '100%', textAlign: 'left' })}>{t('tabs.rename')}</button>
          <button type="button" role="menuitem" className="dv-tl-btn" disabled={readOnly} onClick={() => { deleteTimeline(menu.id) }} style={buttonStyle(readOnly, { border: 'none', display: 'flex', width: '100%', textAlign: 'left', color: palette.danger })}>{t('tabs.delete')}</button>
        </div>
      ) : null}
    </div>
  )

  // The preview fills the height the tracks leave: a 16:9 frame at full height, narrowed to the available width, on the
  // media surround, with the play button, the timecode, and the full-screen button under it.
  const canPlay = clips.some(clip => clip.status === 'ready')
  const viewer = (
    <section ref={viewerBox} aria-label={t('viewer.aria')} style={{ flex: '1 1 auto', minHeight: 140, display: 'flex', flexDirection: 'column', gap: 10, padding: '16px 24px 12px', background: palette.media }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div
          ref={frame} data-testid="dv-timeline-viewer"
          style={{ position: 'relative', height: '100%', maxWidth: '100%', aspectRatio: '16 / 9', borderRadius: 'var(--dv-radius-md)', overflow: 'hidden', background: palette.media, boxShadow: `0 0 0 1px ${palette.line}, var(--dv-shadow-1)` }}
        >
          {[0, 1].map(which => (
            <video
              key={which} ref={player.elements[which as 0 | 1]} muted={false} playsInline preload="auto"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', visibility: player.front === which && playheadClip?.status === 'ready' ? 'visible' : 'hidden' }}
            />
          ))}
          {clips.length === 0 ? <p data-testid="dv-timeline-viewer-empty" style={{ position: 'absolute', inset: 0, margin: 'auto', height: 20, padding: '0 16px', textAlign: 'center', color: palette.muted }}>{t(timeline === null ? 'viewer.noTimelines' : 'viewer.empty')}</p> : null}
          {playheadClip !== undefined && playheadClip.status !== 'ready' ? (
            <p data-testid="dv-timeline-viewer-placeholder" style={{ position: 'absolute', inset: 0, margin: 'auto', height: 20, padding: '0 16px', textAlign: 'center', color: palette.muted }}>
              {t('viewer.placeholder', { position: playheadClip.position, status: t(playheadClip.status === 'failed' ? 'track.renderFailed' : 'track.rendering') })}
            </p>
          ) : null}
        </div>
      </div>
      {/* Three columns keep the transport group centered whatever the widths of the timecode and the right group. */}
      <div style={{ flex: 'none', display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 12, color: palette.fg }}>
        <span data-testid="dv-timeline-time" style={{ justifySelf: 'start', fontFamily: palette.mono, fontSize: 13, lineHeight: '20px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {timecode(player.position)}{' '}<span style={{ color: palette.muted }}>{`/ ${timecode(total)}`}</span>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconButton icon="skipBack" label={t('viewer.skipBack')} disabled={total <= 0} onClick={() => { player.skip(-SKIP_SECONDS) }} />
          <button
            type="button" disabled={!canPlay} aria-label={player.playing ? t('tool.pause') : t('tool.play')} title={player.playing ? t('tool.pause') : t('tool.play')}
            onClick={() => { if (player.playing) player.pause(); else player.play() }}
            style={{ ...buttonStyle(!canPlay, iconButton), borderRadius: 9999, background: palette.fg, color: palette.media }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d={player.playing ? 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z' : 'M7 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L8.5 4.6A1 1 0 0 0 7 5.5z'} />
            </svg>
          </button>
          <IconButton icon="skipForward" label={t('viewer.skipForward')} disabled={total <= 0} onClick={() => { player.skip(SKIP_SECONDS) }} />
        </div>
        <div style={{ justifySelf: 'end', display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button" className="dv-tl-btn" data-testid="dv-timeline-speed" aria-label={t('viewer.speed', { rate: playbackRate })} title={t('viewer.speed', { rate: playbackRate })} onClick={cycleRate}
            style={{ ...button, ...textButton, minWidth: 44, justifyContent: 'center', fontFamily: palette.mono, fontSize: 12, lineHeight: '16px', fontVariantNumeric: 'tabular-nums' }}
          >
            {t('viewer.speedValue', { rate: playbackRate })}
          </button>
          <IconButton icon="fullscreen" label={t('viewer.fullscreen')} disabled={false} onClick={toggleFullscreen} />
        </div>
      </div>
    </section>
  )

  const canSplit = !readOnly && playheadClip?.status === 'ready'
  const toolbar = (
    <div role="toolbar" aria-label={t('tool.aria')} style={{ display: 'flex', gap: 2, alignItems: 'center', padding: '6px 12px', borderBottom: `1px solid ${palette.line}`, flexWrap: 'wrap' }}>
      <IconButton icon="undo" label={t('tool.undo')} disabled={readOnly} onClick={undo} />
      <IconButton icon="redo" label={t('tool.redo')} disabled={readOnly || !canRedo} onClick={redo} />
      <span style={{ width: 1, height: 18, background: palette.lineStrong, margin: '0 6px' }} />
      <IconButton icon="split" label={t('tool.split')} disabled={!canSplit} onClick={splitAtPlayhead} />
      <IconButton icon="delete" label={t('tool.delete')} disabled={readOnly || selected === null} onClick={() => { if (selected !== null) remove(selected) }} />
      {staleRecord !== null
        ? <button type="button" className="dv-tl-btn" style={buttonStyle(readOnly, { marginLeft: 6, color: palette.danger })} disabled={readOnly} onClick={keepStale}>{t('tool.keepAnyway')}</button>
        : null}
      <span style={{ flex: 1 }} />
      {waiting.length > 0 ? <span data-testid="dv-timeline-export-waiting" style={{ color: palette.muted, fontSize: 12, lineHeight: '16px', marginRight: 6 }}>{t('tool.exportWaiting', { positions: waiting.join(', ') })}</span> : null}
      <button type="button" className="dv-tl-btn" style={buttonStyle(readOnly || exporting || clips.length === 0 || waiting.length > 0)} disabled={readOnly || exporting || clips.length === 0 || waiting.length > 0} onClick={exportTimeline}>
        <Icon name="export" />{exporting ? t('tool.exporting') : t('tool.export')}
      </button>
      {exported !== null ? <a href={assetUrl(exported)} target="_blank" rel="noreferrer" data-testid="dv-timeline-exported" style={{ color: palette.accentFg, marginLeft: 6 }}>{t('tool.exported')}</a> : null}
      <span style={{ width: 1, height: 18, background: palette.lineStrong, margin: '0 6px' }} />
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: palette.muted, fontSize: 12, lineHeight: '16px' }}>
        {t('tool.zoom')}
        <input type="range" min={5} max={200} value={px} onChange={(event) => { autoFit.current = false; setPx(Number(event.target.value)) }} style={{ width: 110 }} />
      </label>
      <button type="button" className="dv-tl-btn" style={{ ...button, ...textButton }} onClick={() => { autoFit.current = true; fit() }}>{t('tool.fit')}</button>
    </div>
  )

  const playheadLeft = player.position * px
  // The playhead spans the ruler and both tracks.
  const playheadHeight = RULER_HEIGHT + ROW_GAP + VIDEO_HEIGHT + ROW_GAP + AUDIO_HEIGHT
  const trackHeader = (color: string, name: string): ReactNode => (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 14, fontSize: 12, lineHeight: '16px' }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
      {name}
    </span>
  )
  const tracks = (
    <div ref={scroller} style={{ flex: '1 1 auto', minHeight: 0, overflowX: 'auto', overflowY: 'hidden', position: 'relative', paddingBottom: TRACK_PADDING }}>
      <div ref={rows} style={{ display: 'grid', gridTemplateColumns: `${String(GUTTER)}px ${String(laneWidth)}px`, gridTemplateRows: `${String(RULER_HEIGHT)}px ${String(VIDEO_HEIGHT)}px ${String(AUDIO_HEIGHT)}px`, rowGap: ROW_GAP, minWidth: GUTTER + laneWidth }}>
        <span />
        <div
          ref={lane} data-testid="dv-timeline-ruler" style={{ position: 'relative', borderBottom: `1px solid ${palette.line}`, cursor: 'ew-resize' }}
          onPointerDown={(event) => { capture(event); scrubbing.current = true; seekFromPointer(event) }}
          onPointerMove={(event) => { if (scrubbing.current) seekFromPointer(event) }}
          onPointerUp={() => { scrubbing.current = false }}
        >
          {ticks.map(sec => (
            <span key={sec} style={{ position: 'absolute', left: sec * px, bottom: 0, width: 1, height: sec % steps.label === 0 ? 9 : 4, background: palette.lineStrong }} />
          ))}
          {ticks.filter(sec => sec % steps.label === 0).map(sec => (
            <span key={`label-${String(sec)}`} style={{ position: 'absolute', left: sec * px, top: 3, marginLeft: 4, fontFamily: palette.mono, fontSize: 11, lineHeight: '14px', fontVariantNumeric: 'tabular-nums', color: palette.muted, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
              {timecode(sec).replace(/\.\d+$/, '')}
            </span>
          ))}
        </div>
        {trackHeader(palette.take, t('track.video'))}
        <div
          role="list" aria-label={t('track.aria')} style={{ position: 'relative' }}
          onDragOver={(event) => { if (event.dataTransfer.types.includes(DV_ASSET_DRAG_TYPE)) event.preventDefault() }}
          onDrop={(event) => {
            const asset = event.dataTransfer.getData(DV_ASSET_DRAG_TYPE)
            const box = lane.current?.getBoundingClientRect()
            if (asset.length === 0 || readOnly) return
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
              + `${clip.stale ? ` · ${t('track.stale')}` : ''}${clip.draft ? ` · ${t('track.draft')}` : ''}`
            // The visible label names the shot and any state that changes what the clip can do.
            const label = [t('track.clipLabel', { position: clip.position }), ...ready ? [] : [statusText], ...clip.stale ? [t('track.stale')] : [], ...clip.draft ? [t('track.draft')] : []].join(' · ')
            // A placeholder clip is striped, in the danger color when its render failed.
            const placeholderFill = `repeating-linear-gradient(135deg, ${clip.status === 'failed' ? palette.dangerSoft : palette.lineStrong} 0 8px, ${palette.fill} 8px 16px)`
            const isSelected = selected === clip.position
            return (
              <div
                key={clip.clip} role="listitem" aria-label={t('track.clipAria', { position: clip.position, name })} aria-pressed={isSelected}
                data-clip={clip.clip} data-clip-position={clip.position} data-clip-status={clip.status} data-clip-stale={clip.stale} data-clip-draft={clip.draft} title={caption} {...clipHandlers(clip, 'move')}
                style={{
                  ...isSelected ? { zIndex: 1 } : {}, ...blockGeometry(clip), boxSizing: 'border-box', borderRadius: 'var(--dv-radius-sm)', overflow: 'hidden', cursor: readOnly ? 'pointer' : 'grab', touchAction: 'none',
                  background: !ready ? placeholderFill : clip.thumbnail === null ? palette.fill : `${palette.fill} url("${assetUrl(clip.thumbnail)}") left center / auto 100% repeat-x`,
                  // A border in the track color keeps a visible gap between neighboring clips.
                  border: `1px solid ${palette.panel}`,
                  boxShadow: [isSelected ? `0 0 0 2px ${palette.accent}` : null, `inset 0 0 0 ${clip.stale ? `2px ${palette.danger}` : `1px ${palette.line}`}`].filter(shadow => shadow !== null).join(', '),
                  outline: clip.draft ? `2px dashed ${palette.accent}` : undefined, outlineOffset: clip.draft ? -4 : undefined,
                }}
              >
                {clip.thumbnail === null && clip.assetId !== null ? <video src={assetUrl(clip.assetId)} preload="metadata" muted style={{ height: '100%', pointerEvents: 'none' }} /> : null}
                <span style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 3, background: clip.status === 'failed' ? palette.danger : palette.take, pointerEvents: 'none' }} />
                <span style={{ position: 'absolute', left: handle + 3, bottom: 4, maxWidth: `calc(100% - ${String(handle * 2 + 6)}px)`, boxSizing: 'border-box', padding: '0 5px', borderRadius: 4, background: palette.panel, color: palette.fg, fontSize: 12, lineHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none' }}>
                  {label}
                </span>
                {ready ? (
                  <>
                    <span aria-label={t('track.trimStart', { position: clip.position })} data-trim="start" className="dv-tl-trim" {...clipHandlers(clip, 'trimStart')} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: handle, cursor: 'col-resize' }} />
                    <span aria-label={t('track.trimEnd', { position: clip.position })} data-trim="end" className="dv-tl-trim" {...clipHandlers(clip, 'trimEnd')} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: handle, cursor: 'col-resize' }} />
                  </>
                ) : null}
              </div>
            )
          })}
          {timeline === null ? null : (
            <button
              type="button" className="dv-tl-btn" aria-label={t('track.add')} title={t('track.add')} disabled={readOnly} onClick={() => { setPicking(!picking) }}
              style={buttonStyle(readOnly, { position: 'absolute', left: total * px + 8, top: (VIDEO_HEIGHT - 32) / 2, width: 32, height: 32, padding: 0, justifyContent: 'center', color: palette.muted })}
            >
              <Icon name="add" />
            </button>
          )}
        </div>
        {trackHeader(palette.audio, t('track.audio'))}
        <div style={{ position: 'relative' }} aria-hidden>
          {clips.map(clip => (
            <div
              key={clip.clip}
              style={{ ...blockGeometry(clip), boxSizing: 'border-box', borderRadius: 'var(--dv-radius-sm)', border: `1px solid ${palette.panel}`, background: palette.audioSoft, overflow: 'hidden' }}
            >
              {clip.status === 'ready' && clip.assetId !== null
                ? (
                  <AudioWaveform
                    assetId={clip.assetId} inSec={clip.inSec} outSec={clip.outSec} width={clip.seconds * px} height={AUDIO_HEIGHT - 2}
                  />
                )
                : null}
            </div>
          ))}
        </div>
      </div>
      <div
        aria-label={t('track.playhead')} data-testid="dv-timeline-playhead"
        style={{ position: 'absolute', top: 0, height: playheadHeight, left: GUTTER + playheadLeft, width: 2, marginLeft: -1, background: palette.accent, pointerEvents: 'none', zIndex: 4 }}
      >
        <span style={{ position: 'absolute', top: 0, left: -5, width: 12, height: 12, background: palette.accent, borderRadius: '3px 3px 6px 6px' }} />
      </div>
    </div>
  )

  // The toolbar, the tracks, and the asset picker share one panel; the picker opens under the toolbar, outside the
  // horizontally scrolling tracks, so the scroll area does not clip it. A resized panel gives its extra height to the
  // scrolling track rows, which keep their own heights at the top.
  const editPanel = (
    <div ref={panel} style={{ flex: 'none', ...trackHeight === null ? {} : { height: trackHeight }, display: 'flex', flexDirection: 'column', position: 'relative', background: palette.panel }}>
      {toolbar}
      {tracks}
      {picking ? (
        <div role="dialog" aria-label={t('track.pick')} style={{ position: 'absolute', right: 12, top: 44, maxHeight: 180, overflow: 'auto', background: palette.panel, border: `1px solid ${palette.line}`, borderRadius: 'var(--dv-radius-lg)', boxShadow: 'var(--dv-shadow-1)', padding: 6, zIndex: 5, minWidth: 180 }}>
          <p style={{ margin: '0 0 4px', color: palette.muted, fontSize: 12, lineHeight: '16px' }}>{t('track.pick')}</p>
          {candidates.length === 0 ? <p style={{ margin: 0 }}>{t('track.noAssets')}</p> : candidates.map(entry => (
            <button
              key={entry.id} type="button" className="dv-tl-btn" style={{ ...button, border: 'none', display: 'flex', width: '100%', textAlign: 'left', marginTop: 4 }}
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
      ref={root} tabIndex={0} onKeyDown={onKeyDown} data-testid="dv-timeline-editor" className="dv-tl-editor"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: palette.bg, color: palette.fg, fontFamily: 'var(--dv-font-sans)', fontSize: 13, lineHeight: '20px', outline: 'none' }}
    >
      <style>{EDITOR_CSS}</style>
      <WorkingBranchBar
        client={client} project={project} session={session} surface="timeline" state={state} intent={draftIntent} run={run}
        style={{ padding: '4px 12px', borderBottom: `1px solid ${palette.line}` }}
      />
      {tabs}
      {readOnly ? <p style={{ margin: 0, padding: '4px 12px', color: palette.muted, fontSize: 12, lineHeight: '16px' }}>{t('draftHead')}</p> : null}
      {dropNotice ? <p role="status" style={{ margin: 0, padding: '4px 12px', color: palette.muted, fontSize: 12, lineHeight: '16px' }}>{t('track.fileDrop')}</p> : null}
      {viewer}
      {resizeHandle}
      {editPanel}
    </div>
  )
}
