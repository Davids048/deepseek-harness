// @vitest-environment jsdom
/** The approval cards above the composer: each shot's reference images as thumbnails and inline for its `Picture N`. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { ApprovalCard, ApprovalReference } from '@dv/ui-kit/types.ts'
import { PendingBar, PicturePrompt } from '../src/client/views.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const image = (asset: string, ref = asset): ApprovalReference => ({ role: 'reference', ref, asset, url: `/assets/${asset}.png` })

/** One approval card with the fields a test does not care about filled in. */
function approval(fields: Partial<ApprovalCard>): ApprovalCard {
  return {
    id: 'a1', session: 's1', tool_call: 'call-1', operation: 'shot.render', summary: 'render', prompt: '', duration_sec: 1,
    gpu_seconds: 4, references: [], shots: [], created_at: '2026-01-01T00:00:00Z', ...fields,
  }
}

describe('PicturePrompt', () => {
  it('shows the N-th image in place of each Picture N token, keeping the token as alt text', () => {
    render(<p data-testid="prompt"><PicturePrompt prompt="Picture 1 hands picture 2 to Picture 3" images={[image('front'), image('cup')]} /></p>)
    const prompt = screen.getByTestId('prompt')
    const pictures = within(prompt).getAllByTestId('dv-composer-picture')
    expect(pictures.map(picture => [picture.getAttribute('src'), picture.getAttribute('alt')]))
      .toEqual([['/assets/front.png', 'Picture 1'], ['/assets/cup.png', 'picture 2']])
    // Picture 3 has no image, so it stays text.
    expect(prompt.textContent).toBe(' hands  to Picture 3')
  })
})

describe('PendingBar', () => {
  it('lists each shot of a plan approval with its own images in the order the model receives them', async () => {
    const card = approval({
      operation: 'plan.approve', prompt: '1. Picture 1 walks (1 s)\n3. Picture 2 waits (2 s)', references: [image('front', 'c1@1'), image('room')],
      shots: [
        { shot: 1, prompt: 'Picture 1 walks', duration_sec: 1, references: [image('front', 'c1@1'), image('side', 'c1@1')] },
        { shot: 3, prompt: 'Picture 2 waits', duration_sec: 2, references: [image('front', 'c1@1'), image('room')] },
      ],
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify([card])))))
    render(<PendingBar sessionId="s1" />)
    const shots = await screen.findAllByTestId('dv-composer-approval-shot')
    expect(shots.map(shot => shot.textContent)).toEqual(['1.  walks (1 s)', '3.  waits (2 s)'])
    const second = shots[1]
    if (second === undefined) throw new Error('missing shot 3')
    expect(within(second).getByTestId('dv-composer-picture').getAttribute('src')).toBe('/assets/room.png')
    expect(within(within(second).getByTestId('dv-composer-references')).getAllByRole('img').map(thumb => thumb.getAttribute('src')))
      .toEqual(['/assets/front.png', '/assets/room.png'])
    expect(screen.queryByText(/Picture \d/)).toBeNull()
  })

  it('shows a render approval prompt with inline images and the thumbnails of its references', async () => {
    const card = approval({ prompt: 'Picture 2 rises', references: [image('front', 'c1@1'), image('side', 'c1@1')] })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify([card])))))
    render(<PendingBar sessionId="s2" />)
    const picture = await screen.findByTestId('dv-composer-picture')
    expect([picture.getAttribute('src'), picture.getAttribute('alt')]).toEqual(['/assets/side.png', 'Picture 2'])
    expect(within(screen.getByTestId('dv-composer-references')).getAllByRole('img')).toHaveLength(2)
  })
})
