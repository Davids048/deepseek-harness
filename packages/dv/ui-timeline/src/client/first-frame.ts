/**
 * The first frame of a video as an image URL, so a track clip without a still image can repeat its video's first frame
 * across its whole width. Each video is read once per page: the browser loads it, draws the frame at its start on a
 * canvas, and keeps the PNG data URL.
 *
 * @module @dv/ui-timeline/first-frame
 */
import { useEffect, useState } from 'react'

/** Video URL → its first frame as a PNG data URL, or null when the browser could not decode the video. */
const frames = new Map<string, Promise<string | null>>()

/**
 * Read the first frame of a video once.
 * @param url - the video URL, same origin as the page.
 * @returns the frame as a PNG data URL, or null when the video does not decode.
 */
function firstFrame(url: string): Promise<string | null> {
  const known = frames.get(url)
  if (known !== undefined) return known
  const frame = new Promise<string | null>((resolve) => {
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.addEventListener('loadeddata', () => {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext('2d')
      if (context === null || canvas.width === 0 || canvas.height === 0) { resolve(null); return }
      context.drawImage(video, 0, 0)
      resolve(canvas.toDataURL('image/png'))
    }, { once: true })
    video.addEventListener('error', () => { resolve(null) }, { once: true })
    video.src = url
  })
  frames.set(url, frame)
  return frame
}

/**
 * The first frames of some videos, filled in as each one is read.
 * @param urls - the video URLs.
 * @returns video URL → first frame data URL, for the frames read so far.
 */
export function useFirstFrames(urls: readonly string[]): ReadonlyMap<string, string> {
  const [read, setRead] = useState<ReadonlyMap<string, string>>(new Map())
  const key = urls.join('\n')
  useEffect(() => {
    let live = true
    for (const url of key === '' ? [] : key.split('\n')) {
      void firstFrame(url).then((frame) => {
        if (live && frame !== null) setRead(current => current.get(url) === frame ? current : new Map(current).set(url, frame))
      })
    }
    return () => { live = false }
  }, [key])
  return read
}
