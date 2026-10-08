/**
 * The DreamVerse entry of DSH's `conversation.chat.markdown` chain: in settled chat Markdown, a link to a video asset
 * becomes a 16:9 thumbnail card, an image of an image asset becomes a capped thumbnail, and a table whose every body
 * row links a video asset becomes a three-column grid of cards. The entry exists only while the open project has video
 * or image assets, and it is registered again whenever that index changes, so its `select` stays a pure function of
 * the element and the index it was registered with.
 *
 * @module @dv/ui-composer/chat-media
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MarkdownElement, MarkdownTableElement } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DvClient } from '@dv/ui-kit/api.ts'
import { followAssetKinds, type AssetKind, type AssetKinds } from './asset-kinds.ts'
import { ChatMediaView } from './ChatMedia.tsx'

/** One video card of a shot grid. */
export interface ShotCard {
  readonly asset: string
  /** The row's other cells, joined with ` · `. */
  readonly caption: string
}

/** What the chain entry draws in place of one Markdown element. */
export type ChatMedia =
  | { readonly kind: 'video'; readonly asset: string; readonly label: string }
  | { readonly kind: 'image'; readonly asset: string; readonly alt: string }
  | { readonly kind: 'grid'; readonly shots: readonly ShotCard[] }

/** The path of an asset's file under the host, as `@dv/asset-pool` serves it. */
const ASSET_PATH = /^\/dv\/assets\/([^/]+)$/

/**
 * @param href - an authored Markdown destination, absolute or root-relative.
 * @returns the asset ID that the destination's path names under `/dv/assets/`, or undefined.
 */
export function assetIdOf(href: string): string | undefined {
  let path: string
  try {
    // The base only completes root-relative destinations; the host part is ignored.
    path = new URL(href, 'http://dv.invalid').pathname
  } catch (_error) {
    // An unparsable destination names no asset.
    return undefined
  }
  const encoded = ASSET_PATH.exec(path)?.[1]
  if (encoded === undefined) return undefined
  try {
    return decodeURIComponent(encoded)
  } catch (_error) {
    // A malformed escape names no asset.
    return undefined
  }
}

/**
 * @param href - an authored Markdown destination.
 * @param kinds - the asset index.
 * @param kind - the required kind.
 * @returns the asset ID when the destination names an asset of that kind.
 */
function assetOfKind(href: string, kinds: AssetKinds, kind: AssetKind): string | undefined {
  const asset = assetIdOf(href)
  return asset !== undefined && kinds.get(asset) === kind ? asset : undefined
}

/**
 * @param table - a settled Markdown table.
 * @param kinds - the asset index.
 * @returns the grid, or null when the table has no body row or a body row links no video asset.
 */
function shotGrid(table: MarkdownTableElement, kinds: AssetKinds): ChatMedia | null {
  if (table.rows.length === 0) return null
  const shots: ShotCard[] = []
  for (const row of table.rows) {
    let column = -1
    let asset: string | undefined
    for (const [index, cell] of row.entries()) {
      asset = cell.links.map(link => assetOfKind(link.href, kinds, 'video')).find(id => id !== undefined)
      if (asset !== undefined) {
        column = index
        break
      }
    }
    if (asset === undefined) return null
    const caption = row.filter((_cell, index) => index !== column).map(cell => cell.text).filter(text => text !== '')
    shots.push({ asset, caption: caption.join(' · ') })
  }
  return { kind: 'grid', shots }
}

/**
 * Choose the card form of one settled Markdown element.
 * @param element - the parsed element.
 * @param kinds - the asset index.
 * @returns the card form, or null to keep DSH's default rendering.
 */
export function selectChatMedia(element: MarkdownElement, kinds: AssetKinds): ChatMedia | null {
  if (element.kind === 'link') {
    const asset = assetOfKind(element.href, kinds, 'video')
    return asset === undefined ? null : { kind: 'video', asset, label: element.text }
  }
  if (element.kind === 'image') {
    const asset = assetOfKind(element.src, kinds, 'image')
    return asset === undefined ? null : { kind: 'image', asset, alt: element.alt }
  }
  return shotGrid(element, kinds)
}

/**
 * Register the chain entry while the Chat view declares `conversation.chat.markdown`, following the open project's
 * asset kinds.
 * @param ctx - client root context with the `slots` service.
 */
export function registerChatMedia(ctx: Context): void {
  const client = new DvClient()
  ctx.slots.inject('conversation.chat.markdown', () => {
    let unregister = (): void => {}
    const stop = followAssetKinds(client, (kinds) => {
      const previous = unregister
      unregister = kinds.size === 0 ? () => {} : ctx.slots.register({
        name: 'conversation.chat.markdown',
        select: ({ element }) => selectChatMedia(element, kinds),
      }, ChatMediaView)
      previous()
    })
    return () => {
      stop()
      unregister()
    }
  })
}
