/**
 * What the `dv-history` tab type is: a page type the guide offers, with no resource address.
 *
 * @module @dv/ui-history/definition
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { pickText } from '@dv/ui-kit/locale.ts'

/** The tab kind this package owns. */
export const HISTORY_KIND = 'dv-history'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const HISTORY_ID = '@dv/ui-history'

/** The History type's registry definition. */
export const historyDefinition: SidebarRightTabDefinition = {
  id: HISTORY_ID,
  kind: HISTORY_KIND,
  priority: 'builtin',
  keepMounted: true,
  title: () => pickText('历史', 'History'),
  guide: [{
    id: HISTORY_KIND, order: 45, title: () => pickText('历史', 'History'),
    description: () => pickText('项目的每一条记录：谁在哪里做了什么', 'Every record of the project: who did what, and where'),
  }],
}
