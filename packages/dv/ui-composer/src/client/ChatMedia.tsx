/**
 * The DreamVerse cards that replace asset links, asset images, and shot tables in settled chat Markdown. A video card
 * shows the video's first frame with a play badge; a click plays the video in the card with controls. An image
 * thumbnail is at most 240 px wide; a click opens it large in DSH's image preview.
 *
 * @module @dv/ui-composer/ChatMedia
 */
import { ImageLightbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useState, type CSSProperties, type ReactNode } from 'react'
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

/** @returns the filled play triangle of the badge. */
function PlayIcon(): ReactNode {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L8.5 4.6A1 1 0 0 0 7 5.5z" />
    </svg>
  )
}

/**
 * One 16:9 video card: the first frame and a play badge until clicked, then the video with controls.
 * @param props - the asset, the caption under the frame, and whether the card fills a grid cell.
 * @returns the card.
 */
function VideoCard({ asset, label, inGrid }: { asset: string; label: string; inGrid: boolean }): ReactNode {
  const t = useText()
  const [playing, setPlaying] = useState(false)
  const src = assetUrl(asset)
  const play = t('播放', 'Play')
  return (
    <span style={inGrid ? gridCard : card} data-dv-chat-video={asset}>
      <span style={frame}>
        {playing
          ? <video style={media} src={src} controls autoPlay playsInline />
          : (
            <button type="button" style={thumbButton} aria-label={label === '' ? play : `${play}: ${label}`}
              onClick={() => { setPlaying(true) }}>
              {/* `#t=0.1` makes the browser show an early frame instead of a blank first frame. */}
              <video style={media} src={`${src}#t=0.1`} muted preload="metadata" playsInline tabIndex={-1} aria-hidden="true" />
              <span style={playBadge}><PlayIcon /></span>
            </button>
          )}
      </span>
      {label !== '' && <span style={caption} title={label}>{label}</span>}
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
 * The chain component: the form that the entry's `select` chose.
 * @param props - the `matched` card form.
 * @returns the card, the thumbnail, or the grid.
 */
export function ChatMediaView({ matched }: { matched: ChatMedia }): ReactNode {
  switch (matched.kind) {
    case 'video':
      return <VideoCard asset={matched.asset} label={matched.label} inGrid={false} />
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
