/**
 * DreamVerse project-history UI, browser half: fills the kit's `dreamverse.sidebar` slot with the saved project history
 * sidebar and registers the sidebar's copy as the `dreamverse.projectHistory` locale namespace.
 *
 * @module @dreamverse/ui-project-history/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@dreamverse/ui-kit/contracts.ts'
import Sidebar from './components/Sidebar.tsx'
import { en, zh } from './locales.ts'

/** Required services: the UI slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Register the sidebar's dictionaries, then the occupant while the kit declares the slot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('dreamverse.projectHistory', { zh, en }), 'dreamverse project history copy')
  ctx.slots.inject('dreamverse.sidebar', () =>
    ctx.slots.register({ name: 'dreamverse.sidebar', locale: 'dreamverse.projectHistory' }, Sidebar))
}
