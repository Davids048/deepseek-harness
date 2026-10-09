/**
 * The canvas as a right-Sidebar tab body: the project and undo bar (`ProjectBar`) above a {@link CanvasView} of the
 * selected project's current state.
 * Hosts that place the canvas in the center mount {@link CanvasView} directly.
 */
import { useMemo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { DvClient } from '@dv/ui-kit/api.ts'
import { ProjectBar } from '@dv/ui-kit/ProjectBar.tsx'
import type { ProjectBarLabels } from '@dv/ui-kit/ProjectBar.tsx'
import { useViewSession } from '@dv/ui-kit/useView.ts'
import { CanvasView } from './CanvasView.tsx'
import type {} from './locales.ts'

/** What the plugin hands the body beside the standard props of its DSH UI slot. */
export interface CanvasInjected {
  client: DvClient
}

/** The body's composed props: the tab it draws, the API client, and its copy. */
export type CanvasBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & CanvasInjected & PropsLocale<'dvCanvas'>

const root: CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 12, lineHeight: '16px' }

/**
 * The project and undo bar's copy in the canvas namespace.
 * @param t - namespace-bound translate.
 * @returns the labels.
 */
export function barLabels(t: CanvasBodyProps['t']): ProjectBarLabels {
  return {
    project: t('bar.project'), undo: t('bar.undo'), newProject: t('bar.newProject'), newProjectPrompt: t('bar.newProjectPrompt'),
    noProject: t('bar.noProject'),
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
      <div style={{ flex: 1, minHeight: 0 }}>
        <CanvasView projectId={view.project} client={client} session={view.session} t={t} />
      </div>
    )
  }
  return (
    <div style={root} data-testid="dv-canvas-body">
      <ProjectBar {...view.bar} labels={labels} />
      {content}
    </div>
  )
}
