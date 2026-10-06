/**
 * The stage 2 bridge reducers: the state of the timelines, the story bible, the shot plan, and shot takes, computed
 * from the records of the operations this package registers. They read records only; they never call an operation or
 * a model. Each reducer receives every record of a branch and interprets only its own operations, matched by
 * `record.operation`. The components of stage 3 replace them.
 *
 * @module @video-harness/tools/reducers
 */
import type { AssetId, ComponentStates, ProjectRecord, RecordInputRef, Reducer } from '@dv/project'
import type { EntityVersion, SequenceItem, SequenceState } from './types.ts'

/** `entity.<kind>.create` and `entity.<kind>.update`. */
const ENTITY_OPERATION = /^entity\.([a-z]+)\.(create|update)$/

/**
 * Classify an operation name as a character, location, or style operation.
 * @param name - an operation name.
 * @returns the action and the kind, or null for any other operation.
 */
export function parseEntityOperation(name: string | null): { action: 'create' | 'update'; kind: string } | null {
  const match = name === null ? null : ENTITY_OPERATION.exec(name)
  if (match === null) return null
  return { action: match[2] as 'create' | 'update', kind: match[1] ?? '' }
}

/** The timeline operations; the `timeline` reducer interprets their params. */
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

/** The ID the first timeline gets when a `sequence.create` names none. */
export const DEFAULT_SEQUENCE_ID = 'v1'

/** Renumber positions 1..n in list order. */
function renumber(list: SequenceItem[]): SequenceItem[] {
  return list.map((item, index) => ({ ...item, slot: index + 1 }))
}

/** Apply one non-create timeline record to one timeline's clips; other operations leave them unchanged. */
function applySequenceEdit(items: SequenceItem[], record: ProjectRecord): SequenceItem[] {
  const params = record.params
  const slot = Number(params['slot'] ?? 0)
  switch (record.operation) {
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
 * Apply one timeline record to the project's timelines. `sequence.create` with a new `sequence` ID adds a timeline,
 * with a known ID replaces that timeline's clips, and without an ID replaces the first timeline's clips (creating `v1`
 * when there is none). `sequence.rename` sets a title and `sequence.delete` removes the timeline its `sequence` param
 * names. `sequence.insert` into a timeline that does not exist creates it. Every other operation edits the timeline
 * its `sequence` param names, else the first timeline.
 * @param sequences - the timelines before the record.
 * @param record - a finished record.
 * @returns the timelines after it.
 */
function applySequenceRecord(sequences: SequenceState[], record: ProjectRecord): SequenceState[] {
  const name = record.operation
  if (name === null || !name.startsWith('sequence.')) return sequences
  const params = record.params
  const named = typeof params['sequence'] === 'string' && params['sequence'] !== '' ? params['sequence'] : null
  if (name === SEQUENCE_TOOLS.create) {
    // A scheduled `sequence.create` names its clips as inputs because the assets do not exist when it is recorded.
    const assets = (params['assets'] as AssetId[] | undefined)
      ?? record.inputs.filter(input => input.role === 'clip').map(input => input.resolved_asset)
        .filter((asset): asset is AssetId => asset !== null)
    const items = renumber(assets.map(assetId => ({ slot: 0, assetId, inSec: null, outSec: null })))
    const id = named ?? sequences[0]?.id ?? DEFAULT_SEQUENCE_ID
    const existing = sequences.find(sequence => sequence.id === id)
    const title = typeof params['title'] === 'string' && params['title'] !== ''
      ? params['title']
      : existing?.title ?? `第 ${String(sequences.length + 1)} 集`
    if (existing === undefined) return [...sequences, { id, title, items }]
    return sequences.map(sequence => sequence.id === id ? { id, title, items } : sequence)
  }
  const target = named ?? sequences[0]?.id
  // Renaming and deleting act on a whole timeline; the other operations edit its clips.
  if (name === SEQUENCE_TOOLS.rename) {
    const title = typeof params['title'] === 'string' ? params['title'] : null
    return title === null ? sequences : sequences.map(sequence => sequence.id === target ? { ...sequence, title } : sequence)
  }
  if (name === SEQUENCE_TOOLS.delete) return named === null ? sequences : sequences.filter(sequence => sequence.id !== named)
  // Inserting into a timeline that does not exist yet creates it, so the clip is not lost.
  if (name === SEQUENCE_TOOLS.insert && !sequences.some(sequence => sequence.id === target)) {
    return [
      ...sequences,
      { id: target ?? DEFAULT_SEQUENCE_ID, title: `第 ${String(sequences.length + 1)} 集`, items: applySequenceEdit([], record) },
    ]
  }
  return sequences.map(sequence => sequence.id === target ? { ...sequence, items: applySequenceEdit(sequence.items, record) } : sequence)
}

/** The `timeline` reducer: the timelines and their clips, from the finished timeline records. */
export const timelineReducer: Reducer<'timeline'> = {
  initial: () => ({ sequence: null, sequences: [] }),
  reduce(slice, record) {
    if (record.status !== 'done' || record.operation === null || !record.operation.startsWith('sequence.')) return slice
    const sequences = applySequenceRecord(slice.sequences, record)
    return { sequence: sequences[0] === undefined ? null : { items: sequences[0].items }, sequences }
  },
}

/** A params field as text, or undefined when it is absent or not a string. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The ID and version a character, location, or style reference names, or null for an asset or record reference. */
function versionRef(ref: RecordInputRef): { id: string; version: number } | null {
  if ('character' in ref) return { id: ref.character, version: ref.version }
  if ('location' in ref) return { id: ref.location, version: ref.version }
  if ('style' in ref) return { id: ref.style, version: ref.version }
  return null
}

/**
 * The `bible` reducer: every version of each character, location, and style, from the finished `entity.<kind>.*`
 * records. Its `createdBy` names the record that wrote a version, so Project's `proj` slice marks a record that read a
 * version stale once the record that wrote that version is superseded (each `entity.<kind>.update` supersedes the
 * record that wrote the version before it).
 */
export const bibleReducer: Reducer<'bible'> = {
  initial: () => ({ entities: {} }),
  reduce(slice, record) {
    const entityOperation = parseEntityOperation(record.operation)
    if (entityOperation === null || record.status !== 'done') return slice
    const id = String(record.params['entity'])
    const versions = slice.entities[id] ?? []
    const previous = versions.at(-1)
    const current: EntityVersion = {
      kind: text(record.params['kind']) ?? entityOperation.kind,
      version: versions.length + 1,
      name: text(record.params['name']) ?? previous?.name ?? id,
      description: text(record.params['description']) ?? previous?.description ?? '',
      refs: (record.params['refs'] as AssetId[] | undefined) ?? previous?.refs ?? [],
      updatedBy: record.id,
    }
    return { entities: { ...slice.entities, [id]: [...versions, current] } }
  },
  assetsOf(slice, ref) {
    const version = versionOf(slice, ref)
    return version === undefined ? null : version.refs
  },
  createdBy(slice, ref) {
    return versionOf(slice, ref)?.updatedBy ?? null
  },
}

/**
 * The version a character, location, or style reference names, when the ID belongs to that kind.
 * @param slice - the `bible` slice.
 * @param ref - a record input reference.
 * @returns the version, or undefined for an unknown version or an asset or record reference.
 */
function versionOf(slice: ComponentStates['bible'], ref: RecordInputRef): EntityVersion | undefined {
  const named = versionRef(ref)
  if (named === null) return undefined
  const version = slice.entities[named.id]?.find(candidate => candidate.version === named.version)
  return version === undefined || !(version.kind in ref) ? undefined : version
}

/** The `plan` reducer: every `plan.create` and `plan.update` record, and the finished `plan.approve` that approved it. */
export const planReducer: Reducer<'plan'> = {
  initial: () => ({ plans: [] }),
  reduce(slice, record) {
    if (record.operation === 'plan.create' || record.operation === 'plan.update') {
      return { plans: [...slice.plans, { op: record.id, approved: false, approvedBy: null }] }
    }
    if (record.operation === 'plan.approve' && record.status === 'done' && typeof record.params['plan'] === 'string') {
      const plan = record.params['plan']
      return { plans: slice.plans.map(summary => summary.op === plan ? { ...summary, approved: true, approvedBy: record.id } : summary) }
    }
    return slice
  },
}

/** The `shot` reducer: the takes of a shot, which are the records that are `based_on` its root record. */
export const shotReducer: Reducer<'shot'> = {
  initial: () => ({ takes: {}, roots: {} }),
  reduce(slice, record) {
    if (record.based_on === null) return slice
    const root = slice.roots[record.based_on] ?? record.based_on
    return {
      takes: { ...slice.takes, [root]: [...slice.takes[root] ?? [root], record.id] },
      roots: { ...slice.roots, [record.id]: root },
    }
  },
}

/** The bridge reducers by component key, in registration order. */
export const bridgeReducers: { [K in 'timeline' | 'bible' | 'plan' | 'shot']: Reducer<K> } = {
  timeline: timelineReducer,
  bible: bibleReducer,
  plan: planReducer,
  shot: shotReducer,
}
