/**
 * The working-branch bar the canvas and the timeline editor show: which branch the human's edits in this view go to
 * (the open draft of the chat session the view sits beside, else `main`), and, while the draft is open, accept and
 * discard for it. Discard goes through {@link useDiscardDraft}. Copy comes from `useText()` pairs, so both views show
 * the same words.
 *
 * @module @dv/ui-kit/WorkingBranchBar
 */
import type { CSSProperties, ReactNode } from 'react'
import type { DvClient, ViewSurface } from './api.ts'
import { useDiscardDraft } from './DiscardDraftDialog.tsx'
import { useText } from './locale.ts'
import { sessionDraft } from './state.ts'
import type { WireState } from './types.ts'

/** Props of {@link WorkingBranchBar}. */
export interface WorkingBranchBarProps {
  client: DvClient
  project: string
  /** The chat session the view sits beside; null outside any chat session, which always works on `main`. */
  session: string | null
  surface: ViewSurface
  /** A state of the project, for its open drafts; null while it loads. */
  state: WireState | null
  /** The intent of the open draft's latest record that states one, shown beside it. */
  intent?: string
  /**
   * Run accept and report its failure the way the view reports its own writes; also called with a no-op after a
   * discard, so the view refreshes.
   */
  run: (work: () => Promise<unknown>) => Promise<unknown>
  /** Placement and look of the bar in the hosting view. */
  style?: CSSProperties
}

const button: CSSProperties = { border: 'none', borderRadius: 6, padding: '3px 10px', font: 'inherit', cursor: 'pointer' }

/**
 * The bar, followed by the discard dialog while it is open.
 * @param props - the client, project, chat session, state, and the view's write runner.
 * @returns the elements.
 */
export function WorkingBranchBar({ client, project, session, surface, state, intent = '', run, style }: WorkingBranchBarProps): ReactNode {
  const text = useText()
  const draft = state === null ? null : sessionDraft(state, session)
  const discard = useDiscardDraft(client, project, surface, () => { void run(() => Promise.resolve()) })
  const branch = draft?.branch ?? 'main'
  const shown = draft === null ? 'main' : text('草稿', 'Draft')
  return (
    <>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, ...style }}
        data-testid="dv-kit-working-branch" data-branch={branch}
        title={text('你在这里的修改写入这个分支', 'Your edits here go to this branch')}
        onPointerDown={(event) => { event.stopPropagation() }}
      >
        <span>
          {text(`当前分支：${shown}`, `Working branch: ${shown}`)}
          {draft !== null && intent !== '' ? ` · ${intent}` : ''}
        </span>
        {draft !== null
          ? (
            <>
              <button
                type="button"
                style={{ ...button, background: 'var(--dsw-alias-button-primary-fill, #2f5fae)', color: 'var(--dsw-alias-label-primary-inverted, #ffffff)', fontWeight: 600 }}
                onClick={() => { void run(() => client.acceptDraft(project, { session: draft.session }, surface)) }}
              >
                {text('接受', 'Accept')}
              </button>
              <button
                type="button" style={{ ...button, background: 'var(--dsw-alias-interactive-bg-hover, #ececf0)', color: 'inherit' }}
                onClick={() => { discard.request({ session: draft.session }) }}
              >
                {text('丢弃', 'Discard')}
              </button>
            </>
          )
          : null}
      </div>
      {discard.dialog}
    </>
  )
}
