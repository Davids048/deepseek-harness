/**
 * Host half of the canvas plugin: nothing. The browser half in `src/client/` registers the tab; the host serves it
 * through `@dv/api`.
 *
 * @module @dv/ui-canvas
 */

/** Loader entry; the plugin has no host behavior. */
export function apply(): void {}
