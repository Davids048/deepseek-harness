/**
 * The composer's visible additions: the two mode controls beside the input, the approval cards of waiting
 * renders above it, the card of a `shot.render` call in the chat, and the 在历史中查看 link of settled tool rows.
 *
 * @module @dv/ui-composer/views
 */
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { assetUrl } from '@dv/ui-kit/api.ts'
import { useText } from '@dv/ui-kit/locale.ts'
import type { ApprovalCard, ComposerMode } from '@dv/ui-kit/types.ts'
import { DV_HISTORY_FOCUS_EVENT, dispatchWorkspaceEvent } from '@dv/ui-kit/workspace-events.ts'
import { approvalStore, composerClient } from './api.ts'

const chip: CSSProperties = { display: 'inline-flex', borderRadius: 999, border: '1px solid var(--dsh-border, #3a3a3a)', overflow: 'hidden', fontSize: 12 }
const button = (active: boolean): CSSProperties => ({
  padding: '2px 8px', border: 'none', cursor: 'pointer', fontSize: 12,
  background: active ? 'var(--dsh-accent, #6d5efc)' : 'transparent', color: active ? '#fff' : 'inherit',
})
const card: CSSProperties = { border: '1px solid var(--dsh-border, #3a3a3a)', borderRadius: 10, padding: 10, margin: '6px 0', fontSize: 13 }
const primary: CSSProperties = { padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', background: 'var(--dsh-accent, #6d5efc)', color: '#fff' }
const secondary: CSSProperties = { padding: '4px 12px', borderRadius: 6, cursor: 'pointer', background: 'transparent', color: 'inherit', border: '1px solid var(--dsh-border, #3a3a3a)' }

/** One two-option toggle; each option carries a tooltip that says what it changes. */
function Toggle<V extends string>(props: { value: V; options: Array<[V, string, string]>; onChange: (value: V) => void }) {
  return <span style={chip}>
    {props.options.map(([value, label, hint]) => <button key={value} type="button" title={hint} aria-pressed={props.value === value} style={button(props.value === value)} onClick={() => { props.onChange(value) }}>{label}</button>)}
  </span>
}

/**
 * The 渲染前先问 / 直接渲染 and 质量 / 速度 toggles of one session, stored on the host per session.
 * @param props - the session.
 * @returns the controls.
 */
export function ModeControls(props: { sessionId: string; onMount: () => () => void }) {
  const { sessionId, onMount } = props
  const t = useText()
  const [mode, setMode] = useState<ComposerMode | null>(null)
  useEffect(() => {
    let live = true
    composerClient.getComposerMode(sessionId).then((value) => { if (live) setMode(value) }, () => { if (live) setMode({ confirm: 'direct', speed: 'quality' }) })
    return () => { live = false }
  }, [sessionId])
  useEffect(onMount, [onMount])
  if (mode === null) return null
  const change = (patch: Partial<ComposerMode>): void => {
    setMode({ ...mode, ...patch })
    composerClient.updateComposerMode(sessionId, patch).then(setMode, () => { /* the next read shows the stored choice */ })
  }
  return <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
    <Toggle value={mode.confirm} options={[
      ['ask', t('渲染前先问', 'Ask first'), t('每次渲染前，在输入框上方等你批准', 'Each render waits for your approval above the input')],
      ['direct', t('直接渲染', 'Render directly'), t('智能体直接渲染，不等批准', 'The agent renders without waiting for approval')],
    ]} onChange={(confirm) => { change({ confirm }) }} />
    <Toggle value={mode.speed} options={[
      ['quality', t('质量', 'Quality'), t('智能体写更细的提示词，镜头需要时用更长时长', 'The agent writes careful prompts and uses longer durations where a shot needs them')],
      ['speed', t('速度', 'Speed'), t('智能体用最短时长，每个镜头只渲染一个版本', 'The agent uses the shortest durations and one take per shot')],
    ]} onChange={(speed) => { change({ speed }) }} />
  </span>
}

/** The approval list of a session, kept fresh while mounted. */
function useApprovals(sessionId: string): ApprovalCard[] {
  const store = approvalStore(sessionId)
  return useSyncExternalStore(store.subscribe, store.snapshot)
}

/**
 * The approval area above the composer: one approval card per waiting render, plus 全部批准 when several wait.
 * The cards live here, outside the chat's collapsible tool rows, so a waiting render is always visible.
 * @param props - the session.
 * @returns the area or nothing.
 */
export function PendingBar(props: { sessionId: string }) {
  const t = useText()
  const approvals = useApprovals(props.sessionId)
  if (approvals.length === 0) return null
  return <div data-testid="dv-composer-pending-approvals" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 10px', fontSize: 13, borderRadius: 8, background: 'var(--dsh-surface-2, rgba(109,94,252,.12))', maxHeight: '45vh', overflowY: 'auto' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span>{t('待批准', 'Pending approval')} ({approvals.length})</span>
      {approvals.length > 1 && <button type="button" style={primary} onClick={() => { void approvalStore(props.sessionId).answer('all', 'approve') }}>{t('全部批准', 'Approve all')}</button>}
    </div>
    {approvals.map(approval => <ApprovalCardView key={approval.id} approval={approval} />)}
  </div>
}

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

/** Read tools: they write no record, so their rows have no 在历史中查看 link. */
const READ_TOOLS: ReadonlySet<string> = new Set(['dv_proj_state', 'dv_proj_history_list', 'dv_proj_wait', 'dv_inspect_image', 'dv_inspect_asset'])

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
 * The card of one `shot.render` call: its prompt, status, and the rendered video. While the call waits for the
 * user, the status points to the approval card above the composer, which holds the 批准 / 跳过 buttons.
 * @param props - the call.
 * @returns the card.
 */
export function RenderCard(props: RenderCardProps) {
  const t = useText()
  const approvals = useApprovals(props.sessionId)
  const pending = approvals.find(entry => entry.tool_call === props.callId)
  const block = props.block
  const raw = 'argsRaw' in block && typeof block.argsRaw === 'string' ? block.argsRaw
    : 'call' in block && typeof block.call === 'object' && block.call !== null && 'argsRaw' in block.call ? String(block.call.argsRaw) : ''
  const args = argsOf(raw)
  const prompt = typeof args['prompt'] === 'string' ? args['prompt'] : ''
  const failed = 'isError' in block && block.isError === true
  const video = outputsOf(block).find(output => output.mime.startsWith('video/'))
  const status = pending !== undefined ? t('等待批准（在输入框上方）', 'Waiting for approval (above the input)')
    : props.phase === 'result' ? (failed ? t('未渲染', 'Not rendered') : t('已渲染', 'Rendered')) : t('渲染中…', 'Rendering…')
  return <div style={card} data-tool="dv_shot_render">
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{t('渲染镜头', 'Render shot')}</strong><span style={{ opacity: 0.7 }}>{status}</span></div>
    {prompt !== '' && <div style={{ marginTop: 4, opacity: 0.85 }}>{prompt}</div>}
    {video !== undefined && <video src={video.url} controls muted style={{ marginTop: 8, width: '100%', borderRadius: 8 }} />}
    {props.phase === 'result' && <div style={{ marginTop: 6 }}><HistoryLink sessionId={props.sessionId} callId={props.callId} /></div>}
  </div>
}

/**
 * The chat row of one agent tool call other than `dv_shot_render`: the tool's creator-facing name, whether the step is
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
    {props.phase === 'result' && !READ_TOOLS.has(props.toolName) && <HistoryLink sessionId={props.sessionId} callId={props.callId} />}
  </div>
}

/** The approval card of one waiting render or plan approval, marked with its tool name (`dv_shot_render`, `dv_plan_approve`). */
function ApprovalCardView(props: { approval: ApprovalCard }) {
  const t = useText()
  const { approval } = props
  const store = approvalStore(approval.session)
  // A plan approval's prompt holds one numbered line per shot.
  const shots = approval.operation === 'plan.approve' ? approval.prompt.split('\n').filter(line => line.trim() !== '').length : null
  const title = shots === null ? t('待批准 · 渲染镜头', 'Pending approval · Render shot')
    : t(`待批准 · 分镜计划（${String(shots)} 个镜头）`, `Pending approval · Plan (${String(shots)} ${shots === 1 ? 'shot' : 'shots'})`)
  const tool = `dv_${approval.operation.replace('.', '_')}`
  return <div style={{ ...card, borderColor: 'var(--dsh-accent, #6d5efc)' }} data-tool={tool} data-state="awaiting-approval">
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{title}</strong><span style={{ opacity: 0.7 }}>{t('DreamVerse 视频模型', 'DreamVerse video model')}</span></div>
    <div style={{ marginTop: 6, whiteSpace: 'pre-line' }}>{approval.prompt || approval.summary}</div>
    {approval.references.length > 0 && <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
      {approval.references.map(reference => reference.url === null
        ? <span key={`${reference.role}:${reference.ref}`} style={{ fontSize: 11, opacity: 0.7 }}>{reference.ref}</span>
        : <img key={`${reference.role}:${reference.ref}`} src={reference.url} alt={reference.ref} title={`${reference.role}: ${reference.ref}`} style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6 }} />)}
    </div>}
    <div style={{ display: 'flex', gap: 12, marginTop: 8, opacity: 0.8, fontSize: 12 }}>
      <span>{t('时长', 'Duration')} {approval.duration_sec === null ? t('默认', 'default') : `${String(approval.duration_sec)} ${t('秒', 's')}`}</span>
      <span>{t('预计 GPU', 'Est. GPU')} {Math.round(approval.gpu_seconds)} {t('秒', 's')}</span>
    </div>
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
      <button type="button" style={primary} onClick={() => { void store.answer(approval.id, 'approve') }}>{t('批准', 'Approve')}</button>
      <button type="button" style={secondary} onClick={() => { void store.answer(approval.id, 'skip') }}>{t('跳过', 'Skip')}</button>
    </div>
  </div>
}
