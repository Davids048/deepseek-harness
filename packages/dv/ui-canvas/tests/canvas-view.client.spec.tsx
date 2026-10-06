// @vitest-environment jsdom
/** The canvas over a scripted API: nodes, drag persistence, the floating editor, and the `dv:compose` event. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { DvClient } from '@dv/ui-kit/api.ts'
import { DV_COMPOSE_EVENT } from '@dv/ui-kit/compose.ts'
import type { DvComposeDetail } from '@dv/ui-kit/compose.ts'
import type { WireState } from '@dv/ui-kit/types.ts'
import { DV_CANVAS_FOCUS_EVENT } from '@dv/ui-kit/workspace-events.ts'
import { fixtureState, record, scriptedFetch } from '../../ui-kit/tests/fixture.client.tsx'
import { CanvasView } from '../src/client/CanvasView.tsx'
import type { CanvasTranslate } from '../src/client/NodeCard.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

/**
 * Mount the canvas over scripted `/api/dv` routes and a scripted layout route.
 * @param withTranslate - whether the host passes the Chinese translate.
 * @param edit - changes to the fixture state of every branch.
 * @returns the rendered view, the recorded writes, and a node lookup.
 */
function mount(withTranslate = true, edit: (state: WireState) => void = () => undefined) {
  // `main` lacks the retake g3; the draft of chat session s5 adds it after the request that asked for it.
  const draftRequest = record({ id: 'r5', kind: 'request', branch: 'draft/s5', session: 's5', turn: 't5', intent: 'retake shot 1' })
  const scripted = scriptedFetch({
    state: (branch) => {
      const state = fixtureState()
      edit(state)
      const records = state.components.proj.records
      state.components.proj.records = branch === 'main' ? records.filter(entry => entry.id !== 'g3') : [...records, draftRequest]
      return state
    },
  })
  const layoutWrites: unknown[] = []
  const fetchWithLayout: typeof fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/dv/layout')) {
      if (init?.method === 'POST') layoutWrites.push(JSON.parse(String(init.body)))
      return Promise.resolve(new Response(JSON.stringify({ positions: { g1: { x: 10, y: 20 } }, viewport: { x: 0, y: 0, zoom: 1 } })))
    }
    return scripted.fetch(input, init)
  }
  const client = new DvClient(fetchWithLayout)
  const t: CanvasTranslate = makeTranslate(zh)
  const view = render(<CanvasView projectId="p1" client={client} session="s5" {...withTranslate ? { t } : {}} />)
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
    const bar = view.getByTestId('dv-kit-working-branch')
    expect(bar.getAttribute('data-branch')).toBe('draft/s5')
    expect(bar.textContent).toContain('retake shot 1')
    fireEvent.pointerDown(node('g2'), { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(view.getByTestId('dv-canvas-view'), { clientX: 50, clientY: 30, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    await waitFor(() => { expect(layoutWrites).toHaveLength(1) }, { timeout: 2000 })
    expect(layoutWrites[0]).toMatchObject({ project: 'p1', positions: { g2: { x: 1080 + 50, y: 0 + 30 } } })
  })

  it('opens the editor on click, renders a new take with based_on, and dispatches dv:compose', async () => {
    const { view, node, writes } = mount()
    await waitFor(() => { node('g1') })
    fireEvent.pointerDown(node('g1'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    const editor = await view.findByTestId('dv-canvas-node-editor')
    fireEvent.change(editor.querySelector('textarea') as HTMLTextAreaElement, { target: { value: 'hero runs' } })
    fireEvent.click(view.getByText(zh['editor.renderTake']))
    await waitFor(() => { expect(writes.some(write => write.path === '/api/dv/operation')).toBe(true) })
    expect(writes.find(write => write.path === '/api/dv/operation')?.body).toMatchObject({
      project: 'p1', operation: 'shot.render', surface: 'canvas', based_on: 'g1', params: { prompt: 'hero runs' },
      inputs: [{ role: 'reference', ref: 'hero@1' }],
    })
    fireEvent.pointerDown(node('bible:hero'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    const composed: DvComposeDetail[] = []
    const listener = (event: Event): void => { composed.push((event as CustomEvent<DvComposeDetail>).detail) }
    window.addEventListener(DV_COMPOSE_EVENT, listener)
    fireEvent.click(await view.findByText(zh['editor.askAgent']))
    window.removeEventListener(DV_COMPOSE_EVENT, listener)
    expect(composed).toEqual([{ text: '修改 Hero：', refs: [{ kind: 'character', id: 'hero', label: 'Hero', assetId: 'ref.png' }] }])
    expect(view.queryByTestId('dv-canvas-node-editor')).toBeNull()
    expect(writes.filter(write => write.path === '/api/dv/selection').map(write => write.body)).toEqual([
      { project: 'p1', kind: 'record', id: 'g1', surface: 'canvas' },
      { project: 'p1', kind: 'character', id: 'hero', surface: 'canvas' },
    ])
  })

  it('offers 仍然保留 on a stale node, which accepts its record on the session\'s working branch', async () => {
    const { view, node, writes } = mount()
    await waitFor(() => { node('g2') })
    fireEvent.pointerDown(node('g2'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    await view.findByTestId('dv-canvas-node-editor')
    fireEvent.click(view.getByRole('button', { name: zh['editor.keepAnyway'] }))
    await waitFor(() => { expect(writes.some(write => write.path === '/api/dv/stale/accept')).toBe(true) })
    expect(writes.find(write => write.path === '/api/dv/stale/accept')?.body).toEqual({ project: 'p1', record: 'g2', surface: 'canvas', session: 's5' })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    fireEvent.pointerDown(node('g1'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    await view.findByTestId('dv-canvas-node-editor')
    expect(view.queryByRole('button', { name: zh['editor.keepAnyway'] })).toBeNull()
  })

  it('opens the record a dv:canvas-focus asked for before mounting; empty-canvas clicks and Escape close the editor', async () => {
    window.dispatchEvent(new CustomEvent(DV_CANVAS_FOCUS_EVENT, { detail: { recordId: 'g2' } }))
    const { view, node } = mount()
    const editor = await view.findByTestId('dv-canvas-node-editor')
    expect(editor.getAttribute('aria-label')).toBe(node('g2').getAttribute('aria-label'))
    const canvas = view.getByTestId('dv-canvas-view')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 700, clientY: 500, pointerId: 1 })
    fireEvent.pointerUp(canvas, { pointerId: 1 })
    expect(view.queryByTestId('dv-canvas-node-editor')).toBeNull()
    fireEvent.pointerDown(node('g1'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(canvas, { pointerId: 1 })
    await view.findByTestId('dv-canvas-node-editor')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(view.queryByTestId('dv-canvas-node-editor')).toBeNull()
  })

  it('the plan editor marks a version replaced before approval as 已被 v{n} 取代 and shows each shot\'s reference images', async () => {
    const { view, node } = mount(true, (state) => {
      const [v1] = state.components.plan.plans['p1'] ?? []
      if (v1 === undefined) throw new Error('fixture lacks plan p1')
      const v3 = { ...v1, version: 3, approved_by: null, references: ['hero@1'], shots: [{ prompt: 'Picture 1 walks in the rain' }] }
      state.components.plan.plans['p1'] = [v1, { ...v1, version: 2, approved_by: null }, v3]
    })
    await waitFor(() => { node('plan:p1') })
    fireEvent.pointerDown(node('plan:p1'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    const editor = await view.findByTestId('dv-canvas-node-editor')
    const status = (version: number): string => {
      fireEvent.click(view.getByRole('button', { name: `v${String(version)}` }))
      return editor.querySelector('p')?.textContent ?? ''
    }
    expect([status(1), status(2), status(3)]).toEqual([zh['editor.planApproved'], '已被 v3 取代', zh['editor.planPending']])
    // v3's shot renders from Hero's reference image: a thumbnail beside the shot, and the image in place of Picture 1.
    const shot = editor.querySelector('li[data-shot="1"]')
    expect([...shot?.querySelectorAll('img') ?? []].map(image => [image.getAttribute('alt'), image.getAttribute('src')?.includes('ref.png')]))
      .toEqual([['', true], ['Picture 1', true]])
    expect(shot?.textContent).toBe(' walks in the rain')
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
