/**
 * Host half of the DreamVerse shell plugin: nothing. The browser half in `src/client/` replaces the center and the
 * sidebar navigator; the host serves its data through `@dv/api`.
 *
 * @module @dv/ui-shell
 */

/** Loader entry; the plugin has no host behavior. */
export function apply(): void {}
