/** The zoom factor of one wheel event: mouse wheels, touchpad pinches, and line-mode deltas. */
import { describe, expect, it } from 'vitest'
import { wheelZoomFactor } from '../src/client/CanvasView.tsx'

describe('wheelZoomFactor', () => {
  it('zooms a mouse wheel notch by about 14%', () => {
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false })).toBeCloseTo(Math.exp(0.15))
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false })).toBeCloseTo(Math.exp(-0.15))
  })

  it('zooms a touchpad pinch (ctrlKey) faster per pixel than a mouse wheel', () => {
    const pinch = wheelZoomFactor({ deltaY: -10, deltaMode: 0, ctrlKey: true })
    const wheel = wheelZoomFactor({ deltaY: -10, deltaMode: 0, ctrlKey: false })
    expect(pinch).toBeCloseTo(Math.exp(0.1))
    expect(pinch).toBeGreaterThan(wheel)
  })

  it('converts line-mode deltas to pixels', () => {
    expect(wheelZoomFactor({ deltaY: -3, deltaMode: 1, ctrlKey: false })).toBeCloseTo(Math.exp(3 * 16 * 0.0015))
  })
})
