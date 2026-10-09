/**
 * The right panel's default width. DSH sizes the right panel at 45% of the frame on its first opening, and `ctx.layout`
 * has no width setting, so the shell sets the width preference through the layout store's private `panels.setRightbar`
 * action, once per page load: a layout plugin reload then keeps the width the user dragged.
 *
 * @module @dv/ui-shell/right-panel
 */

/**
 * Width in px of the right panel until the user drags its edge; 448 fits the three 100 px tabs (对话, 素材库, 历史), the active
 * tab's close button, and the tab bar buttons.
 */
export const RIGHT_PANEL_WIDTH = 448

/** Whether this page load already set the right panel's default width. */
let applied = false

/**
 * Set the right panel's width preference to {@link RIGHT_PANEL_WIDTH} on the first call of the page load; later calls
 * do nothing. Logs a console warning when the layout service has no private `panels.setRightbar` action.
 * @param layout - DSH's `ctx.layout` service.
 */
export function applyRightPanelWidth(layout: object): void {
  if (applied) return
  applied = true
  const panels: unknown = Reflect.get(layout, 'panels')
  const setRightbar: unknown = panels !== null && typeof panels === 'object' ? Reflect.get(panels, 'setRightbar') : undefined
  if (typeof setRightbar === 'function') Reflect.apply(setRightbar, panels, [RIGHT_PANEL_WIDTH])
  else console.warn('ui-shell: ctx.layout has no private panels.setRightbar action; the right panel keeps DSH\'s default width')
}
