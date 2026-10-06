/**
 * Canvas nodes and edges derived from a folded project state. A node is an item a creator works with: an entity
 * (character, style, location), an uploaded reference, a plan, or a generated clip. Deterministic edits (frame
 * extraction, probes, sequence records) do not become nodes; a timeline trim shows as a badge on the clip it shortened.
 */
import type { WireOp, WireState } from '@video-harness/ui-kit/types.ts'

/** What a node represents; the canvas colors nodes by it. */
export type CanvasNodeKind = 'entity' | 'reference' | 'plan' | 'clip'

/** Display states of a node. */
export interface CanvasNodeFlags {
  /** On an open draft that the user has not accepted yet. */
  draft: boolean
  stale: boolean
  generating: boolean
  failed: boolean
  superseded: boolean
}

/** One canvas node. */
export interface CanvasNode {
  /** `entity:<name>` for entities, else the operation record ID. */
  id: string
  kind: CanvasNodeKind
  /** For entities, the entity kind such as `character`. */
  entityKind?: string
  /** For entities, the entity name. */
  entity?: string
  title: string
  subtitle: string
  /** An image asset shown as the thumbnail. */
  thumb: string | null
  /** A video asset the editor plays. */
  video: string | null
  durationSec: number | null
  /** The operation record behind the node; for entities, the record that wrote the latest version. */
  op: WireOp | null
  flags: CanvasNodeFlags
  /** Short labels of deterministic edits applied to the node's media, such as `trim`. */
  badges: string[]
  /** For clips of one shot that has several versions, this clip's 1-based version number; null for a single version. */
  take: number | null
  /** The default position when the user has not placed the node. */
  x: number
  y: number
}

/** How one node fed another. */
export type CanvasEdgeKind = 'ref' | 'frame' | 'plan' | 'take'

/** One "used as input" edge. */
export interface CanvasEdge {
  from: string
  to: string
  kind: CanvasEdgeKind
}

/** The canvas graph. */
export interface CanvasGraph {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  /** The node that shows each asset: its entity, or the nearest drawn record up its producer chain. */
  assetNodes: Record<string, string>
}

/** Default spacing of the automatic layout, in canvas units. */
export const NODE_WIDTH = 280
const COLUMN = 360
/** Row pitch; it leaves room for a card whose text has grown at the lowest zoom and that carries a badge row. */
export const ROW = 380

/** A generation record whose outputs are media the creator judges. */
function isGeneration(op: WireOp): boolean {
  return op.tool?.name.startsWith('generate.') === true
}

/** A plan record. */
function isPlan(op: WireOp): boolean {
  return op.tool?.name === 'plan.create' || op.tool?.name === 'plan.update'
}

/**
 * Name each uploaded asset by this project's own `asset.upload` record. The asset store keeps the name of the first
 * upload of identical bytes in any project, so another project's file name would otherwise show here.
 * @param state - a folded state.
 * @returns the state with upload names applied; `state` itself when no name differs.
 */
export function withUploadNames(state: WireState): WireState {
  const names = new Map<string, string>()
  for (const op of state.ops) {
    const name = op.params['name']
    if (op.tool?.name !== 'asset.upload' || op.status !== 'done' || typeof name !== 'string' || name === '') continue
    for (const id of op.outputs) names.set(id, name)
  }
  if (!state.assets.some(asset => names.has(asset.id) && names.get(asset.id) !== asset.name)) return state
  return { ...state, assets: state.assets.map(asset => ({ ...asset, name: names.get(asset.id) ?? asset.name })) }
}

/**
 * Merge an open draft's folded state into the base state: records, assets, and entity versions the base lacks.
 * @param base - the state of the viewed branch.
 * @param draft - the state of an open draft branch, or null.
 * @returns the merged state; `base` itself when there is no draft.
 */
export function overlayDraft(base: WireState, draft: WireState | null): WireState {
  if (draft === null) return base
  const known = new Set(base.ops.map(op => op.id))
  const assets = new Set(base.assets.map(asset => asset.id))
  const entities = { ...base.entities }
  for (const [name, versions] of Object.entries(draft.entities)) {
    if ((entities[name]?.length ?? 0) < versions.length) entities[name] = versions
  }
  return {
    ...base,
    ops: [...base.ops, ...draft.ops.filter(op => !known.has(op.id))],
    assets: [...base.assets, ...draft.assets.filter(asset => !assets.has(asset.id))],
    entities,
    stale: { ...draft.stale, ...base.stale },
    producers: { ...draft.producers, ...base.producers },
  }
}

/**
 * The canvas graph of a folded state, with a default layout: entities and references in column 0, plans in column 1,
 * clips from column 2 rightwards by first-frame chain depth, retakes in their source clip's column.
 * @param state - a folded state, possibly with a draft overlaid by {@link overlayDraft}.
 * @param draftOps - IDs of records that belong to an open draft.
 * @returns the nodes and edges.
 */
export function buildCanvasGraph(state: WireState, draftOps: ReadonlySet<string> = new Set()): CanvasGraph {
  const assets = new Map(state.assets.map(asset => [asset.id, asset]))
  const ops = new Map(state.ops.map(op => [op.id, op]))
  const isImage = (id: string | undefined): boolean => id !== undefined && assets.get(id)?.mime.startsWith('image/') === true
  const isVideo = (id: string | undefined): boolean => id !== undefined && assets.get(id)?.mime.startsWith('video/') === true
  const flagsOf = (op: WireOp | null): CanvasNodeFlags => ({
    draft: op !== null && draftOps.has(op.id),
    stale: op !== null && state.stale[op.id] !== undefined,
    generating: op !== null && (op.status === 'pending' || op.status === 'running'),
    failed: op?.status === 'failed',
    superseded: op !== null && state.superseded[op.id] !== undefined,
  })
  const nodes: CanvasNode[] = []
  const byOp = new Map<string, string>()
  // An asset an entity uses as its reference image belongs to the entity node, so its upload is not drawn twice.
  const entityOfAsset = new Map<string, string>()
  for (const [name, versions] of Object.entries(state.entities)) {
    const latest = versions.at(-1)
    if (latest === undefined) continue
    const id = `entity:${name}`
    for (const version of versions) for (const ref of version.refs) entityOfAsset.set(ref, id)
    const op = ops.get(latest.updatedBy) ?? null
    nodes.push({
      id, kind: 'entity', entityKind: latest.kind, entity: name, title: latest.name || name, subtitle: latest.description,
      thumb: latest.refs.find(ref => isImage(ref)) ?? null, video: null, durationSec: null, op, flags: flagsOf(op), badges: [], take: null,
      x: 0, y: 0,
    })
  }
  for (const op of state.ops) {
    if (op.tool?.name === 'asset.upload') {
      const media = op.outputs.find(id => isImage(id) || isVideo(id))
      if (media === undefined || entityOfAsset.has(media)) continue
      nodes.push({
        id: op.id, kind: 'reference', title: assets.get(media)?.name ?? media, subtitle: '', thumb: isImage(media) ? media : null,
        video: isVideo(media) ? media : null, durationSec: assets.get(media)?.durationSec ?? null,
        op, flags: flagsOf(op), badges: [], take: null, x: 0, y: 0,
      })
    } else if (isPlan(op)) {
      const shots = Array.isArray(op.params['shots']) ? op.params['shots'].length : 0
      const title = typeof op.params['title'] === 'string' ? op.params['title'] : ''
      nodes.push({ id: op.id, kind: 'plan', title, subtitle: String(shots), thumb: null, video: null, durationSec: null, op, flags: flagsOf(op), badges: [], take: null, x: 0, y: 0 })
    } else if (isGeneration(op)) {
      const video = op.outputs.find(id => isVideo(id)) ?? null
      const shot = typeof op.params['shot'] === 'number' ? op.params['shot'] : null
      nodes.push({
        id: op.id, kind: 'clip', title: shot === null ? '' : String(shot), subtitle: typeof op.params['prompt'] === 'string' ? op.params['prompt'] : '',
        thumb: op.outputs.find(id => isImage(id)) ?? null, video,
        durationSec: video === null ? null : assets.get(video)?.durationSec ?? null,
        op, flags: flagsOf(op), badges: [], take: null, x: 0, y: 0,
      })
    } else continue
    byOp.set(op.id, op.id)
  }
  const nodeIds = new Set(nodes.map(node => node.id))
  /** The node an asset comes from: its entity, or the nearest drawn record up its producer chain. */
  const nodeOfAsset = (assetId: string | null, depth = 0): string | null => {
    if (assetId === null) return null
    const entity = entityOfAsset.get(assetId)
    if (entity !== undefined) return entity
    const producer = state.producers[assetId]
    if (producer === undefined || depth > 16) return null
    if (byOp.has(producer)) return producer
    const source = ops.get(producer)?.inputs.find(input => input.resolved !== null)?.resolved
    return source === undefined ? null : nodeOfAsset(source, depth + 1)
  }
  const edges: CanvasEdge[] = []
  const seen = new Set<string>()
  const addEdge = (from: string | null, to: string, kind: CanvasEdgeKind): void => {
    if (from === null || from === to || !nodeIds.has(from)) return
    const key = `${from}>${to}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ from, to, kind })
  }
  for (const node of nodes) {
    const op = node.op
    if (op === null || node.kind === 'entity') continue
    for (const input of op.inputs) {
      const entity = /^(.+)@\d+$/.exec(input.ref)?.[1]
      const from = entity !== undefined && nodeIds.has(`entity:${entity}`) ? `entity:${entity}` : nodeOfAsset(input.resolved)
      addEdge(from, node.id, input.role === 'first_frame' ? 'frame' : 'ref')
    }
    if (typeof op.params['plan'] === 'string') addEdge(op.params['plan'], node.id, 'plan')
    if (op.base_op !== undefined) addEdge(op.base_op, node.id, 'take')
  }
  addBadges(state, nodes, nodeOfAsset)
  numberTakes(nodes, edges)
  layout(nodes, edges)
  const assetNodes: Record<string, string> = {}
  for (const asset of state.assets) {
    const node = nodeOfAsset(asset.id)
    if (node !== null && nodeIds.has(node)) assetNodes[asset.id] = node
  }
  return { nodes, edges, assetNodes }
}

/**
 * Number the versions of each shot, so an original clip and its retakes read differently on the canvas. Clips of the
 * same plan shot, and clips linked by a take edge to such a clip, are versions of one shot, numbered in record order.
 * @param nodes - the drawn nodes; clips get their `take` set in place.
 * @param edges - the edges; a take edge links a retake to its source clip.
 */
function numberTakes(nodes: CanvasNode[], edges: CanvasEdge[]): void {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const baseOf = new Map(edges.filter(edge => edge.kind === 'take').map(edge => [edge.to, edge.from]))
  const groupOf = (node: CanvasNode, depth = 0): string => {
    const base = byId.get(baseOf.get(node.id) ?? '')
    if (base !== undefined && depth < 64) return groupOf(base, depth + 1)
    const plan = node.op?.params['plan']
    return node.title === '' ? node.id : `${typeof plan === 'string' ? plan : ''}#${node.title}`
  }
  const groups = new Map<string, CanvasNode[]>()
  for (const node of nodes) {
    if (node.kind !== 'clip') continue
    const key = groupOf(node)
    groups.set(key, [...groups.get(key) ?? [], node])
  }
  for (const members of groups.values()) {
    if (members.length > 1) members.forEach((node, index) => { node.take = index + 1 })
  }
}

/**
 * Mark clips that the timeline trims: a timeline clip with an in or out point.
 * @param state - the folded state.
 * @param nodes - the drawn nodes, badged in place.
 * @param nodeOfAsset - resolves an asset to its node.
 */
function addBadges(state: WireState, nodes: CanvasNode[], nodeOfAsset: (assetId: string | null) => string | null): void {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const badge = (id: string | null, label: string): void => {
    const node = id === null ? undefined : byId.get(id)
    if (node !== undefined && !node.badges.includes(label)) node.badges.push(label)
  }
  for (const item of state.sequence?.items ?? []) {
    if (item.inSec !== null || item.outSec !== null) badge(nodeOfAsset(item.assetId), 'trim')
  }
}

/**
 * Assign default positions in place. Each column kind (references, plans, clips by first-frame depth) wraps into
 * several sub-columns once it holds more nodes than the shared row count, so a long shot list forms a block that fits
 * the screen. A retake sits right after its source clip in the same column.
 * @param nodes - the nodes.
 * @param edges - the edges, used for first-frame depth and retake columns.
 */
function layout(nodes: CanvasNode[], edges: CanvasEdge[]): void {
  const column = new Map<string, number>()
  const incoming = (id: string, kind: CanvasEdgeKind): string[] =>
    edges.filter(edge => edge.to === id && edge.kind === kind).map(edge => edge.from)
  const columnOf = (node: CanvasNode, depth = 0): number => {
    const known = column.get(node.id)
    if (known !== undefined) return known
    let value = node.kind === 'plan' ? 1 : node.kind === 'clip' ? 2 : 0
    if (node.kind === 'clip' && depth < 64) {
      const base = incoming(node.id, 'take')[0]
      const baseNode = base === undefined ? undefined : nodes.find(candidate => candidate.id === base)
      if (baseNode !== undefined) value = columnOf(baseNode, depth + 1)
      else {
        for (const from of incoming(node.id, 'frame')) {
          const source = nodes.find(candidate => candidate.id === from)
          if (source?.kind === 'clip') value = Math.max(value, columnOf(source, depth + 1) + 1)
        }
      }
    }
    column.set(node.id, value)
    return value
  }
  const columns = new Map<number, CanvasNode[]>()
  for (const node of nodes) {
    const col = columnOf(node)
    columns.set(col, [...columns.get(col) ?? [], node])
  }
  const baseOf = new Map(edges.filter(edge => edge.kind === 'take').map(edge => [edge.to, edge.from]))
  const tallest = Math.max(0, ...[...columns.values()].map(members => members.length))
  // About 1.5 rows per sub-column keeps a wrapped block close to the shape of a landscape screen.
  const rowsPer = Math.max(4, Math.ceil(Math.sqrt(tallest * 1.5)))
  let x = 0
  for (const col of [...columns.keys()].sort((a, b) => a - b)) {
    const members = columns.get(col) ?? []
    const ordered: CanvasNode[] = []
    const place = (node: CanvasNode): void => {
      if (ordered.includes(node)) return
      ordered.push(node)
      for (const take of members) if (baseOf.get(take.id) === node.id) place(take)
    }
    for (const node of members) if (!members.some(other => other.id === baseOf.get(node.id))) place(node)
    for (const node of members) place(node)
    ordered.forEach((node, index) => {
      node.x = x + Math.floor(index / rowsPer) * COLUMN
      node.y = (index % rowsPer) * ROW
    })
    x += Math.ceil(ordered.length / rowsPer) * COLUMN
  }
}
