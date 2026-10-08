// @vitest-environment jsdom
/** The DreamVerse thumbnail cards of chat Markdown: element selection, the cards, and the chain registration. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownElement, MarkdownTableCell } from '@deepseek-ai/dsh-client-ui-primitives'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { DvClient } from '@dv/ui-kit/api.ts'
import { publishCurrentProject } from '@dv/ui-kit/current-project.ts'
import { followAssetKinds, kindOf, NO_ASSET_KINDS, type AssetKinds } from '../src/client/asset-kinds.ts'
import { assetIdOf, registerChatMedia, selectChatMedia, type ChatMedia } from '../src/client/chat-media.ts'
import { ChatMediaView } from '../src/client/ChatMedia.tsx'

const KINDS: AssetKinds = new Map([['v1.mp4', 'video'], ['v2.mp4', 'video'], ['i1.png', 'image']])

const link = (href: string, text = '播放'): MarkdownElement => ({ kind: 'link', href, title: undefined, text })
const cell = (text: string, href?: string): MarkdownTableCell => ({ text, links: href === undefined ? [] : [{ href, text }] })
const table = (...rows: MarkdownTableCell[][]): MarkdownElement => ({
  kind: 'table', header: [cell('镜头'), cell('内容'), cell('视频')], rows,
})

beforeEach(() => { document.documentElement.lang = 'zh-CN' })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  publishCurrentProject(null)
})

describe('selectChatMedia', () => {
  it('turns a link to a video asset into a card, with root-relative and absolute destinations', () => {
    expect(selectChatMedia(link('/dv/assets/v1.mp4'), KINDS)).toEqual({ kind: 'video', asset: 'v1.mp4', label: '播放' })
    expect(selectChatMedia(link('http://host:8080/dv/assets/v%32.mp4'), KINDS)).toEqual({ kind: 'video', asset: 'v2.mp4', label: '播放' })
  })

  it('keeps links to image assets, unknown assets, and other paths', () => {
    expect(selectChatMedia(link('/dv/assets/i1.png'), KINDS)).toBeNull()
    expect(selectChatMedia(link('/dv/assets/missing.mp4'), KINDS)).toBeNull()
    expect(selectChatMedia(link('/dv/assets/v1.mp4/extra'), KINDS)).toBeNull()
    expect(selectChatMedia(link('https://example.com/v1.mp4'), KINDS)).toBeNull()
    expect(selectChatMedia(link('/dv/assets/v1.mp4'), NO_ASSET_KINDS)).toBeNull()
  })

  it('names no asset for an unparsable destination or a malformed escape', () => {
    expect(assetIdOf('http://')).toBeUndefined()
    expect(assetIdOf('/dv/assets/%E0%A4%A')).toBeUndefined()
  })

  it('turns an image of an image asset into a thumbnail and keeps an image of a video', () => {
    const image = (src: string): MarkdownElement => ({ kind: 'image', src, alt: '定妆照', title: undefined })
    expect(selectChatMedia(image('/dv/assets/i1.png'), KINDS)).toEqual({ kind: 'image', asset: 'i1.png', alt: '定妆照' })
    expect(selectChatMedia(image('/dv/assets/v1.mp4'), KINDS)).toBeNull()
  })

  it('turns a table whose every body row links a video into a grid captioned by the other cells', () => {
    expect(selectChatMedia(table(
      [cell('1'), cell('直播间开场「来一把吧」'), cell('播放', '/dv/assets/v1.mp4')],
      [cell('2'), cell(''), cell('播放', '/dv/assets/v2.mp4')],
    ), KINDS)).toEqual({
      kind: 'grid',
      shots: [{ asset: 'v1.mp4', caption: '1 · 直播间开场「来一把吧」' }, { asset: 'v2.mp4', caption: '2' }],
    })
  })

  it('keeps a table with a row that links no video, and a table without body rows', () => {
    expect(selectChatMedia(table(
      [cell('1'), cell('开场'), cell('播放', '/dv/assets/v1.mp4')],
      [cell('2'), cell('特写'), cell('定妆照', '/dv/assets/i1.png')],
    ), KINDS)).toBeNull()
    expect(selectChatMedia(table(), KINDS)).toBeNull()
  })
})

describe('ChatMediaView', () => {
  const view = (matched: ChatMedia) => render(<p><ChatMediaView matched={matched} /></p>)

  it('shows the first frame and plays the video in the card on click', () => {
    const { container } = view({ kind: 'video', asset: 'v1.mp4', label: '播放' })
    const preview = container.querySelector('video')
    expect(preview?.getAttribute('src')).toBe('/dv/assets/v1.mp4#t=0.1')
    expect(preview?.muted).toBe(true)
    expect(preview?.getAttribute('preload')).toBe('metadata')
    expect(preview?.hasAttribute('controls')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '播放: 播放' }))
    const player = container.querySelector('video')
    expect(player?.getAttribute('src')).toBe('/dv/assets/v1.mp4')
    expect(player?.hasAttribute('controls')).toBe(true)
    expect(container.querySelector('a')).toBeNull()
  })

  it('lays out a grid of cards with their captions', () => {
    const { container } = view({ kind: 'grid', shots: [{ asset: 'v1.mp4', caption: '1 · 开场' }, { asset: 'v2.mp4', caption: '' }] })
    expect([...container.querySelectorAll('[data-dv-chat-video]')].map(node => node.getAttribute('data-dv-chat-video')))
      .toEqual(['v1.mp4', 'v2.mp4'])
    expect(screen.getByTitle('1 · 开场').textContent).toBe('1 · 开场')
    expect(screen.getByRole('button', { name: '播放' })).toBeTruthy()
  })

  it('opens an image thumbnail large and closes it, in English', () => {
    document.documentElement.lang = 'en'
    view({ kind: 'image', asset: 'i1.png', alt: 'Costume' })
    expect(screen.getByRole('img', { name: 'Costume' }).getAttribute('src')).toBe('/dv/assets/i1.png')
    fireEvent.click(screen.getByRole('button', { name: 'View large image: Costume' }))
    expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names a thumbnail without alt text by its action', () => {
    view({ kind: 'image', asset: 'i1.png', alt: '' })
    expect(screen.getByRole('button', { name: '查看大图' })).toBeTruthy()
  })
})

/** A project state with the given assets and branches, in the fields the index reads. */
function state(assets: Array<[string, string]>, branches: Array<{ name: string; counts: object | null }> = []) {
  return {
    branches: [{ name: 'main', counts: null }, ...branches],
    assets: assets.map(([id, mime]) => ({ id, mime })),
  }
}

/** Serve `/api/dv/state` from `states`, keyed by `<project>/<branch>`; other keys fail. */
function stateFetch(states: Record<string, unknown>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const query = new URL(url, 'http://dv.invalid').searchParams
    const body = states[`${query.get('project') ?? ''}/${query.get('branch') ?? ''}`]
    return Promise.resolve(body === undefined ? new Response('{}', { status: 404 }) : Response.json(body))
  })
}

/** A browser event stream whose project events the test sends. */
function fakeEvents() {
  const listeners = new Map<string, EventListener>()
  class FakeEventSource {
    constructor(readonly url: string) {}
    addEventListener(type: string, listener: EventListener): void { listeners.set(type, listener) }
    removeEventListener(type: string): void { listeners.delete(type) }
    close(): void {}
  }
  vi.stubGlobal('EventSource', FakeEventSource)
  return { send: () => { listeners.get('record')?.(new MessageEvent('record', { data: 'changed' })) } }
}

describe('followAssetKinds', () => {
  it('reads main and open drafts, follows project events and project changes, and stops', async () => {
    const events = fakeEvents()
    const states: Record<string, unknown> = {
      'p1/main': state([['v1.mp4', 'video/mp4'], ['a1.wav', 'audio/wav']], [{ name: 'draft/s1', counts: {} }, { name: 'old', counts: null }]),
      'p1/draft/s1': state([['i1.png', 'image/png']]),
    }
    const seen: AssetKinds[] = []
    publishCurrentProject('p1')
    const fetchImpl = stateFetch(states)
    const stop = followAssetKinds(new DvClient(fetchImpl), (kinds) => { seen.push(kinds) })
    await vi.waitFor(() => { expect(seen).toHaveLength(1) })
    expect([...seen[0]!]).toEqual([['v1.mp4', 'video'], ['i1.png', 'image']])

    // A burst of events causes one refetch; an unchanged refetch publishes nothing; a new asset publishes again.
    events.send()
    events.send()
    await vi.waitFor(() => { expect(fetchImpl).toHaveBeenCalledTimes(4) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(seen).toHaveLength(1)
    states['p1/main'] = state([['v1.mp4', 'video/mp4'], ['v2.mp4', 'video/mp4']])
    events.send()
    await vi.waitFor(() => { expect(seen).toHaveLength(2) })
    expect([...seen[1]!]).toEqual([['v1.mp4', 'video'], ['v2.mp4', 'video']])

    publishCurrentProject(null)
    expect(seen.at(-1)).toBe(NO_ASSET_KINDS)
    stop()
    publishCurrentProject('p1')
    expect(seen).toHaveLength(3)
  })

  it('drops the fetch of a project closed meanwhile and keeps the last index when a fetch fails', async () => {
    fakeEvents()
    const seen: AssetKinds[] = []
    publishCurrentProject('p1')
    const fetchImpl = stateFetch({ 'p1/main': state([['v1.mp4', 'video/mp4']]) })
    const stop = followAssetKinds(new DvClient(fetchImpl), (kinds) => { seen.push(kinds) })
    publishCurrentProject('gone')
    await vi.waitFor(() => { expect(fetchImpl).toHaveBeenCalledTimes(2) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(seen).toEqual([])
    stop()
  })

  it('maps MIME types to the drawn kinds', () => {
    expect([kindOf('video/mp4'), kindOf('image/webp'), kindOf('audio/mpeg')]).toEqual(['video', 'image', undefined])
  })
})

describe('registerChatMedia', () => {
  it('registers the chain entry while the project has media and removes it when the plugin unloads', async () => {
    fakeEvents()
    vi.stubGlobal('fetch', stateFetch({ 'p1/main': state([['v1.mp4', 'video/mp4']]) }))
    const runtime = await SlotTestRuntime.create()
    await runtime.declare({ 'conversation.chat.markdown': { kind: 'chain', scope: 'session' } })
    const entries = () => runtime.slots.entries('conversation.chat.markdown')
    const plugin = await runtime.mount({ inject: ['slots'], apply: registerChatMedia })
    expect(entries()).toHaveLength(0)

    act(() => { publishCurrentProject('p1') })
    await vi.waitFor(() => { expect(entries()).toHaveLength(1) })
    const select = entries()[0]!.select as (owner: { element: MarkdownElement }) => ChatMedia | null
    expect(select({ element: link('/dv/assets/v1.mp4') })).toEqual({ kind: 'video', asset: 'v1.mp4', label: '播放' })

    act(() => { publishCurrentProject(null) })
    expect(entries()).toHaveLength(0)
    act(() => { publishCurrentProject('p1') })
    await vi.waitFor(() => { expect(entries()).toHaveLength(1) })

    await plugin.dispose()
    expect(entries()).toHaveLength(0)
    act(() => { publishCurrentProject(null) })
    act(() => { publishCurrentProject('p1') })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(entries()).toHaveLength(0)
    await runtime.dispose()
  })
})
