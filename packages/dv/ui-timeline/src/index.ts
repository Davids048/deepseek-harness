/**
 * Host half of the timeline plugin: nothing. The browser half in `src/client/` registers the tab; the host serves it
 * through `@dv/api`.
 *
 * @module @dv/ui-timeline
 */

/** Loader entry; the plugin has no host behavior. */
export function apply(): void {}
