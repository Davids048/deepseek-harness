/**
 * The branch menu every DreamVerse surface shares: a small button with a branch icon names the project's current branch,
 * and a click opens the menu of every branch. The menu switches the current branch, renames a branch in place (✎ on the
 * row, or F2), and forks a new branch (新建分支), which is created at once with its default label and opens in place for
 * an optional name. The workspace's bottom bar opens it upward and the History panel's header opens it downward. Every
 * view and every chat session of a project shows the current branch, so switching here changes what the canvas, the
 * timeline, the asset pool panel and the History panel show. Copy comes from `useText()` pairs; the owning view binds
 * the callbacks with {@link branchActions}.
 *
 * @module @dv/ui-kit/BranchMenu
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { DvClient, ViewSurface } from './api.ts'
import { useText } from './locale.ts'
import { branchLabel } from './state.ts'
import type { Branch, WireState } from './types.ts'

/** What the menu does. */
export interface BranchActions {
  /** Make this branch the project's current branch. */
  onSwitch: (branch: string) => void
  /** Fork a new branch from the current branch; resolves to the new branch's name, or null when the fork failed. */
  onCreate: () => Promise<string | null>
  /** Give a branch a new title; an empty title returns to the default label. */
  onRename: (branch: string, title: string) => void
}

/** What the menu shows and does. */
export interface BranchMenuProps extends BranchActions {
  /** A state of the project, for its branches and current branch; null while it loads. */
  state: WireState | null
  /** The side of the button the menu opens on: `top` in the bottom bar, `bottom` in a panel header. */
  side: 'top' | 'bottom'
}

/** The search field shows above the list from this many branches on. */
const SEARCH_FROM = 8
/** The most characters a branch title holds; the server refuses longer ones. */
const TITLE_MAX = 40

const accent = 'var(--dv-accent, #7c5cff)'
const danger = 'var(--dv-danger, #e5484d)'
const muted = 'var(--dv-muted, rgba(127, 127, 127, 0.95))'
const hover = 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))'
const trigger: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', borderRadius: 6, padding: '3px 8px',
  background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer',
}
const rowButton: CSSProperties = {
  flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, border: 'none', borderRadius: 6, padding: '6px 8px',
  background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const iconButton: CSSProperties = {
  flex: 'none', width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none',
  borderRadius: 6, padding: 0, background: 'transparent', color: 'inherit', cursor: 'pointer',
}
const field: CSSProperties = {
  width: '100%', boxSizing: 'border-box', border: `1px solid ${accent}`, borderRadius: 6, padding: '4px 8px',
  background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13, outline: 'none',
}

/** The branch glyph of the button. */
export function BranchIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10" /><path d="M18 9c0 5-6 4-11 9" />
    </svg>
  )
}

/**
 * Bind the menu's gestures to the branch routes.
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
    onCreate: async () => {
      if (project === null) return null
      const created: { name: string | null } = { name: null }
      await run(async () => { created.name = (await client.createBranch(project, surface)).branch.name })
      return created.name
    },
    onRename: (branch, title) => { if (project !== null) void run(() => client.renameBranch(project, branch, title)) },
  }
}

/**
 * The button, and the menu while it is open. Escape or a click outside closes the menu; ↑ and ↓ move between its rows.
 * @param props - the state, the gestures, and the side the menu opens on.
 * @returns the element.
 */
export function BranchMenu({ state, onSwitch, onCreate, onRename, side }: BranchMenuProps): ReactNode {
  const t = useText()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const branches = state?.branches ?? []
  const current = branches.find(branch => branch.name === state?.current)
  const close = (): void => { setOpen(false); setQuery(''); setEditing(null) }
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) close() }
    document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('pointerdown', outside) }
  }, [open])
  // The menu takes the keyboard when it opens: the search field when it shows, else the current branch's row.
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>('input, [data-testid="dv-kit-branch-option"]')?.focus()
  }, [open])
  // The current branch first, then the rest in the project's order, narrowed by the search text.
  const needle = query.trim().toLowerCase()
  const ordered = current === undefined ? branches : [current, ...branches.filter(branch => branch !== current)]
  const shown = needle === '' ? ordered : ordered.filter(branch => branchLabel(branch, t).toLowerCase().includes(needle))
  const taken = (name: string, title: string): boolean => branches.some(branch => branch.name !== name
    && branchLabel(branch, t).trim().toLowerCase() === title.toLowerCase())
  const create = (): void => {
    void onCreate().then((name) => {
      if (name === null) return
      setQuery('')
      setEditing(name)
    })
  }
  // ↑ and ↓ move between the rows and 新建分支; Escape closes the menu while no name is being edited.
  const keys = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Escape') { close(); root.current?.querySelector<HTMLElement>('button')?.focus(); return }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const stops = [...panel.current?.querySelectorAll<HTMLElement>('[data-branch-stop]') ?? []]
    const at = stops.indexOf(document.activeElement as HTMLElement)
    const next = stops[event.key === 'ArrowDown' ? Math.min(at + 1, stops.length - 1) : Math.max(at - 1, 0)]
    event.preventDefault()
    next?.focus()
  }
  const menu: CSSProperties = {
    position: 'absolute', left: 0, ...side === 'top' ? { bottom: '100%', marginBottom: 4 } : { top: '100%', marginTop: 4 },
    width: 260, padding: 4, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 2,
    border: '0.5px solid var(--dsw-alias-border-l3, #d0d3da)', borderRadius: 10, background: 'var(--dsw-alias-bg-base, #ffffff)',
    boxShadow: '0 6px 24px rgba(0, 0, 0, 0.18)',
  }
  return (
    <div ref={root} style={{ position: 'relative', display: 'inline-flex', flex: 'none' }} data-testid="dv-kit-branch-menu" data-branch={state?.current ?? ''}>
      <button
        type="button" style={trigger} disabled={state === null} aria-haspopup="dialog" aria-expanded={open}
        title={t('当前分支：所有视图都显示它，修改也写到它', 'Current branch: every view shows it, and edits go to it')}
        onClick={() => { if (open) close(); else setOpen(true) }}
      >
        <BranchIcon />
        <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{current === undefined ? '' : branchLabel(current, t)}</span>
      </button>
      {open
        ? (
          <div ref={panel} role="dialog" aria-label={t('分支', 'Branches')} style={menu} onKeyDown={keys}>
            {branches.length >= SEARCH_FROM
              ? (
                <input
                  type="search" value={query} placeholder={t('查找分支…', 'Find branch…')} aria-label={t('查找分支', 'Find branch')}
                  style={{ ...field, borderColor: 'var(--dsw-alias-border-l3, #d0d3da)', marginBottom: 2 }}
                  onChange={(event) => { setQuery(event.currentTarget.value) }}
                />
              )
              : null}
            <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {shown.length === 0 ? <p style={{ margin: 0, padding: '6px 8px', fontSize: 12, color: muted }}>{t('没有匹配的分支', 'No matching branch')}</p> : null}
              {shown.map(branch => editing === branch.name
                ? (
                  <NameField
                    key={branch.name} branch={branch} taken={title => taken(branch.name, title)}
                    onDone={(title) => {
                      setEditing(null)
                      if (title !== null) onRename(branch.name, title)
                    }}
                  />
                )
                : (
                  <div
                    key={branch.name} style={{ display: 'flex', alignItems: 'center', borderRadius: 6, background: active === branch.name ? hover : 'transparent' }}
                    onMouseEnter={() => { setActive(branch.name) }} onMouseLeave={() => { setActive(null) }}
                  >
                    <button
                      type="button" data-testid="dv-kit-branch-option" data-branch={branch.name} data-branch-stop=""
                      aria-current={branch.name === state?.current}
                      style={{ ...rowButton, fontWeight: branch.name === state?.current ? 600 : 400 }}
                      onFocus={() => { setActive(branch.name) }}
                      onClick={() => {
                        close()
                        if (branch.name !== state?.current) onSwitch(branch.name)
                      }}
                      onKeyDown={(event) => { if (event.key === 'F2') { event.preventDefault(); setEditing(branch.name) } }}
                    >
                      <span style={{ width: 14, flex: 'none', color: accent }}>{branch.name === state?.current ? '✓' : ''}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{branchLabel(branch, t)}</span>
                    </button>
                    <button
                      type="button" data-testid="dv-kit-branch-rename" aria-label={t(`重命名 ${branchLabel(branch, t)}`, `Rename ${branchLabel(branch, t)}`)}
                      title={t('重命名（F2）', 'Rename (F2)')} tabIndex={-1}
                      style={{ ...iconButton, opacity: active === branch.name ? 1 : 0 }}
                      onClick={() => { setEditing(branch.name) }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="m13 7 4 4" />
                      </svg>
                    </button>
                  </div>
                ))}
            </div>
            <div style={{ height: 1, margin: '2px 4px', background: 'var(--dsw-alias-border-l3, #d0d3da)' }} />
            <button
              type="button" data-testid="dv-kit-branch-create" data-branch-stop="" style={{ ...rowButton, flex: 'none', color: accent }}
              onClick={create}
            >
              <span style={{ width: 14, flex: 'none' }}>＋</span>{t('新建分支', 'New branch')}
            </button>
          </div>
        )
        : null}
    </div>
  )
}

/**
 * A branch's name in place in the menu, selected so typing replaces it. Enter or leaving the field saves, Escape keeps
 * the name; a name another branch shows is refused with a note below the field.
 * @param props - the branch, the check for a name in use, and the callback with the new title (null to keep the name).
 * @returns the field.
 */
function NameField(props: { branch: Branch; taken: (title: string) => boolean; onDone: (title: string | null) => void }): ReactNode {
  const t = useText()
  const initial = branchLabel(props.branch, t)
  const [value, setValue] = useState(initial)
  const [refused, setRefused] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)
  // Set once the field has reported, so a blur after Enter or Escape reports nothing more.
  const done = useRef(false)
  useEffect(() => { input.current?.select() }, [])
  const finish = (title: string | null): void => {
    if (done.current) return
    done.current = true
    props.onDone(title)
  }
  // An unchanged name writes nothing, so a default label is never stored as a title.
  const save = (): boolean => {
    const title = value.trim()
    if (title === initial) { finish(null); return true }
    if (title !== '' && props.taken(title)) { setRefused(true); return false }
    finish(title === '' && props.branch.title === null ? null : title)
    return true
  }
  return (
    <div style={{ padding: '2px 4px' }}>
      <input
        ref={input} data-testid="dv-kit-branch-name" value={value} maxLength={TITLE_MAX} aria-label={t('分支名称', 'Branch name')}
        aria-invalid={refused} style={{ ...field, ...refused ? { borderColor: danger } : {} }}
        onChange={(event) => { setValue(event.currentTarget.value); setRefused(false) }}
        onBlur={() => { if (!save()) finish(null) }}
        onKeyDown={(event) => {
          // The field keeps its own keys: Enter saves, Escape keeps the name, and the arrows move the caret.
          if (event.key === 'Enter') { event.preventDefault(); save() }
          if (event.key === 'Escape') finish(null)
          if (['Escape', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.stopPropagation()
        }}
      />
      <p style={{ margin: '3px 2px 0', fontSize: 11, color: refused ? danger : muted }}>
        {refused ? t('已有同名分支', 'Name already used') : t('回车保存 · Esc 取消', 'Enter to save · Esc to cancel')}
      </p>
    </div>
  )
}
