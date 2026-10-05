/**
 * Browser events and drag data that the DreamVerse workspace panels exchange without importing each other. Panels
 * dispatch the events on `window`; the shell or the panel that owns the target listens. To prefill the chat composer,
 * call `dispatchCompose` from `@video-harness/ui-kit/compose.ts`, which owns the `vh:compose` event.
 *
 * @module @video-harness/ui-kit/workspace-events
 */

/** The `DataTransfer` type whose value is an asset ID, set by asset drag sources. */
export const VH_ASSET_DRAG_TYPE = 'application/x-vh-asset'

/** Event names and their `detail` fields. */
export interface VhWorkspaceEventMap {
  /** Insert an asset into the active cut. */
  'vh:cut-insert': { assetId: string }
  /** Switch the center to the canvas and focus the node of a record. */
  'vh:canvas-focus': { opId: string }
}

/**
 * Dispatch one workspace event on `window`.
 * @param name - the event name.
 * @param detail - the event fields.
 */
export function dispatchWorkspaceEvent<K extends keyof VhWorkspaceEventMap>(name: K, detail: VhWorkspaceEventMap[K]): void {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}
