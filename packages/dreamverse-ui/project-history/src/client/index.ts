/**
 * DreamVerse project-history UI, browser half: fills the kit's `dreamverse.sidebar` slot with the saved project history
 * sidebar.
 *
 * @module @dreamverse/ui-project-history/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@dreamverse/ui-kit/contracts.ts'
import Sidebar from './components/Sidebar.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Register the occupant while the kit declares the slot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('dreamverse.sidebar', () => ctx.slots.register({ name: 'dreamverse.sidebar' }, Sidebar))
}
