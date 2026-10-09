// @vitest-environment jsdom
/** The project and undo bar of the Sidebar views: project selection, undo, and new projects. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { ProjectBar } from '../src/client/ProjectBar.tsx'
import type { ProjectBarLabels, ProjectBarProps } from '../src/client/ProjectBar.tsx'
import { PROJECT } from './fixture.client.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const labels: ProjectBarLabels = { project: 'project', undo: 'undo', newProject: 'new project', newProjectPrompt: 'title?', noProject: 'none' }

function mount(overrides: Partial<ProjectBarProps> = {}) {
  const props: ProjectBarProps = {
    projects: [PROJECT, { ...PROJECT, id: 'p2', title: 'Other' }], project: 'p1', labels,
    onProject: vi.fn(), onUndo: vi.fn(),
    onCreate: vi.fn(),
    ...overrides,
  }
  const view = render(<ProjectBar {...props} />)
  return { props, view, bar: within(view.getByTestId('dv-kit-project-bar')) }
}

describe('ProjectBar', () => {
  it('lists projects, and reports selection changes and undo', () => {
    const { props, bar } = mount()
    const project = bar.getByLabelText('project')
    expect([...project.querySelectorAll('option')].map(option => option.textContent)).toEqual(['Demo', 'Other'])
    fireEvent.change(project, { target: { value: 'p2' } })
    expect(props.onProject).toHaveBeenCalledWith('p2')
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
