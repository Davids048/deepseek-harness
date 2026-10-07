/**
 * The composer's visible additions: the card of a `dv_shot_render_ref2va` or `dv_shot_render_t2va` call in the chat,
 * and the 在历史中查看 link of settled tool rows.
 *
 * @module @dv/ui-composer/views
 */
import type { CSSProperties } from 'react'
import { assetUrl } from '@dv/ui-kit/api.ts'
import { useText } from '@dv/ui-kit/locale.ts'
import { DV_HISTORY_FOCUS_EVENT, dispatchWorkspaceEvent } from '@dv/ui-kit/workspace-events.ts'

const card: CSSProperties = { border: '1px solid var(--dsh-border, #3a3a3a)', borderRadius: 10, padding: 10, margin: '6px 0', fontSize: 13 }
const secondary: CSSProperties = { padding: '4px 12px', borderRadius: 6, cursor: 'pointer', background: 'transparent', color: 'inherit', border: '1px solid var(--dsh-border, #3a3a3a)' }

/** Parsed arguments of a render call, empty while they stream. */
function argsOf(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  } catch {
    // Arguments are still streaming: the card shows what it has.
    return {}
  }
}

/**
 * Whether a settled tool call wrote a record, so that its row has a 在历史中查看 link. The result metadata of a tool that
 * writes records, an operation tool or a `dv_proj_*` tool, names the record it wrote; a read operation such as
 * `inspect.image` names `record: ''`, and a read `dv_proj_*` tool or a failed call carries no metadata.
 * @param block - the settled call block.
 * @returns whether the call wrote a record.
 */
function wroteRecord(block: object): boolean {
  const meta = 'meta' in block ? block.meta : undefined
  return typeof meta === 'object' && meta !== null && 'record' in meta && typeof meta.record === 'string' && meta.record !== ''
}

/**
 * 在历史中查看 on a settled tool row: asks the History panel to select the record this tool call wrote.
 * @param props - the chat session and the tool call.
 * @returns the link button.
 */
function HistoryLink(props: { sessionId: string; callId: string }) {
  const t = useText()
  const { sessionId, callId } = props
  return <button type="button" data-testid="dv-composer-open-history" style={{ ...secondary, padding: '0 6px', fontSize: 12 }}
    onClick={() => { dispatchWorkspaceEvent(DV_HISTORY_FOCUS_EVENT, { session: sessionId, toolCall: callId }) }}>
    {t('在历史中查看', 'Show in history')}
  </button>
}

/** What the render card reads from the tool-call owner props. */
export interface RenderCardProps {
  /** The render tool, `dv_shot_render_ref2va` or `dv_shot_render_t2va`. */
  toolName: string
  /** The tool's [Chinese, English] name. */
  label: readonly [string, string]
  sessionId: string
  callId: string
  phase: 'preparing' | 'start' | 'result'
  block: object
}

/** The asset URLs of a settled call, from the result's presentation metadata. */
function outputsOf(block: object): Array<{ role: string; url: string; mime: string }> {
  const meta = 'meta' in block ? block.meta : undefined
  if (typeof meta !== 'object' || meta === null || !('outputs' in meta) || !Array.isArray(meta.outputs)) return []
  return (meta.outputs as Array<{ role?: unknown; asset_id?: unknown; mime?: unknown }>).flatMap(output =>
    typeof output.asset_id === 'string' ? [{ role: String(output.role), url: assetUrl(output.asset_id), mime: String(output.mime) }] : [])
}

/**
 * The card of one render call (`dv_shot_render_ref2va` or `dv_shot_render_t2va`): the tool's name, the prompt, the
 * status, and the rendered video.
 * @param props - the call.
 * @returns the card.
 */
export function RenderCard(props: RenderCardProps) {
  const t = useText()
  const block = props.block
  const raw = 'argsRaw' in block && typeof block.argsRaw === 'string' ? block.argsRaw
    : 'call' in block && typeof block.call === 'object' && block.call !== null && 'argsRaw' in block.call ? String(block.call.argsRaw) : ''
  const args = argsOf(raw)
  const prompt = typeof args['prompt'] === 'string' ? args['prompt'] : ''
  const failed = 'isError' in block && block.isError === true
  const video = outputsOf(block).find(output => output.mime.startsWith('video/'))
  const status = props.phase === 'result' ? (failed ? t('未渲染', 'Not rendered') : t('已渲染', 'Rendered')) : t('渲染中…', 'Rendering…')
  return <div style={card} data-tool={props.toolName}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <strong>{t(props.label[0], props.label[1])}</strong><span style={{ opacity: 0.7 }}>{status}</span>
    </div>
    {prompt !== '' && <div style={{ marginTop: 4, opacity: 0.85 }}>{prompt}</div>}
    {video !== undefined && <video src={video.url} controls muted style={{ marginTop: 8, width: '100%', borderRadius: 8 }} />}
    {props.phase === 'result' && <div style={{ marginTop: 6 }}><HistoryLink sessionId={props.sessionId} callId={props.callId} /></div>}
  </div>
}

/**
 * The chat row of one agent tool call other than a render tool: the tool's creator-facing name, whether the step is
 * running, done, or failed, and, once settled, 在历史中查看 for a tool that writes a record.
 * @param props - the tool's [Chinese, English] name, the chat session, the tool call, the call phase, and the call block.
 * @returns the row.
 */
export function ToolLabelRow(props: {
  label: readonly [string, string]
  toolName: string
  sessionId: string
  callId: string
  phase: 'preparing' | 'start' | 'result'
  block: object
}) {
  const t = useText()
  const failed = 'isError' in props.block && props.block.isError === true
  const status = props.phase !== 'result' ? t('进行中…', 'Running…') : failed ? t('未完成', 'Failed') : t('完成', 'Done')
  return <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', margin: '4px 0', fontSize: 13 }} data-tool={props.toolName}>
    <span>{t(props.label[0], props.label[1])}</span><span style={{ opacity: 0.6, fontSize: 12 }}>{status}</span>
    {props.phase === 'result' && wroteRecord(props.block) && <HistoryLink sessionId={props.sessionId} callId={props.callId} />}
  </div>
}
