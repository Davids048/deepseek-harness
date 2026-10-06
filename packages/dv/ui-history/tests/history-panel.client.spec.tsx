// @vitest-environment jsdom
/** The History panel over a scripted API: rows and turn groups, marks, filters, selection, actions, and empty states. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { DvClient } from '@dv/ui-kit/api.ts'
import type { HistoryEntry, HistoryQuery, WireHistory } from '@dv/ui-kit/types.ts'
import { DV_CANVAS_FOCUS_EVENT, DV_HISTORY_FOCUS_EVENT, DV_TIMELINE_FOCUS_EVENT } from '@dv/ui-kit/workspace-events.ts'
import { asset, fixtureState, record, scriptedFetch } from '../../ui-kit/tests/fixture.client.tsx'
import { HistoryPanel } from '../src/client/HistoryPanel.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ENTRIES: HistoryEntry[] = [
  { record: record({ id: 'm1', turn: null, surface: 'timeline', operation: 'timeline.clip_move', params: { clip: 'cl1', to: 2 }, intent: 'move clip 1' }), mark: 'main' },
  {
    record: record({
      id: 'g1', turn: 't3', actor: 'agent', session: 's5', tool_call: 'call-g1', branch: 'draft/s5', operation: 'shot.render', outputs: ['shot1.mp4'],
      inputs: [{ role: 'reference', ref: { asset: 'ref.png' }, resolved_asset: 'ref.png' }],
    }),
    mark: 'main',
  },
  { record: record({ id: 'p1', turn: 't3', actor: 'agent', session: 's5', tool_call: 'call-p1', operation: 'plan.create' }), mark: 'undone' },
  { record: record({ id: 'r3', turn: 't3', kind: 'request', intent: 'render the hero' }), mark: 'main' },
]

/**
 * Mount the panel over scripted routes; `/api/dv/history` answers from {@link ENTRIES} filtered by actor.
 * @param entries - the history the route serves.
 * @returns the rendered panel and the recorded writes.
 */
function mount(entries: HistoryEntry[] = ENTRIES) {
  const queries: HistoryQuery[] = []
  const scripted = scriptedFetch({
    // Timeline `t1` of the fixture holds clips cl1 and cl2, assigned by its create record.
    state: () => {
      const state = fixtureState()
      state.components.proj.records = state.components.proj.records.map(item => item.id === 's1' ? { ...item, report: { clips: ['cl1', 'cl2'] } } : item)
      return state
    },
    post: (path, body) => {
      if (path !== '/api/dv/history') return { status: 200, body: { record: record({ id: 'b1' }), heads: { main: 'b1' } } }
      const query = body as HistoryQuery
      queries.push(query)
      const shown = entries.filter(entry => (query.actor === undefined || entry.record.actor === query.actor)
        && (query.tool_call === undefined || entry.record.tool_call === query.tool_call))
      const answer: WireHistory = {
        entries: shown, requests: { t3: record({ id: 'r3', turn: 't3', kind: 'request', intent: 'render the hero' }) },
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
  it('shows one row per operation record, newest first, with the turn\'s request as its heading and the marks', async () => {
    const { view, row } = mount()
    await waitFor(() => { expect(view.container.querySelectorAll('[data-testid="dv-history-row"]').length).toBe(3) })
    const ids = [...view.container.querySelectorAll('[data-testid="dv-history-row"]')].map(element => element.getAttribute('data-record'))
    expect(ids).toEqual(['m1', 'g1', 'p1'])
    const turn = view.container.querySelector('[data-testid="dv-history-turn"]')
    expect(turn?.getAttribute('data-turn')).toBe('t3')
    expect(turn?.textContent).toContain('render the hero')
    expect(row('m1').textContent).toContain('Move clip')
    expect(row('g1').textContent).toContain('Accepted')
    expect(row('g1').getAttribute('data-actor')).toBe('agent')
    expect(row('p1').getAttribute('data-mark')).toBe('undone')
    expect(row('p1').textContent).toContain('Undone')
    expect(row('g1').querySelectorAll('img, video').length).toBe(2)
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

  it('undoes and redoes with surface history', async () => {
    const { view, writes } = mount()
    await waitFor(() => { view.getByText('Undo') })
    fireEvent.click(view.getByText('Undo'))
    fireEvent.click(view.getByText('Redo'))
    await waitFor(() => {
      expect(writes.filter(write => write.path !== '/api/dv/history')).toEqual([
        { path: '/api/dv/undo', body: { project: 'p1', surface: 'history', session: 's5' } },
        { path: '/api/dv/redo', body: { project: 'p1', surface: 'history', session: 's5' } },
      ])
    })
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
