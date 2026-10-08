/**
 * The branch switcher every DreamVerse view shares: the project's current branch, a list to switch to another branch,
 * and the buttons that fork a new branch and rename the current one. Every view and every chat session of a project
 * shows the current branch, so switching here changes what the canvas, the timeline, the asset pool panel and the
 * History panel show. Copy comes from `useText()` pairs; the owning view binds the callbacks with
 * {@link branchActions}.
 *
 * @module @dv/ui-kit/BranchSwitcher
 */
import type { CSSProperties, ReactNode } from 'react'
import type { DvClient, ViewSurface } from './api.ts'
import { useText } from './locale.ts'
import { branchLabel } from './state.ts'
import type { WireState } from './types.ts'

/** What the switcher shows and does. */
export interface BranchSwitcherProps {
  /** A state of the project, for its branches and current branch; null while it loads. */
  state: WireState | null
  /** Make this branch the project's current branch. */
  onSwitch: (branch: string) => void
  /** Fork a new branch from the current branch. */
  onCreate: () => void
  /** Give a branch a new title; an empty title returns to the default label. */
  onRename: (branch: string, title: string) => void
  /** Ask the human for a branch title; defaults to `window.prompt`. */
  ask?: (message: string, initial: string) => string | null
  /** Placement and look of the switcher in the hosting view. */
  style?: CSSProperties
}

/** The callbacks of {@link BranchSwitcherProps} that write through the API. */
export type BranchActions = Pick<BranchSwitcherProps, 'onSwitch' | 'onCreate' | 'onRename'>

const control: CSSProperties = {
  font: 'inherit', fontSize: 12, padding: '4px 10px', border: '0.5px solid var(--dsw-alias-border-l3, #d0d3da)', borderRadius: 8,
  background: 'transparent', color: 'inherit', whiteSpace: 'nowrap', cursor: 'pointer',
}

/**
 * Bind the switcher's gestures to the branch routes.
 * @param client - the API client.
 * @param project - the project, or null before one is chosen (the gestures then do nothing).
 * @param surface - the view's name in the records a switch writes.
 * @param run - runs one write the way the view reports its own writes, and refreshes the view afterwards.
 * @returns the callbacks.
 */
export function branchActions(
  client: DvClient, project: string | null, surface: ViewSurface, run: (work: () => Promise<unknown>) => Promise<unknown>,
): BranchActions {
  return {
    onSwitch: (branch) => { if (project !== null) void run(() => client.switchBranch(project, branch, surface)) },
    onCreate: () => { if (project !== null) void run(() => client.createBranch(project, null, surface)) },
    onRename: (branch, title) => { if (project !== null) void run(() => client.renameBranch(project, branch, title)) },
  }
}

/**
 * The switcher.
 * @param props - the state and the callbacks.
 * @returns the element.
 */
export function BranchSwitcher({ state, onSwitch, onCreate, onRename, ask, style }: BranchSwitcherProps): ReactNode {
  const t = useText()
  const branches = state?.branches ?? []
  const current = branches.find(branch => branch.name === state?.current)
  const prompt = ask ?? ((message: string, initial: string) => window.prompt(message, initial))
  return (
    <div
      style={{ display: 'inline-flex', flex: 'none', alignItems: 'center', gap: 6, fontSize: 12, whiteSpace: 'nowrap', ...style }}
      data-testid="dv-kit-branch-switcher" data-branch={state?.current ?? ''}
      title={t('所有视图和对话都显示这个分支，修改也写到这个分支', 'Every view and conversation shows this branch, and edits go to it')}
      onPointerDown={(event) => { event.stopPropagation() }}
    >
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span>{t('分支', 'Branch')}</span>
        <select
          style={control} value={state?.current ?? ''} disabled={state === null} aria-label={t('分支', 'Branch')}
          onChange={(event) => { if (event.target.value !== state?.current) onSwitch(event.target.value) }}
        >
          {branches.map(branch => <option key={branch.name} value={branch.name}>{branchLabel(branch, t)}</option>)}
        </select>
      </label>
      <button type="button" style={control} disabled={state === null} onClick={onCreate}>{t('新建分支', 'New branch')}</button>
      <button
        type="button" style={control} disabled={current === undefined}
        onClick={() => {
          if (current === undefined) return
          // The prompt starts from the stored title, so confirming it unchanged never stores a default label.
          const title = prompt(t('分支名称', 'Branch name'), current.title ?? '')
          if (title !== null) onRename(current.name, title.trim())
        }}
      >
        {t('重命名', 'Rename')}
      </button>
    </div>
  )
}
