// @vitest-environment jsdom
/** The chat card of a render call: its tool's name, prompt, status, and the 在历史中查看 link once settled. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RenderCard } from '../src/client/views.tsx'

afterEach(() => { cleanup() })

describe('RenderCard', () => {
  it('names the render tool and shows the prompt while the call renders', () => {
    render(
      <RenderCard
        toolName="dv_shot_render_t2va" label={['文字生成镜头', 'Render shot from text']} sessionId="s1" callId="call-1" phase="start"
        block={{ argsRaw: JSON.stringify({ prompt: 'a lighthouse at dusk' }) }}
      />,
    )
    const card = document.querySelector('[data-tool="dv_shot_render_t2va"]')
    expect(card?.textContent).toContain('Render shot from text')
    expect(card?.textContent).toContain('a lighthouse at dusk')
    expect(screen.queryByTestId('dv-composer-open-history')).toBeNull()
  })

  it('shows the rendered video and the history link once the call settled', () => {
    render(
      <RenderCard
        toolName="dv_shot_render_ref2va" label={['参考图生成镜头', 'Render shot from references']} sessionId="s1" callId="call-2" phase="result"
        block={{ argsRaw: '{"prompt":"Picture 1 walks"}', meta: { outputs: [{ role: 'video', asset_id: 'v1.mp4', mime: 'video/mp4' }] } }}
      />,
    )
    expect(document.querySelector('video')?.getAttribute('src')).toContain('v1.mp4')
    expect(screen.getByTestId('dv-composer-open-history')).toBeTruthy()
  })
})
