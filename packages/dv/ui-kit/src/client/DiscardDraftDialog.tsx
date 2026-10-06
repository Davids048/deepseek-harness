/**
 * The confirmation every draft discard goes through. Discarding a draft drops its agent changes and the human's own
 * edits on it, so the view first reads the counts the server reports for the draft, shows them in a dialog, and sends
 * the discard with the counts the human confirmed. When the draft changed in between, the server refuses with
 * `draft_changed` and its current counts; the dialog then shows those counts with a notice, and the view refreshes.
 * Cancel leaves the draft as it is. Copy comes from `useText()` pairs, so every view shows the same dialog.
 *
 * @module @dv/ui-kit/DiscardDraftDialog
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { DvApiError } from './api.ts'
import type { DvClient, ViewSurface } from './api.ts'
import { useText } from './locale.ts'
import type { DraftCounts, DraftTarget } from './types.ts'

/** What {@link useDiscardDraft} gives a view: the gesture, and the dialog element the view renders. */
export interface DiscardDraft {
  /** Read the draft's counts and open the confirmation dialog. */
  request: (target: DraftTarget) => void
  /** The open dialog, or null. */
  dialog: ReactNode
}

/** The dialog's state while it is open. */
interface PendingDiscard {
  target: DraftTarget
  /** The counts the dialog shows and the discard confirms; null when the dry read failed. */
  counts: DraftCounts | null
  /** True after the server refused the discard because the draft changed. */
  changed: boolean
  failure: string | null
  busy: boolean
}

/**
 * @param value - a field of a response or error body.
 * @returns the value as draft counts, or null when it has another shape.
 */
function draftCountsOf(value: unknown): DraftCounts | null {
  if (typeof value !== 'object' || value === null) return null
  const fields = value as Record<string, unknown>
  const agent = fields['agent_changes']
  const human = fields['human_edits']
  return typeof agent === 'number' && typeof human === 'number' ? { agent_changes: agent, human_edits: human } : null
}

/**
 * @param failure - a thrown value.
 * @returns its message.
 */
function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/**
 * Discard drafts of a project through the confirmation dialog.
 * @param client - the API client.
 * @param project - the project, or null while none is open.
 * @param surface - where the decision is made.
 * @param onChange - called after a discard and after the server reported a changed draft, so the view refreshes.
 * @returns the gesture and the dialog element.
 */
export function useDiscardDraft(
  client: DvClient, project: string | null, surface: ViewSurface, onChange: () => void = () => undefined,
): DiscardDraft {
  const [pending, setPending] = useState<PendingDiscard | null>(null)
  // The dialog of the latest request; an answer for an older request is dropped.
  const latest = useRef<DraftTarget | null>(null)
  const update = (target: DraftTarget, patch: Partial<PendingDiscard>): void => {
    setPending(current => current !== null && current.target === target ? { ...current, ...patch } : current)
  }
  const request = useCallback((target: DraftTarget) => {
    if (project === null) return
    latest.current = target
    void client.discardDraft(project, target, surface).then((answer) => {
      if (latest.current !== target) return
      const counts = draftCountsOf(answer.counts)
      setPending({ target, counts, changed: false, failure: counts === null ? 'counts missing' : null, busy: false })
    }, (failure: unknown) => {
      if (latest.current !== target) return
      setPending({ target, counts: null, changed: false, failure: messageOf(failure), busy: false })
    })
  }, [client, project, surface])
  const cancel = (): void => {
    latest.current = null
    setPending(null)
  }
  const confirm = (): void => {
    if (pending === null || pending.counts === null || project === null) return
    const { target, counts } = pending
    update(target, { busy: true, failure: null })
    void client.discardDraft(project, target, surface, counts).then(() => {
      latest.current = null
      setPending(null)
      onChange()
    }, (failure: unknown) => {
      const moved = failure instanceof DvApiError && failure.code === 'draft_changed' ? draftCountsOf(failure.body['counts']) : null
      if (moved !== null) {
        update(target, { counts: moved, changed: true, busy: false })
        onChange()
        return
      }
      update(target, { failure: messageOf(failure), busy: false })
    })
  }
  const dialog = pending === null ? null : <DiscardDraftDialog pending={pending} onConfirm={confirm} onCancel={cancel} />
  return { request, dialog }
}

// The dialog draws on the DSH theme tokens, with fallbacks for hosts without them.
const overlay: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0, 0, 0, 0.35)',
}
const panel: CSSProperties = {
  width: 'min(420px, calc(100% - 32px))', boxSizing: 'border-box', padding: 18, borderRadius: 12, fontSize: 14, lineHeight: 1.5,
  background: 'var(--dsw-alias-bg-layer-3, #ffffff)', color: 'var(--dsw-alias-label-primary, #1f1f24)',
  border: '1px solid var(--dsw-alias-border-l3, #d9d9de)', boxShadow: '0 18px 48px rgba(0, 0, 0, 0.18)',
}
const button: CSSProperties = { border: 'none', borderRadius: 8, padding: '7px 14px', font: 'inherit', cursor: 'pointer' }

/** Props of {@link DiscardDraftDialog}. */
interface DiscardDraftDialogProps {
  pending: PendingDiscard
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The modal dialog: the counts to be lost, a notice when the draft changed, and Discard and Cancel. Pointer and key
 * events stop here, so the view under it neither pans nor reads Delete as a clip removal; Escape cancels.
 * @param props - the dialog state and the two answers.
 * @returns the element.
 */
function DiscardDraftDialog({ pending, onConfirm, onCancel }: DiscardDraftDialogProps): ReactNode {
  const text = useText()
  const cancelButton = useRef<HTMLButtonElement | null>(null)
  // The safe answer has the focus, so Enter does not discard by accident.
  useEffect(() => { cancelButton.current?.focus() }, [])
  const { counts } = pending
  return (
    <div
      style={overlay}
      onPointerDown={(event) => { event.stopPropagation() }}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') onCancel() }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="dv-kit-discard-title" style={panel} data-testid="dv-kit-discard-dialog">
        <h2 id="dv-kit-discard-title" style={{ margin: '0 0 8px', fontSize: 16 }}>{text('丢弃草稿？', 'Discard the draft?')}</h2>
        {counts !== null
          ? (
            <p style={{ margin: 0 }} data-agent-changes={counts.agent_changes} data-human-edits={counts.human_edits}>
              {text(
                `丢弃后会丢失 ${String(counts.agent_changes)} 处智能体修改和 ${String(counts.human_edits)} 处你自己的修改。`,
                `Discarding loses ${String(counts.agent_changes)} agent changes and ${String(counts.human_edits)} of your own edits.`,
              )}
            </p>
          )
          : null}
        {pending.changed
          ? (
            <p role="status" style={{ margin: '8px 0 0', color: 'var(--dsw-alias-state-warn-primary, #b4432a)' }}>
              {text('草稿在你确认前变了，上面是最新的数量，请再确认一次。', 'The draft changed before you confirmed. The counts above are current; confirm again.')}
            </p>
          )
          : null}
        {pending.failure !== null
          ? (
            <p role="alert" style={{ margin: '8px 0 0', color: 'var(--dsw-alias-state-error-primary, #e5484d)' }}>
              {text(`失败：${pending.failure}`, `Failed: ${pending.failure}`)}
            </p>
          )
          : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button
            ref={cancelButton} type="button" onClick={onCancel}
            style={{ ...button, background: 'var(--dsw-alias-interactive-bg-hover, #ececf0)', color: 'inherit' }}
          >
            {text('取消', 'Cancel')}
          </button>
          <button
            type="button" onClick={onConfirm} disabled={counts === null || pending.busy}
            style={{
              ...button, background: 'var(--dsw-alias-state-error-primary, #e5484d)', color: '#ffffff', fontWeight: 600,
              opacity: counts === null || pending.busy ? 0.5 : 1,
            }}
          >
            {text('丢弃', 'Discard')}
          </button>
        </div>
      </div>
    </div>
  )
}
