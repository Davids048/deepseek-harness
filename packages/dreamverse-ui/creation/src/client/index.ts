/**
 * DreamVerse creation UI, browser half: fills the kit's `dreamverse.creation-studio` slot with the lobby creation
 * studio and its `dreamverse.chatbar` slot with the live directing composer (ChatBar). Both occupants render their copy
 * from the `dreamverse.creation` locale namespace, whose Chinese and English dictionaries this plugin registers.
 *
 * @module @dreamverse/ui-creation/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@dreamverse/ui-kit/contracts.ts'
import CreationStudio from './components/creation/CreationStudio.tsx'
import ChatBar from './components/ChatBar.tsx'
import { en, zh } from './locales.ts'

/** Required services: the UI slot registry and the locale registry that owns the occupants' copy. */
export const inject = ['slots', 'locale']

/**
 * Register the `dreamverse.creation` dictionaries for the plugin's lifetime, and register the occupants with that
 * namespace while the kit declares their slots.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('dreamverse.creation', { zh, en }), 'dreamverse creation copy')
  ctx.slots.inject('dreamverse.creation-studio', () =>
    ctx.slots.register({ name: 'dreamverse.creation-studio', locale: 'dreamverse.creation' }, CreationStudio))
  ctx.slots.inject('dreamverse.chatbar', () =>
    ctx.slots.register({ name: 'dreamverse.chatbar', locale: 'dreamverse.creation' }, ChatBar))
}
