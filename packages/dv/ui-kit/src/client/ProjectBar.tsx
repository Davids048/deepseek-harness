/**
 * The bar both Sidebar views share: project picker, new project, and undo. Its copy arrives through `labels`, already
 * localized by the owning plugin.
 *
 * @module @dv/ui-kit/ProjectBar
 */
import type { CSSProperties, ReactNode } from 'react'
import type { WireProject } from './types.ts'

/** The localized copy the bar shows. */
export interface ProjectBarLabels {
  project: string
  undo: string
  newProject: string
  newProjectPrompt: string
  noProject: string
}

/** What the bar needs and does. */
export interface ProjectBarProps {
  projects: WireProject[]
  project: string | null
  labels: ProjectBarLabels
  onProject: (project: string) => void
  onUndo: () => void
  onCreate: (title: string) => void
  /** Ask the user for a project name; defaults to `window.prompt`. */
  ask?: (message: string) => string | null
}

const bar: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--dv-line)',
  color: 'var(--dv-text-2)', fontSize: 12, lineHeight: '16px',
}
/** A 28 px secondary control: a 1 px strong border on a transparent fill; pair it with the `dv-kit-bar-control` class. */
const control: CSSProperties = {
  boxSizing: 'border-box', height: 28, padding: '0 10px', border: '1px solid var(--dv-line-strong)', borderRadius: 'var(--dv-radius-md)',
  background: 'transparent', color: 'var(--dv-text)', font: 'inherit', fontSize: 12, lineHeight: '16px', cursor: 'pointer',
}
/** Hover and keyboard focus of the bar's controls, which inline styles cannot express. */
const BAR_CSS = `
.dv-kit-bar-control { transition: background-color 120ms var(--dv-ease); }
.dv-kit-bar-control:hover:not(:disabled) { background: var(--dv-surface-3); }
.dv-kit-bar-control:disabled { opacity: 0.4; cursor: default; }
.dv-kit-bar-control:focus-visible { outline: 2px solid var(--dv-accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .dv-kit-bar-control { transition: none; } }
`

/**
 * The bar.
 * @param props - projects, copy, and callbacks.
 * @returns the element.
 */
export function ProjectBar(props: ProjectBarProps): ReactNode {
  const { labels } = props
  const ask = props.ask ?? ((message: string) => window.prompt(message))
  return (
    <div style={bar} data-testid="dv-kit-project-bar">
      <style>{BAR_CSS}</style>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span>{labels.project}</span>
        <select className="dv-kit-bar-control" style={control} value={props.project ?? ''} onChange={(event) => { props.onProject(event.target.value) }} aria-label={labels.project}>
          {props.project === null ? <option value="">{labels.noProject}</option> : null}
          {props.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
        </select>
      </label>
      <button type="button" className="dv-kit-bar-control" style={control} onClick={() => { const title = ask(labels.newProjectPrompt); if (title !== null && title.trim().length > 0) props.onCreate(title.trim()) }}>{labels.newProject}</button>
      <button type="button" className="dv-kit-bar-control" style={control} onClick={props.onUndo} disabled={props.project === null}>{labels.undo}</button>
    </div>
  )
}
