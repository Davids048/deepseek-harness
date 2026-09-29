/** @vitest-environment jsdom */
import '../../kit/tests/support/setup.client.ts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PresetQuickLaunchRail from '../src/client/components/creation/PresetQuickLaunchRail.tsx'

/** Supply browser measurements and resize notifications to the actual rail. */
function renderRail() {
  const storyPresets = [{ id: 'river', label: 'River' }, { id: 'desert', label: 'Desert' }]
  const onPresetGenerate = vi.fn()
  const observe = vi.fn<(target: Element) => void>()
  const disconnect = vi.fn()
  // The latest ResizeObserver that the rail created; calling before one exists fails the case.
  const resize = { notify: (): void => { throw new Error('The rail has not created a ResizeObserver') } }
  vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
    observe = observe
    unobserve = vi.fn()
    disconnect = disconnect
    constructor(callback: ResizeObserverCallback) {
      resize.notify = () => { act(() => { callback([], this) }) }
    }
  })
  const view = render(<PresetQuickLaunchRail storyPresets={storyPresets} onPresetGenerate={onPresetGenerate} />)
  const scrollElement = observe.mock.calls[0]?.[0]
  if (!scrollElement) throw new Error('Expected the rail to observe its scroll element')
  const layout = { clientWidth: 220, scrollWidth: 660 }
  const scrollBy = vi.fn()
  Object.defineProperties(scrollElement, {
    clientWidth: { configurable: true, get: () => layout.clientWidth },
    scrollWidth: { configurable: true, get: () => layout.scrollWidth },
    scrollBy: { configurable: true, value: scrollBy },
  })
  resize.notify()
  return { view, storyPresets, onPresetGenerate, scrollElement, layout, scrollBy, notifyResize: resize.notify, disconnect }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  cleanup()
  // Release fixture resources after the test has observed pending work.
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('PresetQuickLaunchRail', () => {
  /** Native scroll and resize notifications determine arrow visibility without advancing a clock. */
  it('updates arrows from scroll and resize notifications', () => {
    const { scrollElement, layout, scrollBy, notifyResize } = renderRail()
    expect(screen.queryByRole('button', { name: 'Scroll suggested prompts left' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Scroll suggested prompts right' }))
    expect(scrollBy).toHaveBeenNthCalledWith(1, { left: 220, behavior: 'smooth' })
    expect(screen.queryByRole('button', { name: 'Scroll suggested prompts left' })).not.toBeInTheDocument()

    scrollElement.scrollLeft = 220
    fireEvent.scroll(scrollElement)
    expect(screen.getByRole('button', { name: 'Scroll suggested prompts left' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Scroll suggested prompts right' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Scroll suggested prompts left' }))
    expect(scrollBy).toHaveBeenNthCalledWith(2, { left: -220, behavior: 'smooth' })
    expect(scrollBy).toHaveBeenCalledTimes(2)

    scrollElement.scrollLeft = 438
    fireEvent.scroll(scrollElement)
    expect(screen.getByRole('button', { name: 'Scroll suggested prompts left' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Scroll suggested prompts right' })).not.toBeInTheDocument()
    scrollElement.scrollLeft = 2
    fireEvent.scroll(scrollElement)
    expect(screen.queryByRole('button', { name: 'Scroll suggested prompts left' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Scroll suggested prompts right' })).toBeVisible()

    scrollElement.scrollLeft = 0
    layout.clientWidth = 660
    notifyResize()
    expect(screen.queryByRole('button', { name: 'Scroll suggested prompts left' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Scroll suggested prompts right' })).not.toBeInTheDocument()
    layout.clientWidth = 220
    notifyResize()
    expect(screen.getByRole('button', { name: 'Scroll suggested prompts right' })).toBeVisible()
  })

  /** Observe arrow-created work after unmount before fixture cleanup clears any pending timer. */
  it('leaves no delayed arrow callback after unmount', () => {
    const { view, scrollBy, disconnect } = renderRail()
    expect(vi.getTimerCount()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Scroll suggested prompts right' }))
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith({ left: 220, behavior: 'smooth' })
    view.unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  /** Preset buttons forward the selected ID and respect the caller's disabled state. */
  it('submits the selected preset only while enabled', () => {
    const { view, storyPresets, onPresetGenerate } = renderRail()
    fireEvent.click(screen.getByRole('button', { name: 'River' }))
    expect(onPresetGenerate).toHaveBeenCalledExactlyOnceWith('river')
    view.rerender(<PresetQuickLaunchRail storyPresets={storyPresets} disabled onPresetGenerate={onPresetGenerate} />)
    expect(screen.getByRole('button', { name: 'River' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Desert' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'River' }))
    fireEvent.click(screen.getByRole('button', { name: 'Desert' }))
    expect(onPresetGenerate).toHaveBeenCalledExactlyOnceWith('river')
  })
})
