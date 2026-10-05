/**
 * Host half of the assets panel plugin: nothing. The browser half in `src/client/` registers the tab; the host serves
 * the data through `@video-harness/views`.
 *
 * @module @video-harness/ui-assets
 */

/** Loader entry; the plugin has no host behavior. */
export function apply(): void {}
