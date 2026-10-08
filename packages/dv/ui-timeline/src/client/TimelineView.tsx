/**
 * The timeline editor for one project, without the branch bar: the center area's 时间线 view. It reads the state of the
 * project's current branch itself, refetches it after every project change and every write, and follows the current
 * branch when it changes; the view's edits land on that branch.
 */
import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { DvClient } from '@dv/ui-kit/api.ts'
import { useLanguage } from '@dv/ui-kit/locale.ts'
import type { DvLanguage } from '@dv/ui-kit/locale.ts'
import { useProjectState } from '@dv/ui-kit/useProject.ts'
import { TimelineEditor } from './TimelineEditor.tsx'
import { en, zh } from './locales.ts'
import type { DvTimelineKey } from './locales.ts'

/** What the center switcher passes; `client` and `t` default to a same-origin client and the copy of the DSH language. */
export interface TimelineViewProps {
  projectId: string
  client?: DvClient
  /** The chat session the view sits beside, recorded as the `session` of the view's edits. */
  session?: string | null
  t?: Translate<DvTimelineKey>
}

/**
 * Translate from one language's dictionary, filling `{name}` placeholders.
 * @param language - the interface language.
 * @returns the translate function.
 */
export function copyFor(language: DvLanguage): Translate<DvTimelineKey> {
  const dictionary = language === 'zh' ? zh : en
  return (key, params) =>
    dictionary[key].replace(/\{(\w+)\}/g, (whole, name: string) => params !== undefined && name in params ? String(params[name]) : whole)
}

const sharedClient = new DvClient()

/**
 * The timeline editor of a project's current branch.
 * @param props - the project, and optionally the API client, the chat session, and copy.
 * @returns the element.
 */
export function TimelineView({ projectId, client = sharedClient, session = null, t: givenCopy }: TimelineViewProps): ReactNode {
  const language = useLanguage()
  const t = useMemo(() => givenCopy ?? copyFor(language), [givenCopy, language])
  const state = useProjectState(client, projectId)
  const [notice, setNotice] = useState<string | null>(null)
  const reload = state.reload
  const run = useCallback(async (work: () => Promise<unknown>): Promise<boolean> => {
    try {
      await work()
      setNotice(null)
      reload()
      return true
    } catch (failure: unknown) {
      setNotice(failure instanceof Error ? failure.message : String(failure))
      return false
    }
  }, [reload])
  if (state.value === null) {
    return <p style={{ padding: 12 }} role={state.error === null ? undefined : 'alert'}>{state.error === null ? t('loading') : t('error', { message: state.error })}</p>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {notice !== null ? <p role="alert" style={{ margin: 0, padding: '4px 8px', color: 'var(--dv-accent, #b4432a)' }}>{t('error', { message: notice })}</p> : null}
      <div style={{ flex: 1, minHeight: 0 }}>
        <TimelineEditor
          client={client}
          t={t}
          project={projectId}
          session={session}
          state={state.value}
          run={run}
        />
      </div>
    </div>
  )
}
