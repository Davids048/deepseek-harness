import { useCallback, useEffect, useState } from 'react'
import type { ConversationViewRequest } from '../contract/views.ts'
import type { ConversationSessionSlotProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { resolveActiveView } from '../view-selection.ts'
import css from './ConversationRoot.module.css'

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible. An owner that
 * pins `view` may also pass `focus`, which reaches the View as its focus request.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function DefaultConversationViews({
  view, focus, useSession, useConversation, useConversationViews, useInput, inputActions, useStore, actions,
  renderSlot, bindDraftMirror, openView, useInspectCall,
}: ConversationSessionSlotProps) {
  const tabs = useConversationViews(value => value)
  const inspectCall = useInspectCall(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const inputState = useInput(s => s)
  const storedDraft = useStore(s => s.draft)
  const viewRequest = useStore(s => s.viewRequest ?? null)
  // An occurrence that pins its View may address a focus to it through owner props; that request takes precedence
  // over the stored one until the View acknowledges it.
  const [ownerFocus, setOwnerFocus] = useState<string | undefined>(undefined)
  const [ownerRequest, setOwnerRequest] = useState<ConversationViewRequest | null>(null)
  if (focus !== ownerFocus) {
    setOwnerFocus(focus)
    setOwnerRequest(view !== undefined && focus !== undefined ? { view, focus } : null)
  }
  const completeOwnerRequest = useCallback(() => { setOwnerRequest(null) }, [])

  useEffect(() => {
    if (inputState.draft === '' && storedDraft !== '') inputActions.setDraft(storedDraft)
    const unmirror = bindDraftMirror(actions.setDraft)
    return () => { unmirror() }
    // Mount-only (deps pinned to inputActions): later store writes come from
    // the machine mirror, not this seed effect.
  }, [inputActions])

  if (session.blank && conversationPhase(session, conversation) === 'blank') return null
  const viewId = view ?? active?.id
  return (
    <div className={css.viewArea}>
      {viewId !== undefined && renderSlot('conversation.view', {
        inspectCall,
        viewRequest: ownerRequest ?? viewRequest,
        openView,
        completeViewRequest: ownerRequest === null ? actions.completeViewRequest : completeOwnerRequest,
      }, { only: viewId })}
    </div>
  )
}
