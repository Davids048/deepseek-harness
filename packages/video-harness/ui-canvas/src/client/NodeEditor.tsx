/**
 * The floating editor a canvas node opens in the middle of the canvas. A clip shows a large player, its prompt,
 * reference chips, duration, and seed, and offers "生成新版本" (a user `generate.*` record whose `base_op` is the clip)
 * and "让 agent 改" (a `vh:compose` event that prefills the chat composer). An entity can swap its reference image; a
 * plan lists its shots.
 */
import { useState } from 'react'
import type { ChangeEvent, CSSProperties, ReactNode } from 'react'
import { assetUrl } from '@video-harness/ui-kit/api.ts'
import type { VhClient } from '@video-harness/ui-kit/api.ts'
import { dispatchCompose } from '@video-harness/ui-kit/compose.ts'
import type { WireState } from '@video-harness/ui-kit/types.ts'
import type { CanvasNode } from './graph.ts'
import { KIND_COLOR, kindLabel, nodeTitle } from './NodeCard.tsx'
import type { CanvasTranslate } from './NodeCard.tsx'

/** Props of {@link NodeEditor}. */
export interface NodeEditorProps {
  node: CanvasNode
  state: WireState
  client: VhClient
  project: string
  /** The branch writes go to; `main` writes omit the branch. */
  branch: string
  /** True while the viewed head is a draft: generation buttons are disabled. */
  readOnly: boolean
  t: CanvasTranslate
  onClose: () => void
  /** Run a write and report its failure. */
  run: (work: () => Promise<unknown>) => Promise<void>
}

// Editor styles draw on the DSH theme tokens so the floating editor matches the app in the light and dark themes.
const panel: CSSProperties = {
  position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(720px, calc(100% - 32px))',
  maxHeight: 'calc(100% - 32px)', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', borderRadius: 14,
  border: '1px solid var(--dsw-alias-border-l3)', boxShadow: '0 18px 48px rgba(0, 0, 0, 0.18)', zIndex: 10, fontSize: 14,
}
const label: CSSProperties = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-tertiary)', margin: '12px 0 4px' }
const field: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
  border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: '6px 8px', font: 'inherit',
}
const button: CSSProperties = { border: 'none', borderRadius: 8, padding: '8px 14px', font: 'inherit', cursor: 'pointer' }
const secondaryButton: CSSProperties = { ...button, background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)' }
const chip: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px 2px 2px', borderRadius: 14, background: 'var(--dsw-alias-interactive-bg-hover)', fontSize: 13 }
const mediaBackground = 'var(--dsw-alias-interactive-bg-hover)'

/** One input of the edited record. */
interface EditedInput {
  role: string
  ref: string
}

/**
 * The asset that shows a reference: the entity's latest image, or the asset itself.
 * @param state - the folded state.
 * @param ref - an input ref such as `hero@1` or an asset ID.
 * @returns the asset ID, or null.
 */
function refImage(state: WireState, ref: string): string | null {
  const entity = /^(.+)@\d+$/.exec(ref)?.[1]
  if (entity !== undefined) return state.entities[entity]?.at(-1)?.refs[0] ?? null
  return state.assets.some(asset => asset.id === ref) ? ref : null
}

/**
 * A reference chip label: the entity's name, or the asset's name.
 * @param state - the folded state.
 * @param ref - an input ref.
 * @returns the label.
 */
function refName(state: WireState, ref: string): string {
  const entity = /^(.+)@\d+$/.exec(ref)?.[1]
  if (entity !== undefined) return state.entities[entity]?.at(-1)?.name ?? entity
  return state.assets.find(asset => asset.id === ref)?.name ?? ref
}

/**
 * Read a file as base64 without the data-URL prefix.
 * @param file - the file.
 * @returns the base64 text.
 */
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(String(reader.result).replace(/^data:[^,]*,/, '')) }
    reader.onerror = () => { reject(reader.error ?? new Error('read failed')) }
    reader.readAsDataURL(file)
  })
}

/**
 * The editor.
 * @param props - the node, the state it came from, and the write callbacks.
 * @returns the element.
 */
export function NodeEditor(props: NodeEditorProps): ReactNode {
  const { node, t, onClose } = props
  const title = nodeTitle(node, t)
  const askAgent = (): void => {
    const media = node.thumb ?? node.video
    dispatchCompose({
      text: t('compose.text', { title }),
      refs: [{
        kind: node.kind === 'entity' ? 'entity' : 'op',
        id: node.kind === 'entity' ? node.entity ?? node.id : node.op?.id ?? node.id,
        label: title,
        ...media === null ? {} : { assetId: media },
      }],
    })
    onClose()
  }
  let body: ReactNode
  switch (node.kind) {
    case 'clip': body = <ClipForm {...props} title={title} />; break
    case 'entity': body = <EntityForm {...props} />; break
    case 'plan': body = <PlanList {...props} />; break
    case 'reference': body = <Preview node={node} />; break
  }
  return (
    <div style={panel} role="dialog" aria-label={title} data-testid="vh-node-editor" onPointerDown={(event) => { event.stopPropagation() }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l3)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: KIND_COLOR[node.kind] }} />
        <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12, fontWeight: 600 }}>{kindLabel(node, t)}</span>
        <strong style={{ flex: 1, fontSize: 16 }}>{title}</strong>
        <button type="button" style={secondaryButton} onClick={askAgent}>{t('editor.askAgent')}</button>
        <button type="button" aria-label={t('editor.close')} style={{ ...button, background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', padding: '4px 8px' }} onClick={onClose}>✕</button>
      </div>
      <div style={{ padding: 14 }}>
        {props.readOnly ? <p style={{ margin: '0 0 8px', color: 'var(--dsw-alias-state-warn-primary)' }}>{t('editor.readOnly')}</p> : null}
        {body}
      </div>
    </div>
  )
}

/**
 * The node's media at full width: the video when there is one, else the image.
 * @param props - the node.
 * @returns the element.
 */
function Preview({ node }: { node: CanvasNode }): ReactNode {
  const style: CSSProperties = { width: '100%', maxHeight: 360, borderRadius: 10, background: '#000', display: 'block' }
  if (node.video !== null) {
    return (
      <video
        src={assetUrl(node.video)}
        poster={node.thumb === null ? undefined : assetUrl(node.thumb)}
        controls
        autoPlay
        muted
        loop
        style={style}
      />
    )
  }
  if (node.thumb !== null) return <img src={assetUrl(node.thumb)} alt={node.title} style={{ ...style, objectFit: 'contain' }} />
  return null
}

/**
 * A generated clip: preview, prompt, references, duration, seed, and "生成新版本".
 * @param props - editor props plus the title used in the record intent.
 * @returns the element.
 */
function ClipForm(
  { node, state, client, project, branch, readOnly, t, onClose, run, title }: NodeEditorProps & { title: string },
): ReactNode {
  const op = node.op
  const [prompt, setPrompt] = useState(() => typeof op?.params['prompt'] === 'string' ? op.params['prompt'] : '')
  const [inputs, setInputs] = useState<EditedInput[]>(() => op?.inputs.map(input => ({ role: input.role, ref: input.ref })) ?? [])
  const [duration, setDuration] = useState(() => typeof op?.params['duration_sec'] === 'number' ? String(op.params['duration_sec']) : '')
  const [seed, setSeed] = useState(() => typeof op?.params['seed'] === 'number' ? String(op.params['seed']) : '')
  const references = inputs.filter(input => input.role === 'reference')
  const candidates = [
    ...Object.entries(state.entities).flatMap(([name, versions]) => {
      const latest = versions.at(-1)
      return latest === undefined ? [] : [{ ref: `${name}@${String(latest.version)}`, name: latest.name || name }]
    }),
    ...state.assets.filter(asset => asset.mime.startsWith('image/')).map(asset => ({ ref: asset.id, name: asset.name })),
  ].filter(candidate => !references.some(input => input.ref === candidate.ref))
  const regenerate = (): void => {
    if (op?.tool === undefined) return
    const params: Record<string, unknown> = { ...op.params, prompt }
    delete params['duration_sec']
    delete params['seed']
    if (duration.trim() !== '' && Number.isFinite(Number(duration))) params['duration_sec'] = Number(duration)
    if (seed.trim() !== '' && Number.isInteger(Number(seed))) params['seed'] = Number(seed)
    const tool = op.tool.name
    void run(() => client.invoke({
      project, tool, inputs, params, surface: 'canvas', intent: t('intent.regenerate', { title }), base_op: op.id,
      ...branch === 'main' ? {} : { branch },
    })).then(onClose)
  }
  return (
    <div>
      <Preview node={node} />
      <label style={label} htmlFor="vh-editor-prompt">{t('editor.prompt')}</label>
      <textarea id="vh-editor-prompt" style={{ ...field, minHeight: 72, resize: 'vertical' }} value={prompt} onChange={(event) => { setPrompt(event.target.value) }} />
      <span style={label}>{t('editor.references')}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {references.map((input) => {
          const image = refImage(state, input.ref)
          const name = refName(state, input.ref)
          return (
            <span key={input.ref} style={chip}>
              {image === null ? null : <img src={assetUrl(image)} alt="" style={{ width: 22, height: 22, borderRadius: 11, objectFit: 'cover' }} />}
              {name}
              <button type="button" aria-label={t('editor.removeReference', { name })} style={{ border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer' }} onClick={() => { setInputs(inputs.filter(other => other !== input)) }}>×</button>
            </span>
          )
        })}
        {candidates.length > 0
          ? (
            <select aria-label={t('editor.addReference')} style={{ ...field, width: 'auto' }} value="" onChange={(event) => { if (event.target.value !== '') setInputs([...inputs, { role: 'reference', ref: event.target.value }]) }}>
              <option value="">{t('editor.addReference')}</option>
              {candidates.map(candidate => <option key={candidate.ref} value={candidate.ref}>{candidate.name}</option>)}
            </select>
          )
          : null}
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={label} htmlFor="vh-editor-duration">{t('editor.duration')}</label>
          <input id="vh-editor-duration" type="number" min={1} step={1} style={field} value={duration} onChange={(event) => { setDuration(event.target.value) }} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={label} htmlFor="vh-editor-seed">{t('editor.seed')}</label>
          <input id="vh-editor-seed" type="number" step={1} style={field} placeholder={t('editor.seedRandom')} value={seed} onChange={(event) => { setSeed(event.target.value) }} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button type="button" disabled={readOnly || op?.tool === undefined} style={{ ...button, background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-inverted)', fontWeight: 600, opacity: readOnly || op?.tool === undefined ? 0.5 : 1 }} onClick={regenerate}>{t('editor.regenerate')}</button>
      </div>
    </div>
  )
}

/**
 * An entity: its reference images and description, and a control to replace the reference image.
 * @param props - editor props.
 * @returns the element.
 */
function EntityForm({ node, state, client, project, branch, readOnly, t, run }: NodeEditorProps): ReactNode {
  const name = node.entity ?? ''
  const latest = state.entities[name]?.at(-1)
  const images = state.assets.filter(asset => asset.mime.startsWith('image/'))
  const branchField = branch === 'main' ? {} : { branch }
  const replace = (assetId: string): void => {
    if (latest === undefined) return
    void run(() => client.invoke({
      project, tool: `entity.${latest.kind}.update`, params: { entity: name, refs: [assetId] }, surface: 'canvas',
      intent: t('intent.replaceRef', { name: latest.name || name }), ...branchField,
    }))
  }
  const upload = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    if (file === undefined) return
    void run(async () => {
      const base64 = await base64Of(file)
      const record = await client.invoke({ project, tool: 'asset.upload', params: { base64, mime: file.type || 'image/png', name: file.name }, surface: 'canvas', intent: t('intent.upload', { name: file.name }), ...branchField })
      const assetId = record.outputs[0]
      if (assetId !== undefined) replace(assetId)
    })
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(latest?.refs ?? []).map(ref => (
          <img key={ref} src={assetUrl(ref)} alt={ref} style={{ height: 220, borderRadius: 10, background: mediaBackground }} />
        ))}
      </div>
      {latest !== undefined && latest.description !== ''
        ? (<><span style={label}>{t('editor.description')}</span><p style={{ margin: 0 }}>{latest.description}</p></>)
        : null}
      <span style={label}>{t('editor.replaceRef')}</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select aria-label={t('editor.replaceRef')} disabled={readOnly} style={{ ...field, width: 'auto' }} value="" onChange={(event) => { if (event.target.value !== '') replace(event.target.value) }}>
          <option value="">{t('editor.replaceRef')}</option>
          {images.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
        </select>
        <label style={{ ...secondaryButton, opacity: readOnly ? 0.5 : 1 }}>
          {t('editor.upload')}
          <input type="file" accept="image/*" disabled={readOnly} style={{ display: 'none' }} onChange={upload} />
        </label>
      </div>
    </div>
  )
}

/**
 * A plan: approval status and its shots.
 * @param props - editor props.
 * @returns the element.
 */
function PlanList({ node, state, t }: NodeEditorProps): ReactNode {
  const shots = Array.isArray(node.op?.params['shots']) ? node.op.params['shots'] as Array<Record<string, unknown>> : []
  const approved = state.plans.find(plan => plan.op === node.op?.id)?.approved === true
  return (
    <div>
      <p style={{ margin: 0, color: approved ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)' }}>{approved ? t('editor.planApproved') : t('editor.planPending')}</p>
      <span style={label}>{t('editor.shots')}</span>
      <ol style={{ margin: 0, paddingLeft: 20 }}>
        {shots.map((shot, index) => (
          <li key={index} style={{ marginBottom: 6 }}>
            {typeof shot['prompt'] === 'string' ? shot['prompt'] : ''}
            {typeof shot['duration_sec'] === 'number' ? <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{` · ${String(shot['duration_sec'])}s`}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  )
}
