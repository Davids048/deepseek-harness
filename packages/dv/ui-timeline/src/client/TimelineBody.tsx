/**
 * The right-sidebar tab body: the branch bar for choosing a project and its current branch, then the timeline editor of
 * that branch.
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { DvClient } from '@dv/ui-kit/api.ts'
import { BranchBar } from '@dv/ui-kit/BranchBar.tsx'
import type { BranchBarLabels } from '@dv/ui-kit/BranchBar.tsx'
import { useViewSession } from '@dv/ui-kit/useView.ts'
import { TimelineEditor } from './TimelineEditor.tsx'
import type {} from './locales.ts'

/** What the plugin hands the body beside the standard props of its DSH registration. */
export interface TimelineInjected {
  client: DvClient
}

/** The body's composed props: the tab it draws, the API client, and its copy. */
export type TimelineBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & TimelineInjected & PropsLocale<'dvTimeline'>

/**
 * The branch bar's copy in the timeline namespace.
 * @param t - namespace-bound translate.
 * @returns the labels.
 */
export function barLabels(t: TimelineBodyProps['t']): BranchBarLabels {
  return {
    project: t('bar.project'), undo: t('bar.undo'), newProject: t('bar.newProject'), newProjectPrompt: t('bar.newProjectPrompt'),
    noProject: t('bar.noProject'),
  }
}

/**
 * The body.
 * @param props - the API client and the copy; the tab information is unused because the tab keeps one page per kind.
 * @returns the element.
 */
export function TimelineBody({ client, t }: TimelineBodyProps): ReactNode {
  const view = useViewSession(client, 'timeline')
  const labels = useMemo(() => barLabels(t), [t])
  const state = view.state.value
  let content: ReactNode
  if (view.projects.value !== null && view.projects.value.length === 0) content = <p style={{ padding: 8 }}>{t('empty.projects')}</p>
  else if (view.state.error !== null && state === null) content = <p role="alert" style={{ padding: 8 }}>{t('error', { message: view.state.error })}</p>
  else if (state === null || view.project === null) content = <p style={{ padding: 8 }}>{t('loading')}</p>
  else {
    content = (
      <TimelineEditor
        client={client} t={t} project={view.project} session={view.session} state={state} run={view.run}
      />
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 12 }} data-testid="dv-timeline-body">
      <BranchBar {...view.bar} labels={labels} />
      {view.notice !== null ? <p role="alert" style={{ margin: 0, padding: '4px 8px', color: 'var(--dv-accent, #b4432a)' }}>{t('error', { message: view.notice })}</p> : null}
      <div style={{ flex: 1, minHeight: 0 }}>{content}</div>
    </div>
  )
}
