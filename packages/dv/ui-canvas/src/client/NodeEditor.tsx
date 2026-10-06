/**
 * The floating editor a canvas node opens in the middle of the canvas. A take shows a large player, its prompt,
 * reference chips, duration, and seed, and offers "渲染新版本" (a user `shot.render` record whose `based_on` is the take)
 * and "让智能体改" (a `dv:compose` event that prefills the chat composer). A character, location or style can replace
 * its reference image; a plan switches between its versions (v1, v2, …) and lists the shots of the chosen one. A stale
 * node offers "仍然保留", which keeps its record as it is (`proj.stale_accept`).
 */
import { useState } from 'react'
import type { ChangeEvent, CSSProperties, ReactNode } from 'react'
import { assetUrl } from '@dv/ui-kit/api.ts'
import type { DvClient } from '@dv/ui-kit/api.ts'
import { dispatchCompose } from '@dv/ui-kit/compose.ts'
import { pictureParts, referenceImages, shotReferences } from '@dv/ui-kit/references.ts'
import type { WireState } from '@dv/ui-kit/types.ts'
import { bibleItems, bibleVersions, referenceText } from './graph.ts'
import type { CanvasNode } from './graph.ts'
import { KIND_COLOR, kindLabel, nodeTitle } from './NodeCard.tsx'
import type { CanvasTranslate } from './NodeCard.tsx'

/** Props of {@link NodeEditor}. */
export interface NodeEditorProps {
  node: CanvasNode
  state: WireState
  client: DvClient
  project: string
  /** The chat session the canvas sits beside; writes go to its working branch (its open draft, else `main`). */
  session: string | null
  /** True while the viewed branch is a draft: render buttons are disabled. */
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
/** A reference image beside a plan shot, and one that stands in a shot prompt for its Picture N token. */
const shotThumb: CSSProperties = { width: 48, height: 27, objectFit: 'cover', borderRadius: 4, background: 'var(--dsw-alias-interactive-bg-hover)' }
const promptThumb: CSSProperties = { height: '1.4em', width: 'auto', verticalAlign: 'middle', borderRadius: 3, margin: '0 2px' }
const field: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
  border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: '6px 8px', font: 'inherit',
}
const button: CSSProperties = { border: 'none', borderRadius: 8, padding: '8px 14px', font: 'inherit', cursor: 'pointer' }
const secondaryButton: CSSProperties = { ...button, background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)' }
const chip: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px 2px 2px', borderRadius: 14, background: 'var(--dsw-alias-interactive-bg-hover)', fontSize: 13 }
const referenceImage: CSSProperties = { height: 220, borderRadius: 10, background: 'var(--dsw-alias-interactive-bg-hover)' }

/** One input of the edited record. */
interface EditedInput {
  role: string
  ref: string
}

/**
 * The asset that shows a reference: the latest reference image of a character, location or style, or the asset itself.
 * @param state - the branch state.
 * @param ref - reference text such as `hero@1` or an asset ID.
 * @returns the asset ID, or null.
 */
function refImage(state: WireState, ref: string): string | null {
  const bibleId = /^(.+)@\d+$/.exec(ref)?.[1]
  if (bibleId !== undefined) return bibleVersions(state, bibleId)?.at(-1)?.references[0] ?? null
  return state.assets.some(asset => asset.id === ref) ? ref : null
}

/**
 * A reference chip label: the name of the character, location or style, or the asset's name.
 * @param state - the branch state.
 * @param ref - reference text.
 * @returns the label.
 */
function refName(state: WireState, ref: string): string {
  const bibleId = /^(.+)@\d+$/.exec(ref)?.[1]
  if (bibleId !== undefined) return bibleVersions(state, bibleId)?.at(-1)?.name ?? bibleId
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
  const staleRecord = node.flags.stale ? node.record : null
  const askAgent = (): void => {
    const shown = node.thumb ?? node.video
    dispatchCompose({
      text: t('compose.text', { title }),
      refs: [{
        kind: node.bibleKind ?? 'record',
        id: node.bibleId ?? node.record?.id ?? node.id,
        label: title,
        ...shown === null ? {} : { assetId: shown },
      }],
    })
    onClose()
  }
  let body: ReactNode
  switch (node.kind) {
    case 'take': body = <TakeForm {...props} title={title} />; break
    case 'bible': body = <BibleForm {...props} />; break
    case 'plan': body = <PlanList {...props} />; break
    case 'asset': body = <Preview node={node} />; break
  }
  return (
    <div style={panel} role="dialog" aria-label={title} data-testid="dv-canvas-node-editor" onPointerDown={(event) => { event.stopPropagation() }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l3)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: KIND_COLOR[node.kind] }} />
        <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12, fontWeight: 600 }}>{kindLabel(node, t)}</span>
        <strong style={{ flex: 1, fontSize: 16 }}>{title}</strong>
        <button type="button" style={secondaryButton} onClick={askAgent}>{t('editor.askAgent')}</button>
        <button type="button" aria-label={t('editor.close')} style={{ ...button, background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', padding: '4px 8px' }} onClick={onClose}>✕</button>
      </div>
      <div style={{ padding: 14 }}>
        {props.readOnly ? <p style={{ margin: '0 0 8px', color: 'var(--dsw-alias-state-warn-primary)' }}>{t('editor.readOnly')}</p> : null}
        {staleRecord !== null
          ? (
            <p style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px', color: 'var(--dsw-alias-state-error-primary)' }}>
              {t('node.stale')}
              <button
                type="button" disabled={props.readOnly} style={{ ...secondaryButton, padding: '4px 10px', opacity: props.readOnly ? 0.5 : 1 }}
                onClick={() => { void props.run(() => props.client.acceptStale(props.project, staleRecord.id, 'canvas', props.session)) }}
              >
                {t('editor.keepAnyway')}
              </button>
            </p>
          )
          : null}
        {body}
      </div>
    </div>
  )
}

/**
 * The node's asset at full width: the video when there is one, else the image.
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
 * A rendered take: preview, prompt, references, duration, seed, and "渲染新版本".
 * @param props - editor props plus the title used in the record intent.
 * @returns the element.
 */
function TakeForm(
  { node, state, client, project, session, readOnly, t, onClose, run, title }: NodeEditorProps & { title: string },
): ReactNode {
  const record = node.record
  const [prompt, setPrompt] = useState(() => typeof record?.params['prompt'] === 'string' ? record.params['prompt'] : '')
  const [inputs, setInputs] = useState<EditedInput[]>(
    () => record?.inputs.map(input => ({ role: input.role, ref: referenceText(input.ref) })) ?? [],
  )
  const [duration, setDuration] = useState(() => typeof record?.params['duration_sec'] === 'number' ? String(record.params['duration_sec']) : '')
  const [seed, setSeed] = useState(() => typeof record?.params['seed'] === 'number' ? String(record.params['seed']) : '')
  const references = inputs.filter(input => input.role === 'reference')
  const candidates = [
    ...bibleItems(state).flatMap(({ id, versions }) => {
      const latest = versions.at(-1)
      return latest === undefined ? [] : [{ ref: `${id}@${String(latest.version)}`, name: latest.name || id }]
    }),
    ...state.assets.filter(asset => asset.mime.startsWith('image/')).map(asset => ({ ref: asset.id, name: asset.name })),
  ].filter(candidate => !references.some(input => input.ref === candidate.ref))
  const operation = record?.operation ?? null
  const renderTake = (): void => {
    if (record === null || operation === null) return
    const params: Record<string, unknown> = { ...record.params, prompt }
    delete params['duration_sec']
    delete params['seed']
    if (duration.trim() !== '' && Number.isFinite(Number(duration))) params['duration_sec'] = Number(duration)
    if (seed.trim() !== '' && Number.isInteger(Number(seed))) params['seed'] = Number(seed)
    void run(() => client.runOperation({
      project, operation, inputs, params, surface: 'canvas', intent: t('intent.renderTake', { title }), based_on: record.id,
      ...session === null ? {} : { session },
    })).then(onClose)
  }
  return (
    <div>
      <Preview node={node} />
      <label style={label} htmlFor="dv-canvas-editor-prompt">{t('editor.prompt')}</label>
      <textarea id="dv-canvas-editor-prompt" style={{ ...field, minHeight: 72, resize: 'vertical' }} value={prompt} onChange={(event) => { setPrompt(event.target.value) }} />
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
          <label style={label} htmlFor="dv-canvas-editor-duration">{t('editor.duration')}</label>
          <input id="dv-canvas-editor-duration" type="number" min={1} step={1} style={field} value={duration} onChange={(event) => { setDuration(event.target.value) }} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={label} htmlFor="dv-canvas-editor-seed">{t('editor.seed')}</label>
          <input id="dv-canvas-editor-seed" type="number" step={1} style={field} placeholder={t('editor.seedRandom')} value={seed} onChange={(event) => { setSeed(event.target.value) }} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button type="button" disabled={readOnly || operation === null} style={{ ...button, background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-inverted)', fontWeight: 600, opacity: readOnly || operation === null ? 0.5 : 1 }} onClick={renderTake}>{t('editor.renderTake')}</button>
      </div>
    </div>
  )
}

/**
 * A character, location or style: its reference images and description, and a control to replace the reference image.
 * @param props - editor props.
 * @returns the element.
 */
function BibleForm({ node, state, client, project, session, readOnly, t, run }: NodeEditorProps): ReactNode {
  const bibleId = node.bibleId ?? ''
  const kind = node.bibleKind ?? 'character'
  const latest = bibleVersions(state, bibleId)?.at(-1)
  const images = state.assets.filter(asset => asset.mime.startsWith('image/'))
  const sessionField = session === null ? {} : { session }
  const replace = (assetId: string): void => {
    if (latest === undefined) return
    void run(() => client.runOperation({
      project, operation: `bible.${kind}_update`, params: { [kind]: bibleId }, inputs: [{ role: 'reference', ref: assetId }], surface: 'canvas',
      intent: t('intent.replaceRef', { name: latest.name || bibleId }), ...sessionField,
    }))
  }
  const importImage = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    if (file === undefined) return
    void run(async () => {
      const base64 = await base64Of(file)
      const record = await client.runOperation({ project, operation: 'asset.import', params: { base64, mime: file.type || 'image/png', name: file.name }, surface: 'canvas', intent: t('intent.import', { name: file.name }), ...sessionField })
      const assetId = record.outputs[0]
      if (assetId !== undefined) replace(assetId)
    })
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(latest?.references ?? []).map(reference => (
          <img key={reference} src={assetUrl(reference)} alt={reference} style={referenceImage} />
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
          {t('editor.import')}
          <input type="file" accept="image/*" disabled={readOnly} style={{ display: 'none' }} onChange={importImage} />
        </label>
      </div>
    </div>
  )
}

/**
 * A plan: a switch between its versions (latest first selected), and the status and shots of the chosen version. The status
 * is approved, awaiting approval (the latest version only), or replaced by the next version.
 * @param props - editor props.
 * @returns the element.
 */
function PlanList({ node, state, t }: NodeEditorProps): ReactNode {
  const versions = state.components.plan.plans[node.planId ?? ''] ?? []
  const [chosen, setChosen] = useState<number | null>(null)
  const plan = versions.find(version => version.version === chosen) ?? versions.at(-1)
  const approved = plan !== undefined && plan.approved_by !== null
  // A version that a later version replaced before anyone approved it never waits for approval again.
  const replaced = plan !== undefined && !approved && plan !== versions.at(-1)
  let status = t('editor.planPending')
  if (approved) status = t('editor.planApproved')
  else if (replaced) status = t('editor.planReplaced', { version: plan.version + 1 })
  return (
    <div>
      <div role="group" aria-label={t('editor.planVersions')} style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {versions.map((version) => {
          const pressed = version === plan
          return (
            <button
              key={version.version} type="button" aria-pressed={pressed} onClick={() => { setChosen(version.version) }}
              style={{ ...secondaryButton, padding: '4px 12px', fontWeight: pressed ? 600 : 400, outline: pressed ? `2px solid ${KIND_COLOR.plan}` : 'none' }}
            >
              {t('node.planVersion', { version: version.version })}
            </button>
          )
        })}
      </div>
      <p style={{ margin: 0, color: approved ? 'var(--dsw-alias-state-success-primary)' : replaced ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-state-warn-primary)' }}>{status}</p>
      <span style={label}>{t('editor.shots')}</span>
      <ol style={{ margin: 0, paddingLeft: 20 }}>
        {(plan?.shots ?? []).map((shot, index) => {
          // The images the shot renders from, in the order its prompt names them Picture 1, Picture 2, ….
          const images = referenceImages(state, shotReferences(plan ?? {}, shot))
          return (
            <li key={index} style={{ marginBottom: 6 }} data-shot={index + 1}>
              {images.length === 0
                ? null
                : (
                  <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                    {images.map((asset, position) => <img key={position} src={assetUrl(asset)} alt="" style={shotThumb} draggable={false} />)}
                  </div>
                )}
              {pictureParts(shot.prompt).map((part, position) => {
                const asset = 'picture' in part ? images[part.picture - 1] : undefined
                return asset === undefined
                  ? <span key={position}>{part.text}</span>
                  : <img key={position} src={assetUrl(asset)} alt={part.text} title={part.text} style={promptThumb} draggable={false} />
              })}
              {shot.duration_sec === undefined ? null : <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{` · ${String(shot.duration_sec)}s`}</span>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
