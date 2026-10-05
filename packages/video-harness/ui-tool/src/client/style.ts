/**
 * Inline style values of the Tool mode. Colors read `--vh-*` variables that the workspace shell may define, with
 * translucent fallbacks that work on light and dark backgrounds.
 */
import type { CSSProperties } from 'react'

/** Color values. */
export const color = {
  panel: 'var(--vh-panel, rgba(127, 127, 127, 0.07))',
  line: 'var(--vh-line, rgba(127, 127, 127, 0.25))',
  muted: 'var(--vh-muted, rgba(127, 127, 127, 0.95))',
  accent: 'var(--vh-accent, #7c5cff)',
  danger: 'var(--vh-danger, #e5484d)',
} as const

/** A small bordered button. */
export const button: CSSProperties = {
  border: `1px solid ${color.line}`, background: 'transparent', color: 'inherit', borderRadius: 6, padding: '4px 10px',
  fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
}

/** The primary action button. */
export const primaryButton: CSSProperties = {
  ...button, background: color.accent, borderColor: color.accent, color: '#fff', fontSize: 14, padding: '8px 14px', fontWeight: 600,
}

/** A section label in the configuration panel. */
export const label: CSSProperties = { fontSize: 12, color: color.muted, margin: '14px 0 6px' }
