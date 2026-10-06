// @vitest-environment jsdom
/** The cuts editor over a scripted API: video tabs, the track, and each gesture as a record that names its video. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { VhClient } from '@video-harness/ui-kit/api.ts'
import { getCurrentEpisode, publishCurrentEpisode } from '@video-harness/ui-kit/current-episode.ts'
import type { WireState } from '@video-harness/ui-kit/types.ts'
import { asset, fixtureState, scriptedFetch } from '../../ui-kit/tests/fixture.client.tsx'
import { CutsView } from '../src/client/CutsView.tsx'
import { placeVideo } from '../src/client/sequences.ts'

beforeEach(() => { document.documentElement.lang = 'zh-CN' })
afterEach(() => { cleanup(); vi.restoreAllMocks(); publishCurrentEpisode('p1', null) })

/** The shared fixture without its open drafts, with a second video holding one uploaded clip. */
function twoVideos(): WireState {
  const state = fixtureState()
  state.heads = { main: state.heads['main'] ?? 's1' }
  state.assets.push(asset('upload.mp4', 'video/mp4', null, 3))
  state.sequences = [
    { id: 'v1', title: '第 1 集', items: state.sequence?.items ?? [] },
    { id: 'v2', title: '第 2 集', items: [{ slot: 1, assetId: 'upload.mp4', inSec: null, outSec: null }] },
  ]
  return state
}

function mount() {
  const { fetch, writes } = scriptedFetch({ state: twoVideos })
  const view = render(<CutsView projectId="p1" branch="main" client={new VhClient(fetch)} />)
  const clip = (slot: number): HTMLElement => {
    const element = view.container.querySelector(`[data-clip-slot="${String(slot)}"]`)
    if (!(element instanceof HTMLElement)) throw new Error(`no clip ${String(slot)}`)
    return element
  }
  const invokes = (): Array<Record<string, unknown>> => writes.filter(write => write.path === '/api/vh/invoke').map(write => write.body as Record<string, unknown>)
  return { view, writes, clip, invokes, track: () => view.findByRole('list', { name: '视频轨道' }) }
}

describe('CutsView', () => {
  it('shows one tab per video and lays the clips out by their in and out points', async () => {
    const { view, clip, track } = mount()
    await track()
    expect(view.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['第 1 集', '第 2 集'])
    expect(clip(1).style.width).toBe('160px')
    expect(clip(2).style.width).toBe('120px')
    expect(clip(2).getAttribute('data-clip-stale')).toBe('true')
    expect(view.getByTestId('vh-cuts-time').textContent).toBe('0:00.0 / 0:07.0')
    await waitFor(() => { expect(getCurrentEpisode()).toEqual({ projectId: 'p1', episodeId: 'v1' }) })
    fireEvent.click(view.getAllByRole('tab')[1] as HTMLElement)
    expect(view.container.querySelectorAll('[data-clip-slot]')).toHaveLength(1)
  })

  it('writes delete, split, reorder, trim, new video, and insert as sequence records of the shown video', async () => {
    const { view, clip, invokes, writes, track } = mount()
    await track()
    fireEvent.pointerDown(clip(2), { clientX: 0 })
    fireEvent.pointerUp(clip(2), { clientX: 0 })
    await waitFor(() => { expect(writes.some(write => write.path === '/api/vh/selection')).toBe(true) })
    fireEvent.keyDown(view.getByTestId('vh-cuts'), { key: 'Delete' })
    await waitFor(() => { expect(invokes()).toHaveLength(1) })
    expect(invokes()[0]).toMatchObject({ project: 'p1', surface: 'timeline', tool: 'sequence.remove', params: { sequence: 'v1', slot: 2 } })

    fireEvent.pointerDown(view.getByTestId('vh-cuts-ruler'), { clientX: 60 })
    fireEvent.pointerUp(view.getByTestId('vh-cuts-ruler'), { clientX: 60 })
    fireEvent.click(view.getByText('分割'))
    await waitFor(() => { expect(invokes()).toHaveLength(2) })
    expect(invokes()[1]).toMatchObject({ tool: 'sequence.split', params: { sequence: 'v1', slot: 1, atSec: 1.5 } })

    fireEvent.pointerDown(clip(1), { clientX: 0 })
    fireEvent.pointerMove(clip(1), { clientX: 200 })
    fireEvent.pointerUp(clip(1), { clientX: 200 })
    await waitFor(() => { expect(invokes()).toHaveLength(3) })
    expect(invokes()[2]).toMatchObject({ tool: 'sequence.move', params: { sequence: 'v1', from: 1, to: 2 } })

    const start = within(clip(1)).getByLabelText('拖动裁剪第 1 段的开头')
    fireEvent.pointerDown(start, { clientX: 0 })
    fireEvent.pointerMove(start, { clientX: 40 })
    fireEvent.pointerUp(start, { clientX: 40 })
    await waitFor(() => { expect(invokes()).toHaveLength(4) })
    expect(invokes()[3]).toMatchObject({ tool: 'sequence.set_range', params: { sequence: 'v1', slot: 1, inSec: 1, outSec: null } })

    fireEvent.click(view.getByText('＋ 新建'))
    await waitFor(() => { expect(invokes()).toHaveLength(5) })
    expect(invokes()[4]).toMatchObject({ tool: 'sequence.create', params: { sequence: 'v3', title: '第 3 集', assets: [] } })

    fireEvent.click(view.getAllByRole('tab')[1] as HTMLElement)
    fireEvent.click(view.getByLabelText('添加片段'))
    fireEvent.click(within(view.getByRole('dialog')).getByText('shot1.mp4'))
    await waitFor(() => { expect(invokes()).toHaveLength(6) })
    expect(invokes()[5]).toMatchObject({ tool: 'sequence.insert', params: { sequence: 'v2', at: 2, asset: 'shot1.mp4' } })
  })

  it('resets the viewer and playhead when another video is shown, and blanks the viewer for a video without clips', async () => {
    const { fetch } = scriptedFetch({
      state: () => {
        const state = twoVideos()
        state.sequences?.push({ id: 'v3', title: '第 3 集', items: [] })
        return state
      },
    })
    const view = render(<CutsView projectId="p1" branch="main" client={new VhClient(fetch)} />)
    await view.findByRole('list', { name: '视频轨道' })
    const frames = (): HTMLVideoElement[] => [...view.getByTestId('vh-cuts-viewer').querySelectorAll('video')]
    expect(frames()[0]?.getAttribute('src')).toBe('/vh/assets/shot1.mp4/content')
    fireEvent.pointerDown(view.getByTestId('vh-cuts-ruler'), { clientX: 200 })
    fireEvent.pointerUp(view.getByTestId('vh-cuts-ruler'), { clientX: 200 })
    expect(view.getByTestId('vh-cuts-time').textContent).toBe('0:05.0 / 0:07.0')

    await waitFor(() => { expect(getCurrentEpisode()).toEqual({ projectId: 'p1', episodeId: 'v1' }) })
    fireEvent.click(view.getAllByRole('tab')[1] as HTMLElement)
    expect(view.getByTestId('vh-cuts-time').textContent).toBe('0:00.0 / 0:03.0')
    expect(frames()[0]?.getAttribute('src')).toBe('/vh/assets/upload.mp4/content')

    fireEvent.click(view.getAllByRole('tab')[2] as HTMLElement)
    expect(view.getByTestId('vh-cuts-time').textContent).toBe('0:00.0 / 0:00.0')
    expect(frames().map(frame => frame.hasAttribute('src'))).toEqual([false, false])
    expect(frames().map(frame => frame.style.visibility)).toEqual(['hidden', 'hidden'])
    expect(view.getByTestId('vh-cuts-viewer-empty').textContent).toBe('这一集还没有片段，从素材拖入或点 ＋ 添加')
  })

  it('shares the selected episode on window and follows an episode another bundle publishes', async () => {
    const { view, track } = mount()
    await track()
    await waitFor(() => { expect(getCurrentEpisode()).toEqual({ projectId: 'p1', episodeId: 'v1' }) })
    fireEvent.click(view.getAllByRole('tab')[1] as HTMLElement)
    expect(getCurrentEpisode()).toEqual({ projectId: 'p1', episodeId: 'v2' })
    act(() => { publishCurrentEpisode('p1', 'v1') })
    expect(view.getAllByRole('tab').map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false'])
  })

  it('renames an episode by double-click and deletes it from the tab menu after a confirmation', async () => {
    const { view, invokes, track } = mount()
    await track()
    await waitFor(() => { expect(getCurrentEpisode()).toEqual({ projectId: 'p1', episodeId: 'v1' }) })
    fireEvent.doubleClick(view.getAllByRole('tab')[1] as HTMLElement)
    const box = within(view.getByRole('tablist')).getByRole('textbox')
    fireEvent.change(box, { target: { value: '片尾' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => { expect(invokes()).toHaveLength(1) })
    expect(invokes()[0]).toMatchObject({ tool: 'sequence.rename', params: { sequence: 'v2', title: '片尾' } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.contextMenu(view.getAllByRole('tab')[1] as HTMLElement)
    fireEvent.click(view.getByRole('menuitem', { name: '删除这一集' }))
    await waitFor(() => { expect(invokes()).toHaveLength(2) })
    expect(invokes()[1]).toMatchObject({ tool: 'sequence.delete', params: { sequence: 'v2' } })
  })

  it('shows an open agent draft read-only with a note instead of the main state', async () => {
    const { fetch } = scriptedFetch({ state: fixtureState })
    const view = render(<CutsView projectId="p1" branch="main" client={new VhClient(fetch)} />)
    await view.findByText('agent 的草稿还没确认，虚线框的片段来自草稿。接受或丢弃草稿后才能修改。')
    expect((view.getByText('分割') as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps a dropped file from reaching document listeners and explains that the track takes assets only', async () => {
    const { view, invokes, track } = mount()
    await track()
    const seen = vi.fn()
    document.addEventListener('drop', seen)
    fireEvent.drop(await track(), { dataTransfer: { types: ['Files'], files: [], getData: () => '' } })
    document.removeEventListener('drop', seen)
    expect(seen).not.toHaveBeenCalled()
    expect(invokes()).toHaveLength(0)
    expect(view.getByRole('status').textContent).toBe('剪辑只接受素材里的视频。请先把文件拖到对话里上传，再从素材拖到轨道上。')
  })

  it('marks only the clips a shown draft adds, and none on main', () => {
    const state = twoVideos()
    const base = state.sequences?.[0]?.items ?? []
    const added = { slot: base.length + 1, assetId: 'upload.mp4', inSec: null, outSec: null }
    const video = { id: 'v1', title: '', items: [...base, added] }
    expect(placeVideo(state, video, 'draft/t9', base).clips.map(clip => clip.draft)).toEqual([...base.map(() => false), true])
    expect(placeVideo(state, video, 'main', base).clips.some(clip => clip.draft)).toBe(false)
  })

  it('shows English copy and default episode titles when the DSH language is English', async () => {
    document.documentElement.lang = 'en'
    const { view } = mount()
    await view.findByRole('list', { name: 'Video track' })
    expect(view.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Episode 1', 'Episode 2'])
    expect(view.getByText('Split')).toBeTruthy()
  })

  it('exports by cutting ranged clips first and joining all clips in order', async () => {
    const { view, invokes, track } = mount()
    await track()
    fireEvent.click(view.getByText('导出'))
    await waitFor(() => { expect(view.getByTestId('vh-cuts-exported').getAttribute('href')).toBe('/vh/assets/new.mp4/content') })
    expect(invokes().map(body => body['tool'])).toEqual(['clip.trim', 'media.concat'])
    expect(invokes()[0]).toMatchObject({ inputs: [{ role: 'clip', ref: 'shot2.mp4' }], params: { startSec: 1, endSec: 4 } })
    expect(invokes()[1]).toMatchObject({ inputs: [{ role: 'clip', ref: 'shot1.mp4' }, { role: 'clip', ref: 'new.mp4' }] })
  })
})
