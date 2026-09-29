/**
 * DreamVerse player UI, browser half: fills the kit's `dreamverse.player` slot with live and archived playback of the
 * active project.
 *
 * @module @dreamverse/ui-player/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@dreamverse/ui-kit/contracts.ts'
import VideoPlayer from './components/VideoPlayer.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Register the occupant while the kit declares the slot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('dreamverse.player', () => ctx.slots.register({ name: 'dreamverse.player' }, VideoPlayer))
}
