/**
 * The fold state of DSH's left sidebar, read from the `data-sidebar-collapsed` attribute that DSH's app frame
 * (`@deepseek-ai/dsh-client-ui-layout`) sets while the sidebar is closed. `ctx.layout` can toggle the sidebar but does
 * not report its state, so the shell reads the attribute.
 *
 * @module @dv/ui-shell/sidebar
 */
/** The frame attribute that DSH sets while the left sidebar is collapsed. */
const COLLAPSED_ATTRIBUTE = 'data-sidebar-collapsed'

/** @returns whether DSH's left sidebar is collapsed. */
export function isSidebarCollapsed(): boolean {
  return document.querySelector(`[${COLLAPSED_ATTRIBUTE}]`) !== null
}
