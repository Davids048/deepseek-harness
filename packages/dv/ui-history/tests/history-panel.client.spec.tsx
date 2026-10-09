// @vitest-environment jsdom
/**
 * The History panel over a scripted API: the steps with 当前 and greyed later steps, folds, selection, undo, redo,
 * 回到这一步, and empty states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { DvClient } from '@dv/ui-kit/api.ts'
import type { HistoryEntry, HistoryQuery, WireHistory, WireState } from '@dv/ui-kit/types.ts'
import { DV_CANVAS_FOCUS_EVENT, DV_HISTORY_FOCUS_EVENT, DV_TIMELINE_FOCUS_EVENT } from '@dv/ui-kit/workspace-events.ts'
import { asset, fixtureState, record, scriptedFetch } from '../../ui-kit/tests/fixture.client.tsx'
import { HistoryPanel } from '../src/client/HistoryPanel.tsx'

/**
 * Open a row's ⋮ menu.
 * @param element - a list row.
 * @returns the labels of the menu's items.
 */
function menuOf(element: HTMLElement): string[] {
  fireEvent.click(within(element).getByTestId('dv-history-step-actions'))
  return within(element).getAllByRole('menuitem').map(item => item.textContent ?? '')
}

// jsdom lays nothing out and has no scrollIntoView; the panel's scroll requests are recorded instead.
Element.prototype.scrollIntoView = vi.fn()

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ENTRIES: HistoryEntry[] = [
  { record: record({ id: 'm1', turn: null, surface: 'timeline', operation: 'timeline.clip_move', params: { clip: 'cl1', to: 2 }, intent: 'move clip 1' }), place: 'current' },
  {
    record: record({
      id: 'g1', turn: 't3', actor: 'agent', session: 's5', tool_call: 'call-g1', operation: 'shot.render_ref2va', outputs: ['shot1.mp4'],
      intent: 'render the hero',
      inputs: [{ role: 'reference', ref: { asset: 'ref.png' }, resolved_asset: 'ref.png' }],
    }),
    place: 'before',
  },
  { record: record({ id: 'p1', turn: 't3', actor: 'agent', session: 's5', tool_call: 'call-p1', operation: 'plan.create' }), place: 'before' },
]

/**
 * Mount the panel over scripted routes; `/api/dv/history` answers from {@link ENTRIES}.
 * @param entries - the history the route serves.
 * @param adjust - changes to the fixture state that `/api/dv/state` serves.
 * @returns the rendered panel and the recorded writes.
 */
function mount(entries: HistoryEntry[] = ENTRIES, adjust: (state: WireState) => void = () => {}) {
  const queries: HistoryQuery[] = []
  const scripted = scriptedFetch({
    // Timeline `t1` of the fixture holds clips cl1 and cl2, assigned by its create record; the clip move m1 is a record
    // of the current state.
    state: () => {
      const state = fixtureState()
      state.components.proj.records = state.components.proj.records.map(item => item.id === 's1' ? { ...item, report: { clips: ['cl1', 'cl2'] } } : item)
      state.components.proj.records.push(record({ id: 'm1', operation: 'timeline.clip_move', params: { clip: 'cl1', to: 2 } }))
      adjust(state)
      return state
    },
    post: (path, body) => {
      if (path !== '/api/dv/history') return { status: 200, body: { record: record({ id: 'b1' }) } }
      const query = body as HistoryQuery
      queries.push(query)
      const shown = entries.filter(entry => query.tool_call === undefined || entry.record.tool_call === query.tool_call)
      const answer: WireHistory = {
        entries: shown,
        assets: [asset('shot1.mp4', 'video/mp4', 'g1', 4), asset('ref.png', 'image/png', null)],
      }
      return { status: 200, body: answer }
    },
  })
  const view = render(<HistoryPanel projectId="p1" client={new DvClient(scripted.fetch)} />)
  const row = (id: string): HTMLElement => {
    const element = view.container.querySelector(`[data-testid="dv-history-row"][data-record="${id}"]`)
    if (!(element instanceof HTMLElement)) throw new Error(`no row ${id}`)
    return element
  }
  return { view, writes: scripted.writes, queries, row }
}

describe('HistoryPanel', () => {
  it('shows one row per step, newest first, with who, the agent\'s intent, one thumbnail, and 当前 on the current step', async () => {
    const { view, row } = mount()
    await waitFor(() => { expect(view.container.querySelectorAll('[data-testid="dv-history-row"]').length).toBe(3) })
    const ids = [...view.container.querySelectorAll('[data-testid="dv-history-row"]')].map(element => element.getAttribute('data-record'))
    expect(ids).toEqual(['m1', 'g1', 'p1'])
    expect(row('g1').textContent).toContain('render the hero')
    expect(row('g1').textContent).toContain('Agent')
    expect(row('m1').textContent).toContain('Move clip')
    expect(row('m1').textContent).toContain('You')
    expect(row('m1').textContent).not.toContain('render the hero')
    expect(row('g1').getAttribute('data-actor')).toBe('agent')
    expect(row('m1').querySelector('[data-testid="dv-history-current"]')?.textContent).toBe('Current')
    expect(view.container.querySelectorAll('[data-testid="dv-history-current"]')).toHaveLength(1)
    expect(row('g1').querySelectorAll('[data-testid="dv-history-thumb"]').length).toBe(1)
    // A plan's JSON file has no thumbnail.
    expect(row('p1').querySelector('[data-testid="dv-history-thumb"]')).toBeNull()
    // One list: no branch menu and no view switch; redo waits until a step lies after the current one.
    for (const id of ['dv-kit-branch-menu', 'dv-history-view-toggle']) expect(view.queryByTestId(id)).toBeNull()
    await waitFor(() => { expect(view.getByTestId('dv-history-redo')).toHaveProperty('disabled', true) })
  })

  it('folds the renders a plan approval scheduled under its row until the toggle opens them', async () => {
    const approval: HistoryEntry[] = [
      { record: record({ id: 'g2', actor: 'system', operation: 'shot.render_ref2va', params: { plan: 'p1', shot: 2 }, status: 'running' }), place: 'current' },
      { record: record({ id: 'g1', actor: 'system', operation: 'shot.render_ref2va', params: { plan: 'p1', shot: 1 }, outputs: ['shot1.mp4'] }), place: 'before' },
      {
        record: record({ id: 'ap', actor: 'agent', operation: 'plan.approve', params: { plan: 'p1' }, report: { plan: 'p1', version: 1, scheduled: ['g1', 'g2'] } }),
        place: 'before',
      },
    ]
    const { view, row } = mount(approval)
    await waitFor(() => { row('ap') })
    expect(view.container.querySelectorAll('[data-testid="dv-history-row"]').length).toBe(1)
    expect(row('ap').textContent).toContain('Approve plan p1 v1')
    const fold = view.getByTestId('dv-history-fold')
    expect(fold.textContent).toContain('Render 2 shots (1/2)')
    fireEvent.click(fold)
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(row('g1').textContent).toContain('Render shot from references 1')
    expect(row('g2').textContent).toContain('Automatic')
    // Folded rows follow `report.scheduled`: shot 1, then shot 2.
    const folded = [...view.container.querySelectorAll('[data-testid="dv-history-row"]')].map(element => element.getAttribute('data-record'))
    expect(folded).toEqual(['ap', 'g1', 'g2'])
  })

  it('asks for the steps of the history list', async () => {
    const { queries } = mount()
    await waitFor(() => { expect(queries.at(0)).toEqual({ project: 'p1', limit: 50 }) })
  })

  it('selecting a render row plays its output and focuses its node, a clip row focuses the timeline clip, and a step after the current one focuses nothing', async () => {
    const later = ENTRIES.map(entry => entry.record.id === 'p1' ? { ...entry, place: 'after' as const } : entry)
    const { row } = mount(later)
    await waitFor(() => { row('g1') })
    const focused: unknown[] = []
    const onFocus = (event: Event): void => { focused.push((event as CustomEvent).detail) }
    window.addEventListener(DV_CANVAS_FOCUS_EVENT, onFocus)
    window.addEventListener(DV_TIMELINE_FOCUS_EVENT, onFocus)
    fireEvent.click(row('g1'))
    expect(row('g1').getAttribute('aria-selected')).toBe('true')
    expect(row('g1').querySelector('[data-testid="dv-history-preview"] video')).not.toBeNull()
    fireEvent.click(row('m1'))
    fireEvent.click(row('p1'))
    window.removeEventListener(DV_CANVAS_FOCUS_EVENT, onFocus)
    window.removeEventListener(DV_TIMELINE_FOCUS_EVENT, onFocus)
    await waitFor(() => { expect(focused).toEqual([{ recordId: 'g1' }, { timelineId: 't1', clipId: 'cl1' }]) })
  })

  it('undoes and redoes by moving the current position; redo is enabled while a step lies after it', async () => {
    const { view, writes } = mount(ENTRIES, (state) => { state.tip = 'later' })
    await waitFor(() => { expect(view.getByTestId('dv-history-redo')).toHaveProperty('disabled', false) })
    fireEvent.click(view.getByTestId('dv-history-undo'))
    fireEvent.click(view.getByTestId('dv-history-redo'))
    await waitFor(() => {
      expect(writes.filter(write => write.path !== '/api/dv/history')).toEqual([
        { path: '/api/dv/undo', body: { project: 'p1' } }, { path: '/api/dv/redo', body: { project: 'p1' } },
      ])
    })
  })

  it('greys a render step after the current one with a faded, black-and-white thumbnail', async () => {
    const { row } = mount(ENTRIES.map(entry => entry.record.id === 'g1' ? { ...entry, place: 'after' as const } : entry))
    await waitFor(() => { row('g1') })
    const thumb = row('g1').querySelector('[data-testid="dv-history-thumb"]')?.parentElement
    expect(thumb?.style.opacity).toBe('0.3')
    expect(thumb?.style.filter).toBe('grayscale(1)')
  })

  it('greys the steps after the current one and offers 回到这一步 on every other step', async () => {
    const after: HistoryEntry = { record: record({ id: 'a1', operation: 'timeline.rename', params: { timeline: 't1', name: 'x' } }), place: 'after' }
    const { writes, row } = mount([after, ...ENTRIES])
    await waitFor(() => { row('a1') })
    // The text is greyed; the ⋮ menu is not, so it opens above the next row. Rows other than renders have no thumbnail.
    const dimmed = (id: string): string[] => [...row(id).querySelectorAll<HTMLElement>('[style*="opacity"]')].map(element => element.style.opacity)
    expect(dimmed('a1')).toEqual(['0.3'])
    expect(row('a1').style.opacity).toBe('')
    expect(row('a1').getAttribute('data-place')).toBe('after')
    expect(row('a1').querySelector('[data-testid="dv-history-thumb"]')).toBeNull()
    expect(dimmed('m1')).toEqual(['1'])
    // The current step has no ⋮; a step before it and a step after it both have 回到这一步.
    expect(row('m1').querySelector('[data-testid="dv-history-step-actions"]')).toBeNull()
    expect(menuOf(row('g1'))).toEqual(['Go back to this step'])
    fireEvent.click(within(row('g1')).getByTestId('dv-history-step-back'))
    expect(menuOf(row('a1'))).toEqual(['Go back to this step'])
    fireEvent.click(within(row('a1')).getByTestId('dv-history-step-back'))
    await waitFor(() => {
      expect(writes.filter(write => write.path !== '/api/dv/history')).toEqual([
        { path: '/api/dv/undo', body: { project: 'p1', to: 'g1' } }, { path: '/api/dv/undo', body: { project: 'p1', to: 'a1' } },
      ])
    })
    // The menu's gesture does not select the row.
    expect(row('g1').getAttribute('aria-selected')).toBe('false')
  })

  it('says what to do when the project has no records', async () => {
    const { view } = mount([])
    await waitFor(() => { expect(view.getByTestId('dv-history-empty').textContent).toContain('No records yet') })
  })

  it('selects the record a tool call wrote when a dv:history-focus event arrives', async () => {
    const { row } = mount()
    await waitFor(() => { row('p1') })
    window.dispatchEvent(new CustomEvent(DV_HISTORY_FOCUS_EVENT, { detail: { session: 's5', toolCall: 'call-p1' } }))
    await waitFor(() => { expect(row('p1').getAttribute('aria-selected')).toBe('true') })
  })
})
