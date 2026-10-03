/**
 * The player's view of a multiverse: the current scene fills the screen, and when it has played to the end, its branches
 * appear as translucent buttons at the bottom of the frame. The player sees only their own world line and never goes
 * back: a choice generates the chosen branch while the screen holds the previous scene's last frame, then the new scene
 * plays.
 *
 * @module @dreamverse/ui-multiverse/client/PlayerView
 */
import React, { useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { chooseNode, failureText, nodeUrl, proposeAgain, type NodeId, type WireMultiverse, type WireNode } from './api.ts'
import type {} from './locales.ts'

/** Props of {@link PlayerView}. */
export interface PlayerViewProps {
  multiverse: WireMultiverse
  /** The node at the end of the player's world line. */
  nodeId: NodeId
  /** The latest failure to read the multiverse, or null. */
  connectionError: string | null
  /** Move the player to the branch they chose. */
  onAdvance: (nodeId: NodeId) => void
  /** Show every world line. */
  onOpenDevMode: () => void
  /** Leave for the creation studio. */
  onNew: () => void
  /** The multiverse page's translate function. */
  t: TranslateNS<'dreamverse.multiverse'>
}

const OVERLAY_BUTTON = 'pointer-events-auto rounded-full border border-white/25 bg-black/30 px-4 py-1.5 text-xs text-white/90 backdrop-blur-md hover:bg-black/50'
const NOTICE = 'pointer-events-auto rounded-full border border-white/20 bg-black/40 px-4 py-2 text-sm text-white/90 backdrop-blur-md'

/**
 * Play the player's current scene, then offer its branches.
 * @param props - the multiverse, the player's scene, and the navigation callbacks.
 * @returns the full-screen stage.
 */
export function PlayerView({
  multiverse, nodeId, connectionError, onAdvance, onOpenDevMode, onNew, t,
}: PlayerViewProps): React.JSX.Element {
  const [ended, setEnded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setEnded(false)
    setError(null)
  }, [nodeId])

  const byId = new Map(multiverse.nodes.map(node => [node.node_id, node]))
  const node = byId.get(nodeId)
  if (node === undefined) return <div className="h-dvh w-full bg-black" />
  const parent = node.parent_id === null ? undefined : byId.get(node.parent_id)
  const branches = multiverse.nodes.filter(other => other.parent_id === node.node_id)
  const url = (id: NodeId): string => nodeUrl(multiverse.multiverse_id, id)
  const playing = node.status === 'completed' && node.has_clip

  /** Run a node command and show its failure; `then` runs after the server accepts it. */
  function run(command: Promise<void>, then: () => void): void {
    setError(null)
    command.then(then, (cause: unknown) => { setError(failureText(cause, t)) })
  }

  /** Move to a branch, generating it first unless it already exists or is generating. */
  function choose(branch: WireNode): void {
    if (branch.status === 'proposed' || branch.status === 'failed') run(chooseNode(multiverse.multiverse_id, branch.node_id), () => { onAdvance(branch.node_id) })
    else onAdvance(branch.node_id)
  }

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-black text-white" data-testid="player">
      {playing
        ? <video
          key={node.node_id}
          data-testid="scene-video"
          className="h-full w-full object-contain"
          src={`${url(node.node_id)}/clip`}
          autoPlay
          playsInline
          controls
          onEnded={() => { setEnded(true) }}
        />
        : parent?.has_last_frame === true
          ? <img data-testid="held-frame" className="h-full w-full object-contain" alt="" src={`${url(parent.node_id)}/last-frame`} />
          : null}
      {/* Load this scene's last frame while it plays, so the frame held during the next generation shows at once. */}
      {playing && node.has_last_frame && <img hidden data-testid="preloaded-frame" alt="" src={`${url(node.node_id)}/last-frame`} />}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-4">
        <span className="rounded-full bg-black/30 px-3 py-1 text-xs text-white/80 backdrop-blur-md">{t('scene.badge', { number: node.depth + 1, label: node.label })}</span>
        <div className="flex gap-2">
          <button type="button" className={OVERLAY_BUTTON} onClick={onOpenDevMode}>{t('mode.dev')}</button>
          <button type="button" className={OVERLAY_BUTTON} onClick={onNew}>{t('story.new')}</button>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 bg-gradient-to-t from-black/60 via-black/20 to-transparent px-6 pb-20 pt-24">
        {(node.status === 'generating' || node.status === 'proposed') && <p className={NOTICE}>{t('scene.generatingNext')}</p>}
        {node.status === 'failed' && (
          <>
            <p className={NOTICE}>{t('scene.failed', { error: node.error ?? '' })}</p>
            <button type="button" className={OVERLAY_BUTTON} onClick={() => { run(chooseNode(multiverse.multiverse_id, node.node_id), () => {}) }}>{t('retry')}</button>
          </>
        )}
        {playing && ended && (branches.length > 0
          ? (
            <div className="flex flex-wrap justify-center gap-4" role="group" aria-label={t('choices.label')}>
              {branches.map(branch => (
                <button
                  key={branch.node_id}
                  type="button"
                  className="pointer-events-auto flex max-w-xs flex-col gap-1 rounded-2xl border border-white/30 bg-white/10 px-6 py-3 text-left shadow-lg backdrop-blur-md transition hover:bg-white/20"
                  onClick={() => { choose(branch) }}
                >
                  <span className="text-sm font-semibold">{branch.label}</span>
                  <span className="line-clamp-2 text-xs text-white/75">{branch.direction}</span>
                </button>
              ))}
            </div>
          )
          : node.error !== null
            ? <button type="button" className={OVERLAY_BUTTON} onClick={() => { run(proposeAgain(multiverse.multiverse_id, node.node_id), () => {}) }}>{t('choices.proposeAgain')}</button>
            : <p className={NOTICE}>{t('choices.preparing')}</p>)}
        {(error ?? connectionError) !== null && <p role="alert" className={NOTICE}>{error ?? connectionError}</p>}
      </div>
    </div>
  )
}
