/**
 * The composer's visible additions: the two mode controls beside the input, the approval cards of waiting
 * generations above it, and the card of a `generate.video` call in the chat.
 *
 * @module @video-harness/ui-composer/views
 */
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { assetUrl } from '@video-harness/ui-kit/api.ts'
import { useText } from '@video-harness/ui-kit/locale.ts'
import { approvalStore, readMode, writeMode, type ComposerMode, type PendingApproval } from './api.ts'

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
 * The 生成前先问 / 直接生成 and 质量 / 速度 toggles of one session, stored on the host per session.
 * @param props - the session.
 * @returns the controls.
 */
export function ModeControls(props: { sessionId: string; onMount: () => () => void }) {
  const { sessionId, onMount } = props
  const t = useText()
  const [mode, setMode] = useState<ComposerMode | null>(null)
  useEffect(() => {
    let live = true
    readMode(sessionId).then((value) => { if (live) setMode(value) }, () => { if (live) setMode({ confirm: 'direct', speed: 'quality' }) })
    return () => { live = false }
  }, [sessionId])
  useEffect(onMount, [onMount])
  if (mode === null) return null
  const change = (patch: Partial<ComposerMode>): void => {
    setMode({ ...mode, ...patch })
    writeMode(sessionId, patch).then(setMode, () => { /* the next read shows the stored choice */ })
  }
  return <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
    <Toggle value={mode.confirm} options={[
      ['ask', t('生成前先问', 'Ask first'), t('每次生成视频前，在输入框上方等你批准', 'Each video generation waits for your approval above the input')],
      ['direct', t('直接生成', 'Generate directly'), t('agent 直接生成视频，不等批准', 'The agent generates videos without waiting for approval')],
    ]} onChange={(confirm) => { change({ confirm }) }} />
    <Toggle value={mode.speed} options={[
      ['quality', t('质量', 'Quality'), t('agent 写更细的提示词，镜头需要时用更长时长', 'The agent writes careful prompts and uses longer durations where a shot needs them')],
      ['speed', t('速度', 'Speed'), t('agent 用最短时长，每个镜头只生成一版', 'The agent uses the shortest durations and one take per shot')],
    ]} onChange={(speed) => { change({ speed }) }} />
  </span>
}

/** The approval list of a session, kept fresh while mounted. */
function useApprovals(sessionId: string): PendingApproval[] {
  const store = approvalStore(sessionId)
  return useSyncExternalStore(store.subscribe, store.snapshot)
}

/**
 * The approval area above the composer: one approval card per waiting generation, plus 全部批准 when several wait.
 * The cards live here, outside the chat's collapsible tool rows, so a waiting generation is always visible.
 * @param props - the session.
 * @returns the area or nothing.
 */
export function PendingBar(props: { sessionId: string }) {
  const t = useText()
  const approvals = useApprovals(props.sessionId)
  if (approvals.length === 0) return null
  return <div data-testid="vh-pending-approvals" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 10px', fontSize: 13, borderRadius: 8, background: 'var(--dsh-surface-2, rgba(109,94,252,.12))', maxHeight: '45vh', overflowY: 'auto' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span>{t('待批准', 'Pending approval')} ({approvals.length})</span>
      {approvals.length > 1 && <button type="button" style={primary} onClick={() => { void approvalStore(props.sessionId).answer('all', 'approve') }}>{t('全部批准', 'Approve all')}</button>}
    </div>
    {approvals.map(approval => <ApprovalCard key={approval.id} approval={approval} />)}
  </div>
}

/** Parsed arguments of a generate call, empty while they stream. */
function argsOf(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  } catch {
    // Arguments are still streaming: the card shows what it has.
    return {}
  }
}

/** What the generate card reads from the tool-call owner props. */
export interface GenerateCardProps {
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
 * The card of one `generate.video` call: its prompt, status, and the generated video. While the call waits for the
 * user, the status points to the approval card above the composer, which holds the 批准 / 跳过 buttons.
 * @param props - the call.
 * @returns the card.
 */
export function GenerateCard(props: GenerateCardProps) {
  const t = useText()
  const approvals = useApprovals(props.sessionId)
  const pending = approvals.find(entry => entry.callId === props.callId)
  const block = props.block
  const raw = 'argsRaw' in block && typeof block.argsRaw === 'string' ? block.argsRaw
    : 'call' in block && typeof block.call === 'object' && block.call !== null && 'argsRaw' in block.call ? String(block.call.argsRaw) : ''
  const args = argsOf(raw)
  const prompt = typeof args['prompt'] === 'string' ? args['prompt'] : ''
  const failed = 'isError' in block && block.isError === true
  const video = outputsOf(block).find(output => output.mime.startsWith('video/'))
  const status = pending !== undefined ? t('等待批准（在输入框上方）', 'Waiting for approval (above the input)')
    : props.phase === 'result' ? (failed ? t('未生成', 'Not generated') : t('已生成', 'Generated')) : t('生成中…', 'Generating…')
  return <div style={card} data-tool="vh_generate_video">
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{t('生成视频', 'Generate video')}</strong><span style={{ opacity: 0.7 }}>{status}</span></div>
    {prompt !== '' && <div style={{ marginTop: 4, opacity: 0.85 }}>{prompt}</div>}
    {video !== undefined && <video src={video.url} controls muted style={{ marginTop: 8, width: '100%', borderRadius: 8 }} />}
  </div>
}

/**
 * The chat row of one `vh_*` tool call other than generation: the tool's creator-facing name and whether the step is
 * running, done, or failed.
 * @param props - the tool's [Chinese, English] name, the call phase, and the call block.
 * @returns the row.
 */
export function ToolLabelRow(props: { label: readonly [string, string]; toolName: string; phase: 'preparing' | 'start' | 'result'; block: object }) {
  const t = useText()
  const failed = 'isError' in props.block && props.block.isError === true
  const status = props.phase !== 'result' ? t('进行中…', 'Running…') : failed ? t('未完成', 'Failed') : t('完成', 'Done')
  return <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', margin: '4px 0', fontSize: 13 }} data-tool={props.toolName}>
    <span>{t(props.label[0], props.label[1])}</span><span style={{ opacity: 0.6, fontSize: 12 }}>{status}</span>
  </div>
}

/** The approval card of one waiting generation. */
function ApprovalCard(props: { approval: PendingApproval }) {
  const t = useText()
  const { approval } = props
  const store = approvalStore(approval.sessionId)
  // A plan approval's prompt holds one numbered line per shot.
  const shots = approval.tool === 'plan.approve' ? approval.prompt.split('\n').filter(line => line.trim() !== '').length : null
  const title = shots === null ? t('待批准 · 生成视频', 'Pending approval · Generate video')
    : t(`待批准 · 计划（${String(shots)} 个镜头）`, `Pending approval · Plan (${String(shots)} ${shots === 1 ? 'shot' : 'shots'})`)
  return <div style={{ ...card, borderColor: 'var(--dsh-accent, #6d5efc)' }} data-tool="vh_generate_video" data-state="awaiting-approval">
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{title}</strong><span style={{ opacity: 0.7 }}>{t('DreamVerse 视频模型', 'DreamVerse video model')}</span></div>
    <div style={{ marginTop: 6, whiteSpace: 'pre-line' }}>{approval.prompt || approval.summary}</div>
    {approval.references.length > 0 && <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
      {approval.references.map(reference => reference.url === null
        ? <span key={`${reference.role}:${reference.ref}`} style={{ fontSize: 11, opacity: 0.7 }}>{reference.ref}</span>
        : <img key={`${reference.role}:${reference.ref}`} src={reference.url} alt={reference.ref} title={`${reference.role}: ${reference.ref}`} style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6 }} />)}
    </div>}
    <div style={{ display: 'flex', gap: 12, marginTop: 8, opacity: 0.8, fontSize: 12 }}>
      <span>{t('时长', 'Duration')} {approval.durationSec === null ? t('默认', 'default') : `${String(approval.durationSec)} ${t('秒', 's')}`}</span>
      <span>{t('预计 GPU', 'Est. GPU')} {Math.round(approval.estimateGpuSeconds)} {t('秒', 's')}</span>
    </div>
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
      <button type="button" style={primary} onClick={() => { void store.answer(approval.id, 'approve') }}>{t('批准', 'Approve')}</button>
      <button type="button" style={secondary} onClick={() => { void store.answer(approval.id, 'skip') }}>{t('跳过', 'Skip')}</button>
    </div>
  </div>
}
