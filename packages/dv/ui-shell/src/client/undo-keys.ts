/**
 * The page-wide undo and redo keys of an open project: Ctrl+Z (Cmd+Z on macOS) moves the whole project one step back,
 * and Shift+Ctrl+Z (Shift+Cmd+Z) one step forward. Both only move the current position of the history list. Keys typed
 * into a text field, a select, or an editable element (the chat composer) keep their text-editing meaning.
 *
 * @module @dv/ui-shell/undo-keys
 */
import { DvApiError } from '@dv/ui-kit/api.ts'
import { getShell, shellClient } from './store.ts'

/**
 * Which history key a key press is.
 * @param event - the key press.
 * @param mac - whether the page runs on macOS, where Cmd takes the place of Ctrl.
 * @returns `undo` for Ctrl+Z (Cmd+Z on macOS), `redo` with Shift, null for any other key or with Alt.
 */
export function historyKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, mac: boolean,
): 'undo' | 'redo' | null {
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!command || event.altKey || event.key.toLowerCase() !== 'z') return null
  return event.shiftKey ? 'redo' : 'undo'
}

/** @returns whether a key press's target edits text, where Ctrl+Z and Shift+Ctrl+Z belong to the text. */
function editsText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null
}

/**
 * Listen for the undo and redo keys on the window while a project is open.
 * @returns the disposer that removes the listener.
 */
export function listenHistoryKeys(): () => void {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  const onKey = (event: KeyboardEvent): void => {
    const { projectId } = getShell()
    const key = historyKey(event, mac)
    if (key === null || event.defaultPrevented || event.repeat || projectId === null || editsText(event.target)) return
    event.preventDefault()
    const move = key === 'undo' ? shellClient.undo(projectId) : shellClient.redo(projectId)
    move.catch((error: unknown) => {
      // At either end of the history list the key does nothing.
      if (error instanceof DvApiError && (error.code === 'nothing_to_undo' || error.code === 'nothing_to_redo')) return
      console.warn(`ui-shell: ${key} failed`, error)
    })
  }
  window.addEventListener('keydown', onKey)
  return () => { window.removeEventListener('keydown', onKey) }
}
