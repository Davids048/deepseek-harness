/**
 * DreamVerse assets UI, browser half: fills the kit's `dreamverse.asset-library` slot with the asset library dialog and
 * registers the dialog's copy as the `dreamverse.assets` locale namespace.
 *
 * @module @dreamverse/ui-assets/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@dreamverse/ui-kit/contracts.ts'
import AssetLibrary from './components/assets/AssetLibrary.tsx'
import { en, zh } from './locales.ts'

/** Required services: the UI slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Register the dialog's dictionaries, then the occupant while the kit declares the slot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('dreamverse.assets', { zh, en }), 'dreamverse assets copy')
  ctx.slots.inject('dreamverse.asset-library', () =>
    ctx.slots.register({ name: 'dreamverse.asset-library', locale: 'dreamverse.assets' }, AssetLibrary))
}
