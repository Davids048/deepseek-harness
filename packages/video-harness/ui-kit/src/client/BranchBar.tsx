/**
 * The bar both views share: project picker, branch switcher, the open drafts of the project's chat sessions with
 * accept and discard, and undo.
 * Copy arrives through `labels`, already localized by the owning plugin.
 *
 * @module @video-harness/ui-kit/BranchBar
 */
import type { CSSProperties, ReactNode } from 'react'
import { openDrafts, branchNames } from './state.ts'
import type { WireProject, WireState } from './types.ts'

/** The localized copy the bar shows. */
export interface BranchBarLabels {
  project: string
  branch: string
  accept: string
  discard: string
  undo: string
  newBranch: string
  newBranchPrompt: string
  newProject: string
  newProjectPrompt: string
  draftTitle: string
  noProject: string
}

/** What the bar needs and does. */
export interface BranchBarProps {
  projects: WireProject[]
  project: string | null
  state: WireState | null
  head: string
  labels: BranchBarLabels
  onProject: (project: string) => void
  onHead: (head: string) => void
  /** Accept the draft with this branch name. */
  onAccept: (branch: string) => void
  /** Discard the draft with this branch name. */
  onDiscard: (branch: string) => void
  onUndo: () => void
  onBranch: (name: string, at: string) => void
  onCreate: (title: string) => void
  /** Ask the user for a branch or project name; defaults to `window.prompt`. */
  ask?: (message: string) => string | null
}

const bar: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--vh-line, #d0d3da)', fontSize: 12 }
const control: CSSProperties = { fontSize: 12, padding: '2px 6px' }

/**
 * The bar.
 * @param props - projects, state, copy, and callbacks.
 * @returns the element.
 */
export function BranchBar(props: BranchBarProps): ReactNode {
  const { labels } = props
  const drafts = props.state === null ? [] : openDrafts(props.state)
  const names = props.state === null ? ['main'] : branchNames(props.state)
  const ask = props.ask ?? ((message: string) => window.prompt(message))
  return (
    <div style={bar} data-testid="vh-branch-bar">
      <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <span>{labels.project}</span>
        <select style={control} value={props.project ?? ''} onChange={(event) => { props.onProject(event.target.value) }} aria-label={labels.project}>
          {props.project === null ? <option value="">{labels.noProject}</option> : null}
          {props.projects.map(project => <option key={project.projectId} value={project.projectId}>{project.title}</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <span>{labels.branch}</span>
        <select style={control} value={props.head} onChange={(event) => { props.onHead(event.target.value) }} aria-label={labels.branch}>
          {names.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <button type="button" style={control} onClick={() => { const title = ask(labels.newProjectPrompt); if (title !== null && title.trim().length > 0) props.onCreate(title.trim()) }}>{labels.newProject}</button>
      <button type="button" style={control} disabled={props.project === null} onClick={() => { const name = ask(labels.newBranchPrompt); if (name !== null && name.trim().length > 0) props.onBranch(name.trim(), props.head) }}>{labels.newBranch}</button>
      <button type="button" style={control} onClick={props.onUndo} disabled={props.project === null}>{labels.undo}</button>
      {drafts.map(draft => (
        <span key={draft.branch} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', padding: '2px 6px', border: '1px dashed var(--vh-accent, #b4432a)', borderRadius: 4 }} title={draft.branch}>
          <span>{labels.draftTitle}</span>
          <button type="button" style={control} onClick={() => { props.onAccept(draft.branch) }}>{labels.accept}</button>
          <button type="button" style={control} onClick={() => { props.onDiscard(draft.branch) }}>{labels.discard}</button>
        </span>
      ))}
    </div>
  )
}
