/**
 * What the `dv-canvas` tab type is: a page type the guide offers, with no resource address.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from './locales.ts'

/** The tab kind this package owns. */
export const CANVAS_KIND = 'dv-canvas'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const CANVAS_ID = '@dv/ui-canvas'

/**
 * The canvas type's registry definition.
 * @param t - namespace-bound translate, read on every label call.
 * @returns the definition to register.
 */
export function canvasDefinition(t: TranslateNS<'dvCanvas'>): SidebarRightTabDefinition {
  return {
    id: CANVAS_ID,
    kind: CANVAS_KIND,
    priority: 'builtin',
    keepMounted: true,
    title: () => t('type.label'),
    guide: [{ id: 'canvas', order: 40, title: () => t('guide.title'), description: () => t('guide.description') }],
  }
}
