// @vitest-environment jsdom
/** The canvas over a scripted API: nodes, drag persistence, the floating editor, and the `vh:compose` event. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { VhClient } from '@video-harness/ui-kit/api.ts'
import { VH_COMPOSE_EVENT } from '@video-harness/ui-kit/compose.ts'
import type { VhComposeDetail } from '@video-harness/ui-kit/compose.ts'
import { fixtureState, scriptedFetch } from '../../ui-kit/tests/fixture.client.tsx'
import { CanvasView } from '../src/client/CanvasView.tsx'
import type { CanvasViewProps } from '../src/client/CanvasView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

/** Mount the canvas with scripted views routes and a scripted layout route on the global fetch. */
function mount(withTranslate = true) {
  const scripted = scriptedFetch({ state: head => head === 'main' ? { ...fixtureState(), ops: fixtureState().ops.filter(op => op.id !== 'g3') } : fixtureState() })
  const layoutWrites: unknown[] = []
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    if (input.startsWith('/api/vh/layout')) {
      if (init?.method === 'POST') layoutWrites.push(JSON.parse(String(init.body)))
      return Promise.resolve(new Response(JSON.stringify({ positions: { g1: { x: 10, y: 20 } }, viewport: { x: 0, y: 0, zoom: 1 } })))
    }
    return Promise.resolve(new Response('{}', { status: 404 }))
  })
  const client = new VhClient(scripted.fetch)
  const t = makeTranslate(zh) as CanvasViewProps['t']
  const view = render(<CanvasView projectId="p1" client={client} {...withTranslate ? { t } : {}} />)
  const node = (id: string): HTMLElement => {
    const element = view.container.querySelector(`[data-node-id="${id}"]`)
    if (!(element instanceof HTMLElement)) throw new Error(`no node ${id}`)
    return element
  }
  return { view, writes: scripted.writes, layoutWrites, node }
}

describe('CanvasView', () => {
  it('draws nodes at stored positions, overlays the open draft, and stores a dragged position', async () => {
    const { view, node, layoutWrites } = mount()
    await waitFor(() => { node('g3') })
    expect(node('g1').style.left).toBe('10px')
    expect(node('g3').getAttribute('data-node-draft')).toBe('true')
    expect(node('g2').getAttribute('data-node-stale')).toBe('true')
    expect(view.getByText(zh['badge.trim'])).toBeTruthy()
    expect(view.getByText('agent 草稿：retake shot 1')).toBeTruthy()
    fireEvent.pointerDown(node('g2'), { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(view.getByTestId('vh-canvas-view'), { clientX: 50, clientY: 30, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('vh-canvas-view'), { pointerId: 1 })
    await waitFor(() => { expect(layoutWrites).toHaveLength(1) }, { timeout: 2000 })
    expect(layoutWrites[0]).toMatchObject({ project: 'p1', positions: { g2: { x: 1080 + 50, y: 0 + 30 } } })
  })

  it('opens the editor on click, regenerates with base_op, and dispatches vh:compose', async () => {
    const { view, node, writes } = mount()
    await waitFor(() => { node('g1') })
    fireEvent.pointerDown(node('g1'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('vh-canvas-view'), { pointerId: 1 })
    const editor = await view.findByTestId('vh-node-editor')
    fireEvent.change(editor.querySelector('textarea') as HTMLTextAreaElement, { target: { value: 'hero runs' } })
    fireEvent.click(view.getByText(zh['editor.regenerate']))
    await waitFor(() => { expect(writes.some(write => write.path === '/api/vh/invoke')).toBe(true) })
    expect(writes.find(write => write.path === '/api/vh/invoke')?.body).toMatchObject({
      project: 'p1', tool: 'generate.video', surface: 'canvas', base_op: 'g1', params: { prompt: 'hero runs' },
      inputs: [{ role: 'reference', ref: 'hero@1' }],
    })
    fireEvent.pointerDown(node('entity:hero'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('vh-canvas-view'), { pointerId: 1 })
    const composed: VhComposeDetail[] = []
    const listener = (event: Event): void => { composed.push((event as CustomEvent<VhComposeDetail>).detail) }
    window.addEventListener(VH_COMPOSE_EVENT, listener)
    fireEvent.click(await view.findByText(zh['editor.askAgent']))
    window.removeEventListener(VH_COMPOSE_EVENT, listener)
    expect(composed).toEqual([{ text: '修改 Hero：', refs: [{ kind: 'entity', id: 'hero', label: 'Hero', assetId: 'ref.png' }] }])
    expect(view.queryByTestId('vh-node-editor')).toBeNull()
  })

  it('opens the record a vh:canvas-focus asked for before mounting; empty-canvas clicks and Escape close the editor', async () => {
    window.dispatchEvent(new CustomEvent('vh:canvas-focus', { detail: { opId: 'g2' } }))
    const { view, node } = mount()
    const editor = await view.findByTestId('vh-node-editor')
    expect(editor.getAttribute('aria-label')).toBe(node('g2').getAttribute('aria-label'))
    const canvas = view.getByTestId('vh-canvas-view')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 700, clientY: 500, pointerId: 1 })
    fireEvent.pointerUp(canvas, { pointerId: 1 })
    expect(view.queryByTestId('vh-node-editor')).toBeNull()
    fireEvent.pointerDown(node('g1'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(canvas, { pointerId: 1 })
    await view.findByTestId('vh-node-editor')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(view.queryByTestId('vh-node-editor')).toBeNull()
  })

  it('follows the DSH interface language in <html lang> when the host passes no translate', async () => {
    document.documentElement.lang = 'en'
    const { view } = mount(false)
    expect(await view.findByText('Fit')).toBeTruthy()
    await act(async () => { document.documentElement.lang = 'zh-CN'; await Promise.resolve() })
    expect(await view.findByText(zh['canvas.fit'])).toBeTruthy()
    document.documentElement.lang = ''
  })
})
