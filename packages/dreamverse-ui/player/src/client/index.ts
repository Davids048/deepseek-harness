/**
 * DreamVerse player UI, browser half: fills the kit's `dreamverse.player` slot with live and archived playback of the
 * active project and registers the player's copy as the `dreamverse.player` locale namespace.
 *
 * @module @dreamverse/ui-player/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@dreamverse/ui-kit/contracts.ts'
import VideoPlayer from './components/VideoPlayer.tsx'
import { en, zh } from './locales.ts'

/** Required services: the UI slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Register the player's dictionaries, then the occupant while the kit declares the slot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('dreamverse.player', { zh, en }), 'dreamverse player copy')
  ctx.slots.inject('dreamverse.player', () =>
    ctx.slots.register({ name: 'dreamverse.player', locale: 'dreamverse.player' }, VideoPlayer))
}
