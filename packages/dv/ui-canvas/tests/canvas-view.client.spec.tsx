// @vitest-environment jsdom
/** The canvas over a scripted API: nodes, drag persistence, the floating editor, and the `dv:compose` event. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { assetUrl, DvClient } from '@dv/ui-kit/api.ts'
import { DV_COMPOSE_EVENT } from '@dv/ui-kit/compose.ts'
import type { DvComposeDetail } from '@dv/ui-kit/compose.ts'
import type { WireState } from '@dv/ui-kit/types.ts'
import { DV_ASSET_DRAG_TYPE, DV_CANVAS_FOCUS_EVENT } from '@dv/ui-kit/workspace-events.ts'
import { asset, fixtureState, record, scriptedFetch } from '../../ui-kit/tests/fixture.client.tsx'
import { CanvasView } from '../src/client/CanvasView.tsx'
import { NODE_WIDTH } from '../src/client/graph.ts'
import { EDITOR_RECT_KEY } from '../src/client/NodeEditor.tsx'
import type { CanvasTranslate } from '../src/client/NodeCard.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  window.localStorage.removeItem(EDITOR_RECT_KEY)
  window.localStorage.removeItem('dv-canvas-seen:p1')
})

/**
 * Mount the canvas over scripted `/api/dv` routes and a scripted layout route.
 * @param withTranslate - whether the host passes the Chinese translate.
 * @param edit - changes to the fixture state, applied to every state the route serves.
 * @param holdOperations - whether `POST /api/dv/operation` stays unanswered, as a render does until it ends.
 * @returns the rendered view, the recorded writes, and a node lookup.
 */
function mount(withTranslate = true, edit: (state: WireState) => void = () => undefined, holdOperations = false) {
  const scripted = scriptedFetch({
    state: () => {
      const state = fixtureState()
      edit(state)
      return state
    },
  })
  const layoutWrites: unknown[] = []
  const fetchWithLayout: typeof fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/dv/layout')) {
      if (init?.method === 'POST') layoutWrites.push(JSON.parse(String(init.body)))
      const layout = { positions: { g1: { x: 10, y: 20 } }, viewport: { x: 0, y: 0, zoom: 1 } }
      return Promise.resolve(new Response(JSON.stringify(layout)))
    }
    if (holdOperations && input === '/api/dv/operation') {
      void scripted.fetch(input, init)
      return new Promise<Response>(() => undefined)
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
  it('draws the project\'s current state with nodes at stored positions, stores the others\' spots, and stores a dragged position', async () => {
    const { view, node, layoutWrites } = mount()
    await waitFor(() => { node('g3') })
    expect(node('g1').style.left).toBe('10px')
    expect(node('g2').getAttribute('data-node-stale')).toBe('true')
    expect(view.getByText(zh['badge.trim'])).toBeTruthy()
    // Every node without a stored position gets its spot stored once, without the viewport.
    await waitFor(() => { expect(layoutWrites).toHaveLength(1) })
    expect(layoutWrites[0]).toEqual({ project: 'p1', positions: expect.objectContaining({ g2: { x: 720, y: 0 } }) })
    expect(Object.keys((layoutWrites[0] as { positions: object }).positions)).not.toContain('g1')
    fireEvent.pointerDown(node('g2'), { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(view.getByTestId('dv-canvas-view'), { clientX: 50, clientY: 30, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    await waitFor(() => { expect(layoutWrites).toHaveLength(2) }, { timeout: 2000 })
    expect(layoutWrites[1]).toMatchObject({ project: 'p1', positions: { g2: { x: 720 + 50, y: 0 + 30 } } })
  })

  it('keeps the node selected after its editor closes; a click on empty canvas then clears the selection', async () => {
    const { view, node } = mount()
    await waitFor(() => { node('g1') })
    const canvas = view.getByTestId('dv-canvas-view')
    fireEvent.pointerDown(node('g1'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(canvas, { pointerId: 1 })
    await view.findByTestId('dv-canvas-node-editor')
    fireEvent.click(view.getByRole('button', { name: zh['editor.close'] }))
    expect(view.queryByTestId('dv-canvas-node-editor')).toBeNull()
    expect(node('g1').getAttribute('data-node-selected')).toBe('true')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 700, clientY: 500, pointerId: 1 })
    fireEvent.pointerUp(canvas, { pointerId: 1 })
    expect(node('g1').getAttribute('data-node-selected')).toBeNull()
  })

  it('渲染新版本 reads 渲染中… until the new take appears, then the editor closes and the new take is selected', async () => {
    let started = false
    const { view, node } = mount(true, (state) => {
      if (!started) return
      state.components.proj.records.push(record({
        id: 'n1', operation: 'shot.render_ref2va', deterministic: false, based_on: 'g1', params: { prompt: 'hero runs' }, status: 'running',
      }))
    }, true)
    await waitFor(() => { node('g1') })
    fireEvent.pointerDown(node('g1'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    await view.findByTestId('dv-canvas-node-editor')
    fireEvent.click(view.getByText(zh['editor.renderTake']))
    const button = view.getByRole('button', { name: zh['node.rendering'] })
    expect(button.hasAttribute('disabled')).toBe(true)
    // The host wrote the pending record; the next state refetch (a 3-second poll without EventSource) shows its node.
    started = true
    await waitFor(() => { expect(node('n1').getAttribute('data-node-selected')).toBe('true') }, { timeout: 6000 })
    expect(view.queryByTestId('dv-canvas-node-editor')).toBeNull()
    expect(node('g1').getAttribute('data-node-selected')).toBeNull()
  }, 10_000)

  it('marks a take that finished after the first load as unseen until its editor opens', async () => {
    let finished = false
    const { view, node } = mount(true, (state) => {
      if (!finished) return
      state.components.proj.records = state.components.proj.records.map(entry => entry.id === 'g3' ? { ...entry, status: 'done' as const, outputs: ['shot2.mp4'] } : entry)
    })
    await waitFor(() => { node('g3') })
    // Takes that were finished at the first load count as seen.
    expect(view.container.querySelectorAll('[data-node-unseen]')).toHaveLength(0)
    finished = true
    await waitFor(() => { expect(node('g3').getAttribute('data-node-unseen')).toBe('true') }, { timeout: 6000 })
    fireEvent.pointerDown(node('g3'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    await view.findByTestId('dv-canvas-node-editor')
    expect(node('g3').getAttribute('data-node-unseen')).toBeNull()
    expect(JSON.parse(window.localStorage.getItem('dv-canvas-seen:p1') ?? '[]')).toContain('g3')
  }, 10_000)

  it('draws a character as its name and its first reference image with a count of the rest', async () => {
    const references = ['ref.png', 'r2.png', 'r3.png', 'r4.png', 'r5.png', 'r6.png']
    const { node } = mount(true, (state) => {
      state.assets.push(...references.slice(1).map(id => asset(id, 'image/png', 'u1')))
      const hero = state.components.bible.characters['hero']?.[0]
      if (hero !== undefined) hero.references = references
    })
    await waitFor(() => { node('bible:hero') })
    const card = node('bible:hero')
    expect([...card.querySelectorAll('img')].map(image => image.getAttribute('src'))).toEqual([assetUrl('ref.png')])
    expect(card.textContent).toContain(zh['node.character'])
    expect(card.textContent).toContain('Hero')
    expect(card.textContent).toContain('+5')
  })

  it('puts a dropped 素材 tile on the canvas under the pointer with asset.place, and 从画布移除 takes it off with asset.unplace', async () => {
    const { view, node, writes } = mount(true, (state) => {
      state.assets.push(asset('pool.png', 'image/png', 'u2'))
      state.components.proj.records.push(record({ id: 'u2', operation: 'asset.import', params: { name: 'pool.png' }, outputs: ['pool.png'], surface: 'asset_pool' }))
      state.components.proj.created_by['pool.png'] = 'u2'
    })
    await waitFor(() => { node('g1') })
    expect(view.container.querySelector('[data-node-id="u2"]')).toBeNull()
    const dataTransfer = { types: [DV_ASSET_DRAG_TYPE], getData: (type: string) => type === DV_ASSET_DRAG_TYPE ? 'pool.png' : '', files: [] }
    // jsdom's drop event carries no pointer coordinates, so they are set on the event.
    const drop = createEvent.drop(view.getByTestId('dv-canvas-view'), { dataTransfer })
    Object.defineProperties(drop, { clientX: { value: 500 }, clientY: { value: 300 } })
    fireEvent(view.getByTestId('dv-canvas-view'), drop)
    await waitFor(() => { expect(node('u2').style.left).toBe(`${String(500 - NODE_WIDTH / 2)}px`) })
    const placement = (operation: string) => ({
      path: '/api/dv/operation', body: { project: 'p1', operation, surface: 'canvas', inputs: [{ role: 'asset', ref: 'pool.png' }], session: 's5' },
    })
    await waitFor(() => { expect(writes).toContainEqual(placement('asset.place')) })
    fireEvent.pointerDown(node('u2'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    fireEvent.click(await view.findByText(zh['editor.removeFromCanvas']))
    await waitFor(() => { expect(view.container.querySelector('[data-node-id="u2"]')).toBeNull() })
    await waitFor(() => { expect(writes).toContainEqual(placement('asset.unplace')) })
  })

  it('places a dropped 素材 tile of an asset that no record of the current state imported, and draws it as asset:<id>', async () => {
    const canvas: string[] = []
    const { view, writes } = mount(true, (state) => {
      // An undo went back past the import: the asset pool still lists the asset.
      state.assets.push(asset('undone.png', 'image/png', 'u9', null, 'asset.import'))
      state.components.asset.placed = [...canvas]
    })
    await waitFor(() => { expect(view.container.querySelector('[data-node-id="g1"]')).not.toBeNull() })
    const dataTransfer = { types: [DV_ASSET_DRAG_TYPE], getData: (type: string) => type === DV_ASSET_DRAG_TYPE ? 'undone.png' : '', files: [] }
    fireEvent.drop(view.getByTestId('dv-canvas-view'), { dataTransfer })
    await waitFor(() => {
      expect(writes).toContainEqual({
        path: '/api/dv/operation', body: { project: 'p1', operation: 'asset.place', surface: 'canvas', inputs: [{ role: 'asset', ref: 'undone.png' }], session: 's5' },
      })
    })
    await waitFor(() => { expect(view.container.querySelector('[data-node-id="asset:undone.png"]')).not.toBeNull() })
    expect(view.queryByText(/no node/)).toBeNull()
  })

  it('draws an asset that another writer put on the project\'s canvas once the state refetches', async () => {
    const canvas: string[] = []
    const { view, node } = mount(true, (state) => {
      state.assets.push(asset('chat.png', 'image/png', 'u2'))
      state.components.proj.records.push(record({ id: 'u2', operation: 'asset.import', params: { name: 'chat.png' }, outputs: ['chat.png'], surface: 'chat' }))
      state.components.proj.created_by['chat.png'] = 'u2'
      state.components.asset.placed = [...canvas]
    })
    await waitFor(() => { node('g1') })
    expect(view.container.querySelector('[data-node-id="u2"]')).toBeNull()
    // A chat message put the image on the canvas; the next state refetch (a 3-second poll without EventSource) shows it.
    canvas.push('chat.png')
    await waitFor(() => { node('u2') }, { timeout: 6000 })
  }, 10_000)

  it('opens the editor on click, renders a new take with based_on, and dispatches dv:compose', async () => {
    const { view, node, writes } = mount()
    await waitFor(() => { node('g1') })
    fireEvent.pointerDown(node('g1'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    const editor = await view.findByTestId('dv-canvas-node-editor')
    expect(view.getByTestId('dv-canvas-render-mode').textContent).toBe(zh['mode.ref2va'])
    fireEvent.change(editor.querySelector('textarea') as HTMLTextAreaElement, { target: { value: 'hero runs' } })
    fireEvent.click(view.getByText(zh['editor.renderTake']))
    await waitFor(() => { expect(writes.some(write => write.path === '/api/dv/operation')).toBe(true) })
    expect(writes.find(write => write.path === '/api/dv/operation')?.body).toMatchObject({
      project: 'p1', operation: 'shot.render_ref2va', surface: 'canvas', based_on: 'g1', params: { prompt: 'hero runs' },
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
    // Choosing a node is a view gesture: it writes nothing.
    expect(writes.map(write => write.path)).toEqual(['/api/dv/operation'])
  })

  it('offers 仍然保留 on a stale node, which accepts its record for the chat session beside the canvas', async () => {
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

  it('draws a failed take as a row with its failure reason, and 重试 renders it again based on it', async () => {
    const { view, node, writes } = mount(true, (state) => {
      state.components.proj.records = state.components.proj.records.map(entry => entry.id === 'g1'
        ? { ...entry, status: 'failed' as const, outputs: [], error: { code: 'operation_failed', message: 'GPU out of memory' } }
        : entry)
    })
    await waitFor(() => { node('g1') })
    expect(node('g1').getAttribute('title')).toBe('GPU out of memory')
    expect(node('g1').textContent).toContain(zh['node.renderFailed'])
    fireEvent.click(view.getAllByRole('button', { name: zh['node.retry'] })[0] as HTMLElement)
    await waitFor(() => { expect(writes.some(write => write.path === '/api/dv/operation')).toBe(true) })
    expect(writes.find(write => write.path === '/api/dv/operation')?.body).toMatchObject({
      project: 'p1', operation: 'shot.render_ref2va', surface: 'canvas', based_on: 'g1', session: 's5',
      params: { prompt: 'hero walks through the rain at night in the city' }, inputs: [{ role: 'reference', ref: 'hero@1' }],
    })
    fireEvent.pointerDown(node('g1'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    expect((await view.findByTestId('dv-canvas-node-editor')).textContent).toContain('GPU out of memory')
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

  it('opens the editor centered, moves and resizes it, remembers the rectangle for the next node, and resets on a double click', async () => {
    // jsdom has no layout; a 1200 × 800 canvas area gives the default rectangle 240, 80, 720 × 640.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
    const { view, node } = mount()
    const canvas = view.getByTestId('dv-canvas-view')
    const open = async (id: string): Promise<HTMLElement> => {
      await waitFor(() => { node(id) })
      fireEvent.pointerDown(node(id), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
      fireEvent.pointerUp(canvas, { pointerId: 1 })
      return view.findByTestId('dv-canvas-node-editor')
    }
    const box = (editor: HTMLElement): number[] =>
      [editor.style.left, editor.style.top, editor.style.width, editor.style.height].map(value => parseFloat(value))
    const drag = (target: HTMLElement, dx: number, dy: number): void => {
      fireEvent.pointerDown(target, { button: 0, clientX: 300, clientY: 100, pointerId: 2 })
      fireEvent.pointerMove(target, { clientX: 300 + dx, clientY: 100 + dy, pointerId: 2 })
      fireEvent.pointerUp(target, { clientX: 300 + dx, clientY: 100 + dy, pointerId: 2 })
    }
    let editor = await open('g2')
    expect(box(editor)).toEqual([240, 80, 720, 640])
    drag(view.getByTestId('dv-canvas-editor-title-row'), 50, 30)
    expect(box(editor)).toEqual([290, 110, 720, 640])
    // A press on a title-row button starts no move.
    const close = view.getByRole('button', { name: zh['editor.close'] })
    fireEvent.pointerDown(close, { button: 0, clientX: 0, clientY: 0, pointerId: 3 })
    fireEvent.pointerMove(close, { clientX: 400, clientY: 400, pointerId: 3 })
    expect(box(editor)).toEqual([290, 110, 720, 640])
    const resize = view.getByRole('button', { name: zh['editor.resize'] })
    drag(resize, 100, 50)
    expect(box(editor)).toEqual([290, 110, 820, 690])
    fireEvent.keyDown(resize, { key: 'ArrowLeft' })
    fireEvent.keyDown(resize, { key: 'ArrowUp' })
    expect(box(editor)).toEqual([290, 110, 804, 674])
    expect(JSON.parse(window.localStorage.getItem(EDITOR_RECT_KEY) ?? 'null')).toEqual({ x: 290, y: 110, width: 804, height: 674 })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    editor = await open('g1')
    expect(box(editor)).toEqual([290, 110, 804, 674])
    fireEvent.doubleClick(view.getByTestId('dv-canvas-editor-title-row'))
    expect(box(editor)).toEqual([240, 80, 720, 640])
    expect(window.localStorage.getItem(EDITOR_RECT_KEY)).toBeNull()
    fireEvent.click(view.getByRole('button', { name: zh['editor.close'] }))
    expect(view.queryByTestId('dv-canvas-node-editor')).toBeNull()
  })

  it('fits a remembered rectangle from a larger window into the canvas', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    window.localStorage.setItem(EDITOR_RECT_KEY, JSON.stringify({ x: 700, y: 300, width: 1000, height: 500 }))
    const { view, node } = mount()
    await waitFor(() => { node('g2') })
    fireEvent.pointerDown(node('g2'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    const editor = await view.findByTestId('dv-canvas-node-editor')
    expect([editor.style.left, editor.style.top, editor.style.width, editor.style.height]).toEqual(['0px', '100px', '800px', '500px'])
  })

  it('a wheel over the floating editor leaves the canvas viewport alone; a wheel over empty canvas zooms it', async () => {
    const { view, node } = mount()
    await waitFor(() => { node('plan:p1') })
    fireEvent.pointerDown(node('plan:p1'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    const editor = await view.findByTestId('dv-canvas-node-editor')
    const canvas = view.getByTestId('dv-canvas-view')
    const transform = (): string => (canvas.querySelector('div[style*="transform"]') as HTMLElement).style.transform
    const before = transform()
    const overEditor = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
    act(() => { (editor.querySelector('li') ?? editor).dispatchEvent(overEditor) })
    expect(overEditor.defaultPrevented).toBe(false)
    expect(transform()).toBe(before)
    const overCanvas = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
    act(() => { canvas.dispatchEvent(overCanvas) })
    expect(overCanvas.defaultPrevented).toBe(true)
    expect(transform()).not.toBe(before)
  })

  it('the plan editor marks a version replaced before approval as 已被第 {n} 版取代 and shows each shot\'s reference images', async () => {
    const { view, node } = mount(true, (state) => {
      const [v1] = state.components.plan.plans['p1'] ?? []
      if (v1 === undefined) throw new Error('fixture lacks plan p1')
      const v3 = {
        ...v1, version: 3, approved_by: null, references: ['hero@1'],
        shots: [{ prompt: '<Picture 1> walks in the rain', mode: 'ref2va' as const }, { prompt: 'the sky clears', mode: 't2va' as const }],
      }
      state.components.plan.plans['p1'] = [v1, { ...v1, version: 2, approved_by: null }, v3]
    })
    await waitFor(() => { node('plan:p1') })
    fireEvent.pointerDown(node('plan:p1'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    const editor = await view.findByTestId('dv-canvas-node-editor')
    const status = (version: number): string => {
      fireEvent.click(view.getByRole('button', { name: `第 ${String(version)} 版` }))
      return view.getByTestId('dv-canvas-plan-status').textContent ?? ''
    }
    expect([status(1), status(2), status(3)]).toEqual([zh['editor.planApproved'], '已被第 3 版取代', zh['editor.planPending']])
    // v3's shot renders from Hero's reference image: a "Picture 1 · Hero" chip, and the image in place of <Picture 1> and its brackets.
    const shot = editor.querySelector('li[data-shot="1"]')
    expect([...shot?.querySelectorAll('img') ?? []].map(image => [image.getAttribute('alt'), image.getAttribute('src')?.includes('ref.png')]))
      .toEqual([['', true], ['<Picture 1>', true]])
    expect(shot?.textContent).toContain('Picture 1 · Hero')
    expect(shot?.querySelector('p')?.textContent).toBe(' walks in the rain')
    expect(shot?.textContent).toContain(zh['editor.firstFrameNone'])
    // A text shot shows its render mode and no reference images.
    const textShot = editor.querySelector('li[data-shot="2"]')
    expect(textShot?.querySelectorAll('img')).toHaveLength(0)
    expect(textShot?.querySelector('[data-testid="dv-canvas-shot-mode"]')?.textContent).toBe(zh['mode.t2va'])
    expect(textShot?.textContent).toContain(zh['editor.textOnlyReferences'])
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
