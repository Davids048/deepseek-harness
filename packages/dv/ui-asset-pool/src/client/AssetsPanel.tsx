/**
 * The project asset pool panel: an import drop zone, every asset of the project once in thumbnail grids grouped by media
 * type (图片 · 视频 · 从生成中截取的帧), drag sources that carry the asset ID as `application/x-dv-asset`, and a
 * preview on click. The panel lists the assets of the project's current branch up to its head; its toggle 显示其他分支的素材
 * (Show assets from other branches) adds the assets that only other branches or the current branch's redo steps hold,
 * each with a badge naming its branch.
 *
 * @module @dv/ui-asset-pool/AssetsPanel
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DvClient, assetUrl } from '@dv/ui-kit/api.ts'
import type { Asset, WireState } from '@dv/ui-kit/types.ts'
import { dispatchCompose } from '@dv/ui-kit/compose.ts'
import { useCurrentProject } from '@dv/ui-kit/current-project.ts'
import { useText } from '@dv/ui-kit/locale.ts'
import { branchLabel } from '@dv/ui-kit/state.ts'
import { useProjectState } from '@dv/ui-kit/useProject.ts'
import { DV_ASSET_DRAG_TYPE, DV_TIMELINE_INSERT_EVENT, dispatchWorkspaceEvent } from '@dv/ui-kit/workspace-events.ts'
import { assetLibrary, otherBranchAssets } from './library.ts'
import type { OtherBranchAssets } from './library.ts'

/** Props of {@link AssetsPanel}. */
export interface AssetsPanelProps {
  projectId: string
  /** The chat session the panel sits beside, recorded as the `session` of its imports. */
  session: string | null
  /** The API client; defaults to one over the page's fetch. */
  client?: DvClient
}

const line = 'var(--dv-line, rgba(127, 127, 127, 0.25))'
const muted = 'var(--dv-muted, rgba(127, 127, 127, 0.95))'
const accent = 'var(--dv-accent, #7c5cff)'
const button: CSSProperties = { border: `1px solid ${line}`, background: 'transparent', color: 'inherit', borderRadius: 6, padding: '5px 12px', fontSize: 13, cursor: 'pointer' }

/** The most history entries the panel reads for the assets outside the current branch's head. */
const OTHER_BRANCH_ENTRIES = 200

/**
 * The assets that only other branches or the current branch's redo steps hold, refetched whenever the state of the
 * current branch reloads, which happens on every change of the project.
 * @param client - the API client.
 * @param projectId - the project.
 * @param current - the state of the current branch, or null while it loads or while the panel does not show them.
 * @returns the assets, or null while none are read; a failed fetch shows none.
 */
function useOtherBranchAssets(client: DvClient, projectId: string, current: WireState | null): OtherBranchAssets | null {
  const [others, setOthers] = useState<OtherBranchAssets | null>(null)
  useEffect(() => {
    if (current === null) { setOthers(null); return }
    const controller = new AbortController()
    client.listHistory({ project: projectId, marks: ['redo', 'branch'], limit: OTHER_BRANCH_ENTRIES }, controller.signal)
      .then((history) => { if (!controller.signal.aborted) setOthers(otherBranchAssets(history, current)) }, () => {
        if (!controller.signal.aborted) setOthers(null)
      })
    return () => { controller.abort() }
  }, [client, projectId, current])
  return others
}

/**
 * The asset pool panel of one project.
 * @param props - the project and an optional client.
 * @returns the panel.
 */
export function AssetsPanel(props: AssetsPanelProps): ReactNode {
  const client = useMemo(() => props.client ?? new DvClient(), [props.client])
  const state = useProjectState(client, props.projectId, null)
  const [showOthers, setShowOthers] = useState(false)
  const others = useOtherBranchAssets(client, props.projectId, showOthers ? state.value : null)
  const t = useText()
  const [preview, setPreview] = useState<Asset | null>(null)
  const library = useMemo(() => state.value === null ? null : assetLibrary(state.value, others), [state.value, others])
  // Asset ID → the label of the branch it comes from, for the assets outside the current branch's head.
  const elsewhere = useMemo(() => {
    const branches = new Map((state.value?.branches ?? []).map(branch => [branch.name, branchLabel(branch, t)]))
    return new Map([...library?.elsewhere ?? []].map(([id, branch]) => [id, branches.get(branch) ?? branch]))
  }, [library, state.value, t])

  let body: ReactNode
  if (library === null) body = <p style={{ color: muted, fontSize: 12 }}>{state.error === null ? t('正在读取…', 'Loading…') : t(`读取失败：${state.error}`, `Failed to load: ${state.error}`)}</p>
  else if (library.images.length + library.videos.length + library.extracted.length === 0) {
    body = <p style={{ color: muted, fontSize: 12, margin: 0 }}>{t('暂无', 'None yet')}</p>
  } else {
    body = (
      <>
        <Section title={t('图片', 'Images')} assets={library.images} elsewhere={elsewhere} onOpen={setPreview} />
        <Section title={t('视频', 'Videos')} assets={library.videos} elsewhere={elsewhere} onOpen={setPreview} />
        <Section
          title={t('从生成中截取的帧', 'Extracted from generation')} assets={library.extracted} elsewhere={elsewhere} onOpen={setPreview}
        />
      </>
    )
  }
  return (
    <div data-testid="dv-asset-pool-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: 12, gap: 10 }}>
      <ImportZone client={client} projectId={props.projectId} session={props.session} />
      <button
        type="button" data-testid="dv-asset-pool-other-branches" aria-pressed={showOthers}
        onClick={() => { setShowOthers(shown => !shown) }}
        style={{ ...button, alignSelf: 'flex-start', fontSize: 12, padding: '3px 10px', ...showOthers ? { borderColor: accent, color: accent } : {} }}
      >
        {showOthers ? t('隐藏其他分支的素材', 'Hide assets from other branches') : t('显示其他分支的素材', 'Show assets from other branches')}
      </button>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{body}</div>
      {preview === null
        ? null
        : <Preview key={preview.id} asset={preview} branch={elsewhere.get(preview.id) ?? null} onClose={() => { setPreview(null) }} />}
    </div>
  )
}

/**
 * The drop zone that imports image and video files through `POST /api/dv/assets/import`, and names each other file it
 * refuses; also opens a file chooser on click.
 * @param props - the API client, the project, and the chat session the panel sits beside.
 * @returns the zone.
 */
function ImportZone(props: { client: DvClient; projectId: string; session: string | null }): ReactNode {
  const [pending, setPending] = useState(0)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const t = useText()
  const importFiles = useCallback((files: FileList | null) => {
    if (files === null) return
    const accepted = Array.from(files).filter(file => file.type.startsWith('image/') || file.type.startsWith('video/'))
    setRefused(Array.from(files).filter(file => !accepted.includes(file)).map(file => file.name))
    for (const file of accepted) {
      setPending(count => count + 1)
      props.client.importAsset(props.projectId, file, 'asset_pool', props.session)
        .then(() => { setError(null) }, (failure: unknown) => { setError(t(`「${file.name}」导入失败：${String(failure)}`, `Failed to import "${file.name}": ${String(failure)}`)) })
        .finally(() => { setPending(count => count - 1) })
    }
  }, [props.client, props.projectId, props.session, t])
  // Asset drags from the grid carry an asset ID, not files; the zone ignores them.
  const isFileDrag = (event: DragEvent): boolean => event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes(DV_ASSET_DRAG_TYPE)
  return (
    <div
      role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter') input.current?.click() }}
      onDragOver={(event) => { if (isFileDrag(event)) { event.preventDefault(); setOver(true) } }}
      onDragLeave={() => { setOver(false) }}
      onDrop={(event) => { if (!isFileDrag(event)) return; event.preventDefault(); setOver(false); importFiles(event.dataTransfer.files) }}
      style={{ border: `1px dashed ${over ? accent : line}`, borderRadius: 8, padding: '12px 8px', textAlign: 'center', fontSize: 12, color: muted, cursor: 'pointer' }}
    >
      {pending > 0
        ? t(`导入中（${String(pending)}）…`, `Importing (${String(pending)})…`)
        : t('拖入图片或视频导入，或点击选择文件', 'Drop images or videos here to import, or click to choose files')}
      {error === null ? null : <div style={{ color: 'var(--dv-danger, #e5484d)', marginTop: 4 }}>{error}</div>}
      {refused.map(name => (
        <div key={name} style={{ color: 'var(--dv-danger, #e5484d)', marginTop: 4 }}>
          {t(`「${name}」不是图片或视频，没有导入。`, `"${name}" is not an image or a video, so it was not imported.`)}
        </div>
      ))}
      <input ref={input} type="file" accept="image/*,video/*" multiple hidden onChange={(event) => { importFiles(event.currentTarget.files); event.currentTarget.value = '' }} />
    </div>
  )
}

/**
 * One titled grid of thumbnails.
 * @param props - the title, the assets, the branch label of each asset outside the current branch, and the preview callback.
 * @returns the section, or nothing when it has no assets.
 */
function Section(props: {
  title: string
  assets: Asset[]
  elsewhere: ReadonlyMap<string, string>
  onOpen: (asset: Asset) => void
}): ReactNode {
  if (props.assets.length === 0) return null
  return (
    <section style={{ marginBottom: 14 }}>
      <h3 style={{ fontSize: 12, fontWeight: 600, color: muted, margin: '0 0 6px' }}>{props.title} · {props.assets.length}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 6 }}>
        {props.assets.map(asset => (
          <Thumb key={asset.id} asset={asset} branch={props.elsewhere.get(asset.id) ?? null} onOpen={props.onOpen} />
        ))}
      </div>
    </section>
  )
}

/**
 * One draggable thumbnail; dragging it carries the asset ID, clicking it opens the preview.
 * @param props - the asset, the label of the other branch it comes from (null for the current branch), and the preview
 *   callback.
 * @returns the thumbnail.
 */
function Thumb(props: { asset: Asset; branch: string | null; onOpen: (asset: Asset) => void }): ReactNode {
  const { asset } = props
  const video = asset.mime.startsWith('video/')
  const media: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }
  return (
    <button
      type="button" draggable title={asset.name} data-asset-id={asset.id}
      onDragStart={(event) => { event.dataTransfer.setData(DV_ASSET_DRAG_TYPE, asset.id); event.dataTransfer.effectAllowed = 'copy' }}
      onClick={() => { props.onOpen(asset) }}
      style={{ position: 'relative', padding: 0, border: `1px solid ${line}`, borderRadius: 6, overflow: 'hidden', aspectRatio: '1', background: '#0002', cursor: 'grab' }}
    >
      {video
        ? <video src={`${assetUrl(asset.id)}#t=0.1`} muted preload="metadata" style={media} />
        : asset.mime.startsWith('image/') ? <img src={assetUrl(asset.id)} alt={asset.name} loading="lazy" style={media} /> : <span style={{ fontSize: 11 }}>{asset.name}</span>}
      {video && asset.duration_sec !== null
        ? <span style={{ position: 'absolute', right: 3, bottom: 3, fontSize: 10, background: '#000a', color: '#fff', borderRadius: 3, padding: '0 3px' }}>{asset.duration_sec.toFixed(0)}s</span>
        : null}
      {props.branch === null
        ? null
        : <span data-testid="dv-asset-pool-branch-badge" style={{ position: 'absolute', left: 3, top: 3, maxWidth: 'calc(100% - 6px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, background: accent, color: '#fff', borderRadius: 3, padding: '0 4px' }}>{props.branch}</span>}
    </button>
  )
}

/**
 * The preview dialog: the media at full size, its facts, and actions. Escape or a click outside closes it. The dialog
 * renders on `document.body`, so the right sidebar's resize handle and stacking context cannot cover its buttons.
 * @param props - the asset, the label of the other branch it comes from (null for the current branch), and the close
 *   callback.
 * @returns the dialog.
 */
function Preview(props: { asset: Asset; branch: string | null; onClose: () => void }): ReactNode {
  const { asset, onClose } = props
  const t = useText()
  // The asset pool records no dimensions for imported files, so read them from the loaded media.
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
    asset.duration_sec === null ? null : t(`${asset.duration_sec.toFixed(1)} 秒`, `${asset.duration_sec.toFixed(1)} s`),
    asset.size_bytes < 1024 * 1024 ? `${(asset.size_bytes / 1024).toFixed(1)} KB` : `${(asset.size_bytes / 1024 / 1024).toFixed(1)} MB`,
  ].filter((fact): fact is string => fact !== null)
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={asset.name} onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: '#000c', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(event) => { event.stopPropagation() }} style={{ maxWidth: '80vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column', gap: 10, color: '#eee' }}>
        {video
          ? <video src={assetUrl(asset.id)} controls autoPlay onLoadedMetadata={(event) => { setLoadedSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight }) }} style={{ maxWidth: '80vw', maxHeight: '70vh', borderRadius: 8 }} />
          : <img src={assetUrl(asset.id)} alt={asset.name} onLoad={(event) => { setLoadedSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }) }} style={{ maxWidth: '80vw', maxHeight: '70vh', objectFit: 'contain', borderRadius: 8 }} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>{asset.name}</span>
          {props.branch === null ? null : <span style={{ fontSize: 11, background: accent, color: '#fff', borderRadius: 3, padding: '0 4px' }}>{props.branch}</span>}
          <span style={{ opacity: 0.7 }}>{facts.join(' · ')}</span>
          <span style={{ flex: 1 }} />
          {video ? <button type="button" style={button} onClick={() => { dispatchWorkspaceEvent(DV_TIMELINE_INSERT_EVENT, { assetId: asset.id }); onClose() }}>{t('插入片段', 'Insert clip')}</button> : null}
          <button type="button" style={button} onClick={() => { dispatchCompose({ text: t('使用这个素材：', 'Use this asset: '), refs: [{ kind: 'asset', id: asset.id, label: asset.name, assetId: asset.id }] }); onClose() }}>{t('让智能体使用', 'Ask the agent to use it')}</button>
          <button type="button" style={button} onClick={onClose}>{t('关闭', 'Close')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The tab body: the asset pool panel of the project that the DreamVerse shell has open, beside the chat session whose
 * right panel holds the tab.
 * @param props - the tab's chat session and the injected client.
 * @returns the panel, or a notice while no project is open.
 */
export function AssetsTabBody(props: PropsRuntime<'sidebar.right.pane.tab'> & { client: DvClient }): ReactNode {
  const project = useCurrentProject()
  const t = useText()
  if (project === null) return <p style={{ padding: 12, fontSize: 12, color: muted }}>{t('先打开一个项目', 'Open a project first')}</p>
  // Keyed by project so a switch starts from an empty panel instead of showing the previous project's assets.
  return <AssetsPanel key={project} projectId={project} session={props.sessionId} client={props.client} />
}
