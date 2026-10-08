// @vitest-environment jsdom
/** The branch bar (project selection, undo, new projects) and the branch menu of the bottom bar and the History panel. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { BranchBar } from '../src/client/BranchBar.tsx'
import type { BranchBarLabels, BranchBarProps } from '../src/client/BranchBar.tsx'
import { BranchMenu } from '../src/client/BranchMenu.tsx'
import type { BranchMenuProps } from '../src/client/BranchMenu.tsx'
import type { WireState } from '../src/client/types.ts'
import { fixtureState, PROJECT } from './fixture.client.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const labels: BranchBarLabels = { project: 'project', undo: 'undo', newProject: 'new project', newProjectPrompt: 'title?', noProject: 'none' }

function mount(overrides: Partial<BranchBarProps> = {}) {
  const props: BranchBarProps = {
    projects: [PROJECT, { ...PROJECT, id: 'p2', title: 'Other' }], project: 'p1', labels,
    onProject: vi.fn(), onUndo: vi.fn(),
    onCreate: vi.fn(),
    ...overrides,
  }
  const view = render(<BranchBar {...props} />)
  return { props, view, bar: within(view.getByTestId('dv-kit-branch-bar')) }
}

describe('BranchBar', () => {
  it('lists projects, and reports selection changes and undo', () => {
    const { props, bar } = mount()
    const project = bar.getByLabelText('project')
    expect([...project.querySelectorAll('option')].map(option => option.textContent)).toEqual(['Demo', 'Other'])
    fireEvent.change(project, { target: { value: 'p2' } })
    expect(props.onProject).toHaveBeenCalledWith('p2')
    // The Sidebar bar has no branch controls: the branch menu of the bottom bar and the History panel owns them.
    expect(bar.queryByLabelText('Branch')).toBeNull()
    fireEvent.click(bar.getByText('undo'))
    expect(props.onUndo).toHaveBeenCalledOnce()
  })

  it('uses window.prompt by default and shows the placeholder before a project is chosen', () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('from-prompt')
    const { props, bar } = mount({ project: null })
    expect(bar.getByLabelText('project')).toHaveProperty('value', '')
    expect(bar.getByText('none')).toBeTruthy()
    expect(bar.getByText('undo')).toHaveProperty('disabled', true)
    fireEvent.click(bar.getByText('new project'))
    expect(prompt).toHaveBeenCalledWith('title?')
    expect(props.onCreate).toHaveBeenCalledWith('from-prompt')
    prompt.mockRestore()
  })

  it('asks for a project title and ignores an empty or cancelled answer', () => {
    const answers = ['', null, ' Demo 2 ']
    const ask = vi.fn(() => answers.shift() ?? null)
    const { props, bar } = mount({ ask })
    const button = bar.getByText('new project')
    fireEvent.click(button)
    fireEvent.click(button)
    expect(props.onCreate).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(props.onCreate).toHaveBeenCalledWith('Demo 2')
    expect(ask).toHaveBeenCalledWith('title?')
  })
})

/**
 * Mount the branch menu over a state, with spied gestures.
 * @param state - the project state.
 * @param overrides - props to replace.
 * @returns the gestures, the rendered menu, and a re-render with another state.
 */
function mountMenu(state: WireState | null, overrides: Partial<BranchMenuProps> = {}) {
  const props: BranchMenuProps = {
    state, side: 'top', onSwitch: vi.fn(), onCreate: vi.fn(() => Promise.resolve(null)), onRename: vi.fn(), ...overrides,
  }
  const view = render(<BranchMenu {...props} />)
  const menu = within(view.getByTestId('dv-kit-branch-menu'))
  const options = (): string[] => menu.queryAllByTestId('dv-kit-branch-option').map(option => option.getAttribute('data-branch') ?? '')
  return { props, view, menu, options, rerender: (next: WireState) => { view.rerender(<BranchMenu {...props} state={next} />) } }
}

/** A fixture state whose branches are `main`, the titled `b2` (night), and `b3`; `b3` is current. */
function threeBranches(): WireState {
  const state = fixtureState()
  const main = state.branches[0]
  if (main === undefined) throw new Error('fixture has no main branch')
  state.branches = [main, { ...main, name: 'b2', title: 'night', base: 'main' }, { ...main, name: 'b3', title: null, base: 'main' }]
  state.current = 'b3'
  return state
}

describe('BranchMenu', () => {
  it('names the current branch, lists it first, and switches only to another branch', () => {
    const { props, menu, options } = mountMenu(threeBranches())
    const button = menu.getByRole('button', { name: 'Branch 3' })
    expect(options()).toEqual([])
    fireEvent.click(button)
    expect(options()).toEqual(['b3', 'main', 'b2'])
    expect(menu.getAllByTestId('dv-kit-branch-option').map(option => option.getAttribute('aria-current'))).toEqual(['true', 'false', 'false'])
    fireEvent.click(menu.getAllByTestId('dv-kit-branch-option')[0] as HTMLElement)
    expect(props.onSwitch).not.toHaveBeenCalled()
    expect(options()).toEqual([])
    fireEvent.click(button)
    fireEvent.click(menu.getAllByTestId('dv-kit-branch-option')[2] as HTMLElement)
    expect(props.onSwitch).toHaveBeenCalledExactlyOnceWith('b2')
    expect(options()).toEqual([])
  })

  it('closes on Escape and on a click outside, and is disabled while the state loads', () => {
    const { menu, options } = mountMenu(fixtureState())
    fireEvent.click(menu.getByRole('button'))
    fireEvent.keyDown(menu.getByRole('dialog'), { key: 'Escape' })
    expect(options()).toEqual([])
    fireEvent.click(menu.getByRole('button'))
    fireEvent.pointerDown(document.body)
    expect(options()).toEqual([])
    cleanup()
    expect(mountMenu(null).menu.getByRole('button')).toHaveProperty('disabled', true)
  })

  it('renames a branch in place, refuses a name another branch shows, and writes nothing for an unchanged or cancelled name', () => {
    const { props, menu } = mountMenu(threeBranches())
    fireEvent.click(menu.getByRole('button'))
    fireEvent.click(menu.getByRole('button', { name: 'Rename night' }))
    const field = menu.getByTestId('dv-kit-branch-name')
    expect(field).toHaveProperty('value', 'night')
    fireEvent.change(field, { target: { value: ' main ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(menu.getByText('Name already used')).toBeTruthy()
    expect(field.getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(field, { target: { value: ' dusk ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(props.onRename).toHaveBeenCalledExactlyOnceWith('b2', 'dusk')
    // F2 on a row opens its name; the unchanged default label and Escape write nothing and keep the menu open.
    fireEvent.keyDown(menu.getAllByTestId('dv-kit-branch-option')[0] as HTMLElement, { key: 'F2' })
    expect(menu.getByTestId('dv-kit-branch-name')).toHaveProperty('value', 'Branch 3')
    fireEvent.keyDown(menu.getByTestId('dv-kit-branch-name'), { key: 'Enter' })
    fireEvent.click(menu.getByRole('button', { name: 'Rename Main' }))
    fireEvent.change(menu.getByTestId('dv-kit-branch-name'), { target: { value: 'day' } })
    fireEvent.keyDown(menu.getByTestId('dv-kit-branch-name'), { key: 'Escape' })
    expect(props.onRename).toHaveBeenCalledOnce()
    expect(menu.queryByTestId('dv-kit-branch-name')).toBeNull()
    expect(menu.getByRole('dialog')).toBeTruthy()
  })

  it('creates a branch at once and opens its default name for an optional rename', async () => {
    const state = fixtureState()
    const { props, menu, rerender } = mountMenu(state, { onCreate: vi.fn(() => Promise.resolve('b3')) })
    fireEvent.click(menu.getByRole('button'))
    await act(async () => { fireEvent.click(menu.getByTestId('dv-kit-branch-create')); await Promise.resolve() })
    expect(props.onCreate).toHaveBeenCalledOnce()
    const main = state.branches[0]
    if (main === undefined) throw new Error('fixture has no main branch')
    rerender({ ...state, branches: [...state.branches, { ...main, name: 'b3', title: null, base: 'main' }], current: 'b3' })
    const field = menu.getByTestId('dv-kit-branch-name')
    expect(field).toHaveProperty('value', 'Branch 3')
    fireEvent.change(field, { target: { value: 'night' } })
    fireEvent.blur(field)
    expect(props.onRename).toHaveBeenCalledExactlyOnceWith('b3', 'night')
  })

  it('shows a search field from eight branches that narrows the list', () => {
    const state = fixtureState()
    const main = state.branches[0]
    if (main === undefined) throw new Error('fixture has no main branch')
    state.branches = [main, ...[2, 3, 4, 5, 6, 7, 8].map(n => ({ ...main, name: `b${String(n)}`, title: n === 5 ? 'night' : null, base: 'main' }))]
    const { menu, options } = mountMenu(state)
    fireEvent.click(menu.getByRole('button'))
    const search = menu.getByLabelText('Find branch')
    fireEvent.change(search, { target: { value: 'NIG' } })
    expect(options()).toEqual(['b5'])
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(menu.getByText('No matching branch')).toBeTruthy()
    expect(menu.getByTestId('dv-kit-branch-create')).toBeTruthy()
  })
})
