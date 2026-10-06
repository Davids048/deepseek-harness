/**
 * The right-sidebar tab body: the branch bar for choosing a project and head, then the cuts editor of that head.
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { VhClient } from '@video-harness/ui-kit/api.ts'
import { BranchBar } from '@video-harness/ui-kit/BranchBar.tsx'
import type { BranchBarLabels } from '@video-harness/ui-kit/BranchBar.tsx'
import { useViewSession } from '@video-harness/ui-kit/useView.ts'
import { CutsEditor } from './CutsEditor.tsx'
import type {} from './locales.ts'

/** What the plugin hands the body beside the slot's standard props. */
export interface TimelineInjected {
  client: VhClient
}

/** The body's composed props: the tab it draws, the API client, and its copy. */
export type TimelineBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & TimelineInjected & PropsLocale<'vhTimeline'>

/**
 * The branch bar's copy in the timeline namespace.
 * @param t - namespace-bound translate.
 * @returns the labels.
 */
export function barLabels(t: TimelineBodyProps['t']): BranchBarLabels {
  return {
    project: t('bar.project'), branch: t('bar.branch'), accept: t('bar.accept'), discard: t('bar.discard'), undo: t('bar.undo'),
    newBranch: t('bar.newBranch'), newBranchPrompt: t('bar.newBranchPrompt'), newProject: t('bar.newProject'), newProjectPrompt: t('bar.newProjectPrompt'),
    draftTitle: t('bar.draft'), noProject: t('bar.noProject'),
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
      <CutsEditor
        client={client} t={t} project={view.project} head={view.head} session={view.session} state={state}
        readOnly={view.readOnly} run={view.run}
      />
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 12 }} data-testid="vh-timeline">
      <BranchBar {...view.bar} labels={labels} />
      {view.notice !== null ? <p role="alert" style={{ margin: 0, padding: '4px 8px', color: 'var(--vh-accent, #b4432a)' }}>{t('error', { message: view.notice })}</p> : null}
      <div style={{ flex: 1, minHeight: 0 }}>{content}</div>
    </div>
  )
}
