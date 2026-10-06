// @vitest-environment jsdom
/** The working-branch bar and the discard confirmation: the shown branch, accept, and the discard dialog's answers. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { DvClient } from '../src/client/api.ts'
import type { DraftCounts } from '../src/client/types.ts'
import { WorkingBranchBar } from '../src/client/WorkingBranchBar.tsx'
import { fixtureState, scriptedFetch } from './fixture.client.tsx'

afterEach(() => { cleanup(); document.documentElement.lang = '' })

/**
 * Mount the bar for chat session `session` over a scripted discard route.
 * @param session - the chat session beside the view.
 * @param discardCounts - the counts the server reports for the draft on each discard call, in order; a confirmed call
 *   whose counts differ from the current ones answers 409 `draft_changed`.
 * @returns the rendered bar, the recorded writes, and the run spy.
 */
function mount(session: string | null, discardCounts: DraftCounts[] = []) {
  let current: DraftCounts = { agent_changes: 1, human_edits: 0 }
  const { fetch, writes } = scriptedFetch({
    post: (path, body) => {
      if (path !== '/api/dv/drafts/discard') return { status: 200, body: { heads: {} } }
      current = discardCounts.shift() ?? current
      const confirmed = (body as { counts?: DraftCounts }).counts
      if (confirmed === undefined) return { status: 200, body: { draft: 'draft/s5', counts: current } }
      if (confirmed.agent_changes !== current.agent_changes || confirmed.human_edits !== current.human_edits) {
        return { status: 409, body: { error: 'the draft changed', code: 'draft_changed', counts: current } }
      }
      return { status: 200, body: { draft: 'draft/s5', counts: current, heads: {} } }
    },
  })
  const run = vi.fn(async (work: () => Promise<unknown>) => { await work() })
  const view = render(
    <WorkingBranchBar client={new DvClient(fetch)} project="p1" session={session} surface="timeline" state={fixtureState()} intent="retake" run={run} />,
  )
  return { view, writes, run }
}

describe('WorkingBranchBar', () => {
  it('shows main without a session draft, and the draft with its request, accept and discard while one is open', () => {
    const { view } = mount('s1')
    const bar = view.getByTestId('dv-kit-working-branch')
    expect(bar.getAttribute('data-branch')).toBe('main')
    expect(bar.textContent).toBe('Working branch: main')
    expect(within(bar).queryAllByRole('button')).toHaveLength(0)
    cleanup()
    document.documentElement.lang = 'zh-CN'
    const open = mount('s5').view.getByTestId('dv-kit-working-branch')
    expect(open.getAttribute('data-branch')).toBe('draft/s5')
    expect(within(open).getByText('当前分支：草稿 · retake')).toBeTruthy()
    expect(within(open).getAllByRole('button').map(button => button.textContent)).toEqual(['接受', '丢弃'])
  })

  it('accepts the session\'s draft through the view\'s runner', async () => {
    const { view, writes, run } = mount('s5')
    fireEvent.click(view.getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(writes).toHaveLength(1) })
    expect(writes[0]).toEqual({ path: '/api/dv/drafts/accept', body: { project: 'p1', session: 's5', surface: 'timeline' } })
    expect(run).toHaveBeenCalledOnce()
  })

  it('confirms a discard with the counts the server reported, and Cancel leaves the draft alone', async () => {
    const { view, writes, run } = mount('s5', [{ agent_changes: 3, human_edits: 2 }])
    fireEvent.click(view.getByRole('button', { name: 'Discard' }))
    const dialog = await view.findByTestId('dv-kit-discard-dialog')
    expect(dialog.textContent).toContain('Discarding loses 3 agent changes and 2 of your own edits.')
    expect(writes).toEqual([{ path: '/api/dv/drafts/discard', body: { project: 'p1', session: 's5', surface: 'timeline' } }])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(view.queryByTestId('dv-kit-discard-dialog')).toBeNull()
    expect(writes).toHaveLength(1)
    fireEvent.click(view.getByRole('button', { name: 'Discard' }))
    fireEvent.click(within(await view.findByTestId('dv-kit-discard-dialog')).getByRole('button', { name: 'Discard' }))
    await waitFor(() => { expect(view.queryByTestId('dv-kit-discard-dialog')).toBeNull() })
    expect(writes.at(-1)).toEqual({
      path: '/api/dv/drafts/discard', body: { project: 'p1', session: 's5', surface: 'timeline', counts: { agent_changes: 3, human_edits: 2 } },
    })
    // The view refreshes after the discard.
    expect(run).toHaveBeenCalledOnce()
  })

  it('shows the current counts with a notice when the draft changed before the confirmation, and refreshes', async () => {
    // The dry read reports 1 + 0; an agent record lands before the confirm, so the server then holds 2 + 0.
    const { view, writes, run } = mount('s5', [{ agent_changes: 1, human_edits: 0 }, { agent_changes: 2, human_edits: 0 }])
    fireEvent.click(view.getByRole('button', { name: 'Discard' }))
    const dialog = await view.findByTestId('dv-kit-discard-dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    await waitFor(() => { expect(within(dialog).getByRole('status').textContent).toContain('The draft changed before you confirmed.') })
    expect(dialog.textContent).toContain('Discarding loses 2 agent changes and 0 of your own edits.')
    expect(run).toHaveBeenCalledOnce()
    // Confirming again sends the counts the dialog shows now.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    await waitFor(() => { expect(view.queryByTestId('dv-kit-discard-dialog')).toBeNull() })
    expect(writes.at(-1)?.body).toMatchObject({ counts: { agent_changes: 2, human_edits: 0 } })
  })

  it('reports a failed read in the dialog without a way to confirm, and Escape closes it', async () => {
    const { fetch } = scriptedFetch({ post: () => ({ status: 404, body: { error: 'no open draft', code: 'no_open_draft' } }) })
    const view = render(
      <WorkingBranchBar client={new DvClient(fetch)} project="p1" session="s5" surface="canvas" state={fixtureState()} run={async (work) => { await work() }} />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Discard' }))
    const dialog = await view.findByTestId('dv-kit-discard-dialog')
    expect(within(dialog).getByRole('alert').textContent).toBe('Failed: no open draft')
    expect(within(dialog).getByRole('button', { name: 'Discard' })).toHaveProperty('disabled', true)
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
    expect(view.queryByTestId('dv-kit-discard-dialog')).toBeNull()
  })
})
