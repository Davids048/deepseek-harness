// @vitest-environment jsdom
/** The pop-up zoom transition: growing out of the opener, shrinking back into it, and the fallbacks. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { mediaBox, useZoomPresence } from '../src/client/zoom.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations')
})

/** One `element.animate` call: the element, its keyframes, and a way to end the animation. */
interface AnimateCall {
  element: Element
  keyframes: Keyframe[]
  finish: () => void
}

/**
 * Give jsdom a Web Animations API whose animations end only when the test finishes them, a viewport of 1200 × 800, and
 * boxes: the opener at 100, 600 (200 × 100) and the pop-up at 300, 100 (600 × 300).
 * @param openerBox - the opener's box on screen.
 * @returns the recorded animate calls.
 */
function stubLayout(openerBox = { left: 100, top: 600, width: 200, height: 100 }): AnimateCall[] {
  const calls: AnimateCall[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  Object.assign(window, { innerWidth: 1200, innerHeight: 800 })
  const box = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset['role'] === 'opener'
      ? box(openerBox.left, openerBox.top, openerBox.width, openerBox.height)
      : box(300, 100, 600, 300)
  })
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: function (this: Element, keyframes: Keyframe[]) {
      let finish = (): void => undefined
      const finished = new Promise<void>((resolve) => { finish = resolve })
      calls.push({ element: this, keyframes, finish: () => { finish() } })
      return { finished, cancel: () => undefined }
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: () => [] })
  return calls
}

/**
 * A pop-up for `value` with a backdrop, opened from a fixed opener.
 * @param props - the value whose pop-up is open, or null.
 * @returns the opener and, while shown, the pop-up.
 */
function Harness({ value }: { value: string | null }): ReactNode {
  const zoom = useZoomPresence(value, () => document.querySelector('[data-role="opener"]'))
  return (
    <>
      <button type="button" data-role="opener">open</button>
      {zoom.shown === null ? null : <div><div ref={zoom.fadeRef} data-role="backdrop" /><div ref={zoom.targetRef} data-role="popup">{zoom.shown}</div></div>}
    </>
  )
}

describe('useZoomPresence', () => {
  it('grows the pop-up out of its opener, and keeps it on screen until it has shrunk back', async () => {
    const calls = stubLayout()
    const view = render(<Harness value={null} />)
    view.rerender(<Harness value="v1" />)
    const popup = view.container.querySelector('[data-role="popup"]')
    expect(popup?.textContent).toBe('v1')
    // The first frame lays the pop-up over the opener: moved by (100 - 300, 600 - 100) and scaled by 200/600 × 100/300.
    const grow = calls.find(call => call.element === popup)
    expect(grow?.keyframes[0]).toMatchObject({ transform: 'translate(-200px, 500px) scale(0.3333333333333333, 0.3333333333333333)', transformOrigin: '0 0' })
    expect(grow?.keyframes[1]).toMatchObject({ transform: 'none' })
    expect(calls.some(call => call.element.getAttribute('data-role') === 'backdrop')).toBe(true)

    view.rerender(<Harness value={null} />)
    const shrink = calls.at(-1)
    expect(shrink?.keyframes.at(-1)).toMatchObject({ transform: grow?.keyframes[0]?.transform })
    // The pop-up stays while it shrinks, and leaves once the animation ends.
    expect(view.container.querySelector('[data-role="popup"]')).not.toBeNull()
    await act(async () => { shrink?.finish(); await Promise.resolve() })
    expect(view.container.querySelector('[data-role="popup"]')).toBeNull()
  })

  it('scales and fades in place when the opener is off screen', () => {
    const calls = stubLayout({ left: 100, top: 900, width: 200, height: 100 })
    const view = render(<Harness value={null} />)
    view.rerender(<Harness value="v1" />)
    const popup = view.container.querySelector('[data-role="popup"]')
    expect(calls.find(call => call.element === popup)?.keyframes[0]).toMatchObject({ transform: 'scale(0.96)', opacity: 0 })
  })

  it('shows and removes the pop-up at once without the Web Animations API', () => {
    const view = render(<Harness value="v1" />)
    expect(view.container.querySelector('[data-role="popup"]')?.textContent).toBe('v1')
    view.rerender(<Harness value={null} />)
    expect(view.container.querySelector('[data-role="popup"]')).toBeNull()
  })
})

describe('mediaBox', () => {
  it('fits known media dimensions into the maximum box without enlarging them', () => {
    expect(mediaBox(1920, 1080, '80vw - 32px', '70vh')).toEqual({
      aspectRatio: '1920 / 1080', width: `min(80vw - 32px, 1920px, calc(70vh * ${String(1920 / 1080)}))`, height: 'auto',
    })
  })
})
