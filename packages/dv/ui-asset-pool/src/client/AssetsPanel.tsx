/**
 * The project asset pool panel: an import drop zone, every asset of the project once in thumbnail grids grouped by media
 * type (图片 · 视频 · 从生成中截取的帧), drag sources that carry the asset ID as `application/x-dv-asset`, and a
 * preview on click that grows out of the clicked tile and shrinks back into it on close (`@dv/ui-kit/zoom.ts`). The
 * panel lists every asset of the project, including the assets of steps that an undo went back past: the asset pool
 * only grows.
 *
 * @module @dv/ui-asset-pool/AssetsPanel
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DvClient, assetUrl } from '@dv/ui-kit/api.ts'
import type { Asset } from '@dv/ui-kit/types.ts'
import { dispatchCompose } from '@dv/ui-kit/compose.ts'
import { useCurrentProject } from '@dv/ui-kit/current-project.ts'
import { mediaBox, useZoomPresence, type ZoomPresence } from '@dv/ui-kit/zoom.ts'
import { useText } from '@dv/ui-kit/locale.ts'
import { useProjectState } from '@dv/ui-kit/useProject.ts'
import { DV_ASSET_DRAG_TYPE, DV_TIMELINE_INSERT_EVENT, dispatchWorkspaceEvent } from '@dv/ui-kit/workspace-events.ts'
import { assetLibrary } from './library.ts'
import css from './AssetsPanel.module.css'

/** Props of {@link AssetsPanel}. */
export interface AssetsPanelProps {
  projectId: string
  /** The chat session the panel sits beside, recorded as the `session` of its imports. */
  session: string | null
  /** The API client; defaults to one over the page's fetch. */
  client?: DvClient
}

/**
 * The asset pool panel of one project.
 * @param props - the project and an optional client.
 * @returns the panel.
 */
export function AssetsPanel(props: AssetsPanelProps): ReactNode {
  const client = useMemo(() => props.client ?? new DvClient(), [props.client])
  const state = useProjectState(client, props.projectId)
  const t = useText()
  const [preview, setPreview] = useState<Asset | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // The preview on screen lags `preview` while it shrinks back into its tile.
  const previewZoom = useZoomPresence(preview, asset =>
    [...panelRef.current?.querySelectorAll('[data-asset-id]') ?? []].find(tile => tile.getAttribute('data-asset-id') === asset.id) ?? null)
  const library = useMemo(() => state.value === null ? null : assetLibrary(state.value), [state.value])

  let body: ReactNode
  if (library === null) body = <p className={css.note}>{state.error === null ? t('正在读取…', 'Loading…') : t(`读取失败：${state.error}`, `Failed to load: ${state.error}`)}</p>
  else if (library.images.length + library.videos.length + library.extracted.length === 0) {
    body = <p className={css.note}>{t('暂无', 'None yet')}</p>
  } else {
    body = (
      <>
        <Section title={t('图片', 'Images')} assets={library.images} onOpen={setPreview} />
        <Section title={t('视频', 'Videos')} assets={library.videos} onOpen={setPreview} />
        <Section title={t('从生成中截取的帧', 'Extracted from generation')} assets={library.extracted} onOpen={setPreview} />
      </>
    )
  }
  return (
    <div ref={panelRef} data-testid="dv-asset-pool-panel" className={css.panel}>
      <ImportZone client={client} projectId={props.projectId} session={props.session} />
      <div className={css.scroll}>{body}</div>
      {previewZoom.shown === null
        ? null
        : <Preview key={previewZoom.shown.id} asset={previewZoom.shown} onClose={() => { setPreview(null) }} zoom={previewZoom} />}
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
      className={css.importZone} data-over={over ? '' : undefined}
    >
      {pending > 0
        ? t(`导入中（${String(pending)}）…`, `Importing (${String(pending)})…`)
        : t('拖入图片或视频导入，或点击选择文件', 'Drop images or videos here to import, or click to choose files')}
      {error === null ? null : <div className={css.error}>{error}</div>}
      {refused.map(name => (
        <div key={name} className={css.error}>
          {t(`「${name}」不是图片或视频，没有导入。`, `"${name}" is not an image or a video, so it was not imported.`)}
        </div>
      ))}
      <input ref={input} type="file" accept="image/*,video/*" multiple hidden onChange={(event) => { importFiles(event.currentTarget.files); event.currentTarget.value = '' }} />
    </div>
  )
}

/**
 * One titled grid of thumbnails.
 * @param props - the title, the assets, and the preview callback.
 * @returns the section, or nothing when it has no assets.
 */
function Section(props: { title: string; assets: Asset[]; onOpen: (asset: Asset) => void }): ReactNode {
  if (props.assets.length === 0) return null
  return (
    <section className={css.section}>
      <h3 className={css.sectionTitle}>{props.title} · {props.assets.length}</h3>
      <div className={css.grid}>
        {props.assets.map(asset => <Thumb key={asset.id} asset={asset} onOpen={props.onOpen} />)}
      </div>
    </section>
  )
}

/**
 * One draggable thumbnail; dragging it carries the asset ID, clicking it opens the preview.
 * @param props - the asset and the preview callback.
 * @returns the thumbnail.
 */
function Thumb(props: { asset: Asset; onOpen: (asset: Asset) => void }): ReactNode {
  const { asset } = props
  const video = asset.mime.startsWith('video/')
  return (
    <button
      type="button" draggable title={asset.name} data-asset-id={asset.id}
      onDragStart={(event) => { event.dataTransfer.setData(DV_ASSET_DRAG_TYPE, asset.id); event.dataTransfer.effectAllowed = 'copy' }}
      onClick={() => { props.onOpen(asset) }}
      className={css.thumb}
    >
      {video
        ? <video src={`${assetUrl(asset.id)}#t=0.1`} muted preload="metadata" className={css.thumbMedia} />
        : asset.mime.startsWith('image/') ? <img src={assetUrl(asset.id)} alt={asset.name} loading="lazy" className={css.thumbMedia} /> : <span className={css.thumbName}>{asset.name}</span>}
      {video && asset.duration_sec !== null
        ? <span className={css.duration}>{asset.duration_sec.toFixed(0)}s</span>
        : null}
    </button>
  )
}

/**
 * The preview dialog: the media at full size, its facts, and actions. Escape or a click outside closes it. The dialog
 * renders on `document.body`, so the right sidebar's resize handle and stacking context cannot cover its buttons.
 * @param props - the asset, the close callback, and the zoom transition refs: the dialog grows out of the tile, and the
 * backdrop fades.
 * @returns the dialog.
 */
function Preview(props: { asset: Asset; onClose: () => void; zoom: ZoomPresence<Asset> }): ReactNode {
  const { asset, onClose } = props
  const t = useText()
  // When the asset pool could not read the dimensions at import, read them from the loaded media.
  const [loadedSize, setLoadedSize] = useState<{ width: number; height: number } | null>(null)
  const width = asset.width ?? loadedSize?.width ?? null
  const height = asset.height ?? loadedSize?.height ?? null
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])
  const video = asset.mime.startsWith('video/')
  // Media of known dimensions is sized before it loads, so the dialog has its final box when it grows out of the tile.
  // The bounds match `.previewMedia` inside `.dialog` (80vw wide with 16 px padding, media at most 70vh tall).
  const sized = asset.width !== null && asset.height !== null && asset.height > 0
    ? mediaBox(asset.width, asset.height, '80vw - 32px', '70vh')
    : undefined
  const facts = [
    width !== null && height !== null ? `${String(width)}×${String(height)}` : null,
    asset.duration_sec === null ? null : t(`${asset.duration_sec.toFixed(1)} 秒`, `${asset.duration_sec.toFixed(1)} s`),
    asset.size_bytes < 1024 * 1024 ? `${(asset.size_bytes / 1024).toFixed(1)} KB` : `${(asset.size_bytes / 1024 / 1024).toFixed(1)} MB`,
  ].filter((fact): fact is string => fact !== null)
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={asset.name} onClick={onClose} className={css.overlay}>
      <div ref={props.zoom.fadeRef} className={css.backdrop} aria-hidden="true" />
      <div ref={props.zoom.targetRef} onClick={(event) => { event.stopPropagation() }} className={css.dialog}>
        {video
          ? (
            <video
              src={assetUrl(asset.id)} controls autoPlay className={css.previewMedia} style={sized}
              onLoadedMetadata={(event) => {
                setLoadedSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })
              }}
            />
          )
          : (
            <img
              src={assetUrl(asset.id)} alt={asset.name} className={css.previewMedia} style={sized}
              onLoad={(event) => { setLoadedSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }) }}
            />
          )}
        <div className={css.facts}>
          <span className={css.name}>{asset.name}</span>
          <span className={css.factText}>{facts.join(' · ')}</span>
          <span style={{ flex: 1 }} />
          {video ? <button type="button" className={css.button} onClick={() => { dispatchWorkspaceEvent(DV_TIMELINE_INSERT_EVENT, { assetId: asset.id }); onClose() }}>{t('插入片段', 'Insert clip')}</button> : null}
          <button type="button" className={css.button} onClick={() => { dispatchCompose({ text: t('使用这个素材：', 'Use this asset: '), refs: [{ kind: 'asset', id: asset.id, label: asset.name, assetId: asset.id }] }); onClose() }}>{t('让智能体使用', 'Ask the agent to use it')}</button>
          <button type="button" className={css.button} onClick={onClose}>{t('关闭', 'Close')}</button>
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
  if (project === null) return <p className={css.note} style={{ padding: 16 }}>{t('先打开一个项目', 'Open a project first')}</p>
  // Keyed by project so a switch starts from an empty panel instead of showing the previous project's assets.
  return <AssetsPanel key={project} projectId={project} session={props.sessionId} client={props.client} />
}
