/**
 * The bar both Sidebar views share: project picker, the branch switcher of {@link BranchSwitcher}, new project, and
 * undo. The project picker, new project and undo copy arrives through `labels`, already localized by the owning plugin.
 *
 * @module @dv/ui-kit/BranchBar
 */
import type { CSSProperties, ReactNode } from 'react'
import { BranchSwitcher, type BranchActions } from './BranchSwitcher.tsx'
import type { WireProject, WireState } from './types.ts'

/** The localized copy the bar shows. */
export interface BranchBarLabels {
  project: string
  undo: string
  newProject: string
  newProjectPrompt: string
  noProject: string
}

/** What the bar needs and does. */
export interface BranchBarProps {
  projects: WireProject[]
  project: string | null
  /** The state of the project's current branch; null while it loads. */
  state: WireState | null
  labels: BranchBarLabels
  onProject: (project: string) => void
  /** The branch switcher's gestures. */
  branches: BranchActions
  onUndo: () => void
  onCreate: (title: string) => void
  /** Ask the user for a project name; defaults to `window.prompt`. */
  ask?: (message: string) => string | null
}

const bar: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--dv-line, #d0d3da)', fontSize: 12 }
const control: CSSProperties = { fontSize: 12, padding: '2px 6px' }

/**
 * The bar.
 * @param props - projects, state, copy, and callbacks.
 * @returns the element.
 */
export function BranchBar(props: BranchBarProps): ReactNode {
  const { labels } = props
  const ask = props.ask ?? ((message: string) => window.prompt(message))
  return (
    <div style={bar} data-testid="dv-kit-branch-bar">
      <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <span>{labels.project}</span>
        <select style={control} value={props.project ?? ''} onChange={(event) => { props.onProject(event.target.value) }} aria-label={labels.project}>
          {props.project === null ? <option value="">{labels.noProject}</option> : null}
          {props.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
        </select>
      </label>
      <BranchSwitcher state={props.state} {...props.branches} />
      <button type="button" style={control} onClick={() => { const title = ask(labels.newProjectPrompt); if (title !== null && title.trim().length > 0) props.onCreate(title.trim()) }}>{labels.newProject}</button>
      <button type="button" style={control} onClick={props.onUndo} disabled={props.project === null}>{labels.undo}</button>
    </div>
  )
}
