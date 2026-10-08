// @vitest-environment jsdom
/** The asset pool panel: the current branch's assets by default, and the toggle that adds other branches' assets. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { DvClient } from '@dv/ui-kit/api.ts'
import type { HistoryQuery } from '@dv/ui-kit/types.ts'
import { asset, fixtureState, record, scriptedFetch } from '../../ui-kit/tests/fixture.client.tsx'
import { AssetsPanel } from '../src/client/AssetsPanel.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('AssetsPanel', () => {
  it('lists the current branch\'s assets, and adds the other branches\' assets with their branch while the toggle is on', async () => {
    const queries: HistoryQuery[] = []
    const state = { ...fixtureState(), current: 'main' }
    state.branches = state.branches.map(branch => branch.name === 'b2' ? { ...branch, title: 'night' } : branch)
    const history = {
      entries: [{ record: record({ id: 'g3', branch: 'b2', operation: 'shot.render_ref2va', outputs: ['wide.mp4'] }), mark: 'branch', branches: ['b2'] }],
      assets: [asset('wide.mp4', 'video/mp4', 'g3', 5)],
    }
    const { fetch } = scriptedFetch({
      state,
      post: (path, body) => {
        if (path !== '/api/dv/history') return { status: 404, body: { error: path } }
        queries.push(body as HistoryQuery)
        return { status: 200, body: history }
      },
    })
    const view = render(<AssetsPanel projectId="p1" session="s5" client={new DvClient(fetch)} />)
    const panel = within(view.getByTestId('dv-asset-pool-panel'))
    await waitFor(() => { expect(view.container.querySelector('[data-asset-id="shot1.mp4"]')).not.toBeNull() })
    expect(view.container.querySelector('[data-asset-id="wide.mp4"]')).toBeNull()
    expect(queries).toEqual([])

    const toggle = panel.getByTestId('dv-asset-pool-other-branches')
    expect(toggle.textContent).toBe('Show assets from other branches')
    fireEvent.click(toggle)
    await waitFor(() => { expect(view.container.querySelector('[data-asset-id="wide.mp4"]')).not.toBeNull() })
    expect(queries).toEqual([{ project: 'p1', marks: ['redo', 'branch'], limit: 200 }])
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(panel.getAllByTestId('dv-asset-pool-branch-badge').map(badge => badge.textContent)).toEqual(['night'])

    fireEvent.click(toggle)
    await waitFor(() => { expect(view.container.querySelector('[data-asset-id="wide.mp4"]')).toBeNull() })
    expect(toggle.textContent).toBe('Show assets from other branches')
  })
})
