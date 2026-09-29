/**
 * DreamVerse assets UI, browser half: fills the kit's `dreamverse.asset-library` slot with the asset library dialog.
 *
 * @module @dreamverse/ui-assets/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@dreamverse/ui-kit/contracts.ts'
import AssetLibrary from './components/assets/AssetLibrary.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Register the occupant while the kit declares the slot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('dreamverse.asset-library', () =>
    ctx.slots.register({ name: 'dreamverse.asset-library' }, AssetLibrary))
}
