/**
 * The cuts editor: one tab per video of the project, a viewer that plays the selected video across its clips, a
 * toolbar, a ruler, the V1 track with clip thumbnails sized by duration, and a display-only A1 track. Every edit is one
 * `/api/vh/invoke` call with `surface: 'timeline'` that names the video in its `sequence` param.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { assetUrl } from '@video-harness/ui-kit/api.ts'
import type { InvokeBody, VhClient } from '@video-harness/ui-kit/api.ts'
import { publishCurrentEpisode, useCurrentEpisode } from '@video-harness/ui-kit/current-episode.ts'
import { assetIndex, videoAssets } from '@video-harness/ui-kit/state.ts'
import type { WireState } from '@video-harness/ui-kit/types.ts'
import { useSequencePlayer } from './player.ts'
import { clipIndexAt, dropSlot, nextVideoId, placeVideo, timecode, videosOf } from './sequences.ts'
import type { CutClip } from './sequences.ts'
import type { VhTimelineKey } from './locales.ts'

/** The data transfer type an asset carries when it is dragged onto the track; the value is the asset ID. */
export const ASSET_DRAG_TYPE = 'application/x-vh-asset'

/** The editor's inputs: the project and head it shows, the chat session it writes for, the state, and the write runner. */
export interface CutsEditorProps {
  client: VhClient
  t: Translate<VhTimelineKey>
  project: string
  head: string
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

/** The fields of an invoke request a gesture fills in. */
export type Gesture = Omit<InvokeBody, 'project' | 'surface' | 'session'>

/**
 * The invoke request of one gesture.
 * @param project - the project.
 * @param session - the chat session the editor sits beside, whose working branch the record goes to; null for `main`.
 * @param gesture - the tool, inputs, params, and intent.
 * @returns the request body.
 */
export function request(project: string, session: string | null, gesture: Gesture): InvokeBody {
  return { project, surface: 'timeline', ...session === null ? {} : { session }, ...gesture }
}

/** An edge or body drag on a clip, in progress. */
interface ClipDrag {
  kind: 'move' | 'trimStart' | 'trimEnd'
  slot: number
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

/** Where one undo left `main` (`after`); redo is offered while `main` is still there. */
interface RedoEntry {
  after: string
}

/** Redo entries per project, newest last; kept outside the component so a canvas ↔ cuts switch keeps them. */
const redoStacks = new Map<string, RedoEntry[]>()

/**
 * The clip the user selected: its episode, its slot when selected, and its asset, so neither an edit elsewhere nor an
 * episode switch can move the selection onto another clip.
 */
interface SelectedClip {
  videoId: string | null
  slot: number
  assetId: string
}

/**
 * The slot of the selected clip in the clips shown now: the same slot when it still holds the same asset, else the one
 * clip that shows the asset, else none.
 * @param clips - the placed clips.
 * @param videoId - the shown episode.
 * @param chosen - the selected clip, or null.
 * @returns the slot, or null.
 */
function resolveSelection(clips: CutClip[], videoId: string | null, chosen: SelectedClip | null): number | null {
  if (chosen === null || chosen.videoId !== videoId) return null
  if (clips.some(clip => clip.slot === chosen.slot && clip.assetId === chosen.assetId)) return chosen.slot
  const same = clips.filter(clip => clip.assetId === chosen.assetId)
  return same.length === 1 ? same[0]?.slot ?? null : null
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
 * The cuts editor.
 * @param props - the client, copy, project, head, state, and write runner.
 * @returns the element.
 */
export function CutsEditor(
  { client, t, project, head, session = null, state, baseState = null, readOnly, run }: CutsEditorProps,
): ReactNode {
  const videos = useMemo(() => videosOf(state), [state])
  // The selected episode is shared on `window`, so the shell can keep it in the URL and restore it.
  const activeId = useCurrentEpisode(project)
  const setActiveId = (id: string): void => { publishCurrentEpisode(project, id) }
  // An episode created here is selected before the refetched state lists it.
  const pendingEpisode = useRef<string | null>(null)
  const video = videos.find(entry => entry.id === activeId) ?? videos[0] ?? null
  const baseItems = useMemo(
    () => baseState === null || video === null ? [] : videosOf(baseState).find(entry => entry.id === video.id)?.items ?? [],
    [baseState, video],
  )
  const { clips, total } = useMemo(() => placeVideo(state, video, head, baseItems), [state, video, head, baseItems])
  const assets = useMemo(() => assetIndex(state), [state])
  const candidates = useMemo(() => videoAssets(state), [state])
  const videoId = video?.id ?? null
  const player = useSequencePlayer(videoId, clips, total)
  const [px, setPx] = useState(DEFAULT_PX)
  const [chosenClip, setChosenClip] = useState<SelectedClip | null>(null)
  const selected = resolveSelection(clips, videoId, chosenClip)
  const setSelected = (slot: number | null): void => {
    const clip = clips.find(entry => entry.slot === slot)
    setChosenClip(slot === null || clip === undefined ? null : { videoId, slot, assetId: clip.assetId })
  }
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [, setRedoVersion] = useState(0)
  const [dropNotice, setDropNotice] = useState(false)
  const [drag, setDrag] = useState<ClipDrag | null>(null)
  const [picking, setPicking] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const lane = useRef<HTMLDivElement | null>(null)
  const scrubbing = useRef(false)

  // The clip selection, the asset picker, the tab menu, the rename box, and the export link belong to one video.
  useEffect(() => { setChosenClip(null); setPicking(false); setExported(null); setMenu(null); setRenaming(null) }, [videoId])

  // Publish the episode shown when the shared value names none or an episode this project no longer has.
  useEffect(() => {
    if (activeId !== null && activeId === pendingEpisode.current) {
      if (videos.some(entry => entry.id === activeId)) pendingEpisode.current = null
      return
    }
    if (videoId !== activeId) publishCurrentEpisode(project, videoId)
  }, [project, activeId, videoId, videos])

  // Keep the stored selection on the slot it resolved to after an edit elsewhere.
  useEffect(() => {
    if (chosenClip === null || selected === chosenClip.slot) return
    setChosenClip(selected === null ? null : { ...chosenClip, slot: selected })
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

  // A stored default title (`第 N 集`, or `Episode N` from older English sessions) is shown in the interface language.
  const titleOf = (index: number): string => {
    const title = videos[index]?.title ?? ''
    const numbered = /^(?:第 (\d+) 集|Episode (\d+))$/.exec(title)
    if (numbered !== null) return t('tabs.defaultTitle', { n: Number(numbered[1] ?? numbered[2]) })
    return title || t('tabs.defaultTitle', { n: index + 1 })
  }
  const videoTitle = video === null ? '' : titleOf(videos.indexOf(video))
  const invoke = (tool: string, params: Record<string, unknown>, intent: string): Promise<boolean> => {
    const scoped = video === null ? params : { sequence: video.id, ...params }
    return run(() => client.invoke(request(project, session, { tool, params: scoped, intent })))
  }

  // New episodes store the language-neutral default title `第 N 集`; `titleOf` shows it in the interface language.
  const createVideo = (): void => {
    const id = nextVideoId(videos)
    const n = videos.length + 1
    const title = `第 ${String(n)} 集`
    pendingEpisode.current = id
    setActiveId(id)
    void run(() => client.invoke(request(project, session, { tool: 'sequence.create', params: { sequence: id, title, assets: [] }, intent: t('intent.create', { title: t('tabs.defaultTitle', { n }) }) })))
      .then((ok) => {
        if (ok) return
        pendingEpisode.current = null
        publishCurrentEpisode(project, videoId)
      })
  }
  const startRename = (id: string): void => {
    if (readOnly) return
    setMenu(null)
    setRenaming({ id, title: titleOf(videos.findIndex(entry => entry.id === id)) })
  }
  const commitRename = (): void => {
    if (renaming === null) return
    setRenaming(null)
    const index = videos.findIndex(entry => entry.id === renaming.id)
    const title = renaming.title.trim()
    if (index === -1 || title === '' || title === titleOf(index)) return
    void run(() => client.invoke(request(project, session, { tool: 'sequence.rename', params: { sequence: renaming.id, title }, intent: t('intent.rename', { title }) })))
  }
  const deleteVideo = (id: string): void => {
    setMenu(null)
    const title = titleOf(videos.findIndex(entry => entry.id === id))
    if (readOnly || !window.confirm(t('tabs.deleteConfirm', { title }))) return
    void run(() => client.invoke(request(project, session, { tool: 'sequence.delete', params: { sequence: id }, intent: t('intent.delete', { title }) })))
  }
  // `/api/vh/undo` moves `main` back one turn in any video; it is offered only when that turn's record edits this video.
  const latest = state.ops.find(op => op.id === state.heads['main'])
  const latestVideo = latest?.tool?.name.startsWith('sequence.') === true
    ? typeof latest.params['sequence'] === 'string' && latest.params['sequence'] !== '' ? latest.params['sequence'] : videos[0]?.id ?? null
    : null
  // A turn on a video that no longer exists (a deleted episode) can be undone from any episode.
  const undoElsewhere = latestVideo !== null && latestVideo !== videoId && videos.some(entry => entry.id === latestVideo)
  const undoElsewhereTitle = undoElsewhere ? titleOf(videos.findIndex(entry => entry.id === latestVideo)) : ''
  // Redo is offered while `main` is still where the last undo left it.
  const mainHead = state.heads['main'] ?? null
  const redoStack = redoStacks.get(project) ?? []
  const redoEntry = redoStack.length > 0 && redoStack[redoStack.length - 1]?.after === mainHead
    ? redoStack[redoStack.length - 1] ?? null
    : null
  const undo = (): void => {
    void run(async () => {
      const result = await client.undo(project, session)
      const after = result.heads['main']
      if (mainHead === null || after === undefined) return
      const stack = redoStack.length > 0 && redoStack[redoStack.length - 1]?.after === mainHead ? redoStack : []
      redoStacks.set(project, [...stack, { after }])
      setRedoVersion(version => version + 1)
    })
  }
  const redo = (): void => {
    if (redoEntry === null) return
    void run(async () => {
      await client.redo(project, session)
      redoStacks.set(project, redoStack.slice(0, -1))
      setRedoVersion(version => version + 1)
    })
  }
  const remove = (slot: number): void => {
    void invoke('sequence.remove', { slot }, t('intent.remove', { slot })).then((ok) => { if (ok) setSelected(null) })
  }
  const insert = (at: number, asset: string): void => {
    void invoke('sequence.insert', { at, asset }, t('intent.insert', { at }))
  }
  const splitAtPlayhead = (): void => {
    const clip = clips[clipIndexAt(clips, player.position)]
    if (clip === undefined) return
    const atSec = round(clip.inSec + player.position - clip.startSec)
    if (atSec <= clip.inSec + 0.05 || atSec >= clip.outSec - 0.05) return
    void invoke('sequence.split', { slot: clip.slot, atSec }, t('intent.split', { slot: clip.slot, at: atSec }))
  }

  // Export joins the clips in order; a clip with an in or out point is cut to that range first.
  const exportVideo = (): void => {
    setExporting(true)
    setExported(null)
    void run(async () => {
      const refs: string[] = []
      for (const clip of clips) {
        if (clip.rawIn === null && clip.rawOut === null) { refs.push(clip.assetId); continue }
        const cut = await client.invoke(request(project, session, {
          tool: 'clip.trim', inputs: [{ role: 'clip', ref: clip.assetId }], params: { startSec: clip.inSec, endSec: clip.outSec }, intent: t('intent.trim', { slot: clip.slot }),
        }))
        refs.push(cut.outputs[0] ?? clip.assetId)
      }
      const joined = await client.invoke(request(project, session, {
        tool: 'media.concat', inputs: refs.map(ref => ({ role: 'clip', ref })), intent: t('intent.export', { title: videoTitle }),
      }))
      setExported(joined.outputs[0] ?? null)
    }).finally(() => { setExporting(false) })
  }

  const seekFromPointer = (event: PointerEvent<HTMLElement>): void => {
    const box = lane.current?.getBoundingClientRect()
    if (box === undefined) return
    player.seek((event.clientX - box.left) / px)
  }

  // A pointer-up ends a clip drag: a body drag reorders (or selects when it did not move); an edge drag trims.
  const finishDrag = (clip: CutClip, current: ClipDrag): void => {
    setDrag(null)
    const moved = Math.abs(current.dx) > 3
    const deltaSec = current.dx / px
    if (current.kind === 'move') {
      if (!moved) {
        setSelected(clip.slot)
        void client.select({ project, kind: 'clip', id: clip.assetId, slot: clip.slot, surface: 'timeline' })
        return
      }
      const to = dropSlot(clips, clip.startSec + clip.seconds / 2 + deltaSec, clip.slot)
      if (to !== clip.slot) void invoke('sequence.move', { from: clip.slot, to }, t('intent.move', { from: clip.slot, to })).then((ok) => { if (ok) setChosenClip({ videoId, slot: to, assetId: clip.assetId }) })
      return
    }
    if (!moved || readOnly) return
    const inSec = current.kind === 'trimStart' ? round(Math.max(0, Math.min(clip.inSec + deltaSec, clip.outSec - 0.1))) : clip.rawIn
    const outSec = current.kind === 'trimEnd' ? round(Math.max(clip.inSec + 0.1, Math.min(clip.outSec + deltaSec, clip.assetSeconds))) : clip.rawOut
    // An unset end of the range is left out: the operation reads a missing in or out point as the asset's own end.
    const range = { ...inSec === null ? {} : { inSec }, ...outSec === null ? {} : { outSec } }
    void invoke('sequence.set_range', { slot: clip.slot, ...range }, t('intent.setRange', { slot: clip.slot }))
  }

  const clipHandlers = (clip: CutClip, kind: ClipDrag['kind']) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (kind !== 'move' && readOnly) return
      event.stopPropagation()
      capture(event)
      setDrag({ kind, slot: clip.slot, startX: event.clientX, dx: 0 })
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (drag === null || drag.slot !== clip.slot || drag.kind !== kind) return
      if (kind === 'move' && readOnly) return
      setDrag({ ...drag, dx: event.clientX - drag.startX })
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      if (drag === null || drag.slot !== clip.slot || drag.kind !== kind) return
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
    }
  }

  const fit = (): void => {
    const width = (scroller.current?.clientWidth ?? 0) - GUTTER - 60
    if (width > 0 && total > 0) setPx(Math.round(Math.max(5, Math.min(200, width / total))))
  }
  // Each episode opens fitted to the track width once it has clips, and stays fitted while the panel resizes until the
  // user picks a zoom with the slider.
  const fittedVideo = useRef<string | null>(null)
  const autoFit = useRef(true)
  const fitLatest = useRef(fit)
  fitLatest.current = fit
  useEffect(() => {
    if (fittedVideo.current === videoId || total <= 0) return
    fittedVideo.current = videoId
    autoFit.current = true
    fit()
  }, [videoId, total])
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
  const blockGeometry = (clip: CutClip): CSSProperties => {
    let left = clip.startSec * px
    let width = clip.seconds * px
    let transform: string | undefined
    if (drag !== null && drag.slot === clip.slot) {
      if (drag.kind === 'move') transform = `translateX(${String(drag.dx)}px)`
      if (drag.kind === 'trimStart') { const dx = Math.max(-clip.inSec * px, Math.min(drag.dx, width - 4)); left += dx; width -= dx }
      if (drag.kind === 'trimEnd') width = Math.max(4, Math.min(width + drag.dx, (clip.assetSeconds - clip.inSec) * px))
    }
    return { position: 'absolute', top: 0, bottom: 0, left, width, ...transform === undefined ? {} : { transform, zIndex: 3, opacity: 0.85 } }
  }

  // Episode tabs: click selects, double-click renames in place, right-click opens a menu with rename and delete.
  const tabs = (
    <div role="tablist" aria-label={t('tabs.aria')} style={{ display: 'flex', gap: 4, padding: '6px 8px', borderBottom: `1px solid ${palette.line}`, alignItems: 'center', flexWrap: 'wrap' }}>
      {videos.map((entry, index) => renaming?.id === entry.id ? (
        <input
          key={entry.id} autoFocus value={renaming.title} aria-label={t('tabs.renameAria')}
          onChange={(event) => { setRenaming({ id: entry.id, title: event.target.value }) }}
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
          key={entry.id} type="button" role="tab" aria-selected={entry === video} data-video-id={entry.id}
          onClick={() => { setActiveId(entry.id) }}
          onDoubleClick={() => { startRename(entry.id) }}
          onContextMenu={(event) => {
            event.preventDefault()
            const box = event.currentTarget.getBoundingClientRect()
            setMenu({ id: entry.id, x: box.left, y: box.bottom })
          }}
          style={{ ...button, border: 'none', background: entry === video ? palette.hover : 'transparent', fontWeight: entry === video ? 600 : 400 }}
        >
          {titleOf(index)}
        </button>
      ))}
      <button type="button" disabled={readOnly} onClick={createVideo} style={buttonStyle(readOnly, { border: 'none', color: palette.muted })}>{t('tabs.new')}</button>
      {menu !== null ? (
        <div ref={menuRef} role="menu" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 20, background: palette.panel, border: `1px solid ${palette.line}`, borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0, 0, 0, 0.16)', minWidth: 120 }}>
          <button type="button" role="menuitem" disabled={readOnly} onClick={() => { startRename(menu.id) }} style={buttonStyle(readOnly, { border: 'none', display: 'block', width: '100%', textAlign: 'left' })}>{t('tabs.rename')}</button>
          <button type="button" role="menuitem" disabled={readOnly} onClick={() => { deleteVideo(menu.id) }} style={buttonStyle(readOnly, { border: 'none', display: 'block', width: '100%', textAlign: 'left', color: palette.playhead })}>{t('tabs.delete')}</button>
        </div>
      ) : null}
    </div>
  )

  const viewer = (
    <div style={{ position: 'relative', flex: '1 1 45%', minHeight: 140, background: '#000' }} data-testid="vh-cuts-viewer">
      {[0, 1].map(which => (
        <video
          key={which} ref={player.elements[which as 0 | 1]} muted={false} playsInline preload="auto"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', visibility: player.front === which && clips.length > 0 ? 'visible' : 'hidden' }}
        />
      ))}
      {clips.length === 0 ? <p data-testid="vh-cuts-viewer-empty" style={{ position: 'absolute', inset: 0, margin: 'auto', height: 20, textAlign: 'center', color: palette.muted }}>{t(video === null ? 'viewer.noEpisodes' : 'viewer.empty')}</p> : null}
    </div>
  )

  const toolbar = (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 8px', borderTop: `1px solid ${palette.line}`, borderBottom: `1px solid ${palette.line}`, flexWrap: 'wrap' }}>
      <button
        type="button" style={buttonStyle(head !== 'main' || undoElsewhere)} disabled={head !== 'main' || undoElsewhere} title={undoElsewhere ? t('tool.undoElsewhere', { title: undoElsewhereTitle }) : undefined}
        onClick={undo}
      >
        {t('tool.undo')}
      </button>
      <button type="button" style={buttonStyle(head !== 'main' || redoEntry === null)} disabled={head !== 'main' || redoEntry === null} onClick={redo}>{t('tool.redo')}</button>
      <button type="button" style={buttonStyle(readOnly || clips.length === 0)} disabled={readOnly || clips.length === 0} onClick={splitAtPlayhead}>{t('tool.split')}</button>
      <span style={{ flex: 1 }} />
      <button type="button" style={buttonStyle(clips.length === 0)} disabled={clips.length === 0} aria-label={player.playing ? t('tool.pause') : t('tool.play')} onClick={() => { if (player.playing) player.pause(); else player.play() }}>
        {player.playing ? '❚❚' : '▶'}
      </button>
      <span data-testid="vh-cuts-time" style={{ fontVariantNumeric: 'tabular-nums', color: palette.muted }}>{`${timecode(player.position)} / ${timecode(total)}`}</span>
      <span style={{ flex: 1 }} />
      <label style={{ display: 'flex', gap: 4, alignItems: 'center', color: palette.muted }}>
        {t('tool.zoom')}
        <input type="range" min={5} max={200} value={px} onChange={(event) => { autoFit.current = false; setPx(Number(event.target.value)) }} style={{ width: 80 }} />
      </label>
      <button type="button" style={button} onClick={() => { autoFit.current = true; fit() }}>{t('tool.fit')}</button>
      <button type="button" style={buttonStyle(readOnly || exporting || clips.length === 0, { background: palette.accent, borderColor: palette.accent, color: palette.onAccent })} disabled={readOnly || exporting || clips.length === 0} onClick={exportVideo}>
        {exporting ? t('tool.exporting') : t('tool.export')}
      </button>
      {exported !== null ? <a href={assetUrl(exported)} target="_blank" rel="noreferrer" data-testid="vh-cuts-exported" style={{ color: palette.accent }}>{t('tool.exported')}</a> : null}
    </div>
  )

  const playheadLeft = player.position * px
  const tracks = (
    <div ref={scroller} style={{ flex: '1 1 35%', minHeight: 120, overflow: 'auto', position: 'relative' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `${String(GUTTER)}px ${String(laneWidth)}px`, gridTemplateRows: '22px 64px 28px', minWidth: GUTTER + laneWidth }}>
        <span />
        <div
          ref={lane} data-testid="vh-cuts-ruler" style={{ position: 'relative', borderBottom: `1px solid ${palette.line}`, cursor: 'ew-resize' }}
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
          onDragOver={(event) => { if (event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) event.preventDefault() }}
          onDrop={(event) => {
            const asset = event.dataTransfer.getData(ASSET_DRAG_TYPE)
            const box = lane.current?.getBoundingClientRect()
            if (asset.length === 0 || readOnly) return
            event.preventDefault()
            event.stopPropagation()
            insert(dropSlot(clips, box === undefined ? total : (event.clientX - box.left) / px, null), asset)
          }}
        >
          {clips.map((clip) => {
            const name = assets.get(clip.assetId)?.name ?? clip.assetId
            // Trim handles take at most a quarter of the clip each, so a short clip keeps a body to select and drag.
            const handle = Math.max(2, Math.min(7, Math.floor(clip.seconds * px / 4)))
            const caption = `${String(clip.slot)} · ${clip.seconds.toFixed(1)}s${clip.stale ? ` · ${t('track.stale')}` : ''}${clip.draft ? ` · ${t('track.draft')}` : ''}`
            return (
              <div
                key={`${String(clip.slot)}:${clip.assetId}`} role="listitem" aria-label={t('track.clipAria', { slot: clip.slot, name })} aria-pressed={selected === clip.slot}
                data-clip-slot={clip.slot} data-clip-stale={clip.stale} data-clip-draft={clip.draft} title={caption} {...clipHandlers(clip, 'move')}
                style={{
                  ...blockGeometry(clip), boxSizing: 'border-box', borderRadius: 4, overflow: 'hidden', cursor: readOnly ? 'pointer' : 'grab', touchAction: 'none',
                  background: clip.thumbnail === null ? palette.clip : `${palette.clip} url("${assetUrl(clip.thumbnail)}") left center / auto 100% repeat-x`,
                  // A border in the track color keeps a visible gap between neighboring clips.
                  border: `2px solid ${selected === clip.slot ? palette.text : clip.stale ? palette.playhead : palette.bg}`,
                  outline: clip.draft ? `2px dashed ${palette.accent}` : undefined, outlineOffset: clip.draft ? -4 : undefined,
                }}
              >
                {clip.thumbnail === null ? <video src={assetUrl(clip.assetId)} preload="metadata" muted style={{ height: '100%', pointerEvents: 'none' }} /> : null}
                <span style={{ position: 'absolute', left: handle + 2, right: handle + 2, bottom: 2, fontSize: 10, color: '#fff', textShadow: '0 0 3px #000', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none' }}>
                  {caption}
                </span>
                <span aria-label={t('track.trimStart', { slot: clip.slot })} data-trim="start" {...clipHandlers(clip, 'trimStart')} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: handle, cursor: 'col-resize', background: 'rgba(255,255,255,0.35)' }} />
                <span aria-label={t('track.trimEnd', { slot: clip.slot })} data-trim="end" {...clipHandlers(clip, 'trimEnd')} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: handle, cursor: 'col-resize', background: 'rgba(255,255,255,0.35)' }} />
              </div>
            )
          })}
          {video === null ? null : (
            <button
              type="button" aria-label={t('track.add')} disabled={readOnly} onClick={() => { setPicking(!picking) }}
              style={buttonStyle(readOnly, { position: 'absolute', left: total * px + 8, top: 14, width: 32, height: 32, padding: 0, fontSize: 16 })}
            >
              ＋
            </button>
          )}
        </div>
        <span style={{ color: palette.muted, alignSelf: 'center', paddingLeft: 8 }}>{t('track.audio')}</span>
        <div style={{ position: 'relative', margin: '3px 0' }} aria-hidden>
          {clips.map(clip => (
            <div
              key={`${String(clip.slot)}:${clip.assetId}`}
              style={{ ...blockGeometry(clip), boxSizing: 'border-box', borderRadius: 3, border: `1px solid ${palette.bg}`, background: `repeating-linear-gradient(90deg, ${palette.audio} 0 2px, transparent 2px 4px), ${palette.panel}`, opacity: 0.8 }}
            />
          ))}
        </div>
      </div>
      <div
        aria-label={t('track.playhead')} data-testid="vh-cuts-playhead"
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
  const ownsDrag = (event: DragEvent<HTMLDivElement>): boolean => event.dataTransfer.types.includes('Files') || event.dataTransfer.types.includes(ASSET_DRAG_TYPE)
  const holdDrag = (event: DragEvent<HTMLDivElement>): void => {
    if (!ownsDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
  }
  const dropOutside = (event: DragEvent<HTMLDivElement>): void => {
    if (!ownsDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) setDropNotice(true)
  }

  return (
    <div
      onDragEnter={holdDrag} onDragOver={holdDrag} onDrop={dropOutside}
      tabIndex={0} onKeyDown={onKeyDown} data-testid="vh-cuts"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: palette.bg, color: palette.text, fontSize: 12, outline: 'none' }}
    >
      {tabs}
      {readOnly ? <p style={{ margin: 0, padding: '4px 8px', color: palette.muted }}>{t('draftHead')}</p> : null}
      {dropNotice ? <p role="status" style={{ margin: 0, padding: '4px 8px', color: palette.muted }}>{t('track.fileDrop')}</p> : null}
      {viewer}
      {toolbar}
      {tracks}
    </div>
  )
}
