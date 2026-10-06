/**
 * What the `dv-timeline` tab type is: a page type the guide offers, with no resource address.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from './locales.ts'

/** The tab kind this package owns. */
export const TIMELINE_KIND = 'dv-timeline'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const TIMELINE_ID = '@dv/ui-timeline'

/**
 * The timeline type's registry definition.
 * @param t - namespace-bound translate, read on every label call.
 * @returns the definition to register.
 */
export function timelineDefinition(t: TranslateNS<'dvTimeline'>): SidebarRightTabDefinition {
  return {
    id: TIMELINE_ID,
    kind: TIMELINE_KIND,
    priority: 'builtin',
    keepMounted: true,
    title: () => t('type.label'),
    guide: [{ id: 'timeline', order: 41, title: () => t('guide.title'), description: () => t('guide.description') }],
  }
}
