/**
 * Continuous playback of one video's clips through two stacked `<video>` elements. The front element plays the
 * current clip from its in point; the back element holds the next clip, already seeked to its in point, so the switch
 * at the out point does not wait for a load.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { assetUrl } from '@video-harness/ui-kit/api.ts'
import { clipIndexAt } from './sequences.ts'
import type { CutClip } from './sequences.ts'

/** What the viewer and the toolbar read and call. */
export interface SequencePlayer {
  /** The two video elements; `front` says which one is visible. */
  elements: [RefObject<HTMLVideoElement>, RefObject<HTMLVideoElement>]
  front: 0 | 1
  position: number
  playing: boolean
  play: () => void
  pause: () => void
  /** Show the frame at a sequence time; pauses playback. */
  seek: (position: number) => void
}

/**
 * Point an element at a clip and seek it.
 * @param element - the video element.
 * @param clip - the clip.
 * @param assetTime - time inside the clip's asset.
 */
function cue(element: HTMLVideoElement, clip: CutClip, assetTime: number): void {
  const src = assetUrl(clip.assetId)
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
 * Keep two video elements in step with a sequence position, and advance across clips while playing. Switching to
 * another video stops playback, blanks both elements, and moves the playhead to 0; a video without clips leaves both
 * elements blank.
 * @param videoId - the ID of the shown video, or null when the project has none.
 * @param clips - the placed clips of the shown video.
 * @param total - the video's length in seconds.
 * @returns the player.
 */
export function useSequencePlayer(videoId: string | null, clips: CutClip[], total: number): SequencePlayer {
  const first = useRef<HTMLVideoElement>(null)
  const second = useRef<HTMLVideoElement>(null)
  const frontRef = useRef<0 | 1>(0)
  const current = useRef(-1)
  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const [front, setFront] = useState<0 | 1>(0)
  const [position, setPosition] = useState(0)
  // The video the position belongs to: right after a switch, before the reset effect runs, the playhead reads 0
  // instead of the previous video's time.
  const videoRef = useRef(videoId)
  videoRef.current = videoId
  const [positionOf, setPositionOf] = useState(videoId)
  const [playing, setPlaying] = useState(false)
  const element = (which: 0 | 1): HTMLVideoElement | null => (which === 0 ? first : second).current

  const preload = useCallback((index: number) => {
    const back = element(frontRef.current === 0 ? 1 : 0)
    const clip = clipsRef.current[index]
    if (back !== null && clip !== undefined) cue(back, clip, clip.inSec)
  }, [])

  const seek = useCallback((next: number) => {
    const list = clipsRef.current
    const clamped = Math.max(0, Math.min(next, total))
    element(frontRef.current)?.pause()
    setPlaying(false)
    setPosition(clamped)
    setPositionOf(videoRef.current)
    const index = clipIndexAt(list, clamped)
    const clip = list[index]
    const shown = element(frontRef.current)
    if (clip === undefined || shown === null) return
    current.current = index
    cue(shown, clip, clip.inSec + Math.min(clamped - clip.startSec, clip.seconds))
    preload(index + 1)
  }, [total, preload])

  const pause = useCallback(() => {
    element(frontRef.current)?.pause()
    setPlaying(false)
  }, [])

  const play = useCallback(() => {
    if (clipsRef.current.length === 0) return
    if (position >= total - 0.05 || current.current === -1) seek(position >= total - 0.05 ? 0 : position)
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
        const next = list[current.current + 1]
        shown.pause()
        if (next === undefined) { setPosition(total); setPlaying(false); return }
        const back: 0 | 1 = frontRef.current === 0 ? 1 : 0
        const incoming = element(back)
        if (incoming === null) { setPlaying(false); return }
        if (incoming.getAttribute('src') !== assetUrl(next.assetId)) cue(incoming, next, next.inSec)
        start(incoming)
        frontRef.current = back
        setFront(back)
        current.current += 1
        preload(current.current + 1)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame) }
  }, [playing, total, preload])

  // An edit changes the clips under the playhead; show the frame at the same time again. Another video starts at 0.
  const layout = clips.map(clip => `${clip.assetId}@${String(clip.inSec)}-${String(clip.outSec)}`).join('|')
  const shownVideo = useRef(videoId)
  useEffect(() => {
    const switched = shownVideo.current !== videoId
    shownVideo.current = videoId
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
  }, [videoId, layout])

  return { elements: [first, second], front, position: positionOf === videoId ? position : 0, playing, play, pause, seek }
}
