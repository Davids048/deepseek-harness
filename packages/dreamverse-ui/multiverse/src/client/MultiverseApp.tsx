/**
 * The multiverse page: the DreamVerse creation studio and asset library start a multiverse, then the player mode plays
 * the player's own world line full screen, and the dev mode draws every world line below the selected scene. The page
 * URL holds the open multiverse (`multiverse`), the player's current scene (`node`), and the dev mode (`dev=1`), so a
 * reload restores all three.
 *
 * @module @dreamverse/ui-multiverse/client/MultiverseApp
 */
import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PropsLocale, PropsRenderSlots, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { resolveReferenceAssetIds, type AssetRecord, type ReferenceDraft } from '@dreamverse/assets-manager/client/assets.ts'
import {
  clampLobbySelectionToCapabilities,
  validateLobbyCreationSelection,
  type LobbyCreationCapabilities,
  type LobbySelection,
} from '@dreamverse/project-controller/client/creationCapabilities.ts'
import { buildCreationInitPayload } from '@dreamverse/project-controller/client/creationPayload.ts'
import type { ProjectId } from '@dreamverse/project-controller/client/ids.ts'
import Header, { type HeaderLabels } from '@dreamverse/ui-kit/components/Header.tsx'
import { creationProblemText } from '@dreamverse/ui-kit/problemText.ts'
import { Button } from '@dreamverse/ui-kit/components/ui/button.tsx'
import { DREAMVERSE_SLOTS, type DreamverseSlotOwners, type ReferencePickerProps } from '@dreamverse/ui-kit/contracts.ts'
import {
  chooseNode,
  createMultiverse,
  failureText,
  fetchCapabilities,
  nodeUrl,
  proposeAgain,
  subscribeMultiverse,
  type NodeId,
  type WireMultiverse,
  type WireNode,
} from './api.ts'
import type {} from './locales.ts'
import { PlayerView } from './PlayerView.tsx'
import { WorldLines } from './WorldLines.tsx'

/** The multiverse page's translate function. */
type MultiverseTranslate = TranslateNS<'dreamverse.multiverse'>

/** The DreamVerse page slots that the multiverse page renders; `@dreamverse/ui-assets` and `@dreamverse/ui-creation` fill them. */
export const MULTIVERSE_SLOTS = {
  'dreamverse.asset-library': DREAMVERSE_SLOTS['dreamverse.asset-library'],
  'dreamverse.creation-studio': DREAMVERSE_SLOTS['dreamverse.creation-studio'],
} as const

/** The name of one slot that the multiverse page renders. */
export type MultiverseSlot = keyof typeof MULTIVERSE_SLOTS

/** Render one multiverse page slot with its owner props; tests pass a function that renders the occupants directly. */
export type MultiverseSlotRenderer = <K extends MultiverseSlot>(name: K, props: DreamverseSlotOwners[K]) => ReactNode

/**
 * The `root` occupant: the multiverse page with the slot renderer and the translate function that the DSH registration
 * supplies.
 * @param props - the DSH child-render share and the `dreamverse.multiverse` translate seat.
 * @returns the page.
 */
export function MultiverseRoot({ renderSlot, t }: PropsRenderSlots<MultiverseSlot> & PropsLocale<'dreamverse.multiverse'>): React.JSX.Element {
  // The DSH share types each slot's owner through SlotMap; the kit's contracts declare the same owners per slot, which
  // TypeScript cannot correlate across the generic slot name.
  const render = renderSlot as (name: MultiverseSlot, owner: object) => ReactNode
  return <MultiverseApp renderSlot={(name, owner) => render(name, owner)} t={t} />
}

/**
 * The kit header's copy from the multiverse dictionary.
 * @param t - the multiverse page's translate function.
 * @returns the header labels.
 */
function headerLabels(t: MultiverseTranslate): HeaderLabels {
  return {
    toggleSidebar: t('header.toggleSidebar'),
    repositoryLink: t('header.repositoryLink'),
    logo: t('header.logo'),
    joinWaitlist: t('header.joinWaitlist'),
    lightMode: t('header.lightMode'),
    darkMode: t('header.darkMode'),
  }
}

/** The page state that the URL keeps. */
interface PageState {
  multiverseId: ProjectId | null
  /** The player's current scene; null means the multiverse's root. */
  nodeId: NodeId | null
  devMode: boolean
}

/** Read the page state from the URL. */
function readPageState(): PageState {
  const params = new URL(window.location.href).searchParams
  const multiverseId = params.get('multiverse')
  const nodeId = params.get('node')
  return {
    multiverseId: multiverseId === null ? null : brandString<ProjectId>(multiverseId),
    nodeId: nodeId === null ? null : brandString<NodeId>(nodeId),
    devMode: params.get('dev') === '1',
  }
}

/** Write the page state to the URL without reloading. */
function writePageState(state: PageState): void {
  const url = new URL(window.location.href)
  const set = (name: string, value: string | null): void => {
    if (value === null) url.searchParams.delete(name)
    else url.searchParams.set(name, value)
  }
  set('multiverse', state.multiverseId)
  set('node', state.nodeId)
  set('dev', state.devMode ? '1' : null)
  window.history.replaceState(null, '', url)
}

/**
 * Show the creation studio, or the open multiverse in player or dev mode.
 * @param props - the slot renderer and the multiverse page's translate function.
 * @returns the page.
 */
export function MultiverseApp({ renderSlot, t }: { renderSlot: MultiverseSlotRenderer; t: MultiverseTranslate }): React.JSX.Element {
  const [page, setPage] = useState<PageState>(readPageState)
  const update = (changes: Partial<PageState>): void => {
    setPage((current) => {
      const next = { ...current, ...changes }
      writePageState(next)
      return next
    })
  }
  if (page.multiverseId === null) {
    return (
      <main className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
        <Header labels={headerLabels(t)} />
        <CreateView
          renderSlot={renderSlot}
          t={t}
          onCreated={(multiverse) => { update({ multiverseId: multiverse.multiverse_id, nodeId: null }) }}
        />
      </main>
    )
  }
  return (
    <MultiverseView
      multiverseId={page.multiverseId}
      playerNodeId={page.nodeId}
      devMode={page.devMode}
      onAdvance={(nodeId) => { update({ nodeId }) }}
      onDevModeChange={(devMode) => { update({ devMode }) }}
      onNew={() => { update({ multiverseId: null, nodeId: null }) }}
      t={t}
    />
  )
}

/** Loading state of the served model's creation capabilities. */
type CapabilityState =
  | { status: 'loading' }
  | { status: 'available'; capabilities: LobbyCreationCapabilities }
  | { status: 'failed' }

/** The creation choices before capabilities arrive; loading clamps them to the served model. */
const INITIAL_SELECTION: LobbySelection = {
  modeId: 'ref2av', aspectRatio: '16:9', resolution: '720p', segmentCount: 1, segmentDurationSec: 5,
}

/**
 * Collect the opening scene, the character references, and the creation choices with the DreamVerse creation studio,
 * then create the multiverse. Attached files upload in selection order when the user submits.
 * @param props - the slot renderer, the callback that opens the created multiverse, and the translate function.
 * @returns the asset library dialog, the creation studio, and any creation failure.
 */
function CreateView({ renderSlot, onCreated, t }: {
  renderSlot: MultiverseSlotRenderer
  onCreated: (multiverse: WireMultiverse) => void
  t: MultiverseTranslate
}): React.JSX.Element {
  const [capabilityState, setCapabilityState] = useState<CapabilityState>({ status: 'loading' })
  const [selection, setSelection] = useState<LobbySelection>(INITIAL_SELECTION)
  const [prompt, setPrompt] = useState('')
  const [references, setReferences] = useState<ReferenceDraft[]>([])
  const [assets, setAssets] = useState<AssetRecord[]>([])
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchCapabilities().then((capabilities) => {
      if (cancelled) return
      setCapabilityState({ status: 'available', capabilities })
      setSelection(current => clampLobbySelectionToCapabilities({ ...current, capabilities }))
    }, () => {
      if (!cancelled) setCapabilityState({ status: 'failed' })
    })
    return () => { cancelled = true }
  }, [])

  const capabilities = capabilityState.status === 'available' ? capabilityState.capabilities : null
  const referencePicker: ReferencePickerProps | undefined = capabilities === null ? undefined : {
    references,
    onReferencesChange: setReferences,
    onOpenAssets: () => { setAssetsOpen(true) },
    accept: capabilities.asset_upload.image.mime_types.join(','),
    maxCount: capabilities.reference_inputs.max_count,
    maxBytes: capabilities.asset_upload.image.max_bytes,
  }

  /** Append a saved library image after the selected references, unless it is selected already or the selection is full. */
  function selectAsset(asset: AssetRecord): void {
    if (referencePicker === undefined || asset.media_type !== 'image') return
    setReferences(draft => draft.length >= referencePicker.maxCount
      || draft.some(entry => entry.kind === 'savedAsset' && entry.asset.asset_id === asset.asset_id)
      ? draft : [...draft, { draftId: randomUUID(), kind: 'savedAsset', asset }])
    setAssetsOpen(false)
  }

  /** Validate the choices, upload the attached files, create the multiverse, and open it. */
  async function create(): Promise<void> {
    if (capabilities === null || creating) return
    const invalid = validateLobbyCreationSelection({ ...selection, capabilities, references })
    if (invalid !== null) {
      setNotice(creationProblemText(invalid, t))
      return
    }
    setCreating(true)
    setNotice(null)
    try {
      const referenceAssetIds = await resolveReferenceAssetIds(references, (reference, asset) => {
        // A retry after a failed creation reuses the upload instead of sending the file again.
        setReferences(draft => draft.map(entry => entry.draftId === reference.draftId
          ? { draftId: entry.draftId, kind: 'savedAsset', asset } : entry))
      })
      onCreated(await createMultiverse({
        prompt: prompt.trim(),
        ...buildCreationInitPayload({ modelId: capabilities.model_id, ...selection, referenceAssetIds }),
      }))
    } catch (error) {
      setNotice(failureText(error, t))
      setCreating(false)
    }
  }

  return (
    <>
      {renderSlot('dreamverse.asset-library', {
        open: assetsOpen,
        assets,
        onAssetsChange: setAssets,
        uploadPolicy: capabilities?.asset_upload ?? null,
        onClose: () => { setAssetsOpen(false) },
        onSelect: selectAsset,
        canSelect: referencePicker !== undefined && references.length < referencePicker.maxCount,
        onDeleted: (assetId) => {
          setReferences(draft => draft.filter(entry => entry.kind !== 'savedAsset' || entry.asset.asset_id !== assetId))
        },
      })}
      {renderSlot('dreamverse.creation-studio', {
        value: prompt,
        disabled: creating,
        isGenerating: creating,
        canSubmit: capabilities !== null,
        selection,
        referencePicker,
        capabilities,
        capabilityNotice: capabilityState.status === 'failed'
          ? t('capabilities.unavailable')
          : capabilityState.status === 'loading' ? t('capabilities.loading') : null,
        onValueChange: setPrompt,
        onSubmit: () => { void create() },
        onSelectionChange: (changes) => {
          if (capabilities !== null) setSelection(current => clampLobbySelectionToCapabilities({ ...current, ...changes, capabilities }))
        },
        onOpenAssets: () => { setAssetsOpen(true) },
      })}
      {notice !== null && <p role="alert" className="mx-auto w-full max-w-3xl px-4 pb-4 text-sm text-destructive">{notice}</p>}
    </>
  )
}

/** Props of {@link MultiverseView}. */
interface MultiverseViewProps {
  multiverseId: ProjectId
  /** The player's current scene from the URL; null or an unknown ID means the root. */
  playerNodeId: NodeId | null
  devMode: boolean
  onAdvance: (nodeId: NodeId) => void
  onDevModeChange: (devMode: boolean) => void
  /** Leave this multiverse for the creation studio. */
  onNew: () => void
  t: MultiverseTranslate
}

/**
 * Follow one multiverse's snapshots and show it in player or dev mode.
 * @param props - the multiverse ID, the player's scene, the mode, and the navigation callbacks.
 * @returns the player view, the dev view, or a loading screen.
 */
function MultiverseView(props: MultiverseViewProps): React.JSX.Element {
  const { multiverseId, devMode, t } = props
  const [multiverse, setMultiverse] = useState<WireMultiverse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => subscribeMultiverse(multiverseId, (snapshot) => {
    setError(null)
    setMultiverse(snapshot)
  }, () => { setError(t('connection.lost')) }), [multiverseId, t])

  if (multiverse === null) {
    return <p className={devMode ? 'p-6 text-sm text-muted-foreground' : 'flex h-dvh items-center justify-center bg-black text-sm text-white/70'}>{t('loading')}</p>
  }
  const playerNodeId = multiverse.nodes.some(node => node.node_id === props.playerNodeId) && props.playerNodeId !== null
    ? props.playerNodeId : multiverse.root_id
  return devMode
    ? <DevView multiverse={multiverse} playerNodeId={playerNodeId} connectionError={error}
      onLeaveDevMode={() => { props.onDevModeChange(false) }} onNew={props.onNew} t={t} />
    : <PlayerView multiverse={multiverse} nodeId={playerNodeId} connectionError={error} onAdvance={props.onAdvance}
      onOpenDevMode={() => { props.onDevModeChange(true) }} onNew={props.onNew} t={t} />
}

/** Props of {@link DevView}. */
interface DevViewProps {
  multiverse: WireMultiverse
  playerNodeId: NodeId
  connectionError: string | null
  onLeaveDevMode: () => void
  onNew: () => void
  t: MultiverseTranslate
}

/**
 * Show every world line below the selected scene and let the developer play any scene and generate any branch. A
 * scene that finishes generating becomes the selection.
 * @param props - the multiverse, the player's scene, and the navigation callbacks.
 * @returns the dev view.
 */
function DevView({ multiverse, playerNodeId, connectionError, onLeaveDevMode, onNew, t }: DevViewProps): React.JSX.Element {
  const [selectedNodeId, setSelectedNodeId] = useState<NodeId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const completed = useRef<Set<NodeId> | null>(null)

  useEffect(() => {
    const seen = completed.current ?? new Set<NodeId>()
    const newlyCompleted = multiverse.nodes.filter(node => node.status === 'completed' && !seen.has(node.node_id))
    for (const node of newlyCompleted) seen.add(node.node_id)
    completed.current = seen
    const latest = newlyCompleted.at(-1)
    if (latest !== undefined) setSelectedNodeId(latest.node_id)
  }, [multiverse])

  /** Run one node command and show its failure. */
  function run(command: (id: ProjectId, nodeId: NodeId) => Promise<void>, nodeId: NodeId): void {
    setError(null)
    command(multiverse.multiverse_id, nodeId).catch((cause: unknown) => {
      setError(failureText(cause, t))
    })
  }

  const selected = multiverse.nodes.find(node => node.node_id === selectedNodeId) ?? null
  const generating = multiverse.nodes.some(node => node.status === 'generating')
  const shownError = error ?? connectionError
  return (
    <main className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
      <Header labels={headerLabels(t)} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-8 sm:px-6">
        <ScenePlayer multiverseId={multiverse.multiverse_id} node={selected} generating={generating} t={t} />
        <section className="mx-auto flex w-full max-w-6xl flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-foreground">{selected?.label ?? t('title')}</h2>
              {selected !== null && <p className="text-sm text-muted-foreground">{selected.direction}</p>}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" className="rounded-full px-4" onClick={onLeaveDevMode}>{t('mode.player')}</Button>
              <Button variant="outline" size="sm" className="rounded-full px-4" onClick={onNew}>{t('multiverse.new')}</Button>
            </div>
          </div>
          {shownError !== null && <p role="alert" className="text-sm text-destructive">{shownError}</p>}
          <WorldLines
            multiverse={multiverse}
            selectedNodeId={selectedNodeId}
            playerNodeId={playerNodeId}
            onSelect={setSelectedNodeId}
            onChoose={(nodeId) => { run(chooseNode, nodeId) }}
            onProposeAgain={(nodeId) => { run(proposeAgain, nodeId) }}
            t={t}
          />
        </section>
      </div>
    </main>
  )
}

/**
 * Play the selected generated scene in a frame styled like the DreamVerse player.
 * @param props - the multiverse ID, the selected node, whether a scene is generating, and the translate function.
 * @returns the player frame.
 */
function ScenePlayer({ multiverseId, node, generating, t }: {
  multiverseId: ProjectId
  node: WireNode | null
  generating: boolean
  t: MultiverseTranslate
}): React.JSX.Element {
  return (
    <div className="mx-auto mb-4 w-full max-w-3xl sm:mb-6">
      <div className="rounded-2xl border border-border bg-card/50 p-2 shadow-lg backdrop-blur-md">
        <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-black shadow-lg">
          {node !== null && node.has_clip
            ? <video
              key={node.node_id}
              data-testid="scene-video"
              className="h-full w-full bg-slate-900/80 object-cover"
              src={`${nodeUrl(multiverseId, node.node_id)}/clip`}
              controls
              autoPlay
              playsInline
            />
            : <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-white/70">
              {generating ? t('scene.generatingVideo') : t('scene.firstPending')}
            </p>}
        </div>
      </div>
    </div>
  )
}
