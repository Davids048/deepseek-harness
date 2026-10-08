// @vitest-environment jsdom
/** The branch bar (project selection, undo, new projects), the branch switcher of the History panel, and the bottom bar's branch button. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { BranchBar } from '../src/client/BranchBar.tsx'
import type { BranchBarLabels, BranchBarProps } from '../src/client/BranchBar.tsx'
import { BranchStatus } from '../src/client/BranchStatus.tsx'
import { BranchSwitcher } from '../src/client/BranchSwitcher.tsx'
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
    // The Sidebar bar has no branch controls: the bottom bar and the History panel own them.
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

describe('BranchSwitcher', () => {
  it('shows the current branch, switches only to another branch, forks, and renames the current branch', () => {
    const state = { ...fixtureState(), current: 'b2' }
    state.branches = state.branches.map(branch => branch.name === 'b2' ? { ...branch, title: 'night' } : branch)
    const onSwitch = vi.fn()
    const onCreate = vi.fn()
    const onRename = vi.fn()
    const answers: Array<string | null> = [null, ' dusk ']
    const ask = vi.fn((_message: string, _initial: string) => answers.shift() ?? null)
    const view = render(<BranchSwitcher state={state} onSwitch={onSwitch} onCreate={onCreate} onRename={onRename} ask={ask} />)
    const switcher = within(view.getByTestId('dv-kit-branch-switcher'))
    const select = switcher.getByLabelText('Branch')
    expect(select).toHaveProperty('value', 'b2')
    expect([...select.querySelectorAll('option')].map(option => option.textContent)).toEqual(['Main', 'night'])
    fireEvent.change(select, { target: { value: 'b2' } })
    expect(onSwitch).not.toHaveBeenCalled()
    fireEvent.change(select, { target: { value: 'main' } })
    expect(onSwitch).toHaveBeenCalledWith('main')
    fireEvent.click(switcher.getByText('New branch'))
    expect(onCreate).toHaveBeenCalledOnce()
    fireEvent.click(switcher.getByText('Rename'))
    fireEvent.click(switcher.getByText('Rename'))
    expect(ask).toHaveBeenCalledWith('Branch name', 'night')
    expect(onRename).toHaveBeenCalledExactlyOnceWith('b2', 'dusk')
  })

  it('disables its controls while the state loads and asks through window.prompt by default', () => {
    const empty = render(<BranchSwitcher state={null} onSwitch={vi.fn()} onCreate={vi.fn()} onRename={vi.fn()} />)
    expect(empty.getByText('New branch')).toHaveProperty('disabled', true)
    expect(empty.getByText('Rename')).toHaveProperty('disabled', true)
    cleanup()
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('kept')
    const onRename = vi.fn()
    const view = render(<BranchSwitcher state={fixtureState()} onSwitch={vi.fn()} onCreate={vi.fn()} onRename={onRename} />)
    fireEvent.click(view.getByText('Rename'))
    expect(prompt).toHaveBeenCalledWith('Branch name', '')
    expect(onRename).toHaveBeenCalledWith('main', 'kept')
  })
})

describe('BranchStatus', () => {
  it('names the current branch, opens the branch list on a click, and switches only to another branch', () => {
    const onSwitch = vi.fn()
    const view = render(<BranchStatus state={{ ...fixtureState(), current: 'b2' }} onSwitch={onSwitch} />)
    const status = within(view.getByTestId('dv-kit-branch-status'))
    const button = status.getByRole('button', { name: 'Current branch: Branch 2' })
    expect(status.queryAllByTestId('dv-kit-branch-option')).toHaveLength(0)
    fireEvent.click(button)
    const options = status.getAllByTestId('dv-kit-branch-option')
    expect(options.map(option => [option.getAttribute('data-branch'), option.getAttribute('aria-selected')])).toEqual([['main', 'false'], ['b2', 'true']])
    fireEvent.click(options[1] as HTMLElement)
    expect(onSwitch).not.toHaveBeenCalled()
    expect(status.queryAllByTestId('dv-kit-branch-option')).toHaveLength(0)
    fireEvent.click(button)
    fireEvent.click(status.getAllByTestId('dv-kit-branch-option')[0] as HTMLElement)
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith('main')
  })

  it('closes the list on Escape and on a click outside, and is disabled while the state loads', () => {
    const view = render(<BranchStatus state={fixtureState()} onSwitch={vi.fn()} />)
    const status = within(view.getByTestId('dv-kit-branch-status'))
    fireEvent.click(status.getByRole('button'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(status.queryAllByTestId('dv-kit-branch-option')).toHaveLength(0)
    fireEvent.click(status.getByRole('button'))
    fireEvent.pointerDown(document.body)
    expect(status.queryAllByTestId('dv-kit-branch-option')).toHaveLength(0)
    cleanup()
    expect(render(<BranchStatus state={null} onSwitch={vi.fn()} />).getByRole('button')).toHaveProperty('disabled', true)
  })
})
