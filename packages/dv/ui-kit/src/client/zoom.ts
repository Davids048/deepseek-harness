/**
 * The zoom transition of the DreamVerse pop-ups: a pop-up grows out of the element that opened it (a chat video card,
 * a canvas node, an asset pool tile) and shrinks back into it when it closes, while its backdrop fades. When the
 * opener is gone or outside the viewport at that moment, the pop-up scales slightly and fades instead; under
 * `prefers-reduced-motion: reduce` it only fades. A browser without the Web Animations API shows and removes the
 * pop-up at once. The pop-up's box is measured when it opens and when it closes, so a pop-up whose media sets its size
 * must size that media before it loads ({@link mediaBox}).
 *
 * @module @dv/ui-kit/zoom
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

/** How long the pop-up takes to grow out of its opener, in milliseconds. */
const OPEN_MS = 300
/** How long the pop-up takes to shrink back, in milliseconds. */
const CLOSE_MS = 250
/** Fast at the start and settling slowly, close to the spring curve of iOS zoom transitions. */
const EASING = 'cubic-bezier(0.2, 0, 0, 1)'

/**
 * The size of an image or a video of known dimensions, fitted into a maximum box and never enlarged, set before the
 * media loads so that a pop-up showing it has its final size from its first frame.
 * @param width - the media's width in pixels.
 * @param height - the media's height in pixels.
 * @param maxWidth - the widest the media may be, as a CSS length.
 * @param maxHeight - the tallest the media may be, as a CSS length.
 * @returns the width and aspect ratio styles.
 */
export function mediaBox(width: number, height: number, maxWidth: string, maxHeight: string): CSSProperties {
  return {
    aspectRatio: `${String(width)} / ${String(height)}`,
    width: `min(${maxWidth}, ${String(width)}px, calc(${maxHeight} * ${String(width / height)}))`,
    height: 'auto',
  }
}

/** What {@link useZoomPresence} gives the pop-up. */
export interface ZoomPresence<V> {
  /** The value whose pop-up is on screen: the requested value, kept until the closing animation ends. */
  shown: V | null
  /** Attach to the element that grows out of the opener. */
  targetRef: (element: HTMLElement | null) => void
  /** Attach to each element that fades in and out with the pop-up, such as its backdrop. */
  fadeRef: (element: HTMLElement | null) => void
}

/**
 * @param rect - an element's box on screen.
 * @returns whether any of the box is inside the viewport.
 */
function onScreen(rect: DOMRect): boolean {
  const inside = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
  return rect.width > 0 && rect.height > 0 && inside
}

/**
 * Animate a pop-up between its opener and its own box.
 * @param target - the pop-up element.
 * @param opener - the element the pop-up grows out of, or null when it is gone.
 * @param fades - the elements that fade with the pop-up.
 * @param opening - true to grow out of the opener, false to shrink back into it.
 * @returns the pop-up's animation, or null when the browser has no Web Animations API.
 */
function animateZoom(target: HTMLElement, opener: Element | null, fades: Iterable<HTMLElement>, opening: boolean): Animation | null {
  if (typeof target.animate !== 'function') return null
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // A pop-up closed while it still grows shrinks from where it is on screen; its own box is measured without the
  // running animation, whose transform would distort the measurement.
  const inFlight = getComputedStyle(target).transform
  for (const animation of target.getAnimations()) animation.cancel()
  const to = target.getBoundingClientRect()
  const from = opener?.getBoundingClientRect() ?? null
  const zoom = !reduced && from !== null && onScreen(from) && to.width > 0 && to.height > 0
  // The collapsed frame lays the pop-up exactly over the opener; without one, the pop-up only scales a little and fades.
  let collapsed: Keyframe = { transform: 'none', transformOrigin: '50% 50%', opacity: 0 }
  if (zoom) {
    const move = `translate(${String(from.left - to.left)}px, ${String(from.top - to.top)}px)`
    collapsed = { transform: `${move} scale(${String(from.width / to.width)}, ${String(from.height / to.height)})`, transformOrigin: '0 0', opacity: 1 }
  } else if (!reduced) collapsed = { ...collapsed, transform: 'scale(0.96)' }
  const open: Keyframe = { transform: 'none', transformOrigin: collapsed.transformOrigin, opacity: 1 }
  const start: Keyframe = opening || inFlight === 'none' || inFlight === '' ? open : { ...open, transform: inFlight }
  // A closing pop-up holds its collapsed frame until it is removed.
  const timing: KeyframeAnimationOptions = { duration: opening ? OPEN_MS : CLOSE_MS, easing: EASING, fill: opening ? 'none' : 'forwards' }
  for (const fade of fades) {
    if (fade.isConnected) fade.animate(opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], timing)
  }
  return target.animate(opening ? [collapsed, open] : [start, collapsed], timing)
}

/**
 * Keep a pop-up on screen for a value and animate it between the value's opener and its own place. The pop-up opens
 * when the value turns non-null and closes when it turns null; `shown` stays set until the closing animation ends, so
 * every way of closing (a close button, Escape, a backdrop click, a state change elsewhere) animates the same way. A
 * value that changes from one non-null value to another swaps the pop-up without animating.
 * @param value - the value whose pop-up should be open, or null.
 * @param openerOf - the element a value's pop-up grows out of and shrinks back into, or null when it is gone.
 * @param onOpened - called once the pop-up finished growing, for example to start a video.
 * @returns the value on screen and the refs of the pop-up and its fading elements.
 */
export function useZoomPresence<V>(
  value: V | null, openerOf: (value: V) => Element | null, onOpened?: () => void,
): ZoomPresence<V> {
  const [shown, setShown] = useState<V | null>(null)
  const target = useRef<HTMLElement | null>(null)
  const fades = useRef(new Set<HTMLElement>())
  const closing = useRef<Animation | null>(null)
  const latest = useRef({ openerOf, onOpened, shown })
  latest.current = { openerOf, onOpened, shown }

  useLayoutEffect(() => {
    if (value !== null) {
      closing.current?.cancel()
      closing.current = null
      setShown(value)
      return
    }
    const current = latest.current.shown
    const element = target.current
    if (current === null || element === null) { setShown(null); return }
    const animation = animateZoom(element, latest.current.openerOf(current), fades.current, false)
    if (animation === null) { setShown(null); return }
    closing.current = animation
    animation.finished.then(() => {
      if (closing.current !== animation) return
      closing.current = null
      setShown(null)
    }, (error: unknown) => {
      // A cancelled close means the pop-up was asked to open again; it stays.
      void error
    })
  }, [value])

  // Grow the pop-up out of its opener the first time it is on screen. The measurement waits one animation frame, which
  // still runs before the first paint, so that the pop-up's own layout effects have placed it.
  const wasShown = useRef(false)
  useLayoutEffect(() => {
    const opened = shown !== null && !wasShown.current
    wasShown.current = shown !== null
    if (!opened) return
    const element = target.current
    if (element === null || typeof element.animate !== 'function') { latest.current.onOpened?.(); return }
    element.style.opacity = '0'
    const frame = requestAnimationFrame(() => {
      element.style.opacity = ''
      // A pop-up closed before its first frame only shrinks.
      if (closing.current !== null) return
      const value = latest.current.shown
      const animation = animateZoom(element, value === null ? null : latest.current.openerOf(value), fades.current, true)
      if (animation === null) { latest.current.onOpened?.(); return }
      animation.finished.then(() => { latest.current.onOpened?.() }, (error: unknown) => {
        // A cancelled open belongs to a pop-up that closed meanwhile; there is nothing to start.
        void error
      })
    })
    return () => { cancelAnimationFrame(frame); element.style.opacity = '' }
  }, [shown])

  const targetRef = useCallback((element: HTMLElement | null) => { target.current = element }, [])
  const fadeRef = useCallback((element: HTMLElement | null) => {
    if (element !== null) fades.current.add(element)
    for (const fade of fades.current) if (!fade.isConnected && fade !== element) fades.current.delete(fade)
  }, [])
  return { shown, targetRef, fadeRef }
}
