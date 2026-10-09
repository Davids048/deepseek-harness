/**
 * The first frame of a video as an image URL, so a track clip without a still image can repeat its video's first frame
 * across its whole width. Each video is read once per page: the browser loads it, draws the frame at its start on a
 * canvas `FRAME_HEIGHT` pixels high, keeps the JPEG data URL, and then releases the video.
 *
 * @module @dv/ui-timeline/first-frame
 */
import { useEffect, useState } from 'react'

/** The height in pixels of a kept frame; the width follows the video's aspect ratio. Track rows are lower than this. */
const FRAME_HEIGHT = 90

/** Video URL → its first frame as a JPEG data URL, or null when the browser could not decode the video. */
const frames = new Map<string, Promise<string | null>>()

/**
 * Read the first frame of a video once.
 * @param url - the video URL, same origin as the page.
 * @returns the frame as a JPEG data URL, or null when the video does not decode.
 */
function firstFrame(url: string): Promise<string | null> {
  const known = frames.get(url)
  if (known !== undefined) return known
  const frame = new Promise<string | null>((resolve) => {
    const video = document.createElement('video')
    const finish = (frameUrl: string | null): void => {
      video.removeAttribute('src')
      video.load()
      resolve(frameUrl)
    }
    video.muted = true
    video.preload = 'auto'
    video.addEventListener('loadeddata', () => {
      const canvas = document.createElement('canvas')
      canvas.height = FRAME_HEIGHT
      canvas.width = video.videoHeight === 0 ? 0 : Math.round(video.videoWidth * FRAME_HEIGHT / video.videoHeight)
      const context = canvas.getContext('2d')
      if (context === null || canvas.width === 0) { finish(null); return }
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      finish(canvas.toDataURL('image/jpeg', 0.8))
    }, { once: true })
    video.addEventListener('error', () => { finish(null) }, { once: true })
    video.src = url
  })
  frames.set(url, frame)
  return frame
}

/**
 * The first frames of some videos, set once every video of the list is read.
 * @param urls - the video URLs.
 * @returns video URL → first frame data URL, for the videos that decode.
 */
export function useFirstFrames(urls: readonly string[]): ReadonlyMap<string, string> {
  const [read, setRead] = useState<ReadonlyMap<string, string>>(new Map())
  const key = urls.join('\n')
  useEffect(() => {
    let live = true
    const list = key === '' ? [] : key.split('\n')
    void Promise.all(list.map(firstFrame)).then((frameUrls) => {
      if (!live) return
      const next = new Map<string, string>()
      list.forEach((url, index) => {
        const frameUrl = frameUrls[index]
        if (frameUrl !== null && frameUrl !== undefined) next.set(url, frameUrl)
      })
      setRead(next)
    })
    return () => { live = false }
  }, [key])
  return read
}
