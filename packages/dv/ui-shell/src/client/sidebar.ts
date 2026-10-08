/**
 * The fold state of DSH's left sidebar as the shell drives it. DSH's app frame (`@deepseek-ai/dsh-client-ui-layout`)
 * sets the `data-sidebar-collapsed` attribute while the sidebar is closed, and `ctx.layout` can toggle the sidebar but
 * does not report its state, so the shell reads the attribute. The frame updates the attribute only after React
 * commits a toggle, so the shell also keeps the fold its own last toggle asked for until the attribute shows it; a
 * second fold request in the same tick then reads that fold instead of the stale attribute.
 *
 * @module @dv/ui-shell/sidebar
 */
/** The frame attribute that DSH sets while the left sidebar is collapsed. */
const COLLAPSED_ATTRIBUTE = 'data-sidebar-collapsed'

/** @returns whether DSH's app frame shows the left sidebar collapsed. */
export function isSidebarCollapsed(): boolean {
  return document.querySelector(`[${COLLAPSED_ATTRIBUTE}]`) !== null
}

/** The shell's fold actions on DSH's left sidebar. */
export interface SidebarFold {
  /** Collapse the sidebar when it is expanded, remembering that the shell collapsed it. */
  collapse(): void
  /** Expand the sidebar when the shell collapsed it and nobody unfolded or folded it since. */
  restore(): void
  /** Stop watching the frame attribute. */
  dispose(): void
}

/**
 * Drive the left sidebar's fold through a toggle. Collapse and restore are idempotent across calls in one tick, and a
 * fold the user toggles from DSH's rail clears the shell's mark, so a later restore leaves the user's choice alone.
 * @param toggle - flips the sidebar through `ctx.layout.toggleSidebar()`; returns false when no layout service is mounted.
 * @returns the fold actions.
 */
export function createSidebarFold(toggle: () => boolean): SidebarFold {
  // The fold the shell's last toggle asked for, until the frame attribute shows it; null while none is pending.
  let requested: boolean | null = null
  // Whether the shell collapsed the sidebar and neither the shell nor the user changed the fold since.
  let collapsedByShell = false
  const collapsed = (): boolean => requested ?? isSidebarCollapsed()
  const fold = (value: boolean): void => {
    if (collapsed() === value || !toggle()) return
    // Two toggles in one tick cancel out before the frame renders, leaving the attribute as it was.
    requested = isSidebarCollapsed() === value ? null : value
  }
  // A fold change that no pending shell toggle explains came from DSH's rail or the frame's own resize rules.
  let shown = isSidebarCollapsed()
  const observer = new MutationObserver(() => {
    const now = isSidebarCollapsed()
    if (now === shown) return
    shown = now
    if (requested === null) collapsedByShell = false
    else if (now === requested) requested = null
  })
  observer.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: [COLLAPSED_ATTRIBUTE] })
  return {
    collapse() {
      if (collapsed()) return
      fold(true)
      collapsedByShell = true
    },
    restore() {
      if (collapsedByShell) fold(false)
      collapsedByShell = false
    },
    dispose() {
      observer.disconnect()
    },
  }
}
