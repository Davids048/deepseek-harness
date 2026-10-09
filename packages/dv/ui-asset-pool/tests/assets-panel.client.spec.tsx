// @vitest-environment jsdom
/** The asset pool panel: every asset of the project, including the assets of steps an undo went back past. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor, within } from '@testing-library/react'
import { DvClient } from '@dv/ui-kit/api.ts'
import { asset, fixtureState, scriptedFetch } from '../../ui-kit/tests/fixture.client.tsx'
import { AssetsPanel } from '../src/client/AssetsPanel.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('AssetsPanel', () => {
  it('lists every asset of the project from the state alone, with render stills under extracted frames', async () => {
    // An undo went back past g9: the state lists its assets, each with the operation that made it, but not its record.
    const state = fixtureState()
    state.assets.push(asset('wide.mp4', 'video/mp4', 'g9', 5, 'shot.render_ref2va'), asset('wide-last.png', 'image/png', 'g9', null, 'shot.render_ref2va'))
    const posts: string[] = []
    const { fetch } = scriptedFetch({ state, post: (path) => { posts.push(path); return { status: 404, body: { error: path } } } })
    const view = render(<AssetsPanel projectId="p1" session="s5" client={new DvClient(fetch)} />)
    const panel = within(view.getByTestId('dv-asset-pool-panel'))
    await waitFor(() => { expect(view.container.querySelector('[data-asset-id="shot1.mp4"]')).not.toBeNull() })
    expect(view.container.querySelector('[data-asset-id="wide.mp4"]')).not.toBeNull()
    expect(panel.getByText('Extracted from generation · 3')).toBeTruthy()
    // The panel reads no history list.
    expect(posts).toEqual([])
  })
})
