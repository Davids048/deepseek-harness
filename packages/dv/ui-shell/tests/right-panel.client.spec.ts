/** The right panel's default width: set once per page load through the layout store's private action, or a warning. */
import { afterEach, describe, expect, it, vi } from 'vitest'

/** @returns a fresh copy of the module, as a page load evaluates it. */
const load = async (): Promise<typeof import('../src/client/right-panel.ts')> => {
  vi.resetModules()
  return import('../src/client/right-panel.ts')
}

afterEach(() => { vi.restoreAllMocks() })

describe('applyRightPanelWidth', () => {
  it('sets the default width once, so a layout plugin reload keeps the width the user dragged', async () => {
    const { applyRightPanelWidth, RIGHT_PANEL_WIDTH } = await load()
    const setRightbar = vi.fn()
    applyRightPanelWidth({ panels: { setRightbar } })
    applyRightPanelWidth({ panels: { setRightbar } })
    expect(setRightbar.mock.calls).toEqual([[RIGHT_PANEL_WIDTH]])
  })

  it('warns, naming the private action, when the layout service lacks it', async () => {
    const { applyRightPanelWidth } = await load()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    applyRightPanelWidth({})
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('panels.setRightbar')
  })
})
