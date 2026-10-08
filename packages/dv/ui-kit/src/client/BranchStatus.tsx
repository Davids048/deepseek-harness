/**
 * The current-branch button of the workspace's bottom bar, in the manner of an editor status bar: one small button names
 * the project's current branch, and a click opens the list of every branch above it to switch to another one. Creating
 * and renaming branches live in the History panel (`BranchSwitcher`). Copy comes from `useText()` pairs.
 *
 * @module @dv/ui-kit/BranchStatus
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useText } from './locale.ts'
import { branchLabel } from './state.ts'
import type { WireState } from './types.ts'

/** What the button shows and does. */
export interface BranchStatusProps {
  /** A state of the project, for its branches and current branch; null while it loads. */
  state: WireState | null
  /** Make this branch the project's current branch. */
  onSwitch: (branch: string) => void
}

const button: CSSProperties = {
  border: 'none', borderRadius: 4, padding: '2px 8px', background: 'transparent', color: 'inherit', font: 'inherit',
  fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer',
}
const menu: CSSProperties = {
  position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, minWidth: 180, padding: 4, zIndex: 20,
  border: '0.5px solid var(--dsw-alias-border-l3, #d0d3da)', borderRadius: 8, background: 'var(--dsw-alias-bg-base, #ffffff)',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.14)',
}

/**
 * The button, and the branch list while it is open. Escape or a click outside closes the list.
 * @param props - the state and the switch gesture.
 * @returns the element.
 */
export function BranchStatus({ state, onSwitch }: BranchStatusProps): ReactNode {
  const t = useText()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])
  const branches = state?.branches ?? []
  const current = branches.find(branch => branch.name === state?.current)
  const label = current === undefined ? '' : branchLabel(current, t)
  return (
    <div ref={root} style={{ position: 'relative', display: 'inline-flex' }} data-testid="dv-kit-branch-status" data-branch={state?.current ?? ''}>
      <button
        type="button" style={button} disabled={state === null} aria-haspopup="listbox" aria-expanded={open}
        title={t('当前分支：所有视图都显示它，修改也写到它', 'Current branch: every view shows it, and edits go to it')}
        onClick={() => { setOpen(value => !value) }}
      >
        {t(`当前分支：${label}`, `Current branch: ${label}`)}
      </button>
      {open
        ? (
          <div role="listbox" aria-label={t('分支', 'Branches')} style={menu}>
            {branches.map(branch => (
              <button
                key={branch.name} type="button" role="option" aria-selected={branch.name === state?.current}
                data-testid="dv-kit-branch-option" data-branch={branch.name}
                style={{ ...button, display: 'block', width: '100%', textAlign: 'left', fontWeight: branch.name === state?.current ? 600 : 400 }}
                onClick={() => {
                  setOpen(false)
                  if (branch.name !== state?.current) onSwitch(branch.name)
                }}
              >
                {branch.name === state?.current ? '✓ ' : ' '}{branchLabel(branch, t)}
              </button>
            ))}
          </div>
        )
        : null}
    </div>
  )
}
