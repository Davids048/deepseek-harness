/**
 * The operation DAG the canvas draws: records as nodes, asset flow as edges, plan records as composite nodes that hold
 * the records they scheduled, and a layered layout computed without a graph library.
 *
 * @module @video-harness/ui-kit/dag
 */
import type { WireEntityVersion, WireOp, WireState } from './types.ts'

/** A drawn node: a record, an entity, or a collapsed plan. */
export interface DagNode {
  id: string
  kind: 'op' | 'entity' | 'plan'
  label: string
  /** Second line: tool name, status, or entity kind. */
  detail: string
  status: WireOp['status'] | 'entity'
  stale: boolean
  superseded: boolean
  /** Whether the record sits on a `draft/` branch. */
  draft: boolean
  actor: WireOp['actor'] | 'none'
  /** The records a plan node hides while collapsed. */
  children: string[]
  /** The record this one is a take of (`base_op`), when any. */
  takeOf: string | null
  op: WireOp | null
  entity: { id: string; version: WireEntityVersion } | null
}

/** A drawn edge, labeled with the role the asset plays at its target. */
export interface DagEdge {
  from: string
  to: string
  label: string
  /** The asset that flows, or null for a plan's scheduling edge. */
  asset: string | null
}

/** The graph before layout. */
export interface Dag {
  nodes: DagNode[]
  edges: DagEdge[]
}

/** A node with a position. */
export interface PlacedNode extends DagNode {
  x: number
  y: number
  layer: number
}

/** The layout result. */
export interface DagLayout {
  nodes: PlacedNode[]
  edges: DagEdge[]
  width: number
  height: number
}

/** Record kinds the canvas hides: bookkeeping that would only add noise. `plan.approve` records are hidden the same way. */
const HIDDEN_KINDS = new Set(['intent', 'branch', 'approve', 'reject'])

/**
 * The records a plan scheduled: every record whose params name the plan or whose turn is the approval's turn and
 * which the plan's approval preceded.
 * @param plan - the plan record.
 * @param ops - all records.
 * @returns the child record IDs.
 */
function planChildren(plan: WireOp, ops: WireOp[]): string[] {
  const approvals = ops.filter(op => op.tool?.name === 'plan.approve' && op.params['plan'] === plan.id)
  const turns = new Set(approvals.map(op => op.turn))
  return ops
    .filter(op => op.id !== plan.id && !approvals.some(a => a.id === op.id) && turns.has(op.turn) && op.tool?.name !== 'plan.approve')
    .map(op => op.id)
}

/**
 * A short label for a record: the tool's last segment, the prompt's first words, or the kind.
 * @param op - the record.
 * @returns the label.
 */
export function opLabel(op: WireOp): string {
  const prompt = op.params['prompt']
  if (typeof prompt === 'string' && prompt.length > 0) return prompt.length > 28 ? `${prompt.slice(0, 28)}…` : prompt
  if (op.tool !== undefined) return op.tool.name
  return op.kind
}

/**
 * Build the graph of a folded state.
 * @param state - the folded state.
 * @param expanded - plan records whose children are shown instead of collapsed.
 * @returns the nodes and edges.
 */
export function buildDag(state: WireState, expanded: ReadonlySet<string> = new Set()): Dag {
  const nodes: DagNode[] = []
  const edges: DagEdge[] = []
  const hidden = new Set<string>()
  const planOf = new Map<string, string>()
  for (const op of state.ops) {
    if (op.tool?.name === 'plan.create' || op.tool?.name === 'plan.update') {
      const children = planChildren(op, state.ops)
      for (const child of children) planOf.set(child, op.id)
      if (!expanded.has(op.id)) for (const child of children) hidden.add(child)
    }
  }
  for (const [entityId, versions] of Object.entries(state.entities)) {
    const version = versions[versions.length - 1]
    if (version === undefined) continue
    nodes.push({
      id: `entity:${entityId}`, kind: 'entity', label: version.name, detail: `${version.kind} @${String(version.version)}`,
      status: 'entity', stale: false, superseded: false, draft: false, actor: 'none', children: [], takeOf: null, op: null,
      entity: { id: entityId, version },
    })
  }
  const producerNode = new Map<string, string>()
  for (const op of state.ops) {
    if (HIDDEN_KINDS.has(op.kind) || op.tool?.name === 'plan.approve' || hidden.has(op.id)) continue
    const isPlan = op.tool?.name === 'plan.create' || op.tool?.name === 'plan.update'
    nodes.push({
      id: op.id, kind: isPlan ? 'plan' : 'op', label: opLabel(op), detail: isPlan ? 'plan' : (op.tool?.name ?? op.kind),
      status: op.status, stale: op.id in state.stale, superseded: op.id in state.superseded, draft: op.branch.startsWith('draft/'),
      actor: op.actor, children: isPlan ? planChildren(op, state.ops) : [], takeOf: op.base_op ?? null, op, entity: null,
    })
    for (const asset of op.outputs) producerNode.set(asset, op.id)
  }
  const visible = new Set(nodes.map(node => node.id))
  for (const op of state.ops) {
    if (!visible.has(op.id)) continue
    for (const input of op.inputs) {
      const entityMatch = /^([^@#]+)@\d+$/.exec(input.ref)
      if (entityMatch !== null && visible.has(`entity:${entityMatch[1]}`)) {
        edges.push({ from: `entity:${entityMatch[1]}`, to: op.id, label: input.role, asset: input.resolved })
        continue
      }
      const asset = input.resolved ?? input.ref
      let from = producerNode.get(asset) ?? state.producers[asset]
      if (from !== undefined && hidden.has(from)) from = planOf.get(from)
      if (from !== undefined && visible.has(from) && from !== op.id) edges.push({ from, to: op.id, label: input.role, asset })
    }
    const plan = planOf.get(op.id)
    if (plan !== undefined && visible.has(plan) && expanded.has(plan)) edges.push({ from: plan, to: op.id, label: 'plan', asset: null })
  }
  return { nodes, edges: dedupeEdges(edges) }
}

/**
 * @param edges - edges with possible duplicates.
 * @returns edges with one entry per (from, to, label).
 */
function dedupeEdges(edges: DagEdge[]): DagEdge[] {
  const seen = new Set<string>()
  return edges.filter((edge) => {
    const key = `${edge.from}→${edge.to}:${edge.label}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Node size and gaps of the layout, in SVG units. */
export const DAG_METRICS = { width: 168, height: 56, gapX: 48, gapY: 20, padding: 24 } as const

/**
 * Place nodes in layers: the layer of a node is one more than its longest path from any source, so edges always point
 * right; entities start in layer 0; takes of the same record share a layer. Nodes in a layer keep input order.
 * @param dag - the graph.
 * @returns positions and the drawing size.
 */
export function layoutDag(dag: Dag): DagLayout {
  const incoming = new Map<string, string[]>()
  for (const node of dag.nodes) incoming.set(node.id, [])
  for (const edge of dag.edges) incoming.get(edge.to)?.push(edge.from)
  const layer = new Map<string, number>()
  const visiting = new Set<string>()
  // An edge from a node outside the graph counts as a source; a cycle is cut where it closes.
  const layerOf = (id: string): number => {
    const known = layer.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    const parents = incoming.get(id) ?? []
    const value = parents.length === 0 ? 0 : 1 + Math.max(...parents.map(layerOf))
    visiting.delete(id)
    layer.set(id, value)
    return value
  }
  const columns = new Map<number, DagNode[]>()
  for (const node of dag.nodes) {
    const index = layerOf(node.id)
    const column = columns.get(index) ?? []
    column.push(node)
    columns.set(index, column)
  }
  const nodes: PlacedNode[] = []
  let height = 0
  for (const [index, column] of columns) {
    column.forEach((node, row) => {
      nodes.push({
        ...node, layer: index,
        x: DAG_METRICS.padding + index * (DAG_METRICS.width + DAG_METRICS.gapX),
        y: DAG_METRICS.padding + row * (DAG_METRICS.height + DAG_METRICS.gapY),
      })
    })
    height = Math.max(height, column.length)
  }
  const layers = columns.size
  return {
    nodes, edges: dag.edges,
    width: DAG_METRICS.padding * 2 + Math.max(layers, 1) * DAG_METRICS.width + Math.max(layers - 1, 0) * DAG_METRICS.gapX,
    height: DAG_METRICS.padding * 2 + Math.max(height, 1) * DAG_METRICS.height + Math.max(height - 1, 0) * DAG_METRICS.gapY,
  }
}
