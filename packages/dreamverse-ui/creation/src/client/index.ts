/**
 * DreamVerse creation UI, browser half: fills the kit's `dreamverse.creation-studio` slot with the lobby creation
 * studio and its `dreamverse.chatbar` slot with the live directing composer (ChatBar).
 *
 * @module @dreamverse/ui-creation/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@dreamverse/ui-kit/contracts.ts'
import CreationStudio from './components/creation/CreationStudio.tsx'
import ChatBar from './components/ChatBar.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Register the occupants while the kit declares their slots.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('dreamverse.creation-studio', () =>
    ctx.slots.register({ name: 'dreamverse.creation-studio' }, CreationStudio))
  ctx.slots.inject('dreamverse.chatbar', () => ctx.slots.register({ name: 'dreamverse.chatbar' }, ChatBar))
}
