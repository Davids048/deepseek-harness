/**
 * Host half of the asset pool panel plugin: nothing. The browser half in `src/client/` registers the tab; the host
 * serves the data through `@dv/api`.
 *
 * @module @dv/ui-asset-pool
 */

/** Loader entry; the plugin has no host behavior. */
export function apply(): void {}
