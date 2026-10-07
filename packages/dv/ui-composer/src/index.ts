/**
 * Host half of the composer plugin: nothing. The browser half in `src/client/` registers the composer additions; the
 * host routes they call live in `@dv/api`.
 *
 * @module @dv/ui-composer
 */

/** Loader entry; the plugin has no host behavior. */
export function apply(): void {}
