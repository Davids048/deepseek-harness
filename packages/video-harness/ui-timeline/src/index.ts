/**
 * Host half of the timeline plugin: nothing. The browser half in `src/client/` registers the tab; the host serves it
 * through `@video-harness/views`.
 *
 * @module @video-harness/ui-timeline
 */

/** Loader entry; the plugin has no host behavior. */
export function apply(): void {}
