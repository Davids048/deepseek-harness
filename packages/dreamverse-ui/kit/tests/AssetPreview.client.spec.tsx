/** @vitest-environment jsdom */
import './support/setup.client.ts'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AssetPreview, { type AssetPreviewLabels } from '../src/client/components/assets/AssetPreview.tsx'
import { imageAsset } from './support/assetFixtures.client.ts'

/** The localized copy that the rendering package supplies; the kit owns no preview wording. */
const labels: AssetPreviewLabels = {
  unsupported: name => `Your browser cannot preview ${name}. Try another supported format.`,
}

describe('asset previews', () => {
  it('releases exactly the local URLs owned by replaced and unmounted previews', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:front').mockReturnValueOnce('blob:side')
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const { rerender, unmount } = render(<AssetPreview source={new File(['png'], 'front.png', { type: 'image/png' })} labels={labels} />)
    expect(screen.getByAltText('front.png')).toHaveAttribute('src', 'blob:front')
    rerender(<AssetPreview source={new File(['png'], 'side.png', { type: 'image/png' })} labels={labels} />)
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:front')
    unmount()
    expect(create).toHaveBeenCalledTimes(2)
    expect(revoke.mock.calls).toEqual([['blob:front'], ['blob:side']])
  })

  it.each(['video', 'audio'] as const)('renders %s with playback controls and explains decode failures', (media_type) => {
    const asset = { ...imageAsset('media'), media_type, content_url: '/assets/media/content' }
    render(<AssetPreview source={asset} labels={labels} />)
    const player = screen.getByLabelText('media')
    expect(player.tagName.toLowerCase()).toBe(media_type)
    expect(player).toHaveAttribute('controls')
    fireEvent.error(player)
    expect(screen.getByRole('alert')).toHaveTextContent('Your browser cannot preview media')
  })
})
