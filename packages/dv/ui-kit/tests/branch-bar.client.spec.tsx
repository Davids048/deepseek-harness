// @vitest-environment jsdom
/** The branch bar: project and branch selection, open drafts, undo, and new projects. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { BranchBar } from '../src/client/BranchBar.tsx'
import type { BranchBarLabels, BranchBarProps } from '../src/client/BranchBar.tsx'
import { fixtureState, PROJECT } from './fixture.client.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const labels: BranchBarLabels = {
  project: 'project', branch: 'branch', accept: 'accept', discard: 'discard', undo: 'undo', newProject: 'new project',
  newProjectPrompt: 'title?', draftTitle: 'draft', noProject: 'none',
}

function mount(overrides: Partial<BranchBarProps> = {}) {
  const props: BranchBarProps = {
    projects: [PROJECT, { ...PROJECT, id: 'p2', title: 'Other' }], project: 'p1', state: fixtureState(), branch: 'main', labels,
    onProject: vi.fn(), onBranchSelect: vi.fn(), onAccept: vi.fn(), onDiscard: vi.fn(), onUndo: vi.fn(),
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
    const branch = bar.getByLabelText('branch')
    expect([...branch.querySelectorAll('option')].map(option => option.value)).toEqual(['main', 'draft/s5'])
    fireEvent.change(branch, { target: { value: 'draft/s5' } })
    expect(props.onBranchSelect).toHaveBeenCalledWith('draft/s5')
    fireEvent.click(bar.getByText('undo'))
    expect(props.onUndo).toHaveBeenCalledOnce()
  })

  it('shows one chip per open draft with accept and discard, addressed by branch', () => {
    const { props, bar } = mount()
    expect(bar.getAllByText('draft')).toHaveLength(1)
    fireEvent.click(bar.getByText('accept'))
    fireEvent.click(bar.getByText('discard'))
    expect(props.onAccept).toHaveBeenCalledWith('draft/s5')
    expect(props.onDiscard).toHaveBeenCalledWith('draft/s5')
  })

  it('uses window.prompt by default and shows the placeholder before a project is chosen', () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('from-prompt')
    const { props, bar } = mount({ project: null, state: null })
    expect(bar.getByLabelText('project')).toHaveProperty('value', '')
    expect(bar.getByText('none')).toBeTruthy()
    expect([...bar.getByLabelText('branch').querySelectorAll('option')].map(option => option.value)).toEqual(['main'])
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
