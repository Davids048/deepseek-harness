// @vitest-environment jsdom
/** The branch bar: project and branch selection, open drafts, undo, and new branches. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { BranchBar } from '../src/client/BranchBar.tsx'
import type { BranchBarLabels, BranchBarProps } from '../src/client/BranchBar.tsx'
import { fixtureState, PROJECT } from './fixture.client.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const labels: BranchBarLabels = {
  project: 'project', branch: 'branch', accept: 'accept', reject: 'reject', undo: 'undo', newBranch: 'new branch',
  newBranchPrompt: 'name?', newProject: 'new project', newProjectPrompt: 'title?', draftTitle: 'draft', noProject: 'none',
}

function mount(overrides: Partial<BranchBarProps> = {}) {
  const props: BranchBarProps = {
    projects: [PROJECT, { ...PROJECT, projectId: 'p2', title: 'Other' }], project: 'p1', state: fixtureState(), head: 'main', labels,
    onProject: vi.fn(), onHead: vi.fn(), onAccept: vi.fn(), onReject: vi.fn(), onUndo: vi.fn(), onBranch: vi.fn(), onCreate: vi.fn(),
    ...overrides,
  }
  const view = render(<BranchBar {...props} />)
  return { props, view, bar: within(view.getByTestId('vh-branch-bar')) }
}

describe('BranchBar', () => {
  it('lists projects and branches, and reports selection changes', () => {
    const { props, bar } = mount()
    const project = bar.getByLabelText('project')
    expect([...project.querySelectorAll('option')].map(option => option.textContent)).toEqual(['Demo', 'Other'])
    fireEvent.change(project, { target: { value: 'p2' } })
    expect(props.onProject).toHaveBeenCalledWith('p2')
    const branch = bar.getByLabelText('branch')
    expect([...branch.querySelectorAll('option')].map(option => option.value)).toEqual(['main', 'style-b', 'draft/t5', 'draft/t6'])
    fireEvent.change(branch, { target: { value: 'style-b' } })
    expect(props.onHead).toHaveBeenCalledWith('style-b')
    fireEvent.click(bar.getByText('undo'))
    expect(props.onUndo).toHaveBeenCalledOnce()
  })

  it('shows one chip per open draft with accept and reject', () => {
    const { props, bar } = mount()
    expect(bar.getAllByText('draft')).toHaveLength(1)
    fireEvent.click(bar.getByText('accept'))
    fireEvent.click(bar.getByText('reject'))
    expect(props.onAccept).toHaveBeenCalledWith('t5')
    expect(props.onReject).toHaveBeenCalledWith('t5')
  })

  it('asks for a branch name and ignores an empty or cancelled answer', () => {
    const answers = ['  ', null, ' alt ']
    const ask = vi.fn(() => answers.shift() ?? null)
    const { props, bar } = mount({ ask })
    const button = bar.getByText('new branch')
    fireEvent.click(button)
    fireEvent.click(button)
    expect(props.onBranch).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(props.onBranch).toHaveBeenCalledWith('alt', 'main')
    expect(ask).toHaveBeenCalledWith('name?')
  })

  it('uses window.prompt by default and shows the placeholder before a project is chosen', () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('from-prompt')
    const { props, bar } = mount({ project: null, state: null })
    expect(bar.getByLabelText('project')).toHaveProperty('value', '')
    expect(bar.getByText('none')).toBeTruthy()
    expect([...bar.getByLabelText('branch').querySelectorAll('option')].map(option => option.value)).toEqual(['main'])
    expect(bar.getByText('undo')).toHaveProperty('disabled', true)
    expect(bar.getByText('new branch')).toHaveProperty('disabled', true)
    fireEvent.click(bar.getByText('new project'))
    expect(prompt).toHaveBeenCalledWith('title?')
    expect(props.onCreate).toHaveBeenCalledWith('from-prompt')
    prompt.mockRestore()
    cleanup()
    const { props: withProject, bar: ready } = mount()
    vi.spyOn(window, 'prompt').mockReturnValue('from-prompt')
    fireEvent.click(ready.getByText('new branch'))
    expect(withProject.onBranch).toHaveBeenCalledWith('from-prompt', 'main')
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
