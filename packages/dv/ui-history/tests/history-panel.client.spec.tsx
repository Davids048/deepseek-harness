// @vitest-environment jsdom
/** The History panel over a scripted API: action rows, approval folds, marks, filters, selection, actions, and empty states. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { DvClient } from '@dv/ui-kit/api.ts'
import type { HistoryEntry, HistoryQuery, WireHistory, WireState } from '@dv/ui-kit/types.ts'
import { DV_CANVAS_FOCUS_EVENT, DV_HISTORY_FOCUS_EVENT, DV_TIMELINE_FOCUS_EVENT } from '@dv/ui-kit/workspace-events.ts'
import { asset, fixtureState, record, scriptedFetch } from '../../ui-kit/tests/fixture.client.tsx'
import { HistoryPanel } from '../src/client/HistoryPanel.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ENTRIES: HistoryEntry[] = [
  { record: record({ id: 'm1', turn: null, surface: 'timeline', operation: 'timeline.clip_move', params: { clip: 'cl1', to: 2 }, intent: 'move clip 1' }), mark: 'main' },
  {
    record: record({
      id: 'g1', turn: 't3', actor: 'agent', session: 's5', tool_call: 'call-g1', branch: 'draft/s5', operation: 'shot.render_ref2va', outputs: ['shot1.mp4'],
      intent: 'render the hero',
      inputs: [{ role: 'reference', ref: { asset: 'ref.png' }, resolved_asset: 'ref.png' }],
    }),
    mark: 'main',
  },
  { record: record({ id: 'p1', turn: 't3', actor: 'agent', session: 's5', tool_call: 'call-p1', operation: 'plan.create' }), mark: 'undone' },
]

/**
 * Mount the panel over scripted routes; `/api/dv/history` answers from {@link ENTRIES} filtered by actor.
 * @param entries - the history the route serves.
 * @param adjust - changes to the fixture state that `/api/dv/state` serves for every branch.
 * @returns the rendered panel and the recorded writes.
 */
function mount(entries: HistoryEntry[] = ENTRIES, adjust: (state: WireState) => void = () => {}) {
  const queries: HistoryQuery[] = []
  const scripted = scriptedFetch({
    // Timeline `t1` of the fixture holds clips cl1 and cl2, assigned by its create record.
    state: () => {
      const state = fixtureState()
      state.components.proj.records = state.components.proj.records.map(item => item.id === 's1' ? { ...item, report: { clips: ['cl1', 'cl2'] } } : item)
      adjust(state)
      return state
    },
    post: (path, body) => {
      if (path !== '/api/dv/history') return { status: 200, body: { record: record({ id: 'b1' }), heads: { main: 'b1' } } }
      const query = body as HistoryQuery
      queries.push(query)
      const shown = entries.filter(entry => (query.actor === undefined || entry.record.actor === query.actor)
        && (query.tool_call === undefined || entry.record.tool_call === query.tool_call))
      const answer: WireHistory = {
        entries: shown,
        assets: [asset('shot1.mp4', 'video/mp4', 'g1', 4), asset('ref.png', 'image/png', null)],
      }
      return { status: 200, body: answer }
    },
  })
  const view = render(<HistoryPanel projectId="p1" session="s5" client={new DvClient(scripted.fetch)} />)
  const row = (id: string): HTMLElement => {
    const element = view.container.querySelector(`[data-testid="dv-history-row"][data-record="${id}"]`)
    if (!(element instanceof HTMLElement)) throw new Error(`no row ${id}`)
    return element
  }
  return { view, writes: scripted.writes, queries, row }
}

describe('HistoryPanel', () => {
  it('shows one row per operation record, newest first, with who, the agent\'s intent, the marks and one thumbnail', async () => {
    const { view, row } = mount()
    await waitFor(() => { expect(view.container.querySelectorAll('[data-testid="dv-history-row"]').length).toBe(3) })
    const ids = [...view.container.querySelectorAll('[data-testid="dv-history-row"]')].map(element => element.getAttribute('data-record'))
    expect(ids).toEqual(['m1', 'g1', 'p1'])
    expect(view.container.querySelector('[data-testid="dv-history-turn"]')).toBeNull()
    expect(row('g1').textContent).toContain('render the hero')
    expect(row('g1').textContent).toContain('Agent')
    expect(row('m1').textContent).toContain('Move clip')
    expect(row('m1').textContent).toContain('You')
    expect(row('m1').textContent).not.toContain('render the hero')
    expect(row('g1').textContent).toContain('Accepted')
    expect(row('g1').getAttribute('data-actor')).toBe('agent')
    expect(row('p1').getAttribute('data-mark')).toBe('undone')
    expect(row('p1').textContent).toContain('Undone')
    expect(row('g1').querySelectorAll('[data-testid="dv-history-thumb"]').length).toBe(1)
    // A plan's JSON file has no thumbnail.
    expect(row('p1').querySelector('[data-testid="dv-history-thumb"]')).toBeNull()
  })

  it('folds the renders a plan approval scheduled under its row until the toggle opens them', async () => {
    const approval: HistoryEntry[] = [
      { record: record({ id: 'g2', actor: 'system', operation: 'shot.render_ref2va', params: { plan: 'p1', shot: 2 }, status: 'running' }), mark: 'main' },
      { record: record({ id: 'g1', actor: 'system', operation: 'shot.render_ref2va', params: { plan: 'p1', shot: 1 }, outputs: ['shot1.mp4'] }), mark: 'main' },
      { record: record({ id: 'ap', actor: 'agent', operation: 'plan.approve', params: { plan: 'p1' }, report: { plan: 'p1', version: 1, scheduled: ['g1', 'g2'] } }), mark: 'main' },
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

  it('sends the filters as query fields', async () => {
    const { view, queries } = mount()
    await waitFor(() => { expect(queries.length).toBeGreaterThan(0) })
    fireEvent.change(view.getByTestId('dv-history-filter-actor'), { target: { value: 'agent' } })
    fireEvent.change(view.getByTestId('dv-history-filter-branch'), { target: { value: 'main' } })
    fireEvent.change(view.getByTestId('dv-history-filter-component'), { target: { value: 'shot' } })
    await waitFor(() => {
      expect(queries.at(-1)).toEqual({ project: 'p1', actor: 'agent', marks: ['main', 'undone'], component: 'shot', limit: 50 })
    })
  })

  it('selecting a render row plays its output and focuses its node; a clip row focuses the timeline clip', async () => {
    const { row } = mount()
    await waitFor(() => { row('g1') })
    const focused: unknown[] = []
    const onCanvas = (event: Event): void => { focused.push((event as CustomEvent).detail) }
    const onTimeline = (event: Event): void => { focused.push((event as CustomEvent).detail) }
    window.addEventListener(DV_CANVAS_FOCUS_EVENT, onCanvas)
    window.addEventListener(DV_TIMELINE_FOCUS_EVENT, onTimeline)
    fireEvent.click(row('g1'))
    expect(row('g1').getAttribute('aria-selected')).toBe('true')
    expect(row('g1').querySelector('[data-testid="dv-history-preview"] video')).not.toBeNull()
    fireEvent.click(row('m1'))
    fireEvent.click(row('p1'))
    window.removeEventListener(DV_CANVAS_FOCUS_EVENT, onCanvas)
    window.removeEventListener(DV_TIMELINE_FOCUS_EVENT, onTimeline)
    expect(focused).toEqual([{ recordId: 'g1' }, { timelineId: 't1', clipId: 'cl1' }])
  })

  it('undoes, and redoes while the working branch has steps to bring back, with surface history', async () => {
    const { view, writes } = mount(ENTRIES, (state) => { state.redo_steps = ['p1'] })
    await waitFor(() => { expect(view.getByTestId('dv-history-redo').hasAttribute('disabled')).toBe(false) })
    fireEvent.click(view.getByTestId('dv-history-undo'))
    fireEvent.click(view.getByTestId('dv-history-redo'))
    await waitFor(() => {
      expect(writes.filter(write => write.path !== '/api/dv/history')).toEqual([
        { path: '/api/dv/undo', body: { project: 'p1', surface: 'history', session: 's5' } },
        { path: '/api/dv/redo', body: { project: 'p1', surface: 'history', session: 's5' } },
      ])
    })
  })

  it('marks the current step, offers 回到这一步 on the steps before it, and greys the steps redo brings back', async () => {
    const current: HistoryEntry = { record: record({ id: 'g3', branch: 'draft/s5', session: 's5', operation: 'shot.render_ref2va' }), mark: 'draft' }
    const { writes, row } = mount([current, ...ENTRIES], (state) => {
      state.components.proj.records = state.components.proj.records.filter(item => item.id !== 'p1')
      state.redo_steps = ['p1']
    })
    await waitFor(() => { row('p1') })
    expect(row('g3').getAttribute('data-step')).toBe('current')
    expect(row('g3').querySelector('[data-testid="dv-history-current"]')?.textContent).toBe('Current')
    expect(row('g3').querySelector('[data-testid="dv-history-jump"]')).toBeNull()
    expect(row('p1').getAttribute('data-step')).toBe('after')
    expect(row('p1').style.opacity).toBe('0.55')
    expect(row('p1').querySelector('[data-testid="dv-history-jump"]')).toBeNull()
    // A record off the working branch is no step of it.
    expect(row('m1').hasAttribute('data-step')).toBe(false)
    expect(row('g1').getAttribute('data-step')).toBe('before')
    const jump = row('g1').querySelector('[data-testid="dv-history-jump"]')
    expect(jump?.textContent).toBe('Go back to this step')
    fireEvent.click(jump as HTMLElement)
    await waitFor(() => {
      expect(writes.filter(write => write.path !== '/api/dv/history')).toEqual([
        { path: '/api/dv/undo', body: { project: 'p1', surface: 'history', session: 's5', to: 'g1' } },
      ])
    })
    // The jump does not select the row.
    expect(row('g1').getAttribute('aria-selected')).toBe('false')
  })

  it('says what to do when the project has no records, and when the filters match none', async () => {
    const { view } = mount([])
    await waitFor(() => { expect(view.getByTestId('dv-history-empty').textContent).toContain('No records yet') })
    fireEvent.change(view.getByTestId('dv-history-filter-actor'), { target: { value: 'user' } })
    await waitFor(() => { expect(view.getByTestId('dv-history-empty').textContent).toContain('No records match the filters') })
  })

  it('selects the record a tool call wrote when a dv:history-focus event arrives', async () => {
    const { row } = mount()
    await waitFor(() => { row('p1') })
    window.dispatchEvent(new CustomEvent(DV_HISTORY_FOCUS_EVENT, { detail: { session: 's5', toolCall: 'call-p1' } }))
    await waitFor(() => { expect(row('p1').getAttribute('aria-selected')).toBe('true') })
  })
})
