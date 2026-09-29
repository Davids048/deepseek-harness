/**
 * DreamVerse player UI, node half. The empty apply gives the Loader a host-side row; the browser half ships through
 * `exports["./client"]`.
 *
 * @module @dreamverse/ui-player
 */

/** Host plugin body; this package contributes browser presentation only. */
export function apply(): void {}
