/**
 * Continuous playback of one timeline's clips through two stacked `<video>` elements. The front element plays the
 * current clip from its in point; the back element holds the next clip, already seeked to its in point, so the switch
 * at the out point does not wait for a load. Placeholder clips, whose render is not done, have no video: playback jumps
 * over them to the next ready clip, and a seek onto one blanks the viewer.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { assetUrl } from '@dv/ui-kit/api.ts'
import { clipIndexAt, readyIndexFrom } from './timelines.ts'
import type { TrackClip } from './timelines.ts'

/** What the viewer and the toolbar read and call. */
export interface TimelinePlayer {
  /** The two video elements; `front` says which one is visible. */
  elements: [RefObject<HTMLVideoElement>, RefObject<HTMLVideoElement>]
  front: 0 | 1
  position: number
  playing: boolean
  play: () => void
  pause: () => void
  /** Show the frame at a timeline time; pauses playback. */
  seek: (position: number) => void
}

/**
 * Point an element at a ready clip and seek it.
 * @param element - the video element.
 * @param assetId - the clip's asset.
 * @param assetTime - time inside the clip's asset.
 */
function cue(element: HTMLVideoElement, assetId: string, assetTime: number): void {
  const src = assetUrl(assetId)
  if (element.getAttribute('src') !== src) element.setAttribute('src', src)
  try {
    element.currentTime = assetTime
  } catch (error: unknown) {
    // Some engines refuse a seek before metadata loads; the element then starts at 0, which only shifts one preview.
    void error
  }
}

/**
 * Start an element, ignoring the rejection a browser raises when playback is interrupted or not allowed.
 * @param element - the video element.
 */
function start(element: HTMLVideoElement): void {
  try {
    void Promise.resolve(element.play()).catch((error: unknown) => { void error })
  } catch (error: unknown) {
    // Environments without media playback (tests) throw synchronously; the playhead still moves on seek.
    void error
  }
}

/**
 * Stop an element and detach its source so it shows no frame.
 * @param element - the video element.
 */
function blank(element: HTMLVideoElement): void {
  element.pause()
  if (!element.hasAttribute('src')) return
  element.removeAttribute('src')
  element.load()
}

/**
 * Keep two video elements in step with a timeline position, and advance across clips while playing. Switching to
 * another timeline stops playback, blanks both elements, and moves the playhead to 0; a timeline without clips leaves both
 * elements blank.
 * @param timelineId - the ID of the shown timeline, or null when the project has none.
 * @param clips - the placed clips of the shown timeline.
 * @param total - the timeline's length in seconds.
 * @returns the player.
 */
export function useTimelinePlayer(timelineId: string | null, clips: TrackClip[], total: number): TimelinePlayer {
  const first = useRef<HTMLVideoElement>(null)
  const second = useRef<HTMLVideoElement>(null)
  const frontRef = useRef<0 | 1>(0)
  const current = useRef(-1)
  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const [front, setFront] = useState<0 | 1>(0)
  const [position, setPosition] = useState(0)
  // The timeline the position belongs to: right after a switch, before the reset effect runs, the playhead reads 0
  // instead of the previous timeline's time.
  const timelineRef = useRef(timelineId)
  timelineRef.current = timelineId
  const [positionOf, setPositionOf] = useState(timelineId)
  const [playing, setPlaying] = useState(false)
  const element = (which: 0 | 1): HTMLVideoElement | null => (which === 0 ? first : second).current

  // The back element holds the next ready clip at or after `index`.
  const preload = useCallback((index: number) => {
    const back = element(frontRef.current === 0 ? 1 : 0)
    const clip = clipsRef.current[readyIndexFrom(clipsRef.current, index)]
    if (back !== null && clip !== undefined && clip.assetId !== null) cue(back, clip.assetId, clip.inSec)
  }, [])

  const seek = useCallback((next: number) => {
    const list = clipsRef.current
    const clamped = Math.max(0, Math.min(next, total))
    element(frontRef.current)?.pause()
    setPlaying(false)
    setPosition(clamped)
    setPositionOf(timelineRef.current)
    const index = clipIndexAt(list, clamped)
    const clip = list[index]
    const shown = element(frontRef.current)
    if (clip === undefined || shown === null) return
    current.current = index
    if (clip.assetId === null) blank(shown)
    else cue(shown, clip.assetId, clip.inSec + Math.min(clamped - clip.startSec, clip.seconds))
    preload(index + 1)
  }, [total, preload])

  const pause = useCallback(() => {
    element(frontRef.current)?.pause()
    setPlaying(false)
  }, [])

  const play = useCallback(() => {
    const list = clipsRef.current
    if (readyIndexFrom(list, 0) === -1) return
    if (position >= total - 0.05 || current.current === -1) seek(position >= total - 0.05 ? 0 : position)
    // From a placeholder, playback starts at the next ready clip, or at the first one when none follows.
    if (list[current.current]?.status !== 'ready') {
      const later = readyIndexFrom(list, current.current + 1)
      seek(list[later === -1 ? readyIndexFrom(list, 0) : later]?.startSec ?? 0)
    }
    const shown = element(frontRef.current)
    if (shown !== null) start(shown)
    setPlaying(true)
  }, [position, total, seek])

  // While playing, follow the front element every frame and switch elements at each out point.
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = (): void => {
      const list = clipsRef.current
      const shown = element(frontRef.current)
      const clip = list[current.current]
      if (shown === null || clip === undefined) { setPlaying(false); return }
      setPosition(clip.startSec + Math.max(0, shown.currentTime - clip.inSec))
      if (shown.currentTime >= clip.outSec - 0.03 || shown.ended) {
        const nextIndex = readyIndexFrom(list, current.current + 1)
        const next = list[nextIndex]
        shown.pause()
        if (next === undefined || next.assetId === null) { setPosition(total); setPlaying(false); return }
        const back: 0 | 1 = frontRef.current === 0 ? 1 : 0
        const incoming = element(back)
        if (incoming === null) { setPlaying(false); return }
        if (incoming.getAttribute('src') !== assetUrl(next.assetId)) cue(incoming, next.assetId, next.inSec)
        start(incoming)
        frontRef.current = back
        setFront(back)
        current.current = nextIndex
        preload(current.current + 1)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame) }
  }, [playing, total, preload])

  // An edit changes the clips under the playhead; show the frame at the same time again. Another timeline starts at 0.
  const layout = clips.map(clip => `${clip.assetId ?? clip.status}@${String(clip.inSec)}-${String(clip.outSec)}`).join('|')
  const shownTimeline = useRef(timelineId)
  useEffect(() => {
    const switched = shownTimeline.current !== timelineId
    shownTimeline.current = timelineId
    if (switched || clips.length === 0) {
      for (const which of [0, 1] as const) {
        const target = element(which)
        if (target !== null) blank(target)
      }
      frontRef.current = 0
      setFront(0)
      current.current = -1
    }
    seek(switched ? 0 : Math.min(position, total))
  }, [timelineId, layout])

  return { elements: [first, second], front, position: positionOf === timelineId ? position : 0, playing, play, pause, seek }
}
