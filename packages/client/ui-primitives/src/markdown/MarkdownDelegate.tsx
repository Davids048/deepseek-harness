/** Consumer-owned navigation and element replacement for Markdown. */
import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ImageLightboxLabels } from '../ImageLightbox.tsx'

/**
 * Handle one sanitized absolute HTTP(S) URL selected from Markdown.
 * @param href - destination URL.
 */
export type MarkdownExternalLinkHandler = (href: string) => void

/** A settled Markdown link, inline or by reference. */
export interface MarkdownLinkElement {
  readonly kind: 'link'
  /** Destination exactly as authored, before sanitizing. */
  readonly href: string
}

/** A settled Markdown image outside a link, inline or by reference. */
export interface MarkdownImageElement {
  readonly kind: 'image'
  /** Destination exactly as authored, before sanitizing. */
  readonly src: string
  readonly alt: string
}

/** One link inside a table cell. */
export interface MarkdownTableLink {
  /** Destination exactly as authored, before sanitizing. */
  readonly href: string
}

/** One authored table cell. */
export interface MarkdownTableCell {
  /** Plain text of the cell, with whitespace runs collapsed. */
  readonly text: string
  /** Links of the cell in source order, including links nested in emphasis. */
  readonly links: readonly MarkdownTableLink[]
}

/** A settled GFM table: its body rows with their authored cells. */
export interface MarkdownTableElement {
  readonly kind: 'table'
  readonly rows: readonly (readonly MarkdownTableCell[])[]
}

/** Parsed data of one settled element that a {@link MarkdownElementRenderer} may replace. */
export type MarkdownElement = MarkdownLinkElement | MarkdownImageElement | MarkdownTableElement

/**
 * Render one settled Markdown element in place of the default rendering.
 * @param element - Parsed element data.
 * @param fallback - The default rendering; return it to keep the element unchanged.
 * @returns The node rendered at the element's position.
 */
export type MarkdownElementRenderer = (element: MarkdownElement, fallback: ReactNode) => ReactNode

/** Navigation and element-rendering capabilities supplied by the nearest Markdown owner. */
export interface MarkdownDelegate {
  /** Image previews for decoded local paths in this owner's workspace. */
  readonly fileImages?: {
    resolve: (path: string) => string | undefined
    labels: ImageLightboxLabels & { open: string; loading: string; failed: string }
  } | undefined
  /** Ordinary HTTP(S) activation; absent handlers retain native anchor behavior. */
  readonly openExternalLink?: MarkdownExternalLinkHandler | undefined
  /**
   * Open a decoded local destination from settled Markdown; absent handlers leave plain text.
   * @param path - Absolute or workspace-relative file path.
   * @param options - First line to reveal when the destination specifies a line or range.
   */
  readonly openFile?: ((path: string, options?: { line?: number }) => void) | undefined
  /**
   * Replace settled links, images outside links, and tables; absent renderers keep the default rendering.
   * Streaming renders never reach the renderer.
   */
  readonly renderElement?: MarkdownElementRenderer | undefined
}

const MarkdownDelegateContext = createContext<MarkdownDelegate>({})

/** Props for one Markdown navigation scope. */
export interface MarkdownDelegateProviderProps extends MarkdownDelegate {
  readonly children: ReactNode
}

/**
 * Scope Markdown navigation without threading callbacks through renderers.
 * Nested providers replace the enclosing capabilities. Handler changes reach cached links.
 * @param props - Child tree, its file and HTTP(S) link handlers, and its element renderer.
 * @returns the scoped child tree.
 */
export function MarkdownDelegateProvider({
  children,
  openExternalLink,
  openFile,
  fileImages,
  renderElement,
}: MarkdownDelegateProviderProps): ReactNode {
  const delegate = useMemo(
    () => ({ openExternalLink, openFile, fileImages, renderElement }),
    [openExternalLink, openFile, fileImages, renderElement],
  )
  return (
    <MarkdownDelegateContext.Provider value={delegate}>
      {children}
    </MarkdownDelegateContext.Provider>
  )
}

/**
 * Read the nearest Markdown navigation capabilities.
 * @returns Owner callbacks, or an empty delegate outside a provider.
 */
export function useMarkdownDelegate(): MarkdownDelegate {
  return useContext(MarkdownDelegateContext)
}
