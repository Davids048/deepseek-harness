/**
 * Inline title editing and the row menu the DreamVerse shell uses for projects and chat sessions.
 *
 * @module @dv/ui-shell/InlineRename
 */
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { MoreIcon } from './icons.tsx'
import css from './shell.module.css'

/**
 * A text field that replaces a title while it is renamed: Enter or leaving the field saves a changed, non-empty
 * title, and Escape cancels.
 * @param props - the current title, the save callback, and the close callback.
 * @returns the field.
 */
export function InlineRename({ value, onSave, onClose }: {
  value: string
  onSave: (title: string) => void
  onClose: () => void
}): ReactNode {
  const [text, setText] = useState(value)
  const settled = useRef(false)
  const finish = (save: boolean): void => {
    if (settled.current) return
    settled.current = true
    const title = text.trim()
    if (save && title.length > 0 && title !== value) onSave(title)
    onClose()
  }
  return (
    <input
      className={css.renameInput}
      value={text}
      // The field opens in response to the user's rename request, so it takes focus.
      autoFocus
      onFocus={(event) => { event.currentTarget.select() }}
      onChange={(event) => { setText(event.currentTarget.value) }}
      onClick={(event) => { event.stopPropagation() }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(true)
        else if (event.key === 'Escape') finish(false)
      }}
      onBlur={() => { finish(true) }}
    />
  )
}

/** One entry of a {@link RowMenu}. */
export interface RowMenuItem {
  label: string
  danger?: boolean
  run: () => void
}

/**
 * A ⋯ button that shows on row hover and opens a small menu; a click outside the menu closes it.
 * @param props - the menu entries and the button's accessible label.
 * @returns the button and, while open, the menu.
 */
export function RowMenu({ items, label }: { items: RowMenuItem[]; label: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || root.current?.contains(event.target) !== true) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => { document.removeEventListener('mousedown', close) }
  }, [open])
  return (
    <span ref={root} className={css.rowMenu} data-open={open ? '' : undefined}>
      <button
        type="button" className={css.rowMenuButton} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
        onClick={(event) => { event.stopPropagation(); setOpen(value => !value) }}
      ><MoreIcon /></button>
      {open && (
        <span className={css.rowMenuList} role="menu">
          {items.map(item => (
            <button
              key={item.label} type="button" role="menuitem" className={css.rowMenuItem} data-danger={item.danger === true ? '' : undefined}
              onClick={(event) => { event.stopPropagation(); setOpen(false); item.run() }}
            >{item.label}</button>
          ))}
        </span>
      )}
    </span>
  )
}
