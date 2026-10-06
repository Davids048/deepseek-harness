/**
 * Canvas nodes and edges derived from a branch state. A node is an item a creator works with: a character, a location
 * or a style, an imported asset, a plan with all of its versions, or a rendered take. Deterministic edits (still grabs,
 * timeline records) do not become nodes; a timeline trim shows as a badge on the take it shortened.
 */
import type { Character, Location, PlanState, ProjectRecord, RecordInputRef, StoryBibleState, Style, WireState } from '@dv/ui-kit/types.ts'

/** What a node represents; the canvas colors nodes by it. */
export type CanvasNodeKind = 'bible' | 'asset' | 'plan' | 'take'

/** The story bible kinds a `bible` node can stand for. */
export type BibleKind = 'character' | 'location' | 'style'

/** The slice key of each story bible kind. */
const BIBLE_SLICES: Record<BibleKind, keyof StoryBibleState> = { character: 'characters', location: 'locations', style: 'styles' }

/** Display states of a node. */
export interface CanvasNodeFlags {
  /** On an open draft that the user has not accepted yet. */
  draft: boolean
  stale: boolean
  /** The record is pending or running. */
  rendering: boolean
  failed: boolean
  superseded: boolean
}

/** One canvas node. */
export interface CanvasNode {
  /** `bible:<id>` for characters, locations and styles, `plan:<PlanId>` for plans, else the record ID. */
  id: string
  kind: CanvasNodeKind
  /** For story bible nodes, whether the node is a character, a location or a style. */
  bibleKind?: BibleKind
  /** For story bible nodes, the character, location or style ID. */
  bibleId?: string
  /** For plan nodes, the `PlanId` (`p1`). */
  planId?: string
  title: string
  subtitle: string
  /** An image asset shown as the thumbnail. */
  thumb: string | null
  /** A video asset the editor plays. */
  video: string | null
  durationSec: number | null
  /** The record behind the node; for story bible and plan nodes, the record that wrote the latest version. */
  record: ProjectRecord | null
  flags: CanvasNodeFlags
  /** Short labels of deterministic edits applied to the node's asset, such as `trim`. */
  badges: string[]
  /** For takes of one shot that has several takes, this take's 1-based number; null for a single take. */
  take: number | null
  /** The default position when the user has not placed the node. */
  x: number
  y: number
}

/** How one node fed another. */
export type CanvasEdgeKind = 'reference' | 'first_frame' | 'plan' | 'take'

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
  /** The node that shows each asset: its story bible node, or the nearest drawn record up its producer chain. */
  assetNodes: Record<string, string>
}

/** Default spacing of the automatic layout, in canvas units. */
export const NODE_WIDTH = 280
const COLUMN = 360
/** Row pitch; it leaves room for a card whose text has grown at the lowest zoom and that carries a badge row. */
export const ROW = 380

/** A `shot.render` record, whose outputs are the takes the creator judges. */
function isRender(record: ProjectRecord): boolean {
  return record.operation === 'shot.render'
}

/**
 * Every character, location and style of a state with its latest version.
 * @param state - a branch state.
 * @returns one entry per story bible item, characters first.
 */
export function bibleItems(state: WireState): Array<{ kind: BibleKind; id: string; versions: Character[] | Location[] | Style[] }> {
  const bible = state.components.bible
  return (Object.keys(BIBLE_SLICES) as BibleKind[]).flatMap(kind =>
    Object.entries(bible[BIBLE_SLICES[kind]]).map(([id, versions]) => ({ kind, id, versions })))
}

/**
 * The versions of one character, location or style.
 * @param state - a branch state.
 * @param id - the character, location or style ID.
 * @returns its versions, oldest first, or undefined when the story bible has no such ID.
 */
export function bibleVersions(state: WireState, id: string): Character[] | Location[] | Style[] | undefined {
  const bible = state.components.bible
  return bible.characters[id] ?? bible.locations[id] ?? bible.styles[id]
}

/**
 * The reference text of a record input, as an operation request takes it: `<asset>`, `<record>#<output>`, or
 * `<id>@<version>`.
 * @param ref - the stored input reference.
 * @returns the text.
 */
export function referenceText(ref: RecordInputRef): string {
  if ('asset' in ref) return ref.asset
  if ('record' in ref) return `${ref.record}#${String(ref.output)}`
  if ('character' in ref) return `${ref.character}@${String(ref.version)}`
  if ('location' in ref) return `${ref.location}@${String(ref.version)}`
  return `${ref.style}@${String(ref.version)}`
}

/**
 * The story bible ID a stored input reference names, when it names a character, location or style version.
 * @param ref - the stored input reference.
 * @returns the ID, or undefined for an asset or record output.
 */
function bibleIdOf(ref: RecordInputRef): string | undefined {
  if ('character' in ref) return ref.character
  if ('location' in ref) return ref.location
  if ('style' in ref) return ref.style
  return undefined
}

/**
 * Name each imported asset by this project's own `asset.import` record. The asset pool keeps the name of the first
 * import of identical bytes in any project, so another project's file name would otherwise show here.
 * @param state - a branch state.
 * @returns the state with import names applied; `state` itself when no name differs.
 */
export function withImportNames(state: WireState): WireState {
  const names = new Map<string, string>()
  for (const record of state.components.proj.records) {
    const name = record.params['name']
    if (record.operation !== 'asset.import' || record.status !== 'done' || typeof name !== 'string' || name === '') continue
    for (const id of record.outputs) names.set(id, name)
  }
  if (!state.assets.some(asset => names.has(asset.id) && names.get(asset.id) !== asset.name)) return state
  return { ...state, assets: state.assets.map(asset => ({ ...asset, name: names.get(asset.id) ?? asset.name })) }
}

/**
 * Merge an open draft's state into the base state: records, assets, and story bible and plan versions the base lacks. A record
 * the draft holds carries the draft's stale mark, because the draft is the working branch where "keep anyway" clears it.
 * @param base - the state of the viewed branch.
 * @param draft - the state of an open draft branch, or null.
 * @returns the merged state; `base` itself when there is no draft.
 */
export function overlayDraft(base: WireState, draft: WireState | null): WireState {
  if (draft === null) return base
  const proj = base.components.proj
  const draftProj = draft.components.proj
  const known = new Set(proj.records.map(record => record.id))
  const inDraft = new Set(draftProj.records.map(record => record.id))
  const assets = new Set(base.assets.map(asset => asset.id))
  const bible: StoryBibleState = { ...base.components.bible }
  for (const key of Object.values(BIBLE_SLICES)) {
    const merged = { ...bible[key] }
    for (const [id, versions] of Object.entries(draft.components.bible[key])) {
      if ((merged[id]?.length ?? 0) < versions.length) merged[id] = versions
    }
    bible[key] = merged
  }
  const plans: PlanState['plans'] = { ...base.components.plan.plans }
  for (const [id, versions] of Object.entries(draft.components.plan.plans)) {
    if ((plans[id]?.length ?? 0) < versions.length) plans[id] = versions
  }
  return {
    ...base,
    assets: [...base.assets, ...draft.assets.filter(asset => !assets.has(asset.id))],
    components: {
      ...base.components,
      bible,
      plan: { plans },
      proj: {
        ...proj,
        records: [...proj.records, ...draftProj.records.filter(record => !known.has(record.id))],
        stale: { ...Object.fromEntries(Object.entries(proj.stale).filter(([id]) => !inDraft.has(id))), ...draftProj.stale },
        created_by: { ...draftProj.created_by, ...proj.created_by },
      },
    },
  }
}

/**
 * The canvas graph of a branch state, with a default layout: story bible items and assets in column 0, plans in
 * column 1, takes from column 2 rightwards by first-frame chain depth, retakes in their source take's column.
 * @param state - a branch state, possibly with a draft overlaid by {@link overlayDraft}.
 * @param draftRecords - IDs of records that belong to an open draft.
 * @returns the nodes and edges.
 */
export function buildCanvasGraph(state: WireState, draftRecords: ReadonlySet<string> = new Set()): CanvasGraph {
  const proj = state.components.proj
  const assets = new Map(state.assets.map(asset => [asset.id, asset]))
  const records = new Map(proj.records.map(record => [record.id, record]))
  const isImage = (id: string | undefined): boolean => id !== undefined && assets.get(id)?.mime.startsWith('image/') === true
  const isVideo = (id: string | undefined): boolean => id !== undefined && assets.get(id)?.mime.startsWith('video/') === true
  const flagsOf = (record: ProjectRecord | null): CanvasNodeFlags => ({
    draft: record !== null && draftRecords.has(record.id),
    stale: record !== null && proj.stale[record.id] !== undefined,
    rendering: record !== null && (record.status === 'pending' || record.status === 'running'),
    failed: record?.status === 'failed',
    superseded: record !== null && proj.superseded[record.id] !== undefined,
  })
  const nodes: CanvasNode[] = []
  const byRecord = new Set<string>()
  // A reference image of a character, location or style belongs to that node, so its import is not drawn twice.
  const bibleOfAsset = new Map<string, string>()
  for (const { kind, id: bibleId, versions } of bibleItems(state)) {
    const latest = versions.at(-1)
    if (latest === undefined) continue
    const id = `bible:${bibleId}`
    for (const version of versions) for (const reference of version.references) bibleOfAsset.set(reference, id)
    const record = records.get(latest.created_by) ?? null
    nodes.push({
      id, kind: 'bible', bibleKind: kind, bibleId, title: latest.name || bibleId, subtitle: latest.description,
      thumb: latest.references.find(reference => isImage(reference)) ?? null, video: null, durationSec: null, record,
      flags: flagsOf(record), badges: [], take: null, x: 0, y: 0,
    })
  }
  // One node per plan, showing its latest version; the editor switches between versions.
  for (const [planId, versions] of Object.entries(state.components.plan.plans)) {
    const latest = versions.at(-1)
    if (latest === undefined) continue
    const record = records.get(latest.created_by) ?? null
    nodes.push({
      id: `plan:${planId}`, kind: 'plan', planId, title: latest.title ?? '', subtitle: String(latest.shots.length), thumb: null, video: null,
      durationSec: null, record, flags: flagsOf(record), badges: [], take: null, x: 0, y: 0,
    })
  }
  for (const record of proj.records) {
    if (record.operation === 'asset.import') {
      const imported = record.outputs.find(id => isImage(id) || isVideo(id))
      if (imported === undefined || bibleOfAsset.has(imported)) continue
      nodes.push({
        id: record.id, kind: 'asset', title: assets.get(imported)?.name ?? imported, subtitle: '', thumb: isImage(imported) ? imported : null,
        video: isVideo(imported) ? imported : null, durationSec: assets.get(imported)?.duration_sec ?? null,
        record, flags: flagsOf(record), badges: [], take: null, x: 0, y: 0,
      })
    } else if (isRender(record)) {
      const video = record.outputs.find(id => isVideo(id)) ?? null
      const shot = typeof record.params['shot'] === 'number' ? record.params['shot'] : null
      nodes.push({
        id: record.id, kind: 'take', title: shot === null ? '' : String(shot),
        subtitle: typeof record.params['prompt'] === 'string' ? record.params['prompt'] : '',
        thumb: record.outputs.find(id => isImage(id)) ?? null, video,
        durationSec: video === null ? null : assets.get(video)?.duration_sec ?? null,
        record, flags: flagsOf(record), badges: [], take: null, x: 0, y: 0,
      })
    } else continue
    byRecord.add(record.id)
  }
  const nodeIds = new Set(nodes.map(node => node.id))
  /** The node an asset comes from: its story bible node, or the nearest drawn record up its producer chain. */
  const nodeOfAsset = (assetId: string | null, depth = 0): string | null => {
    if (assetId === null) return null
    const bible = bibleOfAsset.get(assetId)
    if (bible !== undefined) return bible
    const producer = proj.created_by[assetId]
    if (producer === undefined || depth > 16) return null
    if (byRecord.has(producer)) return producer
    const source = records.get(producer)?.inputs.find(input => input.resolved_asset !== null)?.resolved_asset
    return source === undefined || source === null ? null : nodeOfAsset(source, depth + 1)
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
    const record = node.record
    if (record === null || node.kind === 'bible') continue
    for (const input of record.inputs) {
      const bibleId = bibleIdOf(input.ref)
      const from = bibleId !== undefined && nodeIds.has(`bible:${bibleId}`) ? `bible:${bibleId}` : nodeOfAsset(input.resolved_asset)
      addEdge(from, node.id, input.role === 'first_frame' ? 'first_frame' : 'reference')
    }
    // A take an approved plan scheduled hangs off that plan's node; an unchanged shot keeps the take an earlier version rendered.
    if (typeof record.params['plan'] === 'string') addEdge(`plan:${record.params['plan']}`, node.id, 'plan')
    if (record.based_on !== null) addEdge(record.based_on, node.id, 'take')
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
 * Number the takes of each shot, so an original take and its retakes read differently on the canvas. Takes of the
 * same plan shot, and takes linked by a take edge to such a take, are takes of one shot, numbered in record order.
 * @param nodes - the drawn nodes; takes get their `take` set in place.
 * @param edges - the edges; a take edge links a retake to its source take.
 */
function numberTakes(nodes: CanvasNode[], edges: CanvasEdge[]): void {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const baseOf = new Map(edges.filter(edge => edge.kind === 'take').map(edge => [edge.to, edge.from]))
  const groupOf = (node: CanvasNode, depth = 0): string => {
    const base = byId.get(baseOf.get(node.id) ?? '')
    if (base !== undefined && depth < 64) return groupOf(base, depth + 1)
    const plan = node.record?.params['plan']
    return node.title === '' ? node.id : `${typeof plan === 'string' ? plan : ''}#${node.title}`
  }
  const groups = new Map<string, CanvasNode[]>()
  for (const node of nodes) {
    if (node.kind !== 'take') continue
    const key = groupOf(node)
    groups.set(key, [...groups.get(key) ?? [], node])
  }
  for (const members of groups.values()) {
    if (members.length > 1) members.forEach((node, index) => { node.take = index + 1 })
  }
}

/**
 * Mark takes that a timeline trims: a timeline clip with an in or out point.
 * @param state - the branch state.
 * @param nodes - the drawn nodes, badged in place.
 * @param nodeOfAsset - resolves an asset to its node.
 */
function addBadges(state: WireState, nodes: CanvasNode[], nodeOfAsset: (assetId: string | null) => string | null): void {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const badge = (id: string | null, label: string): void => {
    const node = id === null ? undefined : byId.get(id)
    if (node !== undefined && !node.badges.includes(label)) node.badges.push(label)
  }
  for (const timeline of state.components.timeline.timelines) {
    for (const clip of timeline.clips) {
      if (clip.in_sec !== null || clip.out_sec !== null) badge(nodeOfAsset(clip.asset), 'trim')
    }
  }
}

/**
 * Assign default positions in place. Each column kind (assets, plans, takes by first-frame depth) wraps into
 * several sub-columns once it holds more nodes than the shared row count, so a long shot list forms a block that fits
 * the screen. A retake sits right after its source take in the same column.
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
    let value = node.kind === 'plan' ? 1 : node.kind === 'take' ? 2 : 0
    if (node.kind === 'take' && depth < 64) {
      const base = incoming(node.id, 'take')[0]
      const baseNode = base === undefined ? undefined : nodes.find(candidate => candidate.id === base)
      if (baseNode !== undefined) value = columnOf(baseNode, depth + 1)
      else {
        for (const from of incoming(node.id, 'first_frame')) {
          const source = nodes.find(candidate => candidate.id === from)
          if (source?.kind === 'take') value = Math.max(value, columnOf(source, depth + 1) + 1)
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
