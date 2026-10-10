/**
 * The composer's visible additions: the card of a `dv_shot_render_ref2va` or `dv_shot_render_t2va` call in the chat,
 * and the 在历史中查看 link of settled tool rows.
 *
 * @module @dv/ui-composer/views
 */
import { assetUrl } from '@dv/ui-kit/api.ts'
import { useText } from '@dv/ui-kit/locale.ts'
import { DV_HISTORY_FOCUS_EVENT, dispatchWorkspaceEvent } from '@dv/ui-kit/workspace-events.ts'
import css from './views.module.css'

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
  return <button type="button" data-testid="dv-composer-open-history" className={css.textButton}
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
  return <div className={css.card} data-tool={props.toolName}>
    <div className={css.cardHeader}>
      <span className={css.title}>{t(props.label[0], props.label[1])}</span>
      <span className={css.status} data-failed={props.phase === 'result' && failed ? '' : undefined}>{status}</span>
    </div>
    {prompt !== '' && <div className={css.prompt}>{prompt}</div>}
    {video !== undefined && <video src={video.url} controls muted className={css.video} />}
    {props.phase === 'result' && <div className={css.cardFooter}><HistoryLink sessionId={props.sessionId} callId={props.callId} /></div>}
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
  return <div className={css.toolRow} data-tool={props.toolName}>
    <span>{t(props.label[0], props.label[1])}</span>
    <span className={css.status} data-failed={props.phase === 'result' && failed ? '' : undefined}>{status}</span>
    {props.phase === 'result' && wroteRecord(props.block) && <HistoryLink sessionId={props.sessionId} callId={props.callId} />}
  </div>
}
