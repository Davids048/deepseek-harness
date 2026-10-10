/**
 * The DreamVerse cards that replace asset links, asset images, and shot tables in settled chat Markdown. A video card
 * shows the video's first frame with a play badge; a click opens the video in a player over the whole page, which
 * grows out of the card, starts the video once it is open, and shrinks back into the card when Escape, a click on the
 * backdrop, or the close button closes it (`@dv/ui-kit/zoom.ts`). The card of a standalone link is captioned 镜头 N /
 * Shot N with the take's shot number, else 视频 / Video, because chat link texts such as 点此播放 do not name the video.
 * An image thumbnail is at most 240 px wide; a click opens the image large in the same kind of page-wide viewer, which
 * grows out of the thumbnail and shrinks back into it.
 *
 * @module @dv/ui-composer/ChatMedia
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { assetUrl } from '@dv/ui-kit/api.ts'
import { useText } from '@dv/ui-kit/locale.ts'
import { mediaBox, useZoomPresence, type ZoomPresence } from '@dv/ui-kit/zoom.ts'
import type { ChatMedia } from './chat-media.ts'

/** A three-column grid of shot cards. */
const grid: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, margin: '8px 0',
}
/** A single card stays inline so it can sit in a sentence or a table cell. */
const card: CSSProperties = {
  display: 'inline-flex', flexDirection: 'column', gap: 4, width: 160, maxWidth: '100%', verticalAlign: 'top',
}
const gridCard: CSSProperties = { ...card, display: 'flex', width: 'auto' }
const frame: CSSProperties = {
  position: 'relative', display: 'block', aspectRatio: '16 / 9', overflow: 'hidden',
  borderRadius: 'var(--dv-radius-sm)', background: 'var(--dv-media-bg)', boxShadow: '0 0 0 1px var(--dv-line)',
}
const thumbButton: CSSProperties = {
  display: 'block', width: '100%', height: '100%', padding: 0, border: 0, background: 'transparent', cursor: 'pointer',
}
const media: CSSProperties = { display: 'block', width: '100%', height: '100%', objectFit: 'cover' }
/** The badge sits on video frames, so it keeps the same light fill and dark glyph in both themes. */
const playBadge: CSSProperties = {
  position: 'absolute', right: 4, bottom: 4, width: 18, height: 18, borderRadius: 9999,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(255, 255, 255, 0.9)', color: '#0A0B0D',
}
const caption: CSSProperties = {
  color: 'var(--dv-text-2)', fontSize: 12, lineHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
}
const imageButton: CSSProperties = {
  display: 'inline-block', maxWidth: 240, padding: 0, border: 0, background: 'transparent', cursor: 'zoom-in',
  verticalAlign: 'top', borderRadius: 'var(--dv-radius-md)',
}
const image: CSSProperties = {
  display: 'block', maxWidth: '100%', height: 'auto', borderRadius: 'var(--dv-radius-md)', boxShadow: '0 0 0 1px var(--dv-line)',
}

const viewerLayer: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center',
  justifyContent: 'center', gap: 12, padding: 40, boxSizing: 'border-box',
}
/** The backdrop stays dark in both themes, as media viewers do, so the media reads best. Clicks pass to the layer. */
const viewerBackdrop: CSSProperties = { position: 'absolute', inset: 0, background: 'rgba(0, 0, 0, 0.8)', pointerEvents: 'none' }
const playerVideo: CSSProperties = {
  position: 'relative',
  // The player fills the width up to 1280 px whatever the video's own size, and is 16:9 before the video loads so the
  // zoom transition measures its final box; a tall view letterboxes the video.
  display: 'block', width: 'min(100%, 1280px)', aspectRatio: '16 / 9', maxHeight: 'calc(100vh - 120px)', borderRadius: 'var(--dv-radius-lg)', background: '#000',
}
/** An image keeps its own size up to the space the viewer has; {@link mediaBox} sets that size before it loads. */
const viewerImage: CSSProperties = {
  position: 'relative', display: 'block', maxWidth: 'min(100%, 1600px)', maxHeight: 'calc(100vh - 120px)', objectFit: 'contain',
  borderRadius: 'var(--dv-radius-lg)',
}
/** The widest and tallest a viewer image may be: the viewer's padded area, at most 1600 px wide. */
const VIEWER_MAX_WIDTH = 'min(100vw - 80px, 1600px)'
const VIEWER_MAX_HEIGHT = '(100vh - 120px)'
const viewerTitle: CSSProperties = { position: 'relative', margin: 0, color: '#FFFFFF', fontSize: 14, lineHeight: '22px', fontWeight: 500 }
const viewerClose: CSSProperties = {
  position: 'fixed', top: 20, right: 20, width: 36, height: 36, borderRadius: 9999, border: 0, padding: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255, 255, 255, 0.16)', color: '#FFFFFF', cursor: 'pointer',
}

/** @returns the filled play triangle of the badge. */
function PlayIcon(): ReactNode {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L8.5 4.6A1 1 0 0 0 7 5.5z" />
    </svg>
  )
}

/** Props of {@link MediaViewer}. */
interface MediaViewerProps {
  /** The dialog's accessible name. */
  label: string
  /** The text above the media; empty for none. */
  title: string
  onClose: () => void
  /** The zoom transition refs: the backdrop, title, and close button fade; the caller attaches `targetRef` to the media. */
  zoom: ZoomPresence<string>
  /** The video or image, shown large. */
  children: ReactNode
}

/**
 * A video or an image large over the whole page, rendered into `document.body` so no chat container clips it. Escape,
 * a click on the backdrop, or the close button closes it, and focus returns to the thumbnail that opened it.
 * @param props - the dialog name, the title above the media, the close callback, the zoom transition refs, and the media.
 * @returns the viewer.
 */
function MediaViewer({ label, title, onClose, zoom, children }: MediaViewerProps): ReactNode {
  const t = useText()
  const closeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      opener?.focus()
    }
  }, [onClose])
  const close = t('关闭', 'Close')
  return createPortal(
    <div style={viewerLayer} role="dialog" aria-modal="true" aria-label={label}
      data-testid="dv-chat-media-viewer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={zoom.fadeRef} style={viewerBackdrop} aria-hidden="true" />
      {title !== '' && <p ref={zoom.fadeRef} style={viewerTitle}>{title}</p>}
      {children}
      <button ref={(element) => { closeRef.current = element; zoom.fadeRef(element) }} type="button" style={viewerClose} aria-label={close} title={close} onClick={onClose}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>,
    document.body,
  )
}

/**
 * One 16:9 video card: the first frame and a play badge; a click opens the video in {@link MediaViewer}, which grows
 * out of the card and starts the video once it is open.
 * @param props - the asset, the caption under the frame, and whether the card fills a grid cell.
 * @returns the card and, while open, the player.
 */
function VideoCard({ asset, label, inGrid }: { asset: string; label: string; inGrid: boolean }): ReactNode {
  const t = useText()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => { setOpen(false) }, [])
  const cardRef = useRef<HTMLButtonElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const zoom = useZoomPresence(open ? asset : null, () => cardRef.current, () => {
    videoRef.current?.play().catch((error: unknown) => {
      // The browser refused to start playback, for example under an autoplay policy; the controls still start it.
      void error
    })
  })
  const src = assetUrl(asset)
  const play = t('播放', 'Play')
  return (
    <span style={inGrid ? gridCard : card} data-dv-chat-video={asset}>
      <span style={frame}>
        <button ref={cardRef} type="button" style={thumbButton} aria-label={label === '' ? play : `${play}: ${label}`}
          onClick={() => { setOpen(true) }}>
          {/* `#t=0.1` makes the browser show an early frame instead of a blank first frame. The preview takes no pointer
              events, so a click focuses the card button, which gets focus back when the viewer closes. */}
          <video style={{ ...media, pointerEvents: 'none' }} src={`${src}#t=0.1`} muted preload="metadata" playsInline aria-hidden="true" />
          <span style={playBadge}><PlayIcon /></span>
        </button>
      </span>
      {label !== '' && <span style={caption} title={label}>{label}</span>}
      {zoom.shown !== null && (
        <MediaViewer label={label === '' ? t('视频', 'Video') : label} title={label} onClose={close} zoom={zoom}>
          <video
            ref={(element) => { zoom.targetRef(element); videoRef.current = element }} style={playerVideo} src={src} controls playsInline
          />
        </MediaViewer>
      )}
    </span>
  )
}

/**
 * One image thumbnail at most 240 px wide that opens the image large in {@link MediaViewer}, growing out of the
 * thumbnail.
 * @param props - the asset and its alt text.
 * @returns the thumbnail and, while open, the viewer.
 */
function ImageThumb({ asset, alt }: { asset: string; alt: string }): ReactNode {
  const t = useText()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => { setOpen(false) }, [])
  const thumbRef = useRef<HTMLButtonElement | null>(null)
  const zoom = useZoomPresence(open ? asset : null, () => thumbRef.current)
  // The thumbnail has loaded the same image, so its natural size sizes the viewer image before that loads.
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const viewerImageStyle = natural === null || natural.height === 0
    ? viewerImage
    : { ...viewerImage, ...mediaBox(natural.width, natural.height, VIEWER_MAX_WIDTH, VIEWER_MAX_HEIGHT) }
  const src = assetUrl(asset)
  const view = t('查看大图', 'View large image')
  return (
    <>
      <button ref={thumbRef} type="button" style={imageButton} aria-label={alt === '' ? view : `${view}: ${alt}`} onClick={() => { setOpen(true) }}>
        <img style={image} src={src} alt={alt} loading="lazy" decoding="async"
          onLoad={(event) => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }) }} />
      </button>
      {zoom.shown !== null && (
        <MediaViewer label={t('图片预览', 'Image preview')} title="" onClose={close} zoom={zoom}>
          <img ref={zoom.targetRef} src={src} alt={alt} style={viewerImageStyle} />
        </MediaViewer>
      )}
    </>
  )
}

/**
 * Draw one card form that the chain entry resolved from an element's asset references and the asset kinds.
 * @param props - the `matched` card form.
 * @returns the card, the thumbnail, or the grid.
 */
export function ChatMediaView({ matched }: { matched: ChatMedia }): ReactNode {
  const t = useText()
  switch (matched.kind) {
    case 'video': {
      const shot = matched.shot === null ? null : String(matched.shot)
      const label = shot === null ? t('视频', 'Video') : t(`镜头 ${shot}`, `Shot ${shot}`)
      return <VideoCard asset={matched.asset} label={label} inGrid={false} />
    }
    case 'image':
      return <ImageThumb asset={matched.asset} alt={matched.alt} />
    case 'grid':
      return (
        <div style={grid}>
          {matched.shots.map((shot, index) => <VideoCard key={index} asset={shot.asset} label={shot.caption} inGrid />)}
        </div>
      )
  }
}
