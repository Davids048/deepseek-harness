/**
 * Host half of the History panel plugin: nothing. The browser half in `src/client/` registers the tab; the host
 * serves the history through `@dv/api`.
 *
 * @module @dv/ui-history
 */

/** Loader entry; the plugin has no host behavior. */
export function apply(): void {}
