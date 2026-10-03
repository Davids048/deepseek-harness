/**
 * The developer view of a multiverse: every world line drawn horizontally, with time running left to right. A scene sits
 * in the column of its depth; the player's world line runs straight along the top lane, a world line keeps its lane
 * through each scene's first branch, and every other branch opens a lane below. Generated scenes show their last
 * frame, proposed branches are dashed cards with a Choose button, the player's world line is drawn solid and the other
 * lines faded, and the selected scene is highlighted.
 *
 * @module @dreamverse/ui-multiverse/client/WorldLines
 */
import React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@dreamverse/ui-kit/components/ui/button.tsx'
import { cn } from '@dreamverse/ui-kit/utils.ts'
import { nodeUrl, type NodeId, type WireMultiverse, type WireNode } from './api.ts'
import type { DreamverseMultiverseKey } from './locales.ts'

/** Props of {@link WorldLines}. */
export interface WorldLinesProps {
  multiverse: WireMultiverse
  selectedNodeId: NodeId | null
  /** The node at the end of the player's world line. */
  playerNodeId: NodeId
  /** Select a generated scene for playback. */
  onSelect: (nodeId: NodeId) => void
  /** Generate a proposed branch, or retry a failed scene. */
  onChoose: (nodeId: NodeId) => void
  /** Propose branches again under a generated scene whose proposal failed. */
  onProposeAgain: (nodeId: NodeId) => void
  /** The multiverse page's translate function. */
  t: TranslateNS<'dreamverse.multiverse'>
}

/** The dictionary key of each node status's card text. */
const STATUS_KEYS: Record<WireNode['status'], DreamverseMultiverseKey> = {
  proposed: 'status.proposed',
  generating: 'status.generating',
  completed: 'status.completed',
  failed: 'status.failed',
}

/** Horizontal distance between scene columns, in pixels. */
const COLUMN_WIDTH = 232
/** Width of one scene card, in pixels. */
const CARD_WIDTH = 192
/** Vertical distance between lanes, in pixels. */
const LANE_HEIGHT = 136
/** Height of one scene card, in pixels. */
const CARD_HEIGHT = 120

/** Where one node is drawn: its scene column and its lane. */
interface Placement {
  column: number
  lane: number
}

/**
 * Place every node: a node keeps the lane of its first branch, and each leaf takes the next free lane in depth-first
 * order, so a world line runs straight and its branches stack below it. The branch on the player's world line comes
 * first, so that line is the top lane.
 * @param multiverse - the multiverse.
 * @param playerLine - the IDs of the nodes on the player's world line.
 * @returns the placement of each node and the number of lanes.
 */
function placeNodes(multiverse: WireMultiverse, playerLine: ReadonlySet<NodeId>): { placements: Map<NodeId, Placement>; lanes: number } {
  const children = new Map<NodeId, WireNode[]>()
  for (const node of multiverse.nodes) {
    if (node.parent_id !== null) children.set(node.parent_id, [...children.get(node.parent_id) ?? [], node])
  }
  const placements = new Map<NodeId, Placement>()
  let nextLane = 0
  const place = (node: WireNode): number => {
    const kids = [...children.get(node.node_id) ?? []].sort((a, b) => Number(playerLine.has(b.node_id)) - Number(playerLine.has(a.node_id)))
    const lane = kids.length === 0 ? nextLane++ : kids.map(place)[0] ?? nextLane++
    placements.set(node.node_id, { column: node.depth, lane })
    return lane
  }
  const root = multiverse.nodes.find(node => node.node_id === multiverse.root_id)
  if (root !== undefined) place(root)
  return { placements, lanes: Math.max(nextLane, 1) }
}

/** The IDs of the nodes from the root to a node, inclusive. */
function lineTo(multiverse: WireMultiverse, nodeId: NodeId): Set<NodeId> {
  const byId = new Map(multiverse.nodes.map(node => [node.node_id, node]))
  const line = new Set<NodeId>()
  for (let node = byId.get(nodeId); node !== undefined; node = node.parent_id === null ? undefined : byId.get(node.parent_id)) {
    line.add(node.node_id)
  }
  return line
}

/**
 * Draw every world line of the multiverse.
 * @param props - the multiverse, the selection, the player's scene, and the node actions.
 * @returns the scrollable world-line chart.
 */
export function WorldLines(props: WorldLinesProps): React.JSX.Element {
  const { multiverse, playerNodeId, t } = props
  const playerLine = lineTo(multiverse, playerNodeId)
  const { placements, lanes } = placeNodes(multiverse, playerLine)
  const generating = multiverse.nodes.some(node => node.status === 'generating')
  const columns = Math.max(...multiverse.nodes.map(node => node.depth), 0) + 1
  const width = (columns - 1) * COLUMN_WIDTH + CARD_WIDTH
  const height = (lanes - 1) * LANE_HEIGHT + CARD_HEIGHT
  const at = (nodeId: NodeId): Placement => placements.get(nodeId) ?? { column: 0, lane: 0 }
  return (
    <div className="overflow-x-auto pb-2">
      <div className="mb-2 flex" style={{ width }} aria-hidden="true">
        {Array.from({ length: columns }, (_value, column) => (
          <span key={column} className="shrink-0 text-xs text-muted-foreground" style={{ width: column === columns - 1 ? CARD_WIDTH : COLUMN_WIDTH }}>
            {t('scene.column', { number: column + 1 })}
          </span>
        ))}
      </div>
      <div className="relative" style={{ width, height }}>
        <svg className="absolute inset-0" width={width} height={height} aria-hidden="true">
          {multiverse.nodes.filter((node): node is WireNode & { parent_id: NodeId } => node.parent_id !== null).map((node) => {
            const from = at(node.parent_id)
            const to = at(node.node_id)
            const x1 = from.column * COLUMN_WIDTH + CARD_WIDTH
            const y1 = from.lane * LANE_HEIGHT + CARD_HEIGHT / 2
            const x2 = to.column * COLUMN_WIDTH
            const y2 = to.lane * LANE_HEIGHT + CARD_HEIGHT / 2
            const bend = (x2 - x1) / 2
            const onPlayerLine = playerLine.has(node.node_id)
            return (
              <path
                key={node.node_id}
                d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={onPlayerLine ? 'var(--accent-blue)' : 'var(--border)'}
                strokeWidth={onPlayerLine ? 2.5 : 1.5}
                strokeDasharray={node.status === 'proposed' ? '4 4' : undefined}
              />
            )
          })}
        </svg>
        <ul className="absolute inset-0" aria-label={t('worldLines.label')}>
          {multiverse.nodes.map(node => (
            <SceneCard key={node.node_id} {...props} node={node} placement={at(node.node_id)} onPlayerLine={playerLine.has(node.node_id)}
              generating={generating} hasBranches={multiverse.nodes.some(other => other.parent_id === node.node_id)} />
          ))}
        </ul>
      </div>
    </div>
  )
}

/** One scene card with its place in the chart. */
interface SceneCardProps extends WorldLinesProps {
  node: WireNode
  placement: Placement
  onPlayerLine: boolean
  /** Whether any node is generating; only one scene generates at a time. */
  generating: boolean
  hasBranches: boolean
}

/**
 * Render one scene as a card at its column and lane.
 * @param props - the node, its placement, and the node actions.
 * @returns the list item.
 */
function SceneCard(props: SceneCardProps): React.JSX.Element {
  const { multiverse, node, placement, onPlayerLine, generating, hasBranches, selectedNodeId, t } = props
  const selected = node.node_id === selectedNodeId
  const canChoose = !generating && (node.status === 'proposed' || node.status === 'failed')
  const canProposeAgain = node.status === 'completed' && node.error !== null && !hasBranches
  return (
    <li
      className={cn(
        'absolute flex flex-col gap-1.5 rounded-xl border border-border bg-card p-2 shadow-sm',
        node.status === 'proposed' && 'border-dashed bg-card/60',
        !onPlayerLine && 'opacity-70',
        selected && 'border-[var(--accent-blue)] ring-1 ring-[var(--accent-blue)]',
      )}
      style={{ left: placement.column * COLUMN_WIDTH, top: placement.lane * LANE_HEIGHT, width: CARD_WIDTH, minHeight: CARD_HEIGHT }}
      data-status={node.status}
      data-testid={`node-${node.node_id}`}
    >
      <button
        type="button"
        className="flex items-center gap-2 rounded-lg text-left enabled:hover:bg-secondary disabled:cursor-default"
        disabled={node.status !== 'completed'}
        aria-pressed={selected}
        title={node.direction}
        onClick={() => { props.onSelect(node.node_id) }}
      >
        {node.has_last_frame
          ? <img className="h-10 w-auto shrink-0 rounded-md border border-border object-cover" alt="" src={`${nodeUrl(multiverse.multiverse_id, node.node_id)}/last-frame`} />
          : <span className="h-10 w-[70px] shrink-0 rounded-md border border-dashed border-border bg-muted" aria-hidden="true" />}
        <span className="flex min-w-0 flex-col">
          <span className="line-clamp-2 text-xs font-medium text-foreground">{node.label}</span>
          <span className={cn('text-[11px] text-muted-foreground', node.status === 'failed' && 'text-destructive')}>{t(STATUS_KEYS[node.status])}</span>
        </span>
      </button>
      {node.status === 'proposed' && <span className="line-clamp-2 text-[11px] text-muted-foreground">{node.direction}</span>}
      {node.error !== null && <p className="line-clamp-2 text-[11px] text-destructive" title={node.error}>{node.error}</p>}
      {canChoose && (
        <Button size="sm" className="h-7 self-start rounded-full px-3 text-xs" onClick={() => { props.onChoose(node.node_id) }}>
          {node.status === 'failed' ? t('retry') : t('choose')}
        </Button>
      )}
      {canProposeAgain && (
        <Button variant="outline" size="sm" className="h-7 self-start rounded-full px-3 text-xs" onClick={() => { props.onProposeAgain(node.node_id) }}>
          {t('choices.proposeAgain')}
        </Button>
      )}
    </li>
  )
}
