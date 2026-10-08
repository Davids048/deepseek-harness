// @vitest-environment jsdom
/** The branch bar and the branch switcher: project selection, switching, forking and renaming branches, undo, and new projects. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { BranchBar } from '../src/client/BranchBar.tsx'
import type { BranchBarLabels, BranchBarProps } from '../src/client/BranchBar.tsx'
import { BranchSwitcher } from '../src/client/BranchSwitcher.tsx'
import { fixtureState, PROJECT } from './fixture.client.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const labels: BranchBarLabels = { project: 'project', undo: 'undo', newProject: 'new project', newProjectPrompt: 'title?', noProject: 'none' }

function mount(overrides: Partial<BranchBarProps> = {}) {
  const props: BranchBarProps = {
    projects: [PROJECT, { ...PROJECT, id: 'p2', title: 'Other' }], project: 'p1', state: fixtureState(), labels,
    onProject: vi.fn(), branches: { onSwitch: vi.fn(), onCreate: vi.fn(), onRename: vi.fn() }, onUndo: vi.fn(),
    onCreate: vi.fn(),
    ...overrides,
  }
  const view = render(<BranchBar {...props} />)
  return { props, view, bar: within(view.getByTestId('dv-kit-branch-bar')) }
}

describe('BranchBar', () => {
  it('lists projects and branches, and reports selection changes', () => {
    const { props, bar } = mount()
    const project = bar.getByLabelText('project')
    expect([...project.querySelectorAll('option')].map(option => option.textContent)).toEqual(['Demo', 'Other'])
    fireEvent.change(project, { target: { value: 'p2' } })
    expect(props.onProject).toHaveBeenCalledWith('p2')
    const branch = bar.getByLabelText('Branch')
    expect([...branch.querySelectorAll('option')].map(option => [option.value, option.textContent])).toEqual([['main', 'Main'], ['b2', 'Branch 2']])
    fireEvent.change(branch, { target: { value: 'b2' } })
    expect(props.branches.onSwitch).toHaveBeenCalledWith('b2')
    fireEvent.click(bar.getByText('undo'))
    expect(props.onUndo).toHaveBeenCalledOnce()
  })

  it('uses window.prompt by default and shows the placeholder before a project is chosen', () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('from-prompt')
    const { props, bar } = mount({ project: null, state: null })
    expect(bar.getByLabelText('project')).toHaveProperty('value', '')
    expect(bar.getByText('none')).toBeTruthy()
    expect(bar.getByLabelText('Branch')).toHaveProperty('disabled', true)
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
