/**
 * The page-wide undo and redo keys of an open project: Ctrl+Z steps the project's current branch back one step and
 * Shift+Ctrl+Z steps it forward (Cmd instead of Ctrl on macOS). Keys typed into a text field, a select, or an editable
 * element (the chat composer) keep their text-editing meaning.
 *
 * @module @dv/ui-shell/undo-keys
 */
import { DvApiError } from '@dv/ui-kit/api.ts'
import { getShell, shellClient } from './store.ts'

/**
 * Which history move a key press asks for.
 * @param event - the key press.
 * @param mac - whether the page runs on macOS, where Cmd takes the place of Ctrl.
 * @returns `undo`, `redo`, or null for any other key.
 */
export function historyKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, mac: boolean,
): 'undo' | 'redo' | null {
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!command || event.altKey || event.key.toLowerCase() !== 'z') return null
  return event.shiftKey ? 'redo' : 'undo'
}

/** @returns whether a key press's target edits text, where Ctrl+Z belongs to the text. */
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
    const move = historyKey(event, mac)
    const { projectId, sessionId, view } = getShell()
    if (move === null || event.defaultPrevented || event.repeat || projectId === null || editsText(event.target)) return
    event.preventDefault()
    const session = sessionId ?? null
    const work = move === 'undo' ? shellClient.undo(projectId, view, session) : shellClient.redo(projectId, view, session)
    work.catch((error: unknown) => {
      // At either end of the history the key does nothing.
      if (error instanceof DvApiError && (error.code === 'nothing_to_undo' || error.code === 'nothing_to_redo')) return
      console.warn(`ui-shell: ${move} failed`, error)
    })
  }
  window.addEventListener('keydown', onKey)
  return () => { window.removeEventListener('keydown', onKey) }
}
