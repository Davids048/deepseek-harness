/**
 * The chat's names of the agent tools: `tool.name.<wire name>` entries added to DSH's `chat` dictionary, which the
 * running group title reads. The names come from `DV_TOOL_LABELS` of `@dv/ui-kit/tool-labels.ts`.
 *
 * @module @dv/ui-composer/tool-labels
 */
import { DV_TOOL_LABELS } from '@dv/ui-kit/tool-labels.ts'

/**
 * Add a `tool.name.<wire name>` entry per labelled tool to the Chinese and English dictionaries of DSH's `chat`
 * namespace, which the running group title reads. The locale runtime refuses a second registration of a namespace
 * and keeps one dictionary object per namespace and language, so the entries are written into those objects; the
 * caller re-runs this when the runtime announces dictionaries registered later.
 * @param locale - `ctx.locale`.
 */
export function addToolNames(locale: unknown): void {
  const dicts: unknown = locale === undefined || locale === null ? undefined : Reflect.get(locale as object, 'dicts')
  if (!(dicts instanceof Map)) return
  const byLocale: unknown = dicts.get('chat')
  if (!(byLocale instanceof Map)) return
  const zh: unknown = byLocale.get('zh')
  const en: unknown = byLocale.get('en')
  for (const [name, [zhName, enName]] of Object.entries(DV_TOOL_LABELS)) {
    if (zh !== null && typeof zh === 'object') Reflect.set(zh, `tool.name.${name}`, zhName)
    if (en !== null && typeof en === 'object') Reflect.set(en, `tool.name.${name}`, enName)
  }
}
