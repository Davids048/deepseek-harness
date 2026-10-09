/**
 * The page-wide undo key of an open project: Ctrl+Z (Cmd+Z on macOS) undoes the last step of the whole project. The undo
 * is a new step at the end of the history; there is no redo key. Keys typed into a text field, a select, or an editable
 * element (the chat composer) keep their text-editing meaning.
 *
 * @module @dv/ui-shell/undo-keys
 */
import { DvApiError } from '@dv/ui-kit/api.ts'
import { getShell, shellClient } from './store.ts'

/**
 * Whether a key press is the undo key.
 * @param event - the key press.
 * @param mac - whether the page runs on macOS, where Cmd takes the place of Ctrl.
 * @returns true for Ctrl+Z (Cmd+Z on macOS) without Shift or Alt.
 */
export function isUndoKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, mac: boolean,
): boolean {
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z'
}

/** @returns whether a key press's target edits text, where Ctrl+Z belongs to the text. */
function editsText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null
}

/**
 * Listen for the undo key on the window while a project is open.
 * @returns the disposer that removes the listener.
 */
export function listenUndoKey(): () => void {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  const onKey = (event: KeyboardEvent): void => {
    const { projectId, sessionId, view } = getShell()
    if (!isUndoKey(event, mac) || event.defaultPrevented || event.repeat || projectId === null || editsText(event.target)) return
    event.preventDefault()
    shellClient.undo(projectId, view, sessionId ?? null).catch((error: unknown) => {
      // At the start of the history the key does nothing.
      if (error instanceof DvApiError && error.code === 'nothing_to_undo') return
      console.warn('ui-shell: undo failed', error)
    })
  }
  window.addEventListener('keydown', onKey)
  return () => { window.removeEventListener('keydown', onKey) }
}
