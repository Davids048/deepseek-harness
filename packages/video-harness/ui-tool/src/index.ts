/**
 * Host half of the Tool mode plugin: nothing. The browser half in `src/client/` exports the Tool view and the Tool
 * session list; the host serves them through the Tool session routes of `@video-harness/views`.
 *
 * @module @video-harness/ui-tool
 */

/** Loader entry; the plugin has no host behavior. */
export function apply(): void {}
