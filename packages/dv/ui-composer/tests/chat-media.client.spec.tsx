// @vitest-environment jsdom
/** The DreamVerse thumbnail cards of chat Markdown: element selection, the cards, and the chain registration. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownElement, MarkdownTableCell } from '@deepseek-ai/dsh-client-ui-primitives'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { DvClient } from '@dv/ui-kit/api.ts'
import { publishCurrentProject } from '@dv/ui-kit/current-project.ts'
import { followAssetKinds, kindOf, NO_ASSET_KINDS, type AssetKinds } from '../src/client/asset-kinds.ts'
import {
  assetIdOf, registerChatMedia, resolveChatMedia, selectAssetReference, type ChatMedia,
} from '../src/client/chat-media.ts'
import { ChatMediaView } from '../src/client/ChatMedia.tsx'

const KINDS: AssetKinds = new Map([['v1.mp4', 'video'], ['v2.mp4', 'video'], ['i1.png', 'image']])

const link = (href: string, text = '播放'): MarkdownElement => ({ kind: 'link', href, title: undefined, text })
const cell = (text: string, href?: string): MarkdownTableCell => ({ text, links: href === undefined ? [] : [{ href, text }] })
const table = (...rows: MarkdownTableCell[][]): MarkdownElement => ({
  kind: 'table', header: [cell('镜头'), cell('内容'), cell('视频')], rows,
})

/** The card form of one element under `kinds`: the entry's `select`, then the component's resolution. */
function selectChatMedia(element: MarkdownElement, kinds: AssetKinds): ChatMedia | null {
  const reference = selectAssetReference(element)
  return reference === null ? null : resolveChatMedia(reference, kinds)
}

beforeEach(() => { document.documentElement.lang = 'zh-CN' })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  publishCurrentProject(null)
})

describe('selectAssetReference', () => {
  it('matches asset paths without the asset kinds and declines other destinations', () => {
    expect(selectAssetReference(link('/dv/assets/missing.mp4'))).toEqual({ kind: 'link', asset: 'missing.mp4', label: '播放' })
    expect(selectAssetReference(link('https://example.com/v1.mp4'))).toBeNull()
    expect(selectAssetReference(table([cell('1'), cell('播放', '/dv/assets/a1.wav')]))).toEqual({
      kind: 'table', rows: [{ assets: [{ column: 1, asset: 'a1.wav' }], texts: ['1', '播放'] }],
    })
    expect(selectAssetReference(table([cell('1'), cell('外链', 'https://example.com/v1.mp4')]))).toBeNull()
  })
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

  it('takes the first video link of a row and captions the card with the other cells', () => {
    const links = [{ href: '/dv/assets/i1.png', text: '定妆照' }, { href: '/dv/assets/v1.mp4', text: '播放' }]
    const row = [cell('1'), { text: '定妆照 播放', links }]
    expect(selectChatMedia(table(row), KINDS)).toEqual({ kind: 'grid', shots: [{ asset: 'v1.mp4', caption: '1' }] })
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

  it('pauses the playing card when another card starts playing', () => {
    const { container } = view({ kind: 'grid', shots: [{ asset: 'v1.mp4', caption: '1' }, { asset: 'v2.mp4', caption: '2' }] })
    fireEvent.click(screen.getByRole('button', { name: '播放: 1' }))
    fireEvent.click(screen.getByRole('button', { name: '播放: 2' }))
    const [first, second] = [...container.querySelectorAll('video')]
    if (first === undefined || second === undefined) throw new Error('expected two card players')
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(first, 'paused', 'get').mockReturnValue(false)
    vi.spyOn(second, 'paused', 'get').mockReturnValue(false)
    fireEvent.play(second)
    expect(pause.mock.contexts).toEqual([first])
    pause.mockRestore()
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
  it('registers one shape-only chain entry per declaration and removes it when the plugin unloads', async () => {
    fakeEvents()
    vi.stubGlobal('fetch', stateFetch({ 'p1/main': state([['v1.mp4', 'video/mp4']]) }))
    const runtime = await SlotTestRuntime.create()
    await runtime.declare({ 'conversation.chat.markdown': { kind: 'chain', scope: 'session' } })
    const entries = () => runtime.slots.entries('conversation.chat.markdown')
    const plugin = await runtime.mount({ inject: ['slots'], apply: registerChatMedia })
    expect(entries()).toHaveLength(1)
    const entry = entries()[0]
    const select = entry!.select as (owner: { element: MarkdownElement }) => unknown
    expect(select({ element: link('/dv/assets/v1.mp4') })).toEqual({ kind: 'link', asset: 'v1.mp4', label: '播放' })

    act(() => { publishCurrentProject('p1') })
    await new Promise(resolve => setTimeout(resolve, 0))
    act(() => { publishCurrentProject(null) })
    expect(entries()).toEqual([entry])

    await plugin.dispose()
    expect(entries()).toHaveLength(0)
    await runtime.dispose()
  })

  it('keeps a playing card mounted while the asset index changes, and keeps the default link for other assets', async () => {
    const events = fakeEvents()
    const states: Record<string, unknown> = { 'p1/main': state([['v1.mp4', 'video/mp4'], ['a1.wav', 'audio/wav']]) }
    const fetchImpl = stateFetch(states)
    vi.stubGlobal('fetch', fetchImpl)
    const runtime = await SlotTestRuntime.create()
    const session = await runtime.sessions.add({ id: 's1' })
    using reference = runtime.sessions.retain(session)
    const anchor = (href: string, text: string) => <a href={href}>{text}</a>
    await runtime.root.declare({ 'conversation.chat.markdown': { kind: 'chain', scope: 'session' } }, props => (
      <props.SessionProvider session={reference}>
        {[['/dv/assets/v1.mp4', '镜头 1'], ['/dv/assets/a1.wav', '配乐']].map(([href, text]) => {
          const fallback = anchor(href!, text!)
          return (
            <p key={href}>
              {props.renderSlotChain('conversation.chat.markdown', { element: link(href!, text), fallback }, { fallback, inline: true })}
            </p>
          )
        })}
      </props.SessionProvider>
    ))
    await runtime.mount({ inject: ['slots'], apply: registerChatMedia })
    const view = runtime.renderRoot()
    // Before the index loads, both assets keep the default link.
    expect(view.getByRole('link', { name: '镜头 1' })).toBeTruthy()

    act(() => { publishCurrentProject('p1') })
    await vi.waitFor(() => { expect(view.getByRole('button', { name: '播放: 镜头 1' })).toBeTruthy() })
    expect(view.getByRole('link', { name: '配乐' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '播放: 镜头 1' }))
    const player = view.container.querySelector('video[controls]')
    expect(player).not.toBeNull()

    // Another shot finishes rendering: the index changes, and the playing card stays the same DOM node.
    states['p1/main'] = state([['v1.mp4', 'video/mp4'], ['v2.mp4', 'video/mp4'], ['a1.wav', 'audio/wav']])
    const fetches = fetchImpl.mock.calls.length
    await act(async () => {
      events.send()
      await vi.waitFor(() => { expect(fetchImpl.mock.calls.length).toBeGreaterThan(fetches) })
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(view.container.querySelector('video[controls]')).toBe(player)
    await runtime.dispose()
  })
})
