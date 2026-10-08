// @vitest-environment jsdom
/** The History panel over a scripted API: action rows, approval folds, selection, actions, the branch tree, and empty states. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { DvClient } from '@dv/ui-kit/api.ts'
import type { HistoryEntry, HistoryQuery, WireHistory, WireState } from '@dv/ui-kit/types.ts'
import { DV_CANVAS_FOCUS_EVENT, DV_HISTORY_FOCUS_EVENT, DV_TIMELINE_FOCUS_EVENT } from '@dv/ui-kit/workspace-events.ts'
import { asset, fixtureState, record, scriptedFetch } from '../../ui-kit/tests/fixture.client.tsx'
import { HistoryPanel } from '../src/client/HistoryPanel.tsx'

/**
 * Open a row's ⋮ menu.
 * @param element - a list row or a tree node.
 * @returns the labels of the menu's items.
 */
function menuOf(element: HTMLElement): string[] {
  fireEvent.click(within(element).getByTestId('dv-history-step-actions'))
  return within(element).getAllByRole('menuitem').map(item => item.textContent ?? '')
}

// jsdom lays nothing out and has no scrollIntoView; the panel's scroll requests are recorded instead.
const scrolled = vi.fn()
Element.prototype.scrollIntoView = scrolled

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ENTRIES: HistoryEntry[] = [
  {
    record: record({ id: 'm1', turn: null, surface: 'timeline', operation: 'timeline.clip_move', params: { clip: 'cl1', to: 2 }, intent: 'move clip 1' }),
    mark: 'current', branches: ['main'],
  },
  {
    record: record({
      id: 'g1', turn: 't3', actor: 'agent', session: 's5', tool_call: 'call-g1', operation: 'shot.render_ref2va', outputs: ['shot1.mp4'],
      intent: 'render the hero',
      inputs: [{ role: 'reference', ref: { asset: 'ref.png' }, resolved_asset: 'ref.png' }],
    }),
    mark: 'current', branches: ['main'],
  },
  { record: record({ id: 'p1', turn: 't3', actor: 'agent', session: 's5', tool_call: 'call-p1', operation: 'plan.create' }), mark: 'redo', branches: ['main'] },
]

/**
 * Mount the panel over scripted routes; `/api/dv/history` answers from {@link ENTRIES}.
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
      if (path !== '/api/dv/history') {
        const branch = { name: 'b3', title: null, head: 'b1', base: 'main', forked_at: 's1', tip: 'b1' }
        return { status: 200, body: { record: record({ id: 'b1' }), branch, heads: { main: 'b1' } } }
      }
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
  const view = render(<HistoryPanel projectId="p1" session="s5" client={new DvClient(scripted.fetch)} />)
  const row = (id: string): HTMLElement => {
    const element = view.container.querySelector(`[data-testid="dv-history-row"][data-record="${id}"]`)
    if (!(element instanceof HTMLElement)) throw new Error(`no row ${id}`)
    return element
  }
  return { view, writes: scripted.writes, queries, row }
}

describe('HistoryPanel', () => {
  it('shows one row per operation record of the current branch, newest first, with who, the agent\'s intent and one thumbnail', async () => {
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
    expect(row('g1').getAttribute('data-actor')).toBe('agent')
    // A step that redo brings back is greyed, without a badge.
    expect(row('p1').getAttribute('data-mark')).toBe('redo')
    expect(row('p1').style.opacity).toBe('0.55')
    expect(row('g1').querySelectorAll('[data-testid="dv-history-thumb"]').length).toBe(1)
    // A plan's JSON file has no thumbnail.
    expect(row('p1').querySelector('[data-testid="dv-history-thumb"]')).toBeNull()
  })

  it('folds the renders a plan approval scheduled under its row until the toggle opens them', async () => {
    const approval: HistoryEntry[] = [
      { record: record({ id: 'g2', actor: 'system', operation: 'shot.render_ref2va', params: { plan: 'p1', shot: 2 }, status: 'running' }), mark: 'current', branches: ['main'] },
      { record: record({ id: 'g1', actor: 'system', operation: 'shot.render_ref2va', params: { plan: 'p1', shot: 1 }, outputs: ['shot1.mp4'] }), mark: 'current', branches: ['main'] },
      {
        record: record({ id: 'ap', actor: 'agent', operation: 'plan.approve', params: { plan: 'p1' }, report: { plan: 'p1', version: 1, scheduled: ['g1', 'g2'] } }),
        mark: 'current', branches: ['main'],
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

  it('asks for the current branch\'s line', async () => {
    const { queries } = mount()
    await waitFor(() => { expect(queries.at(0)).toEqual({ project: 'p1', marks: ['current', 'redo'], limit: 50 }) })
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

  it('undoes, and redoes while the current branch has steps to bring back, with surface history', async () => {
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

  it('marks the current step, offers 回到这一步 on the steps before it and 从这里新建分支 on every step, and greys the steps redo brings back', async () => {
    const current: HistoryEntry = { record: record({ id: 'g3', session: 's5', operation: 'shot.render_ref2va' }), mark: 'current', branches: ['main'] }
    const { writes, row } = mount([current, ...ENTRIES], (state) => {
      state.components.proj.records = state.components.proj.records.filter(item => item.id !== 'p1')
      state.redo_steps = ['p1']
    })
    await waitFor(() => { row('p1') })
    expect(row('g3').getAttribute('data-step')).toBe('current')
    expect(row('g3').querySelector('[data-testid="dv-history-current"]')?.textContent).toBe('Current')
    expect(menuOf(row('g3'))).toEqual(['New branch from here'])
    expect(row('p1').getAttribute('data-step')).toBe('after')
    expect(row('p1').style.opacity).toBe('0.55')
    expect(menuOf(row('p1'))).toEqual(['New branch from here'])
    // A record off the current branch's chain is no step of it.
    expect(row('m1').hasAttribute('data-step')).toBe(false)
    expect(row('g1').getAttribute('data-step')).toBe('before')
    expect(menuOf(row('g1'))).toEqual(['Go back to this step', 'New branch from here'])
    fireEvent.click(within(row('g1')).getByTestId('dv-history-step-back'))
    fireEvent.click(within(row('g1')).getByTestId('dv-history-step-actions'))
    fireEvent.click(within(row('g1')).getByTestId('dv-history-step-fork'))
    await waitFor(() => {
      expect(writes.filter(write => write.path !== '/api/dv/history')).toEqual([
        { path: '/api/dv/undo', body: { project: 'p1', surface: 'history', session: 's5', to: 'g1' } },
        { path: '/api/dv/branches/create', body: { project: 'p1', surface: 'history', branch: 'main', to: 'g1' } },
      ])
    })
    // The menu's gestures do not select the row.
    expect(row('g1').getAttribute('aria-selected')).toBe('false')
  })

  it('draws every branch as a lane in the branch tree, selects a clicked step, and moves the head with 回到这一步', async () => {
    // The fixture's b2 forked from main at x1; r3 is its own step.
    const tree: HistoryEntry[] = [
      { record: record({ id: 'r3', branch: 'b2', operation: 'shot.render_ref2va' }), mark: 'branch', branches: ['b2'] },
      { record: record({ id: 'y1', operation: 'timeline.clip_move' }), mark: 'current', branches: ['main'] },
      { record: record({ id: 'x1', operation: 'asset.grab_still', outputs: ['export-last.png'] }), mark: 'current', branches: ['main', 'b2'] },
      { record: record({ id: 'u1', operation: 'proj.undo' }), mark: 'current', branches: ['main'] },
    ]
    // y1 is the newest step of main, the current branch, so it is the head step.
    const { view, queries, writes } = mount(tree, (state) => { state.components.proj.records.push(record({ id: 'y1', operation: 'timeline.clip_move' })) })
    await waitFor(() => { expect(queries.length).toBeGreaterThan(0) })
    scrolled.mockClear()
    fireEvent.click(within(view.getByTestId('dv-history-view-toggle')).getByRole('tab', { name: 'Branch tree' }))
    await waitFor(() => { expect(view.getAllByTestId('dv-history-tree-node')).toHaveLength(3) })
    expect(within(view.getByTestId('dv-history-view-toggle')).getByRole('tab', { name: 'Branch tree' }).getAttribute('aria-selected')).toBe('true')
    expect(queries.at(-1)).toEqual({ project: 'p1', marks: ['current', 'redo', 'branch'], limit: 50 })
    const node = (id: string): HTMLElement => view.container.querySelector(`[data-testid="dv-history-tree-node"][data-record="${id}"]`) as HTMLElement
    expect([node('r3'), node('y1'), node('x1')].map(element => element.getAttribute('data-lane'))).toEqual(['1', '0', '0'])
    // b2's newest step carries its label; b2's lane bends into x1, the step it forked at.
    expect(within(node('r3')).getByTestId('dv-history-tree-branch').textContent).toBe('Branch 2')
    expect(node('r3').textContent).toBe('Branch 2Render shot from references')
    expect(node('x1').querySelectorAll('path')).toHaveLength(1)
    // The head step carries 当前 and the current branch's label, and the tree scrolls it into view.
    expect(node('y1').getAttribute('data-head')).toBe('true')
    expect(within(node('y1')).getByTestId('dv-history-tree-current').textContent).toBe('Current')
    expect(within(node('y1')).getByTestId('dv-history-tree-branch').textContent).toBe('Main')
    await waitFor(() => { expect(scrolled).toHaveBeenCalledWith({ block: 'center' }) })
    // A click selects a step and writes nothing; 回到这一步 in a step's ⋮ menu moves the head there, and the head step
    // offers only 从这里新建分支.
    fireEvent.click(node('r3'))
    expect(node('r3').getAttribute('aria-selected')).toBe('true')
    expect(writes.filter(write => write.path !== '/api/dv/history')).toEqual([])
    expect(menuOf(node('y1'))).toEqual(['New branch from here'])
    fireEvent.keyDown(within(node('y1')).getByRole('menu'), { key: 'Escape' })
    expect(menuOf(node('r3'))).toEqual(['Go back to this step', 'New branch from here'])
    fireEvent.click(within(node('r3')).getByTestId('dv-history-step-back'))
    menuOf(node('x1'))
    fireEvent.click(within(node('x1')).getByTestId('dv-history-step-back'))
    await waitFor(() => {
      expect(writes.filter(write => write.path !== '/api/dv/history')).toEqual([
        { path: '/api/dv/branches/switch', body: { project: 'p1', branch: 'b2', surface: 'history', to: 'r3', session: 's5' } },
        { path: '/api/dv/branches/switch', body: { project: 'p1', branch: 'main', surface: 'history', to: 'x1', session: 's5' } },
      ])
    })
    fireEvent.click(within(view.getByTestId('dv-history-view-toggle')).getByRole('tab', { name: 'List' }))
    await waitFor(() => { expect(view.queryByTestId('dv-history-tree')).toBeNull() })
  })

  it('switches, forks and renames branches from the branch menu of the header, with surface history', async () => {
    const { view, writes } = mount()
    const menu = within(view.getByTestId('dv-kit-branch-menu'))
    const button = await waitFor(() => menu.getByRole('button', { name: 'Main' }))
    fireEvent.click(button)
    fireEvent.click(menu.getAllByTestId('dv-kit-branch-option')[1] as HTMLElement)
    fireEvent.click(button)
    fireEvent.click(menu.getByTestId('dv-kit-branch-create'))
    fireEvent.click(menu.getByRole('button', { name: 'Rename Main' }))
    fireEvent.change(menu.getByTestId('dv-kit-branch-name'), { target: { value: 'night' } })
    fireEvent.keyDown(menu.getByTestId('dv-kit-branch-name'), { key: 'Enter' })
    await waitFor(() => { expect(writes.filter(write => write.path.startsWith('/api/dv/branches/'))).toHaveLength(3) })
    expect(writes.filter(write => write.path.startsWith('/api/dv/branches/'))).toEqual([
      { path: '/api/dv/branches/switch', body: { project: 'p1', branch: 'b2', surface: 'history' } },
      { path: '/api/dv/branches/create', body: { project: 'p1', surface: 'history' } },
      { path: '/api/dv/branches/rename', body: { project: 'p1', branch: 'main', title: 'night' } },
    ])
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
