/**
 * DreamVerse directing UI, browser half: fills the kit's `dreamverse.workspace` slot with the prompt event timeline of
 * the shown project and registers the timeline's copy as the `dreamverse.directing` locale namespace.
 *
 * @module @dreamverse/ui-directing/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@dreamverse/ui-kit/contracts.ts'
import Workspace from './components/Workspace.tsx'
import { en, zh } from './locales.ts'

/** Required services: the UI slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Register the timeline's dictionaries, then the occupant while the kit declares the slot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('dreamverse.directing', { zh, en }), 'dreamverse directing copy')
  ctx.slots.inject('dreamverse.workspace', () =>
    ctx.slots.register({ name: 'dreamverse.workspace', locale: 'dreamverse.directing' }, Workspace))
}
