// @vitest-environment jsdom
/** The timeline editor over a scripted API: timeline tabs, the track, and each gesture as a record that names its timeline or clip. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { DvClient } from '@dv/ui-kit/api.ts'
import { getCurrentTimeline, publishCurrentTimeline } from '@dv/ui-kit/current-timeline.ts'
import type { WireState } from '@dv/ui-kit/types.ts'
import { asset, fixtureState, record, scriptedFetch } from '../../ui-kit/tests/fixture.client.tsx'
import { FALLBACK_CLIP_SECONDS } from '@dv/ui-kit/timeline.ts'
import { TimelineView } from '../src/client/TimelineView.tsx'
import { placeTimeline } from '../src/client/timelines.ts'

beforeEach(() => { document.documentElement.lang = 'zh-CN' })
afterEach(() => { cleanup(); vi.restoreAllMocks(); publishCurrentTimeline('p1', null) })

/** The shared fixture with a second timeline holding one imported clip. */
function twoTimelines(): WireState {
  const state = fixtureState()
  state.assets.push(asset('imported.mp4', 'video/mp4', null, 3))
  state.components.timeline.timelines.push({ id: 't2', name: '片尾', clips: [{ id: 'cl3', asset: 'imported.mp4', source: null, in_sec: null, out_sec: null }] })
  return state
}

function mount() {
  const { fetch, writes } = scriptedFetch({ state: twoTimelines })
  const view = render(<TimelineView projectId="p1" client={new DvClient(fetch)} />)
  const clip = (position: number): HTMLElement => {
    const element = view.container.querySelector(`[data-clip-position="${String(position)}"]`)
    if (!(element instanceof HTMLElement)) throw new Error(`no clip ${String(position)}`)
    return element
  }
  const requests = (): Array<Record<string, unknown>> => writes.filter(write => write.path === '/api/dv/operation').map(write => write.body as Record<string, unknown>)
  return { view, writes, clip, requests, track: () => view.findByRole('list', { name: '视频轨道' }) }
}

describe('TimelineView', () => {
  it('shows one tab per timeline and lays the clips out by their in and out points', async () => {
    const { view, clip, track } = mount()
    await track()
    expect(view.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['时间线 1', '片尾'])
    expect(clip(1).style.width).toBe('160px')
    expect(clip(2).style.width).toBe('120px')
    expect(clip(2).getAttribute('data-clip-stale')).toBe('true')
    expect(clip(2).getAttribute('data-clip')).toBe('cl2')
    expect(view.getByTestId('dv-timeline-time').textContent).toBe('0:00.0 / 0:07.0')
    await waitFor(() => { expect(getCurrentTimeline()).toEqual({ projectId: 'p1', timelineId: 't1' }) })
    fireEvent.click(view.getAllByRole('tab')[1] as HTMLElement)
    expect(view.container.querySelectorAll('[data-clip]')).toHaveLength(1)
  })

  it('offers 仍然保留 for a selected stale clip, which accepts the record behind its asset', async () => {
    const { view, clip, writes, track } = mount()
    await track()
    fireEvent.pointerDown(clip(1), { clientX: 0 })
    fireEvent.pointerUp(clip(1), { clientX: 0 })
    expect(view.queryByRole('button', { name: '仍然保留' })).toBeNull()
    fireEvent.pointerDown(clip(2), { clientX: 0 })
    fireEvent.pointerUp(clip(2), { clientX: 0 })
    fireEvent.click(view.getByRole('button', { name: '仍然保留' }))
    await waitFor(() => { expect(writes.some(write => write.path === '/api/dv/stale/accept')).toBe(true) })
    expect(writes.find(write => write.path === '/api/dv/stale/accept')?.body).toEqual({ project: 'p1', record: 'g2', surface: 'timeline' })
  })

  it('writes remove, split, move, trim, create, and insert as timeline records of the shown timeline', async () => {
    const { view, clip, requests, track } = mount()
    await track()
    fireEvent.pointerDown(clip(2), { clientX: 0 })
    fireEvent.pointerUp(clip(2), { clientX: 0 })
    await waitFor(() => { expect(clip(2).getAttribute('aria-pressed')).toBe('true') })
    fireEvent.keyDown(view.getByTestId('dv-timeline-editor'), { key: 'Delete' })
    await waitFor(() => { expect(requests()).toHaveLength(1) })
    expect(requests()[0]).toMatchObject({ project: 'p1', surface: 'timeline', operation: 'timeline.clip_remove', params: { clip: 'cl2' } })
    // A clip operation names the clip by its clip ID alone; only an insert names the timeline.
    expect(requests()[0]?.['params']).toEqual({ clip: 'cl2' })

    fireEvent.pointerDown(view.getByTestId('dv-timeline-ruler'), { clientX: 60 })
    fireEvent.pointerUp(view.getByTestId('dv-timeline-ruler'), { clientX: 60 })
    fireEvent.click(view.getByText('拆分'))
    await waitFor(() => { expect(requests()).toHaveLength(2) })
    expect(requests()[1]).toMatchObject({ operation: 'timeline.clip_split', params: { clip: 'cl1', at_sec: 1.5 } })

    fireEvent.pointerDown(clip(1), { clientX: 0 })
    fireEvent.pointerMove(clip(1), { clientX: 200 })
    fireEvent.pointerUp(clip(1), { clientX: 200 })
    await waitFor(() => { expect(requests()).toHaveLength(3) })
    expect(requests()[2]).toMatchObject({ operation: 'timeline.clip_move', params: { clip: 'cl1', to: 2 } })

    const start = within(clip(1)).getByLabelText('拖动裁剪片段 1 的开头')
    fireEvent.pointerDown(start, { clientX: 0 })
    fireEvent.pointerMove(start, { clientX: 40 })
    fireEvent.pointerUp(start, { clientX: 40 })
    await waitFor(() => { expect(requests()).toHaveLength(4) })
    expect(requests()[3]).toMatchObject({ operation: 'timeline.clip_trim', params: { clip: 'cl1', in_sec: 1 } })
    expect(requests()[3]?.['params']).not.toHaveProperty('out_sec')

    fireEvent.click(view.getByText('＋ 新建'))
    await waitFor(() => { expect(requests()).toHaveLength(5) })
    expect(requests()[4]).toMatchObject({ operation: 'timeline.create', params: { timeline: 't3', assets: [] }, intent: '在时间线里新建 时间线 3' })
    expect(requests()[4]?.['params']).not.toHaveProperty('name')

    fireEvent.click(view.getAllByRole('tab')[1] as HTMLElement)
    fireEvent.click(view.getByLabelText('插入片段'))
    fireEvent.click(within(view.getByRole('dialog')).getByText('shot1.mp4'))
    await waitFor(() => { expect(requests()).toHaveLength(6) })
    expect(requests()[5]).toMatchObject({ operation: 'timeline.clip_insert', params: { timeline: 't2', at: 2, asset: 'shot1.mp4' } })
  })

  it('resets the viewer and playhead when another timeline is shown, and blanks the viewer for a timeline without clips', async () => {
    const { fetch } = scriptedFetch({
      state: () => {
        const state = twoTimelines()
        state.components.timeline.timelines.push({ id: 't3', name: '', clips: [] })
        return state
      },
    })
    const view = render(<TimelineView projectId="p1" client={new DvClient(fetch)} />)
    await view.findByRole('list', { name: '视频轨道' })
    const frames = (): HTMLVideoElement[] => [...view.getByTestId('dv-timeline-viewer').querySelectorAll('video')]
    expect(frames()[0]?.getAttribute('src')).toBe('/dv/assets/shot1.mp4')
    fireEvent.pointerDown(view.getByTestId('dv-timeline-ruler'), { clientX: 200 })
    fireEvent.pointerUp(view.getByTestId('dv-timeline-ruler'), { clientX: 200 })
    expect(view.getByTestId('dv-timeline-time').textContent).toBe('0:05.0 / 0:07.0')

    await waitFor(() => { expect(getCurrentTimeline()).toEqual({ projectId: 'p1', timelineId: 't1' }) })
    fireEvent.click(view.getAllByRole('tab')[1] as HTMLElement)
    expect(view.getByTestId('dv-timeline-time').textContent).toBe('0:00.0 / 0:03.0')
    expect(frames()[0]?.getAttribute('src')).toBe('/dv/assets/imported.mp4')

    fireEvent.click(view.getAllByRole('tab')[2] as HTMLElement)
    expect(view.getByTestId('dv-timeline-time').textContent).toBe('0:00.0 / 0:00.0')
    expect(frames().map(frame => frame.hasAttribute('src'))).toEqual([false, false])
    expect(frames().map(frame => frame.style.visibility)).toEqual(['hidden', 'hidden'])
    expect(view.getByTestId('dv-timeline-viewer-empty').textContent).toBe('这条时间线还没有片段，从素材库拖入或点 ＋ 插入')
  })

  it('shares the selected timeline on window and follows a timeline another bundle publishes', async () => {
    const { view, track } = mount()
    await track()
    await waitFor(() => { expect(getCurrentTimeline()).toEqual({ projectId: 'p1', timelineId: 't1' }) })
    fireEvent.click(view.getAllByRole('tab')[1] as HTMLElement)
    expect(getCurrentTimeline()).toEqual({ projectId: 'p1', timelineId: 't2' })
    act(() => { publishCurrentTimeline('p1', 't1') })
    expect(view.getAllByRole('tab').map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false'])
  })

  it('renames a timeline by double-click and deletes it from the tab menu after a confirmation', async () => {
    const { view, requests, track } = mount()
    await track()
    await waitFor(() => { expect(getCurrentTimeline()).toEqual({ projectId: 'p1', timelineId: 't1' }) })
    fireEvent.doubleClick(view.getAllByRole('tab')[1] as HTMLElement)
    const box = within(view.getByRole('tablist')).getByRole('textbox')
    fireEvent.change(box, { target: { value: '结尾' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => { expect(requests()).toHaveLength(1) })
    expect(requests()[0]).toMatchObject({ operation: 'timeline.rename', params: { timeline: 't2', name: '结尾' } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.contextMenu(view.getAllByRole('tab')[1] as HTMLElement)
    fireEvent.click(view.getByRole('menuitem', { name: '删除时间线' }))
    await waitFor(() => { expect(requests()).toHaveLength(2) })
    expect(requests()[1]).toMatchObject({ operation: 'timeline.delete', params: { timeline: 't2' } })
  })

  it('edits the project at once, with the chat session beside it recorded on each edit; undo and redo move the current position', async () => {
    const { fetch, writes } = scriptedFetch({ state: () => ({ ...fixtureState(), tip: 'later' }) })
    const editing = render(<TimelineView projectId="p1" session="s5" client={new DvClient(fetch)} />)
    await waitFor(() => { expect((editing.getByText('拆分') as HTMLButtonElement).disabled).toBe(false) })
    // Redo is enabled while a step lies after the current position.
    expect((editing.getByText('重做') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(editing.getByText('撤销'))
    fireEvent.click(editing.getByText('重做'))
    await waitFor(() => {
      expect(writes.filter(write => write.path === '/api/dv/undo' || write.path === '/api/dv/redo')).toEqual([
        { path: '/api/dv/undo', body: { project: 'p1' } }, { path: '/api/dv/redo', body: { project: 'p1' } },
      ])
    })
    fireEvent.contextMenu(editing.getAllByRole('tab')[0] as HTMLElement)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(editing.getByRole('menuitem', { name: '删除时间线' }))
    await waitFor(() => { expect(writes.find(write => write.path === '/api/dv/operation')?.body).toMatchObject({ session: 's5', operation: 'timeline.delete' }) })
  })

  it('keeps a dropped file from reaching document listeners and explains that the track takes assets only', async () => {
    const { view, requests, track } = mount()
    await track()
    const seen = vi.fn()
    document.addEventListener('drop', seen)
    fireEvent.drop(await track(), { dataTransfer: { types: ['Files'], files: [], getData: () => '' } })
    document.removeEventListener('drop', seen)
    expect(seen).not.toHaveBeenCalled()
    expect(requests()).toHaveLength(0)
    expect(view.getByRole('status').textContent).toBe('时间线轨道只接受素材库里的视频。请先在对话里导入文件，再从素材库拖到轨道上。')
  })

  it('places a placeholder clip at its render length, marks it rendering or failed, and holds export until it is ready', async () => {
    const state = twoTimelines()
    state.components.proj.records.push(
      record({ id: 'r8', operation: 'shot.render_ref2va', status: 'running', params: { duration_sec: 2 } }),
      record({ id: 'r9', operation: 'shot.render_ref2va', status: 'failed', params: {} }),
    )
    const timeline = state.components.timeline.timelines[0]
    timeline?.clips.push(
      { id: 'cl8', asset: null, source: { record: 'r8', output: 0 }, in_sec: null, out_sec: null },
      { id: 'cl9', asset: null, source: { record: 'r9', output: 0 }, in_sec: null, out_sec: null },
    )
    const placed = placeTimeline(state, timeline ?? null).clips.slice(-2)
    expect(placed.map(clip => [clip.status, clip.seconds])).toEqual([['rendering', 2], ['failed', FALLBACK_CLIP_SECONDS]])
    const { fetch } = scriptedFetch({ state: () => state })
    const view = render(<TimelineView projectId="p1" client={new DvClient(fetch)} />)
    await view.findByRole('list', { name: '视频轨道' })
    expect(view.container.querySelector('[data-clip="cl8"]')?.getAttribute('title')).toContain('渲染中…')
    expect(view.container.querySelector('[data-clip="cl9"]')?.getAttribute('title')).toContain('渲染失败')
    expect(view.container.querySelectorAll('[data-clip="cl8"] [data-trim]')).toHaveLength(0)
    expect(view.getByTestId('dv-timeline-export-waiting').textContent).toBe('片段 3, 4 还没就绪，全部就绪后才能导出')
    expect((view.getByText('导出') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows English copy and default timeline names when the DSH language is English', async () => {
    document.documentElement.lang = 'en'
    const { view } = mount()
    await view.findByRole('list', { name: 'Video track' })
    expect(view.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Timeline 1', '片尾'])
    expect(view.getByText('Split')).toBeTruthy()
  })

  it('exports the shown timeline with one deliver.timeline_export call', async () => {
    const { view, requests, track } = mount()
    await track()
    fireEvent.click(view.getByText('导出'))
    await waitFor(() => { expect(view.getByTestId('dv-timeline-exported').getAttribute('href')).toBe('/dv/assets/new.mp4') })
    expect(requests().map(body => body['operation'])).toEqual(['deliver.timeline_export'])
    expect(requests()[0]).toMatchObject({ params: { timeline: 't1' } })
  })
})
