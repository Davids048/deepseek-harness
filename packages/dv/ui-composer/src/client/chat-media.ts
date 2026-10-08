/**
 * The DreamVerse entry of DSH's `conversation.chat.markdown` chain: in settled chat Markdown, a link to a video asset
 * becomes a 16:9 thumbnail card, an image of an image asset becomes a capped thumbnail, and a table whose every body
 * row links a video asset becomes a three-column grid of cards. The entry's `select` finds asset references by their
 * `/dv/assets/<id>` paths alone; the component reads the open project's asset kinds through the `useAssetKinds` hook
 * and renders DSH's default element while an asset is not of the kind that its card needs. The entry stays registered
 * for the whole declaration of the chain, so a change of the asset index re-renders the cards without remounting them.
 *
 * @module @dv/ui-composer/chat-media
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MarkdownElement, MarkdownTableElement } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, type ReactNode } from 'react'
import { DvClient } from '@dv/ui-kit/api.ts'
import { followAssetKinds, NO_ASSET_KINDS, type AssetKind, type AssetKinds } from './asset-kinds.ts'
import { ChatMediaView } from './ChatMedia.tsx'

/** One video card of a shot grid. */
export interface ShotCard {
  readonly asset: string
  /** The row's other cells, joined with ` · `. */
  readonly caption: string
}

/** One asset link of a table body row. */
export interface RowAsset {
  /** The index of the cell that holds the link. */
  readonly column: number
  readonly asset: string
}

/** One table body row that links at least one asset. */
export interface AssetRow {
  /** The row's asset links in cell order, then link order. */
  readonly assets: readonly RowAsset[]
  /** The plain text of every cell of the row. */
  readonly texts: readonly string[]
}

/** The asset references that the entry's `select` finds in one Markdown element, before the asset kinds are known. */
export type AssetReference =
  | { readonly kind: 'link'; readonly asset: string; readonly label: string }
  | { readonly kind: 'image'; readonly asset: string; readonly alt: string }
  | { readonly kind: 'table'; readonly rows: readonly AssetRow[] }

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
 * @param table - a settled Markdown table.
 * @returns the asset links of every body row, or null when the table has no body row or a body row links no asset.
 */
function assetRows(table: MarkdownTableElement): AssetReference | null {
  if (table.rows.length === 0) return null
  const rows: AssetRow[] = []
  for (const row of table.rows) {
    const assets = row.flatMap((cell, column) => cell.links.flatMap((link) => {
      const asset = assetIdOf(link.href)
      return asset === undefined ? [] : [{ column, asset }]
    }))
    if (assets.length === 0) return null
    rows.push({ assets, texts: row.map(cell => cell.text) })
  }
  return { kind: 'table', rows }
}

/**
 * Find the asset references of one settled Markdown element by their paths alone; the chain entry's `select`.
 * @param element - the parsed element.
 * @returns the references, or null to keep DSH's default rendering.
 */
export function selectAssetReference(element: MarkdownElement): AssetReference | null {
  switch (element.kind) {
    case 'link': {
      const asset = assetIdOf(element.href)
      return asset === undefined ? null : { kind: 'link', asset, label: element.text }
    }
    case 'image': {
      const asset = assetIdOf(element.src)
      return asset === undefined ? null : { kind: 'image', asset, alt: element.alt }
    }
    case 'table':
      return assetRows(element)
  }
}

/**
 * @param row - the asset links and cell texts of one body row.
 * @param kinds - the asset index.
 * @returns the card of the row's first video link, or undefined when the row links no video asset.
 */
function shotCard(row: AssetRow, kinds: AssetKinds): ShotCard | undefined {
  const video = row.assets.find(({ asset }) => kinds.get(asset) === 'video')
  if (video === undefined) return undefined
  const caption = row.texts.filter((text, column) => column !== video.column && text !== '')
  return { asset: video.asset, caption: caption.join(' · ') }
}

/**
 * Choose the card form of an element's asset references with the asset kinds.
 * @param reference - the references that {@link selectAssetReference} found.
 * @param kinds - the asset index.
 * @returns the card form, or null when an asset is not of the kind that its card needs.
 */
export function resolveChatMedia(reference: AssetReference, kinds: AssetKinds): ChatMedia | null {
  const isKind = (asset: string, kind: AssetKind): boolean => kinds.get(asset) === kind
  switch (reference.kind) {
    case 'link':
      return isKind(reference.asset, 'video') ? { kind: 'video', asset: reference.asset, label: reference.label } : null
    case 'image':
      return isKind(reference.asset, 'image') ? { kind: 'image', asset: reference.asset, alt: reference.alt } : null
    case 'table': {
      const shots: ShotCard[] = []
      for (const row of reference.rows) {
        const shot = shotCard(row, kinds)
        if (shot === undefined) return null
        shots.push(shot)
      }
      return { kind: 'grid', shots }
    }
  }
}

/** The props that the chain entry's component reads. */
export interface ChatMediaEntryProps {
  /** The `select` result. */
  readonly matched: AssetReference
  /** DSH's default rendering of the element. */
  readonly fallback: ReactNode
  /** Selects from the open project's asset kinds. */
  readonly useAssetKinds: SnapshotSelectorHook<AssetKinds>
}

/**
 * The chain entry's component: the card form of the matched references, or DSH's default element while an asset is
 * not of the kind that its card needs. A change of the asset index re-renders a card in place, so its state survives.
 * @param props - the matched references, the default element, and the asset-kind hook.
 * @returns the card, the thumbnail, the grid, or the default element.
 */
export function ChatMediaEntry({ matched, fallback, useAssetKinds }: ChatMediaEntryProps): ReactNode {
  const media = useAssetKinds(kinds => resolveChatMedia(matched, kinds), sameChatMedia)
  return media === null ? fallback : createElement(ChatMediaView, { matched: media })
}

/**
 * @param a - a card form.
 * @param b - another card form.
 * @returns whether both draw the same cards.
 */
function sameChatMedia(a: ChatMedia | null, b: ChatMedia | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Register the chain entry while the Chat view declares `conversation.chat.markdown`. The entry stays registered for
 * the whole declaration, and the open project's asset kinds reach its component through the `useAssetKinds` hook.
 * @param ctx - client root context with the `slots` service.
 */
export function registerChatMedia(ctx: Context): void {
  const client = new DvClient()
  ctx.slots.inject('conversation.chat.markdown', () => {
    let kinds = NO_ASSET_KINDS
    const listeners = new Set<() => void>()
    const assetKinds = {
      getSnapshot: (): AssetKinds => kinds,
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const stop = followAssetKinds(client, (next) => {
      kinds = next
      for (const listener of [...listeners]) listener()
    })
    const unregister = ctx.slots.register({
      name: 'conversation.chat.markdown',
      select: ({ element }) => selectAssetReference(element),
      inject: () => ({ hooks: { assetKinds } }),
    }, ChatMediaEntry)
    return () => {
      unregister()
      stop()
    }
  })
}
