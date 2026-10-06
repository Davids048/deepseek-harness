/**
 * One canvas node as a card: a colored kind accent, the asset thumbnail, title, badges, and state markers. Pink accents
 * mark story bible items and assets, orange accents plans, green accents rendered takes. Surfaces, borders, and text use the
 * DSH theme tokens, so the card follows the light and dark themes.
 */
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { assetUrl } from '@dv/ui-kit/api.ts'
import { NODE_WIDTH } from './graph.ts'
import type { CanvasNode } from './graph.ts'
import type {} from './locales.ts'

/** The canvas namespace translate. */
export type CanvasTranslate = TranslateNS<'dvCanvas'>

/** The accent color of each node kind. */
export const KIND_COLOR: Record<CanvasNode['kind'], string> = { bible: '#e86fa8', asset: '#e86fa8', plan: '#f0a14a', take: '#4cc38a' }

/**
 * The node's title as the user reads it.
 * @param node - the node.
 * @param t - translate.
 * @returns the title.
 */
export function nodeTitle(node: CanvasNode, t: CanvasTranslate): string {
  if (node.kind === 'take') {
    const shot = node.title === '' ? t('node.takeKind') : t('node.shot', { shot: node.title })
    return node.take === null ? shot : t('node.take', { title: shot, take: node.take })
  }
  if (node.kind === 'plan') return node.title === '' ? t('node.plan') : node.title
  return node.title
}

/**
 * The kind label shown above the thumbnail.
 * @param node - the node.
 * @param t - translate.
 * @returns the label.
 */
export function kindLabel(node: CanvasNode, t: CanvasTranslate): string {
  switch (node.kind) {
    case 'bible':
      return node.bibleKind === 'location' ? t('node.location') : node.bibleKind === 'style' ? t('node.style') : t('node.character')
    case 'asset': return t('node.asset')
    case 'plan': return t('node.plan')
    case 'take': return t('node.takeKind')
  }
}

/** Props of {@link NodeCard}. */
export interface NodeCardProps {
  node: CanvasNode
  x: number
  y: number
  selected: boolean
  /** The canvas zoom; text grows in canvas units below {@link READABLE_ZOOM} so it stays legible on screen. */
  zoom: number
  t: CanvasTranslate
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

/** The zoom at and above which node text keeps its base size; below it text scales up to stay readable. */
const READABLE_ZOOM = 0.8
/** The largest text enlargement, reached near the minimum zoom. */
const MAX_TEXT_SCALE = 2.6
/** Above this enlargement the subtitle line is hidden, so a grown card with a badge row stays shorter than the row pitch. */
const SUBTITLE_MAX_SCALE = 2

const thumbBox: CSSProperties = {
  position: 'relative', aspectRatio: '16 / 9', background: 'var(--dsw-alias-interactive-bg-hover)', display: 'flex', alignItems: 'center',
  justifyContent: 'center', overflow: 'hidden',
}
const media: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }
const ellipsis: CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }

/**
 * The card: a light surface in the DSH theme with a colored kind accent, the media thumbnail, and the title block.
 * @param props - the node, its position, the canvas zoom, and the drag handler.
 * @returns the element.
 */
export function NodeCard({ node, x, y, selected, zoom, t, onPointerDown }: NodeCardProps): ReactNode {
  const color = KIND_COLOR[node.kind]
  const { flags } = node
  const scale = Math.min(MAX_TEXT_SCALE, Math.max(1, READABLE_ZOOM / zoom))
  const size = (base: number): number => Math.round(base * scale)
  let border = '1px solid var(--dsw-alias-border-l3)'
  if (flags.stale) border = '2px solid var(--dsw-alias-state-error-primary)'
  else if (selected) border = `2px solid ${color}`
  const style: CSSProperties = {
    position: 'absolute', left: x, top: y, width: NODE_WIDTH, background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)',
    borderRadius: 12, border, outline: flags.draft ? `2px dashed ${color}` : 'none', outlineOffset: 4,
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.06), 0 6px 16px rgba(0, 0, 0, 0.08)', cursor: 'grab', userSelect: 'none', overflow: 'hidden',
    opacity: flags.superseded ? 0.55 : 1, touchAction: 'none',
  }
  let thumb: ReactNode
  if (node.thumb !== null) thumb = <img src={assetUrl(node.thumb)} alt="" style={media} draggable={false} />
  else if (node.video !== null) thumb = <video src={assetUrl(node.video)} muted preload="metadata" style={media} />
  else if (node.kind === 'plan') thumb = <span style={{ fontSize: size(16), fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' }}>{t('node.planShots', { count: node.subtitle })}</span>
  else thumb = null
  // A take's record renders a shot; every other record runs a non-render operation.
  const take = node.kind === 'take'
  let marker: string | null = null
  if (flags.rendering) marker = take ? t('node.rendering') : t('node.running')
  else if (flags.failed) marker = take ? t('node.renderFailed') : t('node.failed')
  // A plan node shows its latest version, which the `plan.create` or `plan.update` record reports.
  const planVersion = node.kind === 'plan' ? node.record?.report?.['version'] : undefined
  return (
    <div
      style={style}
      data-node-id={node.id}
      data-node-kind={node.kind}
      data-node-draft={String(flags.draft)}
      data-node-stale={String(flags.stale)}
      onPointerDown={onPointerDown}
      role="button"
      tabIndex={0}
      aria-label={nodeTitle(node, t)}
    >
      <div style={{ height: 4, background: color }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', fontSize: size(12), color: 'var(--dsw-alias-label-secondary)' }}>
        <span style={{ flex: 'none', width: size(8), height: size(8), borderRadius: '50%', background: color }} />
        <span style={{ fontWeight: 600 }}>{kindLabel(node, t)}</span>
        {flags.draft ? <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{t('node.draft')}</span> : null}
        {flags.stale ? <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{t('node.stale')}</span> : null}
        {typeof planVersion === 'number' ? <span>{t('node.planVersion', { version: planVersion })}</span> : null}
        <span style={{ flex: 1 }} />
        {node.durationSec !== null ? <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{node.durationSec.toFixed(1)}s</span> : null}
      </div>
      <div style={thumbBox}>
        {thumb}
        {marker !== null
          ? <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0, 0, 0, 0.55)', color: '#fff', fontSize: size(15), fontWeight: 600 }}>{marker}</span>
          : null}
      </div>
      <div style={{ padding: '10px 12px 12px' }}>
        <div style={{ fontSize: size(16), fontWeight: 600, lineHeight: 1.3, ...ellipsis }}>{nodeTitle(node, t)}</div>
        {node.kind !== 'plan' && node.subtitle !== '' && scale <= SUBTITLE_MAX_SCALE
          ? <div style={{ marginTop: 2, fontSize: size(13), lineHeight: 1.35, color: 'var(--dsw-alias-label-secondary)', ...ellipsis }}>{node.subtitle}</div>
          : null}
        {node.badges.length > 0
          ? (
            <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
              {node.badges.map(badge => <span key={badge} style={{ fontSize: size(12), padding: '1px 8px', borderRadius: 10, background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)' }}>{badge === 'trim' ? t('badge.trim') : badge}</span>)}
            </div>
          )
          : null}
      </div>
    </div>
  )
}
