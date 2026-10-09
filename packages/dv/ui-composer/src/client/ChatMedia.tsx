/**
 * The DreamVerse cards that replace asset links, asset images, and shot tables in settled chat Markdown. A video card
 * shows the video's first frame with a play badge; a click opens the video in a player over the whole page, which
 * Escape, a click on the backdrop, or the close button closes. The card of a standalone link is captioned 镜头 N /
 * Shot N with the take's shot number, else 视频 / Video, because chat link texts such as 点此播放 do not name the video.
 * An image thumbnail is at most 240 px wide; a click opens it large in DSH's image preview.
 *
 * @module @dv/ui-composer/ChatMedia
 */
import { ImageLightbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { assetUrl } from '@dv/ui-kit/api.ts'
import { useText } from '@dv/ui-kit/locale.ts'
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

/** The player layer covers the page; it stays dark in both themes, as video players do, so the video reads best. */
const playerLayer: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center',
  justifyContent: 'center', gap: 12, padding: 40, boxSizing: 'border-box', background: 'rgba(0, 0, 0, 0.8)',
}
const playerVideo: CSSProperties = {
  // The player fills the width up to 1280 px whatever the video's own size; a tall view letterboxes the video.
  display: 'block', width: 'min(100%, 1280px)', maxHeight: 'calc(100vh - 120px)', borderRadius: 'var(--dv-radius-lg)', background: '#000',
}
const playerTitle: CSSProperties = { margin: 0, color: '#FFFFFF', fontSize: 14, lineHeight: '22px', fontWeight: 500 }
const playerClose: CSSProperties = {
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

/**
 * A video playing large over the whole page, rendered into `document.body` so no chat container clips it. Escape, a
 * click on the backdrop, or the close button closes it, and focus returns to the card that opened it.
 * @param props - the video URL, the title above it, and the close callback.
 * @returns the player.
 */
function VideoPlayer({ src, title, onClose }: { src: string; title: string; onClose: () => void }): ReactNode {
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
    <div style={playerLayer} role="dialog" aria-modal="true" aria-label={title === '' ? t('视频', 'Video') : title}
      data-testid="dv-chat-video-player" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      {title !== '' && <p style={playerTitle}>{title}</p>}
      <video style={playerVideo} src={src} controls autoPlay playsInline />
      <button ref={closeRef} type="button" style={playerClose} aria-label={close} title={close} onClick={onClose}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>,
    document.body,
  )
}

/**
 * One 16:9 video card: the first frame and a play badge; a click opens the video in {@link VideoPlayer}.
 * @param props - the asset, the caption under the frame, and whether the card fills a grid cell.
 * @returns the card and, while open, the player.
 */
function VideoCard({ asset, label, inGrid }: { asset: string; label: string; inGrid: boolean }): ReactNode {
  const t = useText()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => { setOpen(false) }, [])
  const src = assetUrl(asset)
  const play = t('播放', 'Play')
  return (
    <span style={inGrid ? gridCard : card} data-dv-chat-video={asset}>
      <span style={frame}>
        <button type="button" style={thumbButton} aria-label={label === '' ? play : `${play}: ${label}`}
          onClick={() => { setOpen(true) }}>
          {/* `#t=0.1` makes the browser show an early frame instead of a blank first frame. The preview takes no pointer
              events, so a click focuses the card button, which gets focus back when the viewer closes. */}
          <video style={{ ...media, pointerEvents: 'none' }} src={`${src}#t=0.1`} muted preload="metadata" playsInline aria-hidden="true" />
          <span style={playBadge}><PlayIcon /></span>
        </button>
      </span>
      {label !== '' && <span style={caption} title={label}>{label}</span>}
      {open && <VideoPlayer src={src} title={label} onClose={close} />}
    </span>
  )
}

/**
 * One image thumbnail at most 240 px wide that opens the image large.
 * @param props - the asset and its alt text.
 * @returns the thumbnail and, while open, the preview.
 */
function ImageThumb({ asset, alt }: { asset: string; alt: string }): ReactNode {
  const t = useText()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => { setOpen(false) }, [])
  const src = assetUrl(asset)
  const view = t('查看大图', 'View large image')
  return (
    <>
      <button type="button" style={imageButton} aria-label={alt === '' ? view : `${view}: ${alt}`} onClick={() => { setOpen(true) }}>
        <img style={image} src={src} alt={alt} loading="lazy" decoding="async" />
      </button>
      {open && <ImageLightbox src={src} alt={alt} labels={{ dialog: t('图片预览', 'Image preview'), close: t('关闭', 'Close') }}
        onClose={close} />}
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
