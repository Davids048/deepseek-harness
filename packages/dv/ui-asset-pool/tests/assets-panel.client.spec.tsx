// @vitest-environment jsdom
/** The asset pool panel: every asset of the project, including the assets of steps an undo went back past. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor, within } from '@testing-library/react'
import { DvClient } from '@dv/ui-kit/api.ts'
import type { HistoryQuery } from '@dv/ui-kit/types.ts'
import { asset, fixtureState, record, scriptedFetch } from '../../ui-kit/tests/fixture.client.tsx'
import { AssetsPanel } from '../src/client/AssetsPanel.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('AssetsPanel', () => {
  it('lists every asset of the project, with the stills of records outside the current state under extracted frames', async () => {
    const queries: HistoryQuery[] = []
    // An undo went back past g9, so the state lists its assets but not its record; the history list holds the record.
    const state = fixtureState()
    state.assets.push(asset('wide.mp4', 'video/mp4', 'g9', 5), asset('wide-last.png', 'image/png', 'g9'))
    const history = {
      entries: [{ record: record({ id: 'g9', operation: 'shot.render_ref2va', outputs: ['wide.mp4', 'wide-last.png'] }) }],
      assets: [asset('wide.mp4', 'video/mp4', 'g9', 5), asset('wide-last.png', 'image/png', 'g9')],
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
    expect(view.container.querySelector('[data-asset-id="wide.mp4"]')).not.toBeNull()
    await waitFor(() => { expect(panel.getByText('Extracted from generation · 3')).toBeTruthy() })
    expect(queries[0]).toEqual({ project: 'p1', limit: 200 })
    expect(panel.queryByText('Show assets from other branches')).toBeNull()
  })
})
