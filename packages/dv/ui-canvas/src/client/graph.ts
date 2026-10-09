/**
 * Canvas nodes and edges derived from a project state. The canvas shows the project's current state only: a
 * node is an item a creator works with now: a character, a location or a style at its current version, an imported asset
 * on the project's canvas list (see {@link buildCanvasGraph}), a plan at its latest version, the current take of each
 * shot of that version, a take that is not part of a plan, and a take whose outputs are in use. Deterministic edits
 * (still grabs, timeline records) do not become nodes; a timeline trim shows as a badge on the take it shortened.
 */
import type {
  Character, Clip, Location, NodePosition, PlanVersion, ProjectRecord, RecordInput, RecordInputRef, StoryBibleState, Style, WireState,
} from '@dv/ui-kit/types.ts'

/** What a node represents; the canvas colors nodes by it. */
export type CanvasNodeKind = 'bible' | 'asset' | 'plan' | 'take'

/** The story bible kinds a `bible` node can stand for. */
export type BibleKind = 'character' | 'location' | 'style'

/** The slice key of each story bible kind. */
const BIBLE_SLICES: Record<BibleKind, keyof StoryBibleState> = { character: 'characters', location: 'locations', style: 'styles' }

/** Display states of a node. */
export interface CanvasNodeFlags {
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
  /** An image asset shown as the thumbnail; null for story bible nodes, which show {@link CanvasNode.references}. */
  thumb: string | null
  /** For story bible nodes, the image references of the current version in order; empty for other nodes. */
  references: string[]
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
  /** The node that shows each asset: its story bible node, its import node, or the nearest drawn record up its producer chain. */
  assetNodes: Record<string, string>
}

/** Width of every node card, in canvas units: a take's 16:9 frame fills it (208 × 117 at 100%). */
export const NODE_WIDTH = 208
/** Default spacing of the automatic layout, in canvas units. */
const COLUMN = 240
/** Row pitch; it leaves room for a take card (147 at 100%) whose text has grown at a low zoom. */
export const ROW = 200

/** A `shot.render_ref2va` or `shot.render_t2va` record, whose outputs are the takes the creator judges. */
function isRender(record: ProjectRecord): boolean {
  return record.operation === 'shot.render_ref2va' || record.operation === 'shot.render_t2va'
}

/**
 * The timeline record that the approval of a plan version wrote: its `clip` inputs name the take of each shot in shot
 * order, and a shot the approval left unchanged names the earlier take it reused.
 * @param version - the plan version.
 * @param records - the records of the state by ID.
 * @returns the record, or undefined when the version is not approved.
 */
function approvalLayout(version: PlanVersion, records: ReadonlyMap<string, ProjectRecord>): ProjectRecord | undefined {
  const scheduled = version.approved_by === null ? undefined : records.get(version.approved_by)?.report?.['scheduled']
  if (!Array.isArray(scheduled)) return undefined
  return scheduled.map(id => typeof id === 'string' ? records.get(id) : undefined)
    .find(record => record?.operation?.startsWith('timeline.') === true)
}

/**
 * The render records the canvas draws, which make up the current state of the project:
 * - for each shot of each plan's latest version, its current take together with the retakes of the same original take.
 *   The current take is the take the shot's clip on the plan's timeline plays (the clip at the shot's position, when it
 *   plays a take of that shot), else the newest done take of that shot and version or the earlier take the version's
 *   approval reused, else the newest take still rendering;
 * - every take that is not part of a plan, with its retakes;
 * - every take whose outputs are in use: played by a timeline clip, named as a reference by a current story bible or plan
 *   version, or read as an input by a drawn take.
 * Takes of shots a later plan version removed, and takes of earlier versions that nothing uses, are left out.
 * @param state - a project state.
 * @returns the record IDs.
 */
function shownTakes(state: WireState): Set<string> {
  const proj = state.components.proj
  const records = new Map(proj.records.map(record => [record.id, record]))
  const renders = proj.records.filter(isRender)
  const rootOf = (id: string): string => {
    let current = id
    for (let depth = 0; depth < 64; depth++) {
      const base = records.get(current)?.based_on
      if (base === null || base === undefined || !records.has(base)) break
      current = base
    }
    return current
  }
  const producerOf = (input: RecordInput): string | undefined =>
    'record' in input.ref ? input.ref.record : input.resolved_asset === null ? undefined : proj.created_by[input.resolved_asset]
  // The render or import behind a record, walking up deterministic edits such as a still grab or a timeline export.
  const sourceOf = (recordId: string | undefined, depth = 0): ProjectRecord | undefined => {
    const record = recordId === undefined ? undefined : records.get(recordId)
    if (record === undefined || depth > 16 || isRender(record) || record.operation === 'asset.import') return record
    const input = record.inputs.find(entry => producerOf(entry) !== undefined)
    return input === undefined ? undefined : sourceOf(producerOf(input), depth + 1)
  }
  const clipRecord = (clip: Clip): string | undefined =>
    clip.source?.record ?? (clip.asset === null ? undefined : proj.created_by[clip.asset])
  const used: string[] = []
  const use = (recordId: string | undefined): void => {
    const source = sourceOf(recordId)
    if (source !== undefined && isRender(source)) used.push(source.id)
  }
  for (const timeline of state.components.timeline.timelines) {
    for (const clip of timeline.clips) use(clipRecord(clip))
  }
  for (const { versions } of bibleItems(state)) for (const reference of versions.at(-1)?.references ?? []) use(proj.created_by[reference])
  const shown = new Set<string>()
  const addFamily = (root: string): void => { for (const render of renders) if (rootOf(render.id) === root) shown.add(render.id) }
  for (const [planId, versions] of Object.entries(state.components.plan.plans)) {
    const latest = versions.at(-1)
    if (latest === undefined) continue
    const references = [...latest.references ?? [], ...latest.shots.flatMap(shot => shot.references ?? [])]
    for (const reference of references) use(proj.created_by[reference])
    const layout = approvalLayout(latest, records)
    const pointed = layout?.inputs.filter(input => input.role === 'clip').map(input => 'record' in input.ref ? input.ref.record : undefined) ?? []
    const timelineId = layout?.params['timeline'] ?? 't1'
    const clips = layout === undefined ? [] : state.components.timeline.timelines.find(timeline => timeline.id === timelineId)?.clips ?? []
    latest.shots.forEach((_shot, index) => {
      const shot = index + 1
      const own = renders.filter(render => render.params['plan'] === planId && render.params['plan_version'] === latest.version
        && render.params['shot'] === shot).map(render => render.id)
      const roots = new Set([...own, pointed[index]].flatMap(id => id === undefined || !records.has(id) ? [] : [rootOf(id)]))
      const candidates = renders.filter(render => roots.has(rootOf(render.id)))
      const clip = clips[index]
      const played = clip === undefined ? undefined : sourceOf(clipRecord(clip))
      const playsShot = played !== undefined && isRender(played)
        && (roots.has(rootOf(played.id)) || (played.params['plan'] === planId && played.params['shot'] === shot))
      const current = playsShot ? played : candidates.findLast(render => render.status === 'done') ?? candidates.at(-1)
      if (current !== undefined) addFamily(rootOf(current.id))
    })
  }
  for (const render of renders) if (typeof records.get(rootOf(render.id))?.params['plan'] !== 'string') shown.add(render.id)
  // Takes in use, and the takes a drawn take read its inputs from.
  const queue = [...shown, ...used]
  const visited = new Set<string>()
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    const record = records.get(id)
    if (visited.has(id) || record === undefined) continue
    visited.add(id)
    shown.add(id)
    for (const input of record.inputs) {
      const source = sourceOf(producerOf(input))
      if (source !== undefined && isRender(source)) queue.push(source.id)
    }
  }
  return shown
}

/**
 * Every character, location and style of a state with its latest version.
 * @param state - a project state.
 * @returns one entry per story bible item, characters first.
 */
export function bibleItems(state: WireState): Array<{ kind: BibleKind; id: string; versions: Character[] | Location[] | Style[] }> {
  const bible = state.components.bible
  return (Object.keys(BIBLE_SLICES) as BibleKind[]).flatMap(kind =>
    Object.entries(bible[BIBLE_SLICES[kind]]).map(([id, versions]) => ({ kind, id, versions })))
}

/**
 * The versions of one character, location or style.
 * @param state - a project state.
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
 * The canvas graph of a project state, with a default layout: story bible items and assets in column 0, plans in
 * column 1, takes from column 2 rightwards by first-frame chain depth, retakes in their source take's column.
 * Every image or video on the project's canvas (`placed`) gets one node, unless a story bible node (a reference image) or
 * a take node (a take output) already shows it: drawn from its first `asset.import` record of the current state when
 * there is one, else as `asset:<id>` with no record (an import that an undo went back past, a still, an export). A take that
 * reads an asset off the canvas has no edge from it.
 * @param state - a project state.
 * @param placed - the assets on the canvas; defaults to the state's `asset` slice.
 * @returns the nodes and edges.
 */
export function buildCanvasGraph(
  state: WireState, placed: ReadonlySet<string> = new Set(state.components.asset.placed),
): CanvasGraph {
  const proj = state.components.proj
  const assets = new Map(state.assets.map(asset => [asset.id, asset]))
  const records = new Map(proj.records.map(record => [record.id, record]))
  const isImage = (id: string | undefined): boolean => id !== undefined && assets.get(id)?.mime.startsWith('image/') === true
  const isVideo = (id: string | undefined): boolean => id !== undefined && assets.get(id)?.mime.startsWith('video/') === true
  const flagsOf = (record: ProjectRecord | null): CanvasNodeFlags => ({
    stale: record !== null && proj.stale[record.id] !== undefined,
    rendering: record !== null && (record.status === 'pending' || record.status === 'running'),
    failed: record?.status === 'failed',
    superseded: record !== null && proj.superseded[record.id] !== undefined,
  })
  const nodes: CanvasNode[] = []
  const byRecord = new Set<string>()
  const takes = shownTakes(state)
  // The import node of each drawn imported asset.
  const importNodes = new Map<string, string>()
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
      thumb: null, references: latest.references.filter(reference => isImage(reference)), video: null, durationSec: null, record,
      flags: flagsOf(record), badges: [], take: null, x: 0, y: 0,
    })
  }
  // One node per plan, showing its latest version; the editor switches between versions.
  for (const [planId, versions] of Object.entries(state.components.plan.plans)) {
    const latest = versions.at(-1)
    if (latest === undefined) continue
    const record = records.get(latest.created_by) ?? null
    nodes.push({
      id: `plan:${planId}`, kind: 'plan', planId, title: latest.title ?? '', subtitle: String(latest.shots.length), thumb: null, references: [], video: null,
      durationSec: null, record, flags: flagsOf(record), badges: [], take: null, x: 0, y: 0,
    })
  }
  for (const record of proj.records) {
    if (record.operation === 'asset.import') {
      // An import off the canvas stays in the asset pool only.
      const imported = record.outputs.find(id => isImage(id) || isVideo(id))
      if (imported === undefined || !placed.has(imported) || bibleOfAsset.has(imported) || importNodes.has(imported)) continue
      importNodes.set(imported, record.id)
      nodes.push({
        id: record.id, kind: 'asset', title: assets.get(imported)?.name ?? imported, subtitle: '', thumb: isImage(imported) ? imported : null, references: [],
        video: isVideo(imported) ? imported : null, durationSec: assets.get(imported)?.duration_sec ?? null,
        record, flags: flagsOf(record), badges: [], take: null, x: 0, y: 0,
      })
    } else if (isRender(record) && takes.has(record.id)) {
      const video = record.outputs.find(id => isVideo(id)) ?? null
      const shot = typeof record.params['shot'] === 'number' ? record.params['shot'] : null
      nodes.push({
        id: record.id, kind: 'take', title: shot === null ? '' : String(shot),
        subtitle: typeof record.params['prompt'] === 'string' ? record.params['prompt'] : '',
        thumb: record.outputs.find(id => isImage(id)) ?? null, references: [], video,
        durationSec: video === null ? null : assets.get(video)?.duration_sec ?? null,
        record, flags: flagsOf(record), badges: [], take: null, x: 0, y: 0,
      })
    } else continue
    byRecord.add(record.id)
  }
  // A placed asset that no node shows yet (an import that an undo went back past, a still, an export, or another take
  // output) gets its own node, `asset:<id>`, with no record.
  const shownByTake = new Set(proj.records.flatMap(record => byRecord.has(record.id) && isRender(record) ? record.outputs : []))
  for (const assetId of placed) {
    const shown = bibleOfAsset.has(assetId) || importNodes.has(assetId) || shownByTake.has(assetId)
    if (!(isImage(assetId) || isVideo(assetId)) || shown) continue
    const id = `asset:${assetId}`
    importNodes.set(assetId, id)
    nodes.push({
      id, kind: 'asset', title: assets.get(assetId)?.name ?? assetId, subtitle: '', thumb: isImage(assetId) ? assetId : null, references: [],
      video: isVideo(assetId) ? assetId : null, durationSec: assets.get(assetId)?.duration_sec ?? null,
      record: null, flags: flagsOf(null), badges: [], take: null, x: 0, y: 0,
    })
  }
  const nodeIds = new Set(nodes.map(node => node.id))
  /** The node an asset comes from: its story bible node, its import node, or the nearest drawn record up its producer chain. */
  const nodeOfAsset = (assetId: string | null, depth = 0): string | null => {
    if (assetId === null) return null
    const own = bibleOfAsset.get(assetId) ?? importNodes.get(assetId)
    if (own !== undefined) return own
    const producer = proj.created_by[assetId]
    if (producer === undefined || depth > 16) return null
    if (byRecord.has(producer)) return producer
    const produced = records.get(producer)
    // A take or an import the canvas leaves out has no node to stand for its assets.
    if (produced !== undefined && (isRender(produced) || produced.operation === 'asset.import')) return null
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
 * @param state - the project state.
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

/** The media a plan node's mini grid shows for one shot. */
export interface PlanShotFrame {
  thumb: string | null
  video: string | null
}

/**
 * The frame of each shot of a plan, for the plan node's mini grid: the newest finished take node of that plan and shot
 * (a retake carries the plan and shot of its source take) that has an image or a video.
 * @param nodes - the drawn nodes, in record order.
 * @param planId - the plan (`p1`).
 * @param shotCount - the number of shots of the plan's latest version.
 * @returns one entry per shot, null for a shot without a drawn finished take.
 */
export function planShotFrames(nodes: readonly CanvasNode[], planId: string, shotCount: number): Array<PlanShotFrame | null> {
  return Array.from({ length: shotCount }, (_unused, index) => {
    const take = nodes.findLast(node => node.kind === 'take' && node.record?.status === 'done' && node.record.params['plan'] === planId
      && node.record.params['shot'] === index + 1 && (node.thumb !== null || node.video !== null))
    return take === undefined ? null : { thumb: take.thumb, video: take.video }
  })
}

/** The least space between two node cards that {@link freePositions} keeps, in canvas units. */
const NODE_GAP = 12

/**
 * Positions for the nodes that have no stored position: each node's automatic position, moved down one row at a time
 * until its card overlaps neither a stored node nor a node placed before it. A node that appears later therefore never
 * covers a node that the user moved.
 * @param nodes - the graph's nodes, in graph order.
 * @param stored - the stored positions by node ID.
 * @param heightOf - a node's card height in canvas units.
 * @returns the positions of the nodes that had none, by node ID.
 */
export function freePositions(
  nodes: readonly CanvasNode[], stored: Readonly<Record<string, NodePosition>>, heightOf: (node: CanvasNode) => number,
): Record<string, NodePosition> {
  const boxes = nodes.flatMap((node) => {
    const at = stored[node.id]
    return at === undefined ? [] : [{ ...at, height: heightOf(node) }]
  })
  const placed: Record<string, NodePosition> = {}
  for (const node of nodes) {
    if (stored[node.id] !== undefined) continue
    const height = heightOf(node)
    let y = node.y
    const overlaps = (box: { x: number; y: number; height: number }): boolean =>
      box.x < node.x + NODE_WIDTH + NODE_GAP && node.x < box.x + NODE_WIDTH + NODE_GAP
      && box.y < y + height + NODE_GAP && y < box.y + box.height + NODE_GAP
    while (boxes.some(overlaps)) y += ROW
    placed[node.id] = { x: node.x, y }
    boxes.push({ x: node.x, y, height })
  }
  return placed
}
