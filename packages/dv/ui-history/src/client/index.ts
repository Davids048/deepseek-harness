/**
 * Browser half: register `dv-history` as a right-Sidebar tab type and its body, open the tab when a `dv:history-focus`
 * event asks for a record, and export the History panel for direct rendering.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { DvClient } from '@dv/ui-kit/api.ts'
import { DV_HISTORY_FOCUS_EVENT } from '@dv/ui-kit/workspace-events.ts'
import { HistoryTabBody } from './HistoryPanel.tsx'
import { HISTORY_ID, HISTORY_KIND, historyDefinition } from './definition.ts'

export { HistoryPanel, type HistoryPanelProps } from './HistoryPanel.tsx'
export { HISTORY_ID, HISTORY_KIND }

/** Required browser services: the tab registry and the DSH UI slot registry. */
export const inject = ['slots', 'sidebarRightTabs']

/**
 * Client plugin body: register the tab type and its body under the type's id; while the right panel service is
 * present, a `dv:history-focus` event opens the tab (the panel itself selects the record).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.sidebarRightTabs.register(historyDefinition), 'ui-history: tab type')
  const injected = { client: new DvClient() }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: HISTORY_ID, inject: () => injected },
    HistoryTabBody,
  )), 'ui-history: tab body')
  ctx.inject(['sidebarRight'], (scope) => {
    scope.effect(() => {
      const open = (): void => { scope.sidebarRight.openTab(HISTORY_KIND) }
      window.addEventListener(DV_HISTORY_FOCUS_EVENT, open)
      return () => { window.removeEventListener(DV_HISTORY_FOCUS_EVENT, open) }
    }, 'ui-history: open on dv:history-focus')
  })
}
