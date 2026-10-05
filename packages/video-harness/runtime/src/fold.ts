/**
 * Fold a chain of operation records into the state a view shows. The fold reads records only; it never calls a tool
 * or a model, so rebuilding any historical state is cheap and deterministic.
 *
 * @module @video-harness/runtime/fold
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId, EntityId, InputRef, Op, OpId, OpInput, ProjectId, TurnId } from '@video-harness/oplog'
import type { EntityVersion, PlanSummary, ProjectState, SequenceItem, SequenceState, TurnSummary } from './types.ts'

/** Tool names whose records change entities or the sequence; the fold interprets their params. */
export const ENTITY_CREATE_TOOL = 'entity.create'
export const ENTITY_UPDATE_TOOL = 'entity.update'
/** `entity.create`, `entity.update`, and the kind-specific forms `entity.<kind>.create` / `entity.<kind>.update`. */
const ENTITY_TOOL = /^entity\.(?:([a-z]+)\.)?(create|update)$/

/**
 * Classify a tool name as an entity operation.
 * @param name - a tool name.
 * @returns the action and the kind the name carries, or null for any other tool.
 */
export function parseEntityTool(name: string | undefined): { action: 'create' | 'update'; kind: string | null } | null {
  const match = name === undefined ? null : ENTITY_TOOL.exec(name)
  if (match === null) return null
  return { action: match[2] as 'create' | 'update', kind: match[1] ?? null }
}
export const SEQUENCE_TOOLS = {
  create: 'sequence.create',
  replace: 'sequence.replace',
  move: 'sequence.move',
  setRange: 'sequence.set_range',
  insert: 'sequence.insert',
  remove: 'sequence.remove',
  split: 'sequence.split',
  rename: 'sequence.rename',
  delete: 'sequence.delete',
} as const

/** The ID the first video gets when a `sequence.create` names none. */
export const DEFAULT_SEQUENCE_ID = 'v1'

/**
 * Split an entity reference into its parts.
 * @param ref - an input reference.
 * @returns the entity and version, or null when the reference is an asset ID.
 */
export function parseEntityRef(ref: InputRef): { entity: EntityId; version: number } | null {
  const at = ref.lastIndexOf('@')
  if (at <= 0) return null
  const version = Number(ref.slice(at + 1))
  if (!Number.isInteger(version)) return null
  return { entity: brandString<EntityId>(ref.slice(0, at)), version }
}

/**
 * Split an output reference into its parts.
 * @param ref - an input reference.
 * @returns the producing record and the output index, or null when the reference is an asset or an entity.
 */
export function parseOutputRef(ref: InputRef): { op: OpId; index: number } | null {
  const hash = ref.lastIndexOf('#')
  if (hash <= 0) return null
  const index = Number(ref.slice(hash + 1))
  if (!Number.isInteger(index) || index < 0) return null
  return { op: brandString<OpId>(ref.slice(0, hash)), index }
}

/**
 * The asset an input stands for in the fold: the resolved asset when execution recorded one, else the reference itself
 * when it is a plain asset ID.
 * @param input - a record input.
 * @returns the asset, or null for an unresolved entity or output reference.
 */
export function inputAsset(input: OpInput): AssetId | null {
  if (input.resolved !== null) return input.resolved
  if (parseEntityRef(input.ref) !== null || parseOutputRef(input.ref) !== null) return null
  return input.ref as AssetId
}

/** Renumber slots 1..n in list order. */
function renumber(list: SequenceItem[]): SequenceItem[] {
  return list.map((item, index) => ({ ...item, slot: index + 1 }))
}

/** Apply one non-create `sequence.*` record to one video's item list; unknown tools leave it unchanged. */
function applySequenceEdit(items: SequenceItem[], op: Op): SequenceItem[] {
  const params = op.params
  const slot = Number(params['slot'] ?? 0)
  switch (op.tool?.name) {
    case SEQUENCE_TOOLS.replace:
      return items.map(item => item.slot === slot ? { ...item, assetId: params['asset'] as AssetId, inSec: null, outSec: null } : item)
    case SEQUENCE_TOOLS.move: {
      const from = Number(params['from'])
      const to = Number(params['to'])
      const moved = [...items]
      const [item] = moved.splice(from - 1, 1)
      if (item !== undefined) moved.splice(to - 1, 0, item)
      return renumber(moved)
    }
    case SEQUENCE_TOOLS.setRange:
      return items.map(item => item.slot === slot
        ? { ...item, inSec: (params['inSec'] as number | null) ?? null, outSec: (params['outSec'] as number | null) ?? null }
        : item)
    case SEQUENCE_TOOLS.insert: {
      const inserted = [...items]
      inserted.splice(Number(params['at']) - 1, 0, { slot: 0, assetId: params['asset'] as AssetId, inSec: null, outSec: null })
      return renumber(inserted)
    }
    case SEQUENCE_TOOLS.remove:
      return renumber(items.filter(item => item.slot !== slot))
    case SEQUENCE_TOOLS.split: {
      // `atSec` is a time inside the clip's asset, so the split needs no asset duration: the first part ends there and
      // the second part starts there, both pointing at the same asset.
      const atSec = Number(params['atSec'])
      const index = items.findIndex(item => item.slot === slot)
      const item = items[index]
      if (item === undefined || !Number.isFinite(atSec)) return items
      const split = [...items]
      split.splice(index, 1, { ...item, outSec: atSec }, { ...item, inSec: atSec })
      return renumber(split)
    }
    default:
      return items
  }
}

/**
 * Apply one `sequence.*` record to the project's videos. `sequence.create` with a new `sequence` ID adds a video, with
 * a known ID replaces that video's clips, and without an ID replaces the first video's clips (creating `v1` when there
 * is none). `sequence.rename` sets a video's title and `sequence.delete` removes the video its `sequence` param names.
 * `sequence.insert` into a video that does not exist creates it. Every other tool edits the video its `sequence` param
 * names, else the first video.
 * @param sequences - the videos before the record.
 * @param op - a finished record.
 * @returns the videos after it.
 */
function applySequenceOp(sequences: SequenceState[], op: Op): SequenceState[] {
  const name = op.tool?.name
  if (name === undefined || !name.startsWith('sequence.')) return sequences
  const params = op.params
  const named = typeof params['sequence'] === 'string' && params['sequence'] !== '' ? params['sequence'] : null
  if (name === SEQUENCE_TOOLS.create) {
    // A scheduled `sequence.create` names its clips as inputs because the assets do not exist when it is recorded.
    const assets = (params['assets'] as AssetId[] | undefined)
      ?? op.inputs.filter(input => input.role === 'clip').map(inputAsset).filter((asset): asset is AssetId => asset !== null)
    const items = renumber(assets.map(assetId => ({ slot: 0, assetId, inSec: null, outSec: null })))
    const id = named ?? sequences[0]?.id ?? DEFAULT_SEQUENCE_ID
    const existing = sequences.find(sequence => sequence.id === id)
    const title = typeof params['title'] === 'string' && params['title'] !== '' ? params['title'] : existing?.title ?? `第 ${String(sequences.length + 1)} 集`
    if (existing === undefined) return [...sequences, { id, title, items }]
    return sequences.map(sequence => sequence.id === id ? { id, title, items } : sequence)
  }
  const target = named ?? sequences[0]?.id
  // Renaming and deleting act on a whole video; the other tools edit its clips.
  if (name === SEQUENCE_TOOLS.rename) {
    const title = typeof params['title'] === 'string' ? params['title'] : null
    return title === null ? sequences : sequences.map(sequence => sequence.id === target ? { ...sequence, title } : sequence)
  }
  if (name === SEQUENCE_TOOLS.delete) return named === null ? sequences : sequences.filter(sequence => sequence.id !== named)
  // Inserting into a video that does not exist yet (a project without episodes) creates it, so the clip is not lost.
  if (name === SEQUENCE_TOOLS.insert && !sequences.some(sequence => sequence.id === target)) {
    return [...sequences, { id: target ?? DEFAULT_SEQUENCE_ID, title: `第 ${String(sequences.length + 1)} 集`, items: applySequenceEdit([], op) }]
  }
  return sequences.map(sequence => sequence.id === target ? { ...sequence, items: applySequenceEdit(sequence.items, op) } : sequence)
}

/** A params field as text, or undefined when it is absent or not a string. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Apply one `entity.*` record: `create` opens version 1, `update` appends the next version. */
function applyEntityOp(entities: Record<EntityId, EntityVersion[]>, op: Op): void {
  const entityTool = parseEntityTool(op.tool?.name)
  if (entityTool === null || op.status !== 'done') return
  const entity = brandString<EntityId>(String(op.params['entity']))
  const versions = entities[entity] ?? []
  const previous = versions.at(-1)
  const refs = (op.params['refs'] as AssetId[] | undefined) ?? previous?.refs ?? []
  versions.push({
    kind: text(op.params['kind']) ?? entityTool.kind ?? previous?.kind ?? 'character',
    version: versions.length + 1,
    name: text(op.params['name']) ?? previous?.name ?? entity,
    description: text(op.params['description']) ?? previous?.description ?? '',
    refs,
    updatedBy: op.id,
  })
  entities[entity] = versions
}

/**
 * Walk the `base_op` chain of a record to the record it ultimately derives from.
 * @param op - a record.
 * @param byId - every record of the chain.
 * @returns the root record ID.
 */
function takeRoot(op: Op, byId: Map<OpId, Op>): OpId {
  let current = op
  const seen = new Set<OpId>()
  while (current.base_op !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    const base = byId.get(current.base_op)
    if (base === undefined) break
    current = base
  }
  return current.id
}

/**
 * Fold records into state. Records are visited in chain order, so a record's inputs always refer to records already
 * folded, and one pass settles staleness.
 * @param projectId - the project.
 * @param chain - the records from the project's first record to the head.
 * @param mainChain - the records on `main`, used to decide which turns are accepted; null when folding `main` itself.
 * @returns the state at the head.
 */
export function foldChain(projectId: ProjectId, chain: Op[], mainChain: Set<OpId> | null): ProjectState {
  const byId = new Map(chain.map(op => [op.id, op]))
  const head = chain.at(-1)
  if (head === undefined) throw new Error('Cannot fold an empty chain.')
  const assets = new Set<AssetId>()
  const producers: Record<AssetId, OpId> = {}
  const entities: Record<EntityId, EntityVersion[]> = {}
  const stale: Record<OpId, { because: OpId }> = {}
  const superseded: Record<OpId, OpId> = {}
  const turns: Record<TurnId, TurnSummary> = {}
  const takes: Record<OpId, OpId[]> = {}
  const plans: PlanSummary[] = []
  const approvals = new Map<OpId, OpId>()
  const acceptedStale = new Set<OpId>()
  let sequences: SequenceState[] = []

  for (const op of chain) {
    for (const asset of op.outputs) {
      assets.add(asset)
      producers[asset] = op.id
    }
    for (const earlier of op.supersedes ?? []) superseded[earlier] = op.id
    applyEntityOp(entities, op)
    if (op.status === 'done') sequences = applySequenceOp(sequences, op)
    if (op.kind === 'plan') plans.push({ op: op.id, approved: false, approvedBy: null })
    if (op.kind === 'approve' && typeof op.params['plan'] === 'string') approvals.set(brandString<OpId>(op.params['plan']), op.id)
    if (op.kind === 'accept_stale' && typeof op.params['op'] === 'string') acceptedStale.add(brandString<OpId>(op.params['op']))
    if (op.base_op !== undefined) {
      const root = takeRoot(op, byId)
      takes[root] = [...takes[root] ?? [root], op.id]
    }
    const summary = turns[op.turn] ?? {
      ops: [], actor: op.actor, surface: op.surface, intent: op.intent, rejected: false,
      accepted: mainChain === null || mainChain.has(op.id),
    }
    summary.ops.push(op.id)
    if (op.kind === 'reject') summary.rejected = true
    if (op.kind === 'intent' && summary.intent === '') summary.intent = op.intent
    turns[op.turn] = summary
  }

  // Staleness: a record is stale when an input's producer was superseded by a later record, when an input's producer
  // is itself stale, or when an entity input is older than the entity's current version. Consumers of an accepted
  // record are not stale through it.
  for (const op of chain) {
    if (op.kind !== 'tool' && op.kind !== 'command' && op.kind !== 'plan') continue
    // An `accept_stale` record is the user's decision that the result still stands; the mark is not recomputed.
    if (acceptedStale.has(op.id)) continue
    for (const input of op.inputs) {
      const entityRef = parseEntityRef(input.ref)
      if (entityRef !== null) {
        const current = entities[entityRef.entity]?.at(-1)
        if (current !== undefined && current.version > entityRef.version && !(op.id in stale)) {
          stale[op.id] = { because: current.updatedBy }
        }
        continue
      }
      const asset = inputAsset(input)
      const producer = asset === null ? undefined : producers[asset]
      if (producer === undefined || producer === op.id) continue
      const because = superseded[producer] ?? stale[producer]?.because
      if (because !== undefined && !(op.id in stale)) stale[op.id] = { because }
    }
  }
  for (const plan of plans) {
    const approvedBy = approvals.get(plan.op)
    if (approvedBy !== undefined) {
      plan.approved = true
      plan.approvedBy = approvedBy
    }
  }
  return {
    projectId, head: head.id, ops: chain, assets, producers, entities,
    sequence: sequences[0] === undefined ? null : { items: sequences[0].items }, sequences, stale, superseded, turns, takes, plans,
  }
}
