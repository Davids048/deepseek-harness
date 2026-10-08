/**
 * The node editor panel's geometry: the centered default, moves that keep the header reachable, resizes, and fitting a
 * remembered rectangle.
 */
import { describe, expect, it } from 'vitest'
import { clampEditorRect, defaultEditorRect, fitEditorRect, moveEditorRect, resizeEditorRect } from '../src/client/NodeEditor.tsx'

const area = { width: 1200, height: 800 }
const both = { right: true, bottom: true }

describe('defaultEditorRect', () => {
  it('centers a 720-wide panel at 80% of the area height', () => {
    expect(defaultEditorRect(area)).toEqual({ x: 240, y: 80, width: 720, height: 640 })
  })

  it('keeps 24 px margins in a narrow area and gives at least 480 px of height when it fits', () => {
    expect(defaultEditorRect({ width: 600, height: 560 })).toEqual({ x: 24, y: 40, width: 552, height: 480 })
  })

  it('takes the area height minus the margins when 480 px does not fit', () => {
    expect(defaultEditorRect({ width: 900, height: 400 })).toEqual({ x: 90, y: 24, width: 720, height: 352 })
  })
})

describe('moveEditorRect', () => {
  const start = { x: 240, y: 80, width: 720, height: 640 }

  it('moves by the pointer offset', () => {
    expect(moveEditorRect(start, 50, -30, area)).toEqual({ ...start, x: 290, y: 50 })
  })

  it('keeps 48 px of the header inside the area on every side', () => {
    expect(moveEditorRect(start, -5000, -5000, area)).toEqual({ ...start, x: 48 - 720, y: 0 })
    expect(moveEditorRect(start, 5000, 5000, area)).toEqual({ ...start, x: 1200 - 48, y: 800 - 48 })
  })
})

describe('resizeEditorRect', () => {
  const start = { x: 100, y: 100, width: 720, height: 640 }

  it('moves only the chosen edges and keeps the top-left corner', () => {
    expect(resizeEditorRect(start, 40, 30, both, area)).toEqual({ ...start, width: 760, height: 670 })
    expect(resizeEditorRect(start, 40, 30, { right: true, bottom: false }, area)).toEqual({ ...start, width: 760 })
    expect(resizeEditorRect(start, 40, 30, { right: false, bottom: true }, area)).toEqual({ ...start, height: 670 })
  })

  it('keeps at least 480 × 320 px and stops the moving edges at the area edges', () => {
    expect(resizeEditorRect(start, -1000, -1000, both, area)).toEqual({ ...start, width: 480, height: 320 })
    expect(resizeEditorRect(start, 5000, 5000, both, area)).toEqual({ ...start, width: 1100, height: 700 })
  })

  it('still grows to the minimum size when the panel sits near the area edge', () => {
    const nearEdge = { x: 900, y: 600, width: 480, height: 320 }
    expect(resizeEditorRect(nearEdge, 100, 100, both, area)).toEqual(nearEdge)
  })
})

describe('clampEditorRect and fitEditorRect', () => {
  it('caps the minimum size at an area smaller than the minimum', () => {
    expect(clampEditorRect({ x: 0, y: 0, width: 720, height: 640 }, { width: 400, height: 300 }))
      .toEqual({ x: 0, y: 0, width: 400, height: 300 })
  })

  it('fits a rectangle remembered under a larger window fully inside the area', () => {
    expect(fitEditorRect({ x: 900, y: 500, width: 1000, height: 700 }, { width: 800, height: 600 }))
      .toEqual({ x: 0, y: 0, width: 800, height: 600 })
    expect(fitEditorRect({ x: 700, y: 400, width: 600, height: 400 }, { width: 1000, height: 700 }))
      .toEqual({ x: 400, y: 300, width: 600, height: 400 })
  })

  it('leaves a rectangle that fits unchanged', () => {
    const rect = { x: 10, y: 20, width: 500, height: 400 }
    expect(fitEditorRect(rect, area)).toEqual(rect)
  })
})
