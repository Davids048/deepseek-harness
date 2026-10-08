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
import type { CanvasTranslate } from '../src/client/NodeCard.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

/**
 * Mount the canvas over scripted `/api/dv` routes and a scripted layout route.
 * @param withTranslate - whether the host passes the Chinese translate.
 * @param edit - changes to the fixture state.
 * @param stored - the canvas list the layout route returns.
 * @returns the rendered view, the recorded writes, and a node lookup.
 */
function mount(withTranslate = true, edit: (state: WireState) => void = () => undefined, stored: { placed: string[] } = { placed: [] }) {
  // The project's current branch is b2, which holds the retake g3; the view asks for the current branch by name.
  const branches: Array<string | null> = []
  const scripted = scriptedFetch({
    state: () => {
      const state = fixtureState()
      edit(state)
      return { ...state, branch: 'b2', current: 'b2' }
    },
  })
  const layoutWrites: unknown[] = []
  const fetchWithLayout: typeof fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/dv/state')) branches.push(new URL(input, 'http://host').searchParams.get('branch'))
    if (typeof input === 'string' && input.startsWith('/api/dv/layout')) {
      if (init?.method === 'POST') layoutWrites.push(JSON.parse(String(init.body)))
      const layout = { positions: { g1: { x: 10, y: 20 } }, viewport: { x: 0, y: 0, zoom: 1 }, placed: stored.placed }
      return Promise.resolve(new Response(JSON.stringify(layout)))
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
  return { view, writes: scripted.writes, layoutWrites, node, branches }
}

describe('CanvasView', () => {
  it('draws the project\'s current branch with nodes at stored positions, and stores a dragged position', async () => {
    const { view, node, layoutWrites, branches } = mount()
    await waitFor(() => { node('g3') })
    expect(branches.every(branch => branch === null)).toBe(true)
    expect(node('g1').style.left).toBe('10px')
    expect(node('g3').hasAttribute('data-node-draft')).toBe(false)
    expect(node('g2').getAttribute('data-node-stale')).toBe('true')
    expect(view.getByText(zh['badge.trim'])).toBeTruthy()
    // The center canvas has no branch bar; the shell shows the branch switcher above it.
    expect(view.queryByTestId('dv-kit-branch-switcher')).toBeNull()
    fireEvent.pointerDown(node('g2'), { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(view.getByTestId('dv-canvas-view'), { clientX: 50, clientY: 30, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    await waitFor(() => { expect(layoutWrites).toHaveLength(1) }, { timeout: 2000 })
    expect(layoutWrites[0]).toMatchObject({ project: 'p1', positions: { g2: { x: 1080 + 50, y: 0 + 30 } } })
  })

  it('draws a character as its name and a row of up to four reference images with a count of the rest', async () => {
    const references = ['ref.png', 'r2.png', 'r3.png', 'r4.png', 'r5.png', 'r6.png']
    const { node } = mount(true, (state) => {
      state.assets.push(...references.slice(1).map(id => asset(id, 'image/png', 'u1')))
      const hero = state.components.bible.characters['hero']?.[0]
      if (hero !== undefined) hero.references = references
    })
    await waitFor(() => { node('bible:hero') })
    const card = node('bible:hero')
    expect([...card.querySelectorAll('img')].map(image => image.getAttribute('src'))).toEqual(references.slice(0, 4).map(id => assetUrl(id)))
    expect(card.textContent).toContain(zh['node.character'])
    expect(card.textContent).toContain('Hero')
    expect(card.textContent).toContain('+2')
  })

  it('puts a dropped 素材 tile on the canvas list under the pointer, and 从画布移除 takes it off the list', async () => {
    const { view, node, layoutWrites } = mount(true, (state) => {
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
    await waitFor(() => { expect(node('u2').style.left).toBe(`${String(500 - 280 / 2)}px`) })
    await waitFor(() => { expect(layoutWrites).toContainEqual({ project: 'p1', placed: ['pool.png'] }) })
    fireEvent.pointerDown(node('u2'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(view.getByTestId('dv-canvas-view'), { pointerId: 1 })
    fireEvent.click(await view.findByText(zh['editor.removeFromCanvas']))
    await waitFor(() => { expect(view.container.querySelector('[data-node-id="u2"]')).toBeNull() })
    await waitFor(() => { expect(layoutWrites).toContainEqual({ project: 'p1', removed: ['pool.png'] }) })
  })

  it('draws an asset that another view put on the canvas list once the state refetches', async () => {
    const stored = { placed: [] as string[] }
    const { view, node } = mount(true, (state) => {
      state.assets.push(asset('chat.png', 'image/png', 'u2'))
      state.components.proj.records.push(record({ id: 'u2', operation: 'asset.import', params: { name: 'chat.png' }, outputs: ['chat.png'], surface: 'chat' }))
      state.components.proj.created_by['chat.png'] = 'u2'
    }, stored)
    await waitFor(() => { node('g1') })
    expect(view.container.querySelector('[data-node-id="u2"]')).toBeNull()
    // The chat composer placed the sent image; the next state refetch (a 3-second poll without EventSource) reads the list.
    stored.placed = ['chat.png']
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

  it('the plan editor marks a version replaced before approval as 已被 v{n} 取代 and shows each shot\'s reference images', async () => {
    const { view, node } = mount(true, (state) => {
      const [v1] = state.components.plan.plans['p1'] ?? []
      if (v1 === undefined) throw new Error('fixture lacks plan p1')
      const v3 = {
        ...v1, version: 3, approved_by: null, references: ['hero@1'],
        shots: [{ prompt: 'Picture 1 walks in the rain', mode: 'ref2va' as const }, { prompt: 'the sky clears', mode: 't2va' as const }],
      }
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
    expect(shot?.textContent).toBe(` walks in the rain${zh['mode.ref2va']}`)
    // A text shot shows its render mode and no reference images.
    const textShot = editor.querySelector('li[data-shot="2"]')
    expect(textShot?.querySelectorAll('img')).toHaveLength(0)
    expect(textShot?.querySelector('[data-testid="dv-canvas-shot-mode"]')?.textContent).toBe(zh['mode.t2va'])
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
