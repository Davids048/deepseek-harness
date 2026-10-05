/**
 * The Tool mode of one Tool session: a configuration panel on the left (video, Reference mode only) and the session's
 * results feed in the center, newest first. Every generation is one `generate.video` record with actor `user`,
 * surface `tool`, and `params.tool_session`, written through `POST /api/vh/tool-sessions/generate`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, ReactNode } from 'react'
import { VhClient, assetUrl } from '@video-harness/ui-kit/api.ts'
import { dispatchCompose } from '@video-harness/ui-kit/compose.ts'
import { useText } from '@video-harness/ui-kit/locale.ts'
import { ToolApi, VH_TOOL_SESSIONS_CHANGED_EVENT, toolSessionTitle } from '@video-harness/ui-kit/tool-api.ts'
import type { WireToolCapabilities, WireToolSession } from '@video-harness/ui-kit/tool-api.ts'
import type { WireOp } from '@video-harness/ui-kit/types.ts'
import { useProjectState } from '@video-harness/ui-kit/useProject.ts'
import { VH_ASSET_DRAG_TYPE, dispatchWorkspaceEvent } from '@video-harness/ui-kit/workspace-events.ts'
import { button, color, label, primaryButton } from './style.ts'

/** Props of {@link ToolView}. */
export interface ToolViewProps {
  projectId: string
  toolSessionId: string
  /** Called once when the session does not exist (deleted, or a stale link), so the host can leave it. */
  onMissing?: () => void
  /** Insert a generated video into the active cut; omitted, the view dispatches `vh:cut-insert`. */
  onInsertToCut?: (assetId: string) => void
  /** The API clients; default to ones over the page's fetch. */
  api?: ToolApi
  client?: VhClient
}

/** Limits shown until the host answers. */
const PLACEHOLDER_CAPABILITIES: WireToolCapabilities = { available: false, modelName: 'FastH3 Ref2AV', minDurationSec: 5, maxDurationSec: 15, maxReferences: 3 }


/** Milliseconds between result refetches while a generation is queued or running. */
const LIVE_POLL_MS = 3000

/**
 * The Tool session's records, refetched on every log change and polled while a generation is queued or running.
 * @param api - the Tool API.
 * @param client - the views client, for the log event stream.
 * @param projectId - the project.
 * @param sessionId - the Tool session.
 * @returns the records, newest first, and a reload function.
 */
function useResults(
  api: ToolApi,
  client: VhClient,
  projectId: string,
  sessionId: string,
): { ops: WireOp[]; error: string | null; reload: () => void } {
  const [ops, setOps] = useState<WireOp[]>([])
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    api.results(projectId, sessionId).then(
      (rows) => { setOps(rows); setError(null) },
      (failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) },
    )
  }, [api, projectId, sessionId])
  useEffect(() => {
    setOps([])
    reload()
    let timer: ReturnType<typeof setTimeout> | null = null
    // Coalesce bursts of log events (append, patch, head) into one refetch.
    const stop = client.subscribe(projectId, () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(reload, 250)
    })
    return () => { stop(); if (timer !== null) clearTimeout(timer) }
  }, [client, projectId, reload])
  const live = ops.some(op => op.status === 'pending' || op.status === 'running')
  useEffect(() => {
    if (!live) return undefined
    // The log event stream can miss changes (a proxy that buffers it, a browser out of connections); polling keeps an
    // in-flight card from showing a stale status after its generation has finished.
    const timer = setInterval(reload, LIVE_POLL_MS)
    return () => { clearInterval(timer) }
  }, [live, reload])
  return { ops, error, reload }
}

/**
 * The Tool mode body.
 * @param props - the project, the Tool session, and the optional cut-insert callback.
 * @returns the view.
 */
export function ToolView(props: ToolViewProps): ReactNode {
  const api = useMemo(() => props.api ?? new ToolApi(), [props.api])
  const client = useMemo(() => props.client ?? new VhClient(), [props.client])
  const { projectId, toolSessionId } = props
  const t = useText()
  const [caps, setCaps] = useState<WireToolCapabilities>(PLACEHOLDER_CAPABILITIES)
  // Null while the session list loads; 'missing' when the project has no session with this ID.
  const [session, setSession] = useState<WireToolSession | 'missing' | null>(null)
  const results = useResults(api, client, projectId, toolSessionId)
  useEffect(() => { api.capabilities().then(setCaps, () => { setCaps(PLACEHOLDER_CAPABILITIES) }) }, [api])
  // Read the session's title now and again whenever a view renames a session of this project.
  useEffect(() => {
    const load = (): void => {
      api.sessions(projectId).then((rows) => { setSession(rows.find(row => row.id === toolSessionId) ?? 'missing') }, () => { setSession(null) })
    }
    load()
    const onChanged = (event: Event): void => { if ((event as CustomEvent<string>).detail === projectId) load() }
    window.addEventListener(VH_TOOL_SESSIONS_CHANGED_EVENT, onChanged)
    return () => { window.removeEventListener(VH_TOOL_SESSIONS_CHANGED_EVENT, onChanged) }
  }, [api, projectId, toolSessionId])

  const { onMissing } = props
  useEffect(() => { if (session === 'missing') onMissing?.() }, [session, onMissing])
  if (session === 'missing') {
    return (
      <div data-testid="vh-tool-missing" style={{ padding: 24, color: color.muted, fontSize: 13 }}>
        {t('这个 Tool 会话已删除或不存在。从左侧的 Tool 会话列表打开或新建一个会话。', 'This Tool session was deleted or does not exist. Open or create one from the Tool sessions list on the left.')}
      </div>
    )
  }

  const insert = (assetId: string): void => {
    if (props.onInsertToCut === undefined) dispatchWorkspaceEvent('vh:cut-insert', { assetId })
    else props.onInsertToCut(assetId)
  }
  return (
    <div data-testid="vh-tool-view" style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <ToolConfig
        api={api} client={client} projectId={projectId} toolSessionId={toolSessionId} caps={caps}
        onSubmitted={results.reload}
      />
      <section style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '16px 16px' }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 12px' }}>{session === null ? t('Tool 会话', 'Tool session') : toolSessionTitle(session.title)}</h2>
        {results.error === null ? null : <p style={{ color: color.danger, fontSize: 12 }}>{results.error}</p>}
        {results.ops.length === 0
          ? <p style={{ color: color.muted, fontSize: 13 }}>{t('还没有生成结果。在左侧添加参考图、填写提示词并点击「生成」。', 'No results yet. Add a reference image and a prompt on the left, then click Generate.')}</p>
          : results.ops.map(op => <ResultCard key={op.id} op={op} onInsert={insert} />)}
      </section>
    </div>
  )
}

/** Props of {@link ToolConfig}. */
interface ToolConfigProps {
  api: ToolApi
  client: VhClient
  projectId: string
  toolSessionId: string
  caps: WireToolCapabilities
  onSubmitted: () => void
}

/**
 * The left configuration panel: media tab, mode, reference images, prompt, duration, seed, model chip, and 生成.
 * @param props - the clients, the target session, the model limits, and the submit callback.
 * @returns the panel.
 */
function ToolConfig(props: ToolConfigProps): ReactNode {
  const { api, caps } = props
  const t = useText()
  const [references, setReferences] = useState<string[]>([])
  const [prompt, setPrompt] = useState('')
  const [duration, setDuration] = useState<number | null>(null)
  const [seed, setSeed] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const durationSec = Math.min(caps.maxDurationSec, Math.max(caps.minDurationSec, duration ?? caps.minDurationSec))
  const full = references.length >= caps.maxReferences

  const addReference = (assetId: string): void => {
    setReferences(current => current.includes(assetId) || current.length >= caps.maxReferences ? current : [...current, assetId])
  }
  const uploadFiles = (files: FileList | null): void => {
    if (files === null) return
    const images: File[] = []
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) { setNotice(t(`「${file.name}」不是图片，参考图只接受图片。`, `"${file.name}" is not an image; references accept images only.`)); continue }
      images.push(file)
    }
    // Upload only the images that fit, so the extras never become project assets.
    const free = Math.max(0, caps.maxReferences - references.length)
    const skipped = images.slice(free).map(file => file.name)
    if (skipped.length > 0) {
      const max = String(caps.maxReferences)
      setNotice(t(`参考图最多 ${max} 张，未上传：${skipped.join('、')}`, `At most ${max} reference images fit; not uploaded: ${skipped.join(', ')}`))
    }
    for (const file of images.slice(0, free)) {
      api.upload(props.projectId, file).then(
        addReference,
        (failure: unknown) => { setNotice(failure instanceof Error ? failure.message : String(failure)) },
      )
    }
  }
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const assetId = event.dataTransfer.getData(VH_ASSET_DRAG_TYPE)
    if (assetId.length > 0) addReference(assetId)
    else uploadFiles(event.dataTransfer.files)
  }
  const submit = (): void => {
    // Reference mode generates from at least one reference image; the backend rejects a request without one.
    if (references.length === 0) { setNotice(t('参考模式至少需要一张参考图。', 'Reference mode needs at least one reference image.')); return }
    if (prompt.trim().length === 0) { setNotice(t('请先填写提示词。', 'Write a prompt first.')); return }
    const seedValue = seed.trim().length === 0 ? undefined : Number(seed)
    if (seedValue !== undefined && !Number.isInteger(seedValue)) { setNotice(t('种子必须是整数。', 'The seed must be an integer.')); return }
    setBusy(true)
    api.generate({
      project: props.projectId, session: props.toolSessionId, prompt: prompt.trim(), references, duration_sec: durationSec,
      ...(seedValue === undefined ? {} : { seed: seedValue }),
    }).then(() => { setNotice(null); props.onSubmitted() }, (failure: unknown) => { setNotice(String(failure)) })
      .finally(() => { setBusy(false) })
  }

  const tab = (active: boolean): CSSProperties => ({
    ...button, border: 'none', borderRadius: 0, padding: '6px 2px', marginRight: 14, fontSize: 13,
    borderBottom: active ? `2px solid ${color.accent}` : '2px solid transparent', opacity: active ? 1 : 0.45, cursor: active ? 'default' : 'not-allowed',
  })
  return (
    <aside style={{ width: 'clamp(220px, 32%, 320px)', flexShrink: 0, borderRight: `1px solid ${color.line}`, padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div>
        <button type="button" style={tab(true)}>{t('视频', 'Video')}</button>
        <button type="button" style={tab(false)} disabled title={t('即将推出', 'Coming soon')}>{t('图片', 'Image')}</button>
      </div>
      <div style={label}>{t('模式', 'Mode')}</div>
      <span style={{ ...button, alignSelf: 'flex-start', borderColor: color.accent, color: color.accent, cursor: 'default' }}>{t('参考', 'Reference')}</span>

      <div style={label}>{t('参考图', 'References')} ({references.length}/{caps.maxReferences})</div>
      <div
        onDragOver={(event) => { event.preventDefault() }} onDrop={onDrop}
        style={{ border: `1px dashed ${color.line}`, borderRadius: 8, padding: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}
      >
        {references.map(id => (
          <div key={id} style={{ position: 'relative', width: 64, height: 64 }}>
            <img src={assetUrl(id)} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6 }} />
            <button
              type="button" aria-label={t('移除参考图', 'Remove reference image')} onClick={() => { setReferences(current => current.filter(ref => ref !== id)) }}
              style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9, border: 'none', background: '#000a', color: '#fff', fontSize: 11, cursor: 'pointer', padding: 0 }}
            >×</button>
          </div>
        ))}
        {full
          ? null
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, justifyContent: 'center', fontSize: 12, color: color.muted }}>
              <span>{t('拖入图片或素材', 'Drop images or assets here')}</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button type="button" style={button} onClick={() => fileInput.current?.click()}>{t('上传', 'Upload')}</button>
                <button type="button" style={button} onClick={() => { setPicking(open => !open) }}>{t('从素材选择', 'Choose from assets')}</button>
              </span>
            </div>
          )}
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(event) => { uploadFiles(event.currentTarget.files); event.currentTarget.value = '' }} />
      </div>
      {picking && !full
        ? (
          <AssetPicker
            client={props.client}
            projectId={props.projectId}
            selected={references}
            onPick={(id) => { addReference(id); setPicking(false) }}
          />
        )
        : null}

      <div style={label}>{t('提示词', 'Prompt')}</div>
      <textarea
        value={prompt} onChange={(event) => { setPrompt(event.currentTarget.value) }} rows={6}
        placeholder={t('描述画面、动作和镜头。用 Picture 1、Picture 2 指代参考图。', 'Describe the scene, the action, and the camera. Refer to the references as Picture 1, Picture 2.')}
        style={{ resize: 'vertical', borderRadius: 8, border: `1px solid ${color.line}`, background: 'transparent', color: 'inherit', padding: 8, fontSize: 13, fontFamily: 'inherit' }}
      />

      <div style={label}>{t(`时长 · ${String(durationSec)} 秒`, `Duration · ${String(durationSec)} s`)}</div>
      <input
        type="range" min={caps.minDurationSec} max={caps.maxDurationSec} step={1} value={durationSec}
        onChange={(event) => { setDuration(Number(event.currentTarget.value)) }} aria-label={t('时长（秒）', 'Duration (seconds)')}
      />

      <div style={label}>{t('种子', 'Seed')}</div>
      <span style={{ display: 'flex', gap: 6 }}>
        <input
          value={seed} onChange={(event) => { setSeed(event.currentTarget.value) }} placeholder={t('留空则随机', 'Empty for random')} inputMode="numeric"
          style={{ ...button, flex: 1, cursor: 'text', fontSize: 13 }}
        />
        <button type="button" style={button} title={t('随机种子', 'Random seed')} onClick={() => { setSeed(String(Math.floor(Math.random() * 2 ** 31))) }}>🎲</button>
      </span>

      <div style={{ marginTop: 'auto', paddingTop: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...button, cursor: 'default' }} title={caps.available ? t('视频模型已连接', 'Video model connected') : t('生成后端未连接', 'Generation backend not connected')}>
          {caps.available ? '●' : '○'} {t('DreamVerse 视频模型', 'DreamVerse video model')}
        </span>
        <button type="button" style={{ ...primaryButton, flex: 1, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>
          {busy ? t('提交中…', 'Submitting…') : t('生成', 'Generate')}
        </button>
      </div>
      {notice === null ? null : <p style={{ color: color.danger, fontSize: 12, marginTop: 8 }}>{notice}</p>}
    </aside>
  )
}

/**
 * A picker over the project's image assets.
 * @param props - the client, the project, the already selected assets, and the pick callback.
 * @returns the picker.
 */
function AssetPicker(props: { client: VhClient; projectId: string; selected: string[]; onPick: (assetId: string) => void }): ReactNode {
  const state = useProjectState(props.client, props.projectId, 'main')
  const t = useText()
  const images = (state.value?.assets ?? []).filter(asset => asset.mime.startsWith('image/') && !props.selected.includes(asset.id))
  return (
    <div style={{ marginTop: 8, border: `1px solid ${color.line}`, borderRadius: 8, padding: 8, maxHeight: 200, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
      {images.length === 0 ? <span style={{ gridColumn: '1 / -1', fontSize: 12, color: color.muted }}>{t('项目里还没有图片素材。', 'This project has no image assets yet.')}</span> : null}
      {images.map(asset => (
        <button key={asset.id} type="button" title={asset.name} onClick={() => { props.onPick(asset.id) }} style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}>
          <img src={assetUrl(asset.id)} alt={asset.name} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 4 }} />
        </button>
      ))}
    </div>
  )
}

/**
 * One generation in the feed: the video or its status, the prompt, the settings, and the actions.
 * @param props - the record and the cut-insert action.
 * @returns the card.
 */
function ResultCard(props: { op: WireOp; onInsert: (assetId: string) => void }): ReactNode {
  const { op } = props
  const t = useText()
  const prompt = typeof op.params['prompt'] === 'string' ? op.params['prompt'] : ''
  const video = op.status === 'done' ? op.outputs[0] : undefined
  const references = op.inputs.filter(input => input.role === 'reference')
  const facts = [
    typeof op.params['duration_sec'] === 'number' ? t(`${String(op.params['duration_sec'])} 秒`, `${String(op.params['duration_sec'])} s`) : null,
    typeof op.report?.['seed'] === 'number' ? `${t('种子', 'Seed')} ${String(op.report['seed'])}` : typeof op.params['seed'] === 'number' ? `${t('种子', 'Seed')} ${String(op.params['seed'])}` : null,
    typeof op.cost?.gpu_s === 'number' ? t(`GPU ${op.cost.gpu_s.toFixed(1)} 秒`, `GPU ${op.cost.gpu_s.toFixed(1)} s`) : null,
    new Date(op.created_at).toLocaleString(),
  ].filter((fact): fact is string => fact !== null)
  return (
    <article data-testid="vh-tool-result" style={{ border: `1px solid ${color.line}`, borderRadius: 10, padding: 12, marginBottom: 16, background: color.panel }}>
      <div style={{ aspectRatio: '16 / 9', maxHeight: 420, borderRadius: 8, overflow: 'hidden', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {video === undefined
          ? <OpStatus op={op} />
          : <video src={assetUrl(video)} controls preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
      </div>
      <p style={{ fontSize: 13, margin: '10px 0 6px', whiteSpace: 'pre-wrap' }}>{prompt}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: color.muted }}>
        {references.map(input => <img key={input.ref} src={assetUrl(input.resolved ?? input.ref)} alt="" style={{ width: 24, height: 24, objectFit: 'cover', borderRadius: 4 }} />)}
        <span>{facts.join(' · ')}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        <button type="button" style={button} disabled={video === undefined} onClick={() => { if (video !== undefined) props.onInsert(video) }}>{t('加入剪辑', 'Add to cuts')}</button>
        <button type="button" style={button} onClick={() => { dispatchWorkspaceEvent('vh:canvas-focus', { opId: op.id }) }}>{t('在画布打开', 'Open on canvas')}</button>
        <button
          type="button" style={button}
          onClick={() => {
            dispatchCompose({ text: t(`基于这条 Tool 生成接着做：${prompt}`, `Continue from this Tool generation: ${prompt}`), refs: [{ kind: 'op', id: op.id, label: t('Tool 生成', 'Tool generation'), ...(video === undefined ? {} : { assetId: video }) }] })
          }}
        >{t('让 agent 接着做', 'Continue with agent')}</button>
      </div>
    </article>
  )
}

/**
 * The status of a record without a video yet: waiting, generating with the elapsed time, or the failure.
 * @param props - the record.
 * @returns the status text.
 */
function OpStatus(props: { op: WireOp }): ReactNode {
  const { op } = props
  const t = useText()
  const [now, setNow] = useState(() => Date.now())
  const live = op.status === 'pending' || op.status === 'running'
  useEffect(() => {
    if (!live) return undefined
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [live])
  if (op.status === 'failed') return <span style={{ color: color.danger, fontSize: 13, padding: 16 }}>{t('生成失败：', 'Generation failed: ')}{op.error ?? t('未知原因', 'unknown reason')}</span>
  const elapsed = String(Math.max(0, Math.round((now - Date.parse(op.created_at)) / 1000)))
  return (
    <span style={{ color: '#ddd', fontSize: 13 }}>
      {op.status === 'pending' ? t(`排队中… 已等 ${elapsed} 秒`, `Queued… ${elapsed} s`) : t(`生成中… 已用 ${elapsed} 秒`, `Generating… ${elapsed} s`)}
    </span>
  )
}
