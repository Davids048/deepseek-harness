/**
 * Browser half: register `dv-canvas` as a right-Sidebar tab type, its dictionaries, and its body.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { DvClient } from '@dv/ui-kit/api.ts'
import { CanvasBody } from './CanvasBody.tsx'
import type { CanvasInjected } from './CanvasBody.tsx'
import { CANVAS_ID, canvasDefinition } from './definition.ts'
import { en, NS, zh } from './locales.ts'

export type { DvCanvasKey } from './locales.ts'
export type { CanvasBodyProps, CanvasInjected } from './CanvasBody.tsx'
export { CanvasView } from './CanvasView.tsx'
export type { CanvasViewProps } from './CanvasView.tsx'

/** Required browser services: the tab registry, the DSH UI slot registry, and the dictionaries. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Client plugin body: register the type, its dictionaries, and its body under the type's id.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(canvasDefinition(t)), 'ui-canvas: tab type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-canvas: dictionaries')
  const injected: CanvasInjected = { client: new DvClient() }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: CANVAS_ID, locale: NS, inject: () => injected },
    CanvasBody,
  )), 'ui-canvas: tab body')
}
