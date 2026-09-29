/**
 * DreamVerse directing UI, browser half: fills the kit's `dreamverse.workspace` slot with the prompt event timeline of
 * the shown project.
 *
 * @module @dreamverse/ui-directing/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@dreamverse/ui-kit/contracts.ts'
import Workspace from './components/Workspace.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Register the occupant while the kit declares the slot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('dreamverse.workspace', () => ctx.slots.register({ name: 'dreamverse.workspace' }, Workspace))
}
