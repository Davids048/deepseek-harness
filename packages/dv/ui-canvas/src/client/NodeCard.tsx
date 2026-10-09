/**
 * One canvas node as a card on the `--dv-*` theme variables. Every card has a kind dot: pink for characters, locations,
 * styles and imported assets, orange for plans, teal for takes. A take or an imported asset shows a header row (dot,
 * title, duration) above its 16:9 frame at full card width; a failed take is a compact danger row instead of a frame. A
 * story bible card shows a 40 × 40 reference image beside its kind and name. A plan card shows its version, a mini grid
 * of its shots' frames when any shot has one, and its shot count and total duration.
 */
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { assetUrl } from '@dv/ui-kit/api.ts'
import type { PlanVersion } from '@dv/ui-kit/types.ts'
import { NODE_WIDTH } from './graph.ts'
import type { CanvasNode, PlanShotFrame } from './graph.ts'
import type {} from './locales.ts'

/** The canvas namespace translate. */
export type CanvasTranslate = TranslateNS<'dvCanvas'>

/** The kind dot color of each node kind. */
export const KIND_COLOR: Record<CanvasNode['kind'], string> = {
  bible: 'var(--dv-kind-character)', asset: 'var(--dv-kind-character)', plan: 'var(--dv-kind-plan)', take: 'var(--dv-kind-take)',
}

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
 * The kind label shown beside the kind dot.
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

/**
 * A duration as minutes and seconds, such as `0:30`.
 * @param seconds - the duration in seconds.
 * @returns the clock text.
 */
export function clockText(seconds: number): string {
  const whole = Math.round(seconds)
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`
}

/** Header row height of a card with a frame. */
const HEADER_HEIGHT = 30
/** Height of the 16:9 frame at full card width. */
const FRAME_HEIGHT = Math.round(NODE_WIDTH * 9 / 16)

/**
 * The approximate rendered height of a card at its base text size, used to anchor edges and to center a focused node.
 * @param node - the node.
 * @param hasFrames - for a plan node, whether its mini grid shows.
 * @returns the height in canvas units.
 */
export function nodeHeight(node: CanvasNode, hasFrames = false): number {
  switch (node.kind) {
    case 'take': return node.flags.failed ? 52 : HEADER_HEIGHT + FRAME_HEIGHT
    case 'asset': return HEADER_HEIGHT + FRAME_HEIGHT
    case 'bible': return 60
    case 'plan': return hasFrames ? 140 : 76
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
  /** For a plan node, the plan's latest version. */
  plan?: PlanVersion
  /** For a plan node, the frame of each shot of the latest version; null for a shot without one. */
  frames?: Array<PlanShotFrame | null>
  /** For a failed take, renders it again; omitted when the canvas is read-only. */
  onRetry?: () => void
}

/** The zoom at and above which node text keeps its base size; below it text scales up to stay readable. */
const READABLE_ZOOM = 0.8
/** The largest text enlargement, reached near the minimum zoom. */
const MAX_TEXT_SCALE = 2.6

const media: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none', display: 'block' }
const ellipsis: CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
const mono: CSSProperties = { fontFamily: 'var(--dv-font-mono)', fontVariantNumeric: 'tabular-nums' }

/**
 * The image or video of an asset, filling its box.
 * @param props - the image and video asset IDs.
 * @returns the element, or null when there is neither.
 */
function Media({ thumb, video }: { thumb: string | null; video: string | null }): ReactNode {
  if (thumb !== null) return <img src={assetUrl(thumb)} alt="" style={media} draggable={false} />
  if (video !== null) return <video src={assetUrl(video)} muted preload="metadata" style={media} />
  return null
}

/**
 * The card.
 * @param props - the node, its position, the canvas zoom, the plan data of a plan node, and the gesture callbacks.
 * @returns the element.
 */
export function NodeCard({ node, x, y, selected, zoom, t, onPointerDown, plan, frames = [], onRetry }: NodeCardProps): ReactNode {
  const { flags } = node
  const scale = Math.min(MAX_TEXT_SCALE, Math.max(1, READABLE_ZOOM / zoom))
  const size = (base: number): number => Math.round(base * scale)
  // Type scale pairs: 12/16 metadata, 13/20 titles, 14/22 names.
  const text = (base: 12 | 13 | 14): CSSProperties => ({ fontSize: size(base), lineHeight: `${String(size({ 12: 16, 13: 20, 14: 22 }[base]))}px` })
  const take = node.kind === 'take'
  const failedTake = take && flags.failed
  // A selected card wears the accent ring; a stale card a danger outline; any other card the plain outline.
  let ring = '0 0 0 1px var(--dv-line-strong), var(--dv-shadow-1)'
  if (selected) ring = '0 0 0 2px var(--dv-accent), 0 0 0 6px var(--dv-accent-soft)'
  else if (flags.stale) ring = '0 0 0 1px var(--dv-danger), var(--dv-shadow-1)'
  else if (failedTake) ring = '0 0 0 1px var(--dv-line)'
  const style: CSSProperties = {
    position: 'absolute', left: x, top: y, width: NODE_WIDTH, boxSizing: 'border-box', background: failedTake ? 'var(--dv-danger-soft)' : 'var(--dv-surface-2)',
    color: 'var(--dv-text)', borderRadius: 'var(--dv-radius-lg)', boxShadow: ring, cursor: 'grab', userSelect: 'none', overflow: 'hidden',
    opacity: flags.superseded ? 0.55 : 1, touchAction: 'none',
  }
  let marker: string | null = null
  if (flags.rendering) marker = take ? t('node.rendering') : t('node.running')
  else if (flags.failed) marker = take ? t('node.renderFailed') : t('node.failed')
  const dot = <span style={{ flex: 'none', width: size(6), height: size(6), borderRadius: 9999, background: KIND_COLOR[node.kind] }} />
  const stale = flags.stale ? <span style={{ ...text(12), flex: 'none', color: 'var(--dv-danger)' }}>{t('node.stale')}</span> : null
  // Deterministic-edit badges, such as 已裁剪: over the frame's bottom-left corner, or a row under a card without a frame.
  const badges = (overFrame: boolean): ReactNode => node.badges.length === 0
    ? null
    : (
      <span style={overFrame ? { position: 'absolute', left: 6, bottom: 6, display: 'flex', gap: 4 } : { display: 'flex', gap: 4, padding: '0 10px 10px' }}>
        {node.badges.map(badge => <span key={badge} style={{ ...text(12), padding: '0 6px', borderRadius: 'var(--dv-radius-sm)', background: 'var(--dv-surface-3)', color: 'var(--dv-text-2)' }}>{badge === 'trim' ? t('badge.trim') : badge}</span>)}
      </span>
    )
  let body: ReactNode
  if (failedTake) {
    // A failed take has no frame: a compact row with the failure, the reason on hover, and 重试 when it can render again.
    body = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px' }}>
        <svg width={size(16)} height={size(16)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', color: 'var(--dv-danger)' }} aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" />
        </svg>
        <span style={{ ...text(12), flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', ...ellipsis }}>{nodeTitle(node, t)}</span>
          <span style={{ display: 'block', color: 'var(--dv-text-2)' }}>{marker}</span>
        </span>
        {stale}
        {onRetry === undefined
          ? null
          : (
            <button
              type="button" className="dv-canvas-btn"
              style={{ fontFamily: 'inherit', ...text(12), flex: 'none', height: 24, padding: '0 8px', border: '1px solid var(--dv-line-strong)', borderRadius: 'var(--dv-radius-sm)', color: 'var(--dv-text)', cursor: 'pointer' }}
              onPointerDown={(event) => { event.stopPropagation() }}
              onClick={onRetry}
            >
              {t('node.retry')}
            </button>
          )}
      </div>
    )
  } else if (node.kind === 'bible') {
    const extra = node.references.length - 1
    body = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10 }}>
        <div style={{ position: 'relative', flex: 'none', width: 40, height: 40, borderRadius: 'var(--dv-radius-md)', overflow: 'hidden', background: 'var(--dv-surface-3)' }}>
          {node.references[0] === undefined ? null : <img src={assetUrl(node.references[0])} alt="" style={media} draggable={false} />}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span style={{ ...text(12), display: 'flex', alignItems: 'center', gap: 6, color: 'var(--dv-text-2)' }}>
            {dot}{kindLabel(node, t)}
            {extra > 0 ? <span style={mono}>{t('node.moreReferences', { count: extra })}</span> : null}
            {stale}
          </span>
          <span style={{ ...text(14), fontWeight: 500, ...ellipsis }}>{node.title}</span>
          {marker === null ? null : <span style={{ ...text(12), color: flags.failed ? 'var(--dv-danger)' : 'var(--dv-text-2)' }}>{marker}</span>}
        </div>
      </div>
    )
  } else if (node.kind === 'plan') {
    const shots = plan?.shots ?? []
    const durations = shots.map(shot => shot.duration_sec)
    const total = durations.every(duration => duration !== undefined) && durations.length > 0
      ? durations.reduce<number>((sum, duration) => sum + (duration ?? 0), 0)
      : null
    const label = plan === undefined ? kindLabel(node, t) : `${kindLabel(node, t)} · ${t('node.planVersion', { version: plan.version })}`
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10 }}>
        <span style={{ ...text(12), display: 'flex', alignItems: 'center', gap: 6, color: 'var(--dv-text-2)' }}>
          {dot}<span style={{ flex: 1, minWidth: 0, ...ellipsis }}>{label}</span>{stale}
        </span>
        {frames.some(frame => frame !== null)
          ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 3 }}>
              {frames.map((frame, index) => (
                <div key={index} style={{ aspectRatio: '16 / 9', borderRadius: 3, overflow: 'hidden', background: 'var(--dv-surface-3)' }}>
                  {frame === null ? null : <Media {...frame} />}
                </div>
              ))}
            </div>
          )
          : null}
        <span style={{ ...text(14), fontWeight: 500 }}>
          {t('node.planShots', { count: node.subtitle })}
          {total === null ? null : <>{' · '}<span style={mono}>{clockText(total)}</span></>}
        </span>
        {marker === null ? null : <span style={{ ...text(12), color: flags.failed ? 'var(--dv-danger)' : 'var(--dv-text-2)' }}>{marker}</span>}
      </div>
    )
  } else {
    // A take or an imported asset: the header row above the 16:9 frame at full card width.
    body = (
      <>
        <div style={{ minHeight: size(HEADER_HEIGHT), boxSizing: 'border-box', padding: '0 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
          {dot}
          <span style={{ ...text(13), flex: 1, minWidth: 0, fontWeight: 500, ...ellipsis }}>{nodeTitle(node, t)}</span>
          {stale}
          {node.durationSec !== null ? <span style={{ ...text(12), ...mono, flex: 'none', color: 'var(--dv-text-2)' }}>{`${node.durationSec.toFixed(1)}s`}</span> : null}
        </div>
        <div style={{ position: 'relative', width: NODE_WIDTH, height: FRAME_HEIGHT, background: 'var(--dv-surface-3)', overflow: 'hidden' }}>
          <Media thumb={node.thumb} video={node.video} />
          {marker !== null
            ? <span style={{ ...text(13), position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--dv-overlay)', color: 'var(--dv-text)', fontWeight: 500 }}>{marker}</span>
            : null}
          {badges(true)}
        </div>
      </>
    )
  }
  return (
    <div
      style={style}
      data-node-id={node.id}
      data-node-kind={node.kind}
      data-node-stale={String(flags.stale)}
      onPointerDown={onPointerDown}
      role="button"
      tabIndex={0}
      aria-label={nodeTitle(node, t)}
      title={failedTake ? node.record?.error?.message : undefined}
    >
      {body}
      {node.kind === 'take' || node.kind === 'asset' ? null : badges(false)}
    </div>
  )
}
