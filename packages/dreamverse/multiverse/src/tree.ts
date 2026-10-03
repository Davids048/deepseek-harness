/**
 * `dreamverseMultiverseTree`: the multiverse data structure. Each multiverse is a project of kind `multiverse` in
 * `dreamverseProjectStore`: the multiverse ID is the project ID, the tree is the project's workload data, and each
 * node's video and last frame are files that the project owns in the file store. A node is proposed when a branch is
 * suggested and becomes generated once its video exists. The tree stores and changes nodes and saves them with the
 * project's lease; generating video and proposing branches belong to `dreamverseMultiverseDirector`.
 *
 * At start the tree loads every stored multiverse. A node that was generating when the harness stopped becomes
 * failed, and a generated node whose branch proposal was cut off gets an error, so the page offers a retry for both.
 *
 * @module @dreamverse/multiverse/tree
 */
import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { AssetId } from '@dreamverse/assets-manager'
import type DreamverseProjectStore from '@dreamverse/project-store'
import type { ProjectId, ProjectLease, ProjectRecord, WorkloadData } from '@dreamverse/project-store'
import type { CreationConfig } from '@dreamverse/segment-generation'
import { MultiverseNotFoundError } from './errors.ts'

export * from './errors.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The multiverse trees and their nodes. */
    dreamverseMultiverseTree: MultiverseTree
  }
}

/** The project kind of a multiverse. */
export const MULTIVERSE_KIND = 'multiverse'

/** The format version of a multiverse project's workload data. */
export const MULTIVERSE_WORKLOAD_SCHEMA_VERSION = 1

/** The error of a node whose generation or branch proposal stopped because the harness stopped. */
export const INTERRUPTED_ERROR = 'Interrupted by a restart.'

/** The longest project title; a multiverse's title is its opening prompt. */
const TITLE_MAX_LENGTH = 60

/**
 * A node's life cycle: `proposed` (a suggested branch without video), `generating`, then `completed` or `failed`.
 * A failed node can be generated again.
 */
export type MultiverseNodeStatus = 'proposed' | 'generating' | 'completed' | 'failed'

const NODE_STATUSES: readonly MultiverseNodeStatus[] = ['proposed', 'generating', 'completed', 'failed']

/**
 * The ID of one node of a multiverse tree, unique within its multiverse. The multiverse page's `NodeId` in
 * `@dreamverse/ui-multiverse` (`src/client/api.ts`) uses the same brand label.
 */
export type NodeId = Branded<'MultiverseNodeId'>

/** One node of a multiverse tree: one video segment and the branch that leads to it. */
export interface MultiverseNode {
  readonly nodeId: NodeId
  /** The node this one continues; null for the root. */
  readonly parentId: NodeId | null
  /** Zero for the root. */
  readonly depth: number
  /** Short name shown on the tree, such as `Follow the blue signal`. */
  readonly label: string
  /** What happens in this node: the user's prompt for the root, the proposed direction for a branch. */
  readonly direction: string
  status: MultiverseNodeStatus
  /** The complete prompt sent to the video model; null until generation writes it. */
  prompt: string | null
  /** Why the last generation or branch proposal failed; null otherwise. */
  error: string | null
  /** The project's file of the generated fMP4 video; null until generated. */
  videoAssetId: AssetId | null
  /** The project's file of the video's last frame, which children continue from; null until generated. */
  lastFrameAssetId: AssetId | null
}

/** One multiverse: its creation settings, the character references every node uses, and its nodes. */
export interface Multiverse {
  /** The ID of the multiverse's project. */
  readonly multiverseId: ProjectId
  /** Milliseconds since the epoch. */
  readonly createdAt: number
  readonly creationConfig: CreationConfig
  /** The project's copies of the character reference images, in selection order. */
  referenceAssetIds: readonly AssetId[]
  /** Whether prompts go through prompt enhancement before generation. */
  readonly enhancementEnabled: boolean
  readonly rootId: NodeId
  /** Every node by ID, in creation order. */
  readonly nodes: Map<NodeId, MultiverseNode>
}

/** The inputs of a new multiverse; its root node starts as `proposed` and its references start empty. */
export interface MultiverseInit {
  creationConfig: CreationConfig
  enhancementEnabled: boolean
  rootLabel: string
  rootDirection: string
}

/** A proposed branch: its tree label and its direction. */
export interface BranchDraft {
  label: string
  direction: string
}

/** Called with the multiverse ID after any of its nodes changes. */
export type MultiverseChangeListener = (multiverseId: ProjectId) => void

/** Holds every multiverse and applies node changes; listeners hear about each change after it is applied. */
export class MultiverseTree extends Service {
  static inject = ['dreamverseProjectStore']

  private readonly multiverses = new Map<ProjectId, Multiverse>()
  /** The thumbnail each multiverse's project shows, so a save writes it only when it changes. */
  private readonly thumbnails = new Map<ProjectId, AssetId | null>()
  private readonly listeners = new Set<MultiverseChangeListener>()

  /** @param ctx - owning plugin context. */
  constructor(ctx: Context) {
    super(ctx, 'dreamverseMultiverseTree')
  }

  private get store(): DreamverseProjectStore {
    return this.ctx.dreamverseProjectStore
  }

  /**
   * Load every stored multiverse, and save the ones whose interrupted nodes the load marked. A project whose workload
   * data is not a multiverse tree is skipped with a warning.
   */
  protected async [Service.init](): Promise<void> {
    const logger = this.ctx.logger('multiverse')
    for (const record of this.store.list({ kind: MULTIVERSE_KIND })) {
      let multiverse: Multiverse
      try {
        multiverse = parseMultiverse(record)
      } catch (error) {
        logger.warn(`Skipping multiverse ${record.projectId}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      this.multiverses.set(multiverse.multiverseId, multiverse)
      this.thumbnails.set(multiverse.multiverseId, record.thumbnailAssetId)
      if (!markInterrupted(multiverse)) continue
      const lease = await this.store.acquire(multiverse.multiverseId, { revoke: () => Promise.resolve() })
      try {
        this.save(lease, multiverse.multiverseId)
      } finally {
        this.store.release(lease)
      }
    }
  }

  /**
   * Create a multiverse project with one root node.
   * @param init - the creation settings, enhancement choice, and the root's label and direction.
   * @returns the new multiverse.
   */
  create(init: MultiverseInit): Multiverse {
    const rootId = brandString<NodeId>(randomUUID())
    const root = newNode(rootId, null, 0, { label: init.rootLabel, direction: init.rootDirection })
    const draft = {
      creationConfig: init.creationConfig, referenceAssetIds: [], enhancementEnabled: init.enhancementEnabled, rootId,
      nodes: new Map([[rootId, root]]),
    }
    const title = init.rootDirection.trim().slice(0, TITLE_MAX_LENGTH)
    const record = this.store.create({ kind: MULTIVERSE_KIND, title, workload: workloadData(draft) })
    const multiverse: Multiverse = { ...draft, multiverseId: record.projectId, createdAt: Date.parse(record.createdAt) }
    this.multiverses.set(multiverse.multiverseId, multiverse)
    this.thumbnails.set(multiverse.multiverseId, null)
    this.changed(multiverse.multiverseId)
    return multiverse
  }

  /**
   * Look up one multiverse. A multiverse whose project was deleted through the project store leaves the tree here.
   * @param multiverseId - the multiverse.
   * @returns the multiverse.
   * @throws {MultiverseNotFoundError} for an unknown or deleted multiverse.
   */
  get(multiverseId: ProjectId): Multiverse {
    const multiverse = this.multiverses.get(multiverseId)
    if (multiverse !== undefined && this.store.get(multiverseId) === undefined) this.drop(multiverseId)
    else if (multiverse !== undefined) return multiverse
    throw new MultiverseNotFoundError(`Unknown multiverse: ${multiverseId}`)
  }

  /**
   * List every multiverse that the project store still holds.
   * @returns the multiverses, oldest first.
   */
  list(): Multiverse[] {
    const stored = new Set(this.store.list({ kind: MULTIVERSE_KIND }).map(record => record.projectId))
    for (const multiverseId of [...this.multiverses.keys()]) {
      if (!stored.has(multiverseId)) this.drop(multiverseId)
    }
    return [...this.multiverses.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Forget a multiverse whose project is gone.
   * @param multiverseId - the multiverse.
   */
  drop(multiverseId: ProjectId): void {
    this.multiverses.delete(multiverseId)
    this.thumbnails.delete(multiverseId)
  }

  /**
   * Look up one node.
   * @param multiverseId - the multiverse.
   * @param nodeId - the node.
   * @returns the node.
   * @throws {MultiverseNotFoundError} for an unknown multiverse or node.
   */
  node(multiverseId: ProjectId, nodeId: NodeId): MultiverseNode {
    const node = this.get(multiverseId).nodes.get(nodeId)
    if (node === undefined) throw new MultiverseNotFoundError(`Unknown node ${nodeId} in multiverse ${multiverseId}`)
    return node
  }

  /**
   * Follow a node's parents up to the root.
   * @param multiverseId - the multiverse.
   * @param nodeId - the node.
   * @returns the nodes from the root to this node, root first.
   */
  pathToRoot(multiverseId: ProjectId, nodeId: NodeId): MultiverseNode[] {
    const { nodes } = this.get(multiverseId)
    const path: MultiverseNode[] = []
    for (let node = nodes.get(nodeId); node !== undefined; node = node.parentId === null ? undefined : nodes.get(node.parentId)) {
      path.unshift(node)
    }
    if (path.length === 0) throw new MultiverseNotFoundError(`Unknown node ${nodeId} in multiverse ${multiverseId}`)
    return path
  }

  /**
   * List the branches under a node.
   * @param multiverseId - the multiverse.
   * @param nodeId - the parent node.
   * @returns the node's children in creation order.
   */
  children(multiverseId: ProjectId, nodeId: NodeId): MultiverseNode[] {
    const { nodes } = this.get(multiverseId)
    if (!nodes.has(nodeId)) throw new MultiverseNotFoundError(`Unknown node ${nodeId} in multiverse ${multiverseId}`)
    return [...nodes.values()].filter(node => node.parentId === nodeId)
  }

  /**
   * Set the project's copies of the character reference images.
   * @param multiverseId - the multiverse.
   * @param assetIds - the copies in selection order.
   */
  setReferences(multiverseId: ProjectId, assetIds: readonly AssetId[]): void {
    this.get(multiverseId).referenceAssetIds = [...assetIds]
    this.changed(multiverseId)
  }

  /**
   * Add a proposed branch under a node.
   * @param multiverseId - the multiverse.
   * @param parentId - the node the branch continues.
   * @param draft - the branch's label and direction.
   * @returns the new `proposed` node.
   */
  addProposal(multiverseId: ProjectId, parentId: NodeId, draft: BranchDraft): MultiverseNode {
    const parent = this.node(multiverseId, parentId)
    const node = newNode(brandString<NodeId>(randomUUID()), parentId, parent.depth + 1, draft)
    this.get(multiverseId).nodes.set(node.nodeId, node)
    this.changed(multiverseId)
    return node
  }

  /**
   * Start generating a `proposed` or `failed` node.
   * @param multiverseId - the multiverse.
   * @param nodeId - the node.
   * @throws Error when the node is generating or already generated.
   */
  markGenerating(multiverseId: ProjectId, nodeId: NodeId): void {
    const node = this.node(multiverseId, nodeId)
    if (node.status !== 'proposed' && node.status !== 'failed') {
      throw new Error(`Node ${nodeId} cannot start generating from status ${node.status}`)
    }
    node.status = 'generating'
    node.prompt = null
    node.error = null
    this.changed(multiverseId)
  }

  /**
   * Record the complete prompt of a generating node.
   * @param multiverseId - the multiverse.
   * @param nodeId - the node.
   * @param prompt - the prompt sent to the video model.
   */
  setPrompt(multiverseId: ProjectId, nodeId: NodeId, prompt: string): void {
    this.node(multiverseId, nodeId).prompt = prompt
    this.changed(multiverseId)
  }

  /**
   * Finish a generating node with its files.
   * @param multiverseId - the multiverse.
   * @param nodeId - the node.
   * @param videoAssetId - the project's file of the video.
   * @param lastFrameAssetId - the project's file of the video's last frame.
   */
  markCompleted(multiverseId: ProjectId, nodeId: NodeId, videoAssetId: AssetId, lastFrameAssetId: AssetId): void {
    const node = this.node(multiverseId, nodeId)
    node.status = 'completed'
    node.videoAssetId = videoAssetId
    node.lastFrameAssetId = lastFrameAssetId
    node.error = null
    this.changed(multiverseId)
  }

  /**
   * Fail a generating node; it can be generated again.
   * @param multiverseId - the multiverse.
   * @param nodeId - the node.
   * @param error - the failure message.
   */
  markFailed(multiverseId: ProjectId, nodeId: NodeId, error: string): void {
    const node = this.node(multiverseId, nodeId)
    node.status = 'failed'
    node.error = error
    this.changed(multiverseId)
  }

  /**
   * Record a failed branch proposal on a completed node, or clear it with null.
   * @param multiverseId - the multiverse.
   * @param nodeId - the completed node.
   * @param error - the failure message, or null.
   */
  setError(multiverseId: ProjectId, nodeId: NodeId, error: string | null): void {
    this.node(multiverseId, nodeId).error = error
    this.changed(multiverseId)
  }

  /**
   * Write a multiverse to its project: the tree as workload data, and the root's last frame as the thumbnail once the
   * root is generated.
   * @param lease - the project's current lease.
   * @param multiverseId - the multiverse.
   * @throws {StaleLeaseError} from the project store when the lease is not current.
   */
  save(lease: ProjectLease, multiverseId: ProjectId): void {
    const multiverse = this.get(multiverseId)
    this.store.updateWorkload(lease, workloadData(multiverse))
    const thumbnail = multiverse.nodes.get(multiverse.rootId)?.lastFrameAssetId ?? null
    if (thumbnail !== null && this.thumbnails.get(multiverseId) !== thumbnail) {
      this.store.setThumbnail(lease, thumbnail)
      this.thumbnails.set(multiverseId, thumbnail)
    }
  }

  /**
   * Hear about every change. Register inside `ctx.effect()` so unloading the listener's plugin removes it.
   * @param listener - called with the changed multiverse's ID.
   * @returns the disposer that removes the listener.
   */
  onChange(listener: MultiverseChangeListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Notify listeners after a change has been applied. */
  private changed(multiverseId: ProjectId): void {
    for (const listener of this.listeners) listener(multiverseId)
  }
}

/** Build a `proposed` node without video. */
function newNode(nodeId: NodeId, parentId: NodeId | null, depth: number, draft: BranchDraft): MultiverseNode {
  return {
    nodeId, parentId, depth, label: draft.label, direction: draft.direction,
    status: 'proposed', prompt: null, error: null, videoAssetId: null, lastFrameAssetId: null,
  }
}

/**
 * Mark the nodes that a stopped harness interrupted: a generating node fails, and a generated node without branches
 * or error gets an error so its branches can be proposed again.
 * @param multiverse - the loaded multiverse.
 * @returns whether any node changed.
 */
function markInterrupted(multiverse: Multiverse): boolean {
  let changed = false
  const parents = new Set([...multiverse.nodes.values()].map(node => node.parentId))
  for (const node of multiverse.nodes.values()) {
    if (node.status === 'generating') {
      node.status = 'failed'
      node.error = INTERRUPTED_ERROR
      changed = true
    } else if (node.status === 'completed' && node.error === null && !parents.has(node.nodeId)) {
      node.error = INTERRUPTED_ERROR
      changed = true
    }
  }
  return changed
}

/** The fields of a multiverse that its workload data holds. */
type StoredMultiverse = Pick<Multiverse, 'creationConfig' | 'referenceAssetIds' | 'enhancementEnabled' | 'rootId' | 'nodes'>

/**
 * Serialize a multiverse as its project's workload data.
 * @param multiverse - the multiverse.
 * @returns the workload data with its format version.
 */
function workloadData(multiverse: StoredMultiverse): WorkloadData {
  return {
    schemaVersion: MULTIVERSE_WORKLOAD_SCHEMA_VERSION,
    data: {
      creation_config: { ...multiverse.creationConfig },
      enhancement_enabled: multiverse.enhancementEnabled,
      reference_asset_ids: [...multiverse.referenceAssetIds],
      root_id: multiverse.rootId,
      nodes: [...multiverse.nodes.values()].map(node => ({
        node_id: node.nodeId,
        parent_id: node.parentId,
        depth: node.depth,
        label: node.label,
        direction: node.direction,
        status: node.status,
        prompt: node.prompt,
        error: node.error,
        video_asset_id: node.videoAssetId,
        last_frame_asset_id: node.lastFrameAssetId,
      })),
    },
  }
}

/** Whether a JSON value is an object whose fields can be read by name. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a required string field. */
function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name]
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

/** Read a string-or-null field. */
function nullableStringField(record: Record<string, unknown>, name: string): string | null {
  const value = record[name]
  if (value !== null && typeof value !== 'string') throw new Error(`${name} must be a string or null`)
  return value
}

/** Brand a stored ID that may be null. */
function storedIdOrNull<T extends Branded<string>>(value: string | T | null): T | null {
  return value === null ? null : brandString<T>(value)
}

/** Read a required number field. */
function numberField(record: Record<string, unknown>, name: string): number {
  const value = record[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return value
}

/** Read the stored creation settings. */
function parseCreationConfig(value: unknown): CreationConfig {
  if (!isRecord(value)) throw new Error('creation_config must be an object')
  return {
    model_id: stringField(value, 'model_id'),
    generation_mode: stringField(value, 'generation_mode'),
    aspect_ratio: stringField(value, 'aspect_ratio'),
    resolution: stringField(value, 'resolution'),
    segment_count: numberField(value, 'segment_count'),
    segment_duration_sec: numberField(value, 'segment_duration_sec'),
    frame_width: numberField(value, 'frame_width'),
    frame_height: numberField(value, 'frame_height'),
    num_frames: numberField(value, 'num_frames'),
  }
}

/** Read one stored node. */
function parseNode(value: unknown): MultiverseNode {
  if (!isRecord(value)) throw new Error('a node must be an object')
  const status = value['status']
  const known = NODE_STATUSES.find(candidate => candidate === status)
  if (known === undefined) throw new Error(`node status ${JSON.stringify(status)} is unknown`)
  return {
    nodeId: brandString<NodeId>(stringField(value, 'node_id')),
    parentId: storedIdOrNull<NodeId>(nullableStringField(value, 'parent_id')),
    depth: numberField(value, 'depth'),
    label: stringField(value, 'label'),
    direction: stringField(value, 'direction'),
    status: known,
    prompt: nullableStringField(value, 'prompt'),
    error: nullableStringField(value, 'error'),
    videoAssetId: storedIdOrNull<AssetId>(nullableStringField(value, 'video_asset_id')),
    lastFrameAssetId: storedIdOrNull<AssetId>(nullableStringField(value, 'last_frame_asset_id')),
  }
}

/**
 * Read a multiverse from its project record.
 * @param record - a stored project of kind `multiverse`.
 * @returns the multiverse.
 * @throws Error when the workload data is not a multiverse tree of this format version.
 */
function parseMultiverse(record: ProjectRecord): Multiverse {
  if (record.workload.schemaVersion !== MULTIVERSE_WORKLOAD_SCHEMA_VERSION) {
    throw new Error(`workload schema version ${record.workload.schemaVersion} is not ${MULTIVERSE_WORKLOAD_SCHEMA_VERSION}`)
  }
  const data = record.workload.data
  if (!isRecord(data)) throw new Error('workload data must be an object')
  const references = data['reference_asset_ids']
  if (!Array.isArray(references) || !references.every((id: unknown): id is string => typeof id === 'string')) {
    throw new Error('reference_asset_ids must be a list of strings')
  }
  const enhancementEnabled = data['enhancement_enabled']
  if (typeof enhancementEnabled !== 'boolean') throw new Error('enhancement_enabled must be a boolean')
  const nodeList = data['nodes']
  if (!Array.isArray(nodeList)) throw new Error('nodes must be a list')
  const nodes = new Map(nodeList.map((value: unknown) => {
    const node = parseNode(value)
    return [node.nodeId, node] as const
  }))
  const rootId = brandString<NodeId>(stringField(data, 'root_id'))
  if (!nodes.has(rootId)) throw new Error(`root node ${rootId} is missing`)
  return {
    multiverseId: record.projectId,
    createdAt: Date.parse(record.createdAt),
    creationConfig: parseCreationConfig(data['creation_config']),
    referenceAssetIds: references.map(assetId => brandString<AssetId>(assetId)),
    enhancementEnabled,
    rootId,
    nodes,
  }
}

export default MultiverseTree
