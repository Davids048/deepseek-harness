/**
 * The canvas as a right-Sidebar tab body: the branch bar above a {@link CanvasView} of the selected project and head.
 * Hosts that place the canvas in the center mount {@link CanvasView} directly.
 */
import { useMemo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { VhClient } from '@video-harness/ui-kit/api.ts'
import { BranchBar } from '@video-harness/ui-kit/BranchBar.tsx'
import type { BranchBarLabels } from '@video-harness/ui-kit/BranchBar.tsx'
import { useViewSession } from '@video-harness/ui-kit/useView.ts'
import { CanvasView } from './CanvasView.tsx'
import type {} from './locales.ts'

/** What the plugin hands the body beside the slot's standard props. */
export interface CanvasInjected {
  client: VhClient
}

/** The body's composed props: the tab it draws, the API client, and its copy. */
export type CanvasBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & CanvasInjected & PropsLocale<'vhCanvas'>

const root: CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 12 }

/**
 * The branch bar's copy in the canvas namespace.
 * @param t - namespace-bound translate.
 * @returns the labels.
 */
export function barLabels(t: CanvasBodyProps['t']): BranchBarLabels {
  return {
    project: t('bar.project'), branch: t('bar.branch'), accept: t('bar.accept'), reject: t('bar.reject'), undo: t('bar.undo'),
    newBranch: t('bar.newBranch'), newBranchPrompt: t('bar.newBranchPrompt'), newProject: t('bar.newProject'), newProjectPrompt: t('bar.newProjectPrompt'),
    draftTitle: t('bar.draft'), noProject: t('bar.noProject'),
  }
}

/**
 * The body.
 * @param props - the API client and the copy; the tab information is unused because the canvas keeps one page per kind.
 * @returns the element.
 */
export function CanvasBody({ client, t }: CanvasBodyProps): ReactNode {
  const view = useViewSession(client, 'canvas')
  const labels = useMemo(() => barLabels(t), [t])
  let content: ReactNode
  if (view.projects.value !== null && view.projects.value.length === 0) content = <p style={{ padding: 8 }}>{t('empty.projects')}</p>
  else if (view.project === null) content = <p style={{ padding: 8 }}>{t('loading')}</p>
  else {
    content = (
      <div style={{ flex: 1, minHeight: 0 }}><CanvasView projectId={view.project} branch={view.head} client={client} t={t} /></div>
    )
  }
  return (
    <div style={root} data-testid="vh-canvas">
      <BranchBar {...view.bar} labels={labels} />
      {content}
    </div>
  )
}
