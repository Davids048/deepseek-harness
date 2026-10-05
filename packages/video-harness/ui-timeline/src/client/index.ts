/**
 * Browser half: register `vh-timeline` as a right-Sidebar tab type, its dictionaries, and its body; export the cuts
 * editor (`CutsView`) for the workspace center.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { VhClient } from '@video-harness/ui-kit/api.ts'
import { TIMELINE_ID, timelineDefinition } from './definition.ts'
import { en, NS, zh } from './locales.ts'
import { TimelineBody } from './TimelineBody.tsx'
import type { TimelineInjected } from './TimelineBody.tsx'

export type { VhTimelineKey } from './locales.ts'
export type { TimelineBodyProps, TimelineInjected } from './TimelineBody.tsx'
export { CutsView } from './CutsView.tsx'
export type { CutsViewProps } from './CutsView.tsx'
export { ASSET_DRAG_TYPE } from './CutsEditor.tsx'

/** Required browser services: the tab registry, the slot registry, and the dictionaries. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Client plugin body: register the type, its dictionaries, and its body under the type's id.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(timelineDefinition(t)), 'ui-timeline: tab type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-timeline: dictionaries')
  const injected: TimelineInjected = { client: new VhClient() }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TIMELINE_ID, locale: NS, inject: () => injected },
    TimelineBody,
  )), 'ui-timeline: tab body')
}
