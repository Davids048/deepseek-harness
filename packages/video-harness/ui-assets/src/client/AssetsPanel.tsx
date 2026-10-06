/**
 * The project assets panel: filters (全部 / 上传 / 生成), an upload drop zone, a thumbnail grid in sections
 * (人物 · 参考 · 生成), drag sources that carry the asset ID as `application/x-vh-asset`, and a preview on click. Assets
 * of an agent draft that the user has not accepted yet are listed too, with a 草稿 (Draft) badge.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { VhClient, assetUrl } from '@video-harness/ui-kit/api.ts'
import { ToolApi } from '@video-harness/ui-kit/tool-api.ts'
import type { WireAsset, WireState } from '@video-harness/ui-kit/types.ts'
import { dispatchCompose } from '@video-harness/ui-kit/compose.ts'
import { useCurrentProject } from '@video-harness/ui-kit/current-project.ts'
import { useText } from '@video-harness/ui-kit/locale.ts'
import { openDrafts } from '@video-harness/ui-kit/state.ts'
import { useProjectState } from '@video-harness/ui-kit/useProject.ts'
import { VH_ASSET_DRAG_TYPE, dispatchWorkspaceEvent } from '@video-harness/ui-kit/workspace-events.ts'
import { assetLibrary } from './library.ts'
import type { DraftState } from './library.ts'

/** Props of {@link AssetsPanel}. */
export interface AssetsPanelProps {
  projectId: string
  /** The API clients; default to ones over the page's fetch. */
  client?: VhClient
  api?: ToolApi
}

/** The filters above the grid. */
type Filter = 'all' | 'uploads' | 'generated'

const FILTERS: Array<{ id: Filter; zh: string; en: string }> = [
  { id: 'all', zh: '全部', en: 'All' }, { id: 'uploads', zh: '上传', en: 'Uploads' }, { id: 'generated', zh: '生成', en: 'Generated' },
]

const line = 'var(--vh-line, rgba(127, 127, 127, 0.25))'
const muted = 'var(--vh-muted, rgba(127, 127, 127, 0.95))'
const accent = 'var(--vh-accent, #7c5cff)'
const chip = (active: boolean): CSSProperties => ({
  border: `1px solid ${active ? accent : line}`, color: active ? accent : 'inherit', background: 'transparent', borderRadius: 14,
  padding: '3px 10px', fontSize: 12, cursor: 'pointer',
})
const button: CSSProperties = { border: `1px solid ${line}`, background: 'transparent', color: 'inherit', borderRadius: 6, padding: '5px 12px', fontSize: 13, cursor: 'pointer' }

/**
 * The folded states of the project's open agent drafts, refetched whenever the state of `main` reloads, which happens
 * on every change of the project's log, draft branches included.
 * @param client - the API client.
 * @param projectId - the project.
 * @param main - the folded state of `main`, or null while it loads.
 * @returns the draft states; a draft whose fetch fails is left out.
 */
function useDraftStates(client: VhClient, projectId: string, main: WireState | null): DraftState[] {
  const [drafts, setDrafts] = useState<DraftState[]>([])
  useEffect(() => {
    const branches = main === null ? [] : openDrafts(main).map(draft => draft.branch)
    if (branches.length === 0) { setDrafts([]); return }
    const controller = new AbortController()
    void Promise.all(branches.map(branch => client.state(projectId, branch, controller.signal)
      .then(state => ({ branch, state }), () => null)))
      .then((rows) => { if (!controller.signal.aborted) setDrafts(rows.filter((row): row is DraftState => row !== null)) })
    return () => { controller.abort() }
  }, [client, projectId, main])
  return drafts
}

/**
 * The assets panel of one project.
 * @param props - the project and optional clients.
 * @returns the panel.
 */
export function AssetsPanel(props: AssetsPanelProps): ReactNode {
  const client = useMemo(() => props.client ?? new VhClient(), [props.client])
  const api = useMemo(() => props.api ?? new ToolApi(), [props.api])
  const state = useProjectState(client, props.projectId, 'main')
  const drafts = useDraftStates(client, props.projectId, state.value)
  const t = useText()
  const [filter, setFilter] = useState<Filter>('all')
  const [preview, setPreview] = useState<WireAsset | null>(null)
  const library = useMemo(() => state.value === null ? null : assetLibrary(state.value, drafts), [state.value, drafts])
  const draft = library?.draft ?? new Set<string>()

  let body: ReactNode
  if (library === null) body = <p style={{ color: muted, fontSize: 12 }}>{state.error === null ? t('正在读取…', 'Loading…') : t(`读取失败：${state.error}`, `Failed to load: ${state.error}`)}</p>
  else if (filter === 'all') {
    body = (
      <>
        <Section title={t('人物', 'Characters')} assets={library.characters} draft={draft} onOpen={setPreview} />
        <Section title={t('参考', 'References')} assets={library.references} draft={draft} onOpen={setPreview} />
        <Section title={t('生成', 'Generated')} assets={library.generated} draft={draft} onOpen={setPreview} />
      </>
    )
  } else if (filter === 'uploads') body = <Section title={t('上传', 'Uploads')} assets={library.uploads} draft={draft} onOpen={setPreview} />
  else body = <Section title={t('生成', 'Generated')} assets={library.generated} draft={draft} onOpen={setPreview} />
  return (
    <div data-testid="vh-assets-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: 12, gap: 10 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {FILTERS.map(row => (
          <button key={row.id} type="button" style={chip(filter === row.id)} onClick={() => { setFilter(row.id) }}>
            {t(row.zh, row.en)}
          </button>
        ))}
      </div>
      <UploadZone api={api} projectId={props.projectId} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{body}</div>
      {preview === null
        ? null
        : <Preview key={preview.id} asset={preview} draft={draft.has(preview.id)} onClose={() => { setPreview(null) }} />}
    </div>
  )
}

/**
 * The drop zone that uploads files through `POST /api/vh/assets/upload`; also opens a file chooser on click.
 * @param props - the asset import client and the project.
 * @returns the zone.
 */
function UploadZone(props: { api: ToolApi; projectId: string }): ReactNode {
  const [pending, setPending] = useState(0)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const t = useText()
  const upload = useCallback((files: FileList | null) => {
    if (files === null) return
    for (const file of Array.from(files)) {
      setPending(count => count + 1)
      props.api.upload(props.projectId, file)
        .then(() => { setError(null) }, (failure: unknown) => { setError(t(`「${file.name}」上传失败：${String(failure)}`, `Failed to upload "${file.name}": ${String(failure)}`)) })
        .finally(() => { setPending(count => count - 1) })
    }
  }, [props.api, props.projectId, t])
  // Asset drags from the grid carry an asset ID, not files; the zone ignores them.
  const isFileDrag = (event: DragEvent): boolean => event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes(VH_ASSET_DRAG_TYPE)
  return (
    <div
      role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter') input.current?.click() }}
      onDragOver={(event) => { if (isFileDrag(event)) { event.preventDefault(); setOver(true) } }}
      onDragLeave={() => { setOver(false) }}
      onDrop={(event) => { if (!isFileDrag(event)) return; event.preventDefault(); setOver(false); upload(event.dataTransfer.files) }}
      style={{ border: `1px dashed ${over ? accent : line}`, borderRadius: 8, padding: '12px 8px', textAlign: 'center', fontSize: 12, color: muted, cursor: 'pointer' }}
    >
      {pending > 0
        ? t(`上传中（${String(pending)}）…`, `Uploading (${String(pending)})…`)
        : t('拖入图片或视频上传，或点击选择文件', 'Drop images or videos here to upload, or click to choose files')}
      {error === null ? null : <div style={{ color: 'var(--vh-danger, #e5484d)', marginTop: 4 }}>{error}</div>}
      <input ref={input} type="file" accept="image/*,video/*" multiple hidden onChange={(event) => { upload(event.currentTarget.files); event.currentTarget.value = '' }} />
    </div>
  )
}

/**
 * One titled grid of thumbnails.
 * @param props - the title, the assets, the IDs of draft assets, and the preview callback.
 * @returns the section, or nothing when it has no assets and is one of several.
 */
function Section(props: { title: string; assets: WireAsset[]; draft: ReadonlySet<string>; onOpen: (asset: WireAsset) => void }): ReactNode {
  const t = useText()
  return (
    <section style={{ marginBottom: 14 }}>
      <h3 style={{ fontSize: 12, fontWeight: 600, color: muted, margin: '0 0 6px' }}>{props.title} · {props.assets.length}</h3>
      {props.assets.length === 0
        ? <p style={{ fontSize: 12, color: muted, margin: 0 }}>{t('暂无', 'None yet')}</p>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 6 }}>
            {props.assets.map(asset => <Thumb key={asset.id} asset={asset} draft={props.draft.has(asset.id)} onOpen={props.onOpen} />)}
          </div>
        )}
    </section>
  )
}

/**
 * One draggable thumbnail; dragging it carries the asset ID, clicking it opens the preview.
 * @param props - the asset, whether only an unaccepted draft has it, and the preview callback.
 * @returns the thumbnail.
 */
function Thumb(props: { asset: WireAsset; draft: boolean; onOpen: (asset: WireAsset) => void }): ReactNode {
  const { asset } = props
  const t = useText()
  const video = asset.mime.startsWith('video/')
  const media: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }
  return (
    <button
      type="button" draggable title={asset.name} data-asset-id={asset.id}
      onDragStart={(event) => { event.dataTransfer.setData(VH_ASSET_DRAG_TYPE, asset.id); event.dataTransfer.effectAllowed = 'copy' }}
      onClick={() => { props.onOpen(asset) }}
      style={{ position: 'relative', padding: 0, border: `1px solid ${line}`, borderRadius: 6, overflow: 'hidden', aspectRatio: '1', background: '#0002', cursor: 'grab' }}
    >
      {video
        ? <video src={`${assetUrl(asset.id)}#t=0.1`} muted preload="metadata" style={media} />
        : asset.mime.startsWith('image/') ? <img src={assetUrl(asset.id)} alt={asset.name} loading="lazy" style={media} /> : <span style={{ fontSize: 11 }}>{asset.name}</span>}
      {video && asset.durationSec !== null
        ? <span style={{ position: 'absolute', right: 3, bottom: 3, fontSize: 10, background: '#000a', color: '#fff', borderRadius: 3, padding: '0 3px' }}>{asset.durationSec.toFixed(0)}s</span>
        : null}
      {props.draft
        ? <span style={{ position: 'absolute', left: 3, top: 3, fontSize: 10, background: accent, color: '#fff', borderRadius: 3, padding: '0 4px' }}>{t('草稿', 'Draft')}</span>
        : null}
    </button>
  )
}

/**
 * The preview dialog: the media at full size, its facts, and actions. Escape or a click outside closes it. The dialog
 * renders on `document.body`, so the right sidebar's resize handle and stacking context cannot cover its buttons.
 * @param props - the asset, whether only an unaccepted draft has it, and the close callback.
 * @returns the dialog.
 */
function Preview(props: { asset: WireAsset; draft: boolean; onClose: () => void }): ReactNode {
  const { asset, onClose } = props
  const t = useText()
  // The store records no dimensions for uploads, so read them from the loaded media.
  const [loadedSize, setLoadedSize] = useState<{ width: number; height: number } | null>(null)
  const width = asset.width ?? loadedSize?.width ?? null
  const height = asset.height ?? loadedSize?.height ?? null
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])
  const video = asset.mime.startsWith('video/')
  const facts = [
    width !== null && height !== null ? `${String(width)}×${String(height)}` : null,
    asset.durationSec === null ? null : t(`${asset.durationSec.toFixed(1)} 秒`, `${asset.durationSec.toFixed(1)} s`),
    asset.sizeBytes < 1024 * 1024 ? `${(asset.sizeBytes / 1024).toFixed(1)} KB` : `${(asset.sizeBytes / 1024 / 1024).toFixed(1)} MB`,
  ].filter((fact): fact is string => fact !== null)
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={asset.name} onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: '#000c', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(event) => { event.stopPropagation() }} style={{ maxWidth: '80vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column', gap: 10, color: '#eee' }}>
        {video
          ? <video src={assetUrl(asset.id)} controls autoPlay onLoadedMetadata={(event) => { setLoadedSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight }) }} style={{ maxWidth: '80vw', maxHeight: '70vh', borderRadius: 8 }} />
          : <img src={assetUrl(asset.id)} alt={asset.name} onLoad={(event) => { setLoadedSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }) }} style={{ maxWidth: '80vw', maxHeight: '70vh', objectFit: 'contain', borderRadius: 8 }} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>{asset.name}</span>
          {props.draft ? <span style={{ fontSize: 11, background: accent, color: '#fff', borderRadius: 3, padding: '0 4px' }}>{t('草稿', 'Draft')}</span> : null}
          <span style={{ opacity: 0.7 }}>{facts.join(' · ')}</span>
          <span style={{ flex: 1 }} />
          {video ? <button type="button" style={button} onClick={() => { dispatchWorkspaceEvent('vh:cut-insert', { assetId: asset.id }); onClose() }}>{t('加入剪辑', 'Add to Cuts')}</button> : null}
          <button type="button" style={button} onClick={() => { dispatchCompose({ text: t('使用这个素材：', 'Use this asset: '), refs: [{ kind: 'asset', id: asset.id, label: asset.name, assetId: asset.id }] }); onClose() }}>{t('让 agent 使用', 'Ask the agent to use it')}</button>
          <button type="button" style={button} onClick={onClose}>{t('关闭', 'Close')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The tab body: the assets panel of the project that the DreamVerse shell has open.
 * @param props - the injected clients.
 * @returns the panel, or a notice while no project is open.
 */
export function AssetsTabBody(props: { client: VhClient; api: ToolApi }): ReactNode {
  const project = useCurrentProject()
  const t = useText()
  if (project === null) return <p style={{ padding: 12, fontSize: 12, color: muted }}>{t('先打开一个项目', 'Open a project first')}</p>
  // Keyed by project so a switch starts from an empty panel instead of showing the previous project's assets.
  return <AssetsPanel key={project} projectId={project} client={props.client} api={props.api} />
}
