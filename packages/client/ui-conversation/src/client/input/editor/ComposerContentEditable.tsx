/**
 * The composer's contenteditable host: binds one shell-owned Lexical editor
 * to a resident div. Session-maybe by design — a null editor renders the
 * same DOM inert (the no-session Workspace-trigger state), so switching
 * between the two never swaps the element tree. Editability has ONE writer:
 * this component reflects the `editable` prop onto the editor; nothing else
 * calls setEditable.
 */
import { useLayoutEffect, useRef } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import type { LexicalEditor } from 'lexical'

/**
 * The hosts that currently claim each editor, oldest first. One session editor can be shown by several composer
 * hosts at once (for example a chat panel and a second Conversation occurrence); the newest claim owns the root,
 * and when a host unmounts the editor returns to the newest remaining host instead of being left without a root.
 */
const claims = new WeakMap<LexicalEditor, HTMLDivElement[]>()

/**
 * Make `el` the editor's root and the newest claim.
 * @param editor - the shared editor.
 * @param el - the claiming host.
 */
function claimRoot(editor: LexicalEditor, el: HTMLDivElement): void {
  const hosts = (claims.get(editor) ?? []).filter(host => host !== el)
  hosts.push(el)
  claims.set(editor, hosts)
  if (editor.getRootElement() !== el) editor.setRootElement(el)
}

/**
 * Drop `el`'s claim; if it held the root, hand the root to the newest remaining host.
 * @param editor - the shared editor.
 * @param el - the releasing host.
 */
function releaseRoot(editor: LexicalEditor, el: HTMLDivElement): void {
  const hosts = (claims.get(editor) ?? []).filter(host => host !== el)
  claims.set(editor, hosts)
  if (editor.getRootElement() === el) editor.setRootElement(hosts.at(-1) ?? null)
}

/** Host props: the editor binding plus the div passthroughs the bar owns. */
export interface ComposerContentEditableProps extends HTMLAttributes<HTMLDivElement> {
  /** The shell-owned editor; null renders the same div unbound and inert. */
  readonly editor: LexicalEditor | null
  /** Whether the user may edit (readOnly/disabled states fold in here). */
  readonly editable: boolean
}

/**
 * Render the composer's editable surface.
 * @param props - editor binding, editability, and div passthroughs.
 * @returns the resident contenteditable div.
 */
export function ComposerContentEditable({ editor, editable, onFocus, onPointerDown, ...rest }: ComposerContentEditableProps): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (editor === null || el === null) return
    claimRoot(editor, el)
    return () => { releaseRoot(editor, el) }
  }, [editor])
  // The host the user interacts with takes the editor back from any other host showing the same session.
  const reclaim = (): void => {
    const el = ref.current
    if (editor !== null && el !== null) claimRoot(editor, el)
  }
  useLayoutEffect(() => {
    if (editor !== null) editor.setEditable(editable)
  }, [editor, editable])
  return (
    <div
      ref={ref}
      // Lexical's setRootElement never touches contenteditable; the binding
      // renders it, and setEditable above keeps the editor's own gate in step.
      contentEditable={editor !== null && editable}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      data-composer-input
      {...rest}
      onPointerDown={(event) => { reclaim(); onPointerDown?.(event) }}
      onFocus={(event) => { reclaim(); onFocus?.(event) }}
    />
  )
}
