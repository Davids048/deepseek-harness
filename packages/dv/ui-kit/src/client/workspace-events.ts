/**
 * Browser events and drag data that the DreamVerse workspace panels exchange without importing each other. Panels
 * dispatch the events on `window`; the shell or the panel that owns the target listens. To prefill the chat composer,
 * call `dispatchCompose` from `@dv/ui-kit/compose.ts`, which owns the `dv:compose` event.
 *
 * @module @dv/ui-kit/workspace-events
 */

/** The `DataTransfer` type whose value is an asset ID, set by asset drag sources. */
export const DV_ASSET_DRAG_TYPE = 'application/x-dv-asset'

/** The event that inserts an asset into the current timeline. */
export const DV_TIMELINE_INSERT_EVENT = 'dv:timeline-insert'

/** The event that switches the center to the canvas and focuses the node of a record. */
export const DV_CANVAS_FOCUS_EVENT = 'dv:canvas-focus'

/** Event names and their `detail` fields. */
export interface DvWorkspaceEventMap {
  /** Insert an asset into the current timeline. */
  'dv:timeline-insert': { assetId: string }
  /** Switch the center to the canvas and focus the node of a record. */
  'dv:canvas-focus': { recordId: string }
}

/**
 * Dispatch one workspace event on `window`.
 * @param name - the event name.
 * @param detail - the event fields.
 */
export function dispatchWorkspaceEvent<K extends keyof DvWorkspaceEventMap>(name: K, detail: DvWorkspaceEventMap[K]): void {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}
