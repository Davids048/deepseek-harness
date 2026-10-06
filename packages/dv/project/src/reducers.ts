/**
 * The reducer registry and project state. Components register one reducer per component key; the state of a branch
 * is the result of passing every record of the branch's effective chain (see `effectiveChain` in the history module),
 * oldest first, through every registered reducer. Project registers its own reducer, {@link projReducer}, for the
 * `proj` slice.
 *
 * Calls: reads records through the record store and the effective chain through the history module. Called by the
 * service (`getState`), the runner (state at a record's parent, character, location and style resolution), and drafts
 * (accept replay).
 *
 * @module @dv/project/reducers
 */
import { effectiveChain } from './history.ts'
import type { RecordStore } from './record-store.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { COMPONENT_KEYS, ProjectError } from './shared.ts'
import type {
  AssetId, AssetStore, ComponentStates, ProjectId, ProjectInfo, ProjectRecord, ProjectState, RecordId, RecordInput, RecordInputRef,
  Reducer,
} from './types.ts'

/** The `proj` slice. */
type ProjSlice = ComponentStates['proj']

/** A slice of any declared component. */
type AnySlice = ComponentStates[keyof ComponentStates]

/** The record that created the character, location or style version a reference names; null for any other reference. */
type VersionCreator = (ref: RecordInputRef) => RecordId | null

/** The version lookup without a reducer that defines `createdBy`: no reference names a version. */
const noVersions: VersionCreator = () => null

/**
 * The records that a `proj.stale_accept` record among the given records accepted.
 * @param records - records, oldest first.
 * @returns the accepted record IDs.
 */
function acceptedRecords(records: ProjectRecord[]): Set<string> {
  const accepted = new Set<string>()
  for (const record of records) {
    if (record.operation === 'proj.stale_accept' && typeof record.params.record === 'string') accepted.add(record.params.record)
  }
  return accepted
}

/**
 * The records an input was produced by: the record that created its resolved asset, and for a character, location or
 * style reference, the record that created that version.
 * @param input - one input of a record.
 * @param created_by - the asset → record map of the slice.
 * @param versionCreator - the version lookup.
 * @returns the producing records.
 */
function producersOf(input: RecordInput, created_by: ProjSlice['created_by'], versionCreator: VersionCreator): RecordId[] {
  const producers: RecordId[] = []
  const assetProducer = input.resolved_asset === null ? undefined : created_by[input.resolved_asset]
  if (assetProducer !== undefined) producers.push(assetProducer)
  const versionProducer = 'asset' in input.ref || 'record' in input.ref ? null : versionCreator(input.ref)
  if (versionProducer !== null) producers.push(versionProducer)
  return producers
}

/**
 * Why a record is stale: the superseding record (or the record that made the producer stale) of the first input whose
 * producer is superseded or stale. A record is never stale through itself.
 * @param record - the record.
 * @param slice - the slice whose `created_by`, `superseded` and `stale` maps are read.
 * @param versionCreator - finds the producer of a character, location or style reference.
 * @returns the record that makes it stale, or undefined.
 */
function staleReason(
  record: ProjectRecord, slice: Pick<ProjSlice, 'created_by' | 'superseded' | 'stale'>, versionCreator: VersionCreator,
): RecordId | undefined {
  for (const input of record.inputs) {
    for (const producer of producersOf(input, slice.created_by, versionCreator)) {
      if (producer === record.id) continue
      const reason = slice.superseded[producer] ?? slice.stale[producer]
      if (reason !== undefined && reason !== record.id) return reason
    }
  }
  return undefined
}

/**
 * Recompute every stale mark over a list of records in one forward pass, so that a mark reaches every record that is
 * downstream of a superseded record, and no mark reaches an accepted record or passes through one.
 * @param records - the records, oldest first; producers come before their consumers.
 * @param slice - the `created_by` and `superseded` maps after the newest record.
 * @param versionCreator - finds the producer of a character, location or style reference.
 * @returns the stale map.
 */
function computeStale(
  records: ProjectRecord[], slice: Pick<ProjSlice, 'created_by' | 'superseded'>, versionCreator: VersionCreator,
): ProjSlice['stale'] {
  const accepted = acceptedRecords(records)
  const stale: ProjSlice['stale'] = {}
  for (const record of records) {
    if (accepted.has(record.id)) continue
    const reason = staleReason(record, { ...slice, stale }, versionCreator)
    if (reason !== undefined) stale[record.id] = reason
  }
  return stale
}

/**
 * Apply one record to the `proj` slice (see {@link projReducer}).
 * @param slice - the slice before the record.
 * @param record - the record.
 * @param versionCreator - finds the producer of a character, location or style reference, from the slice of the
 *   reducer that defines `createdBy`, before the record.
 * @returns the slice after the record.
 */
function reduceProj(slice: ProjSlice, record: ProjectRecord, versionCreator: VersionCreator): ProjSlice {
  const records = [...slice.records, record]
  const created_by = { ...slice.created_by }
  if (record.status === 'done') for (const asset of record.outputs) created_by[asset] = record.id
  const superseded = { ...slice.superseded }
  for (const id of record.supersedes) superseded[id] = record.id
  // A supersede or a stale acceptance can change the marks of earlier records; anything else only marks this one.
  if (record.supersedes.length > 0 || record.operation === 'proj.stale_accept') {
    return { records, created_by, superseded, stale: computeStale(records, { created_by, superseded }, versionCreator) }
  }
  const reason = staleReason(record, { created_by, superseded, stale: slice.stale }, versionCreator)
  const stale = reason === undefined || acceptedRecords(slice.records).has(record.id)
    ? slice.stale
    : { ...slice.stale, [record.id]: reason }
  return { records, created_by, superseded, stale }
}

/**
 * Project's own reducer for the `proj` slice:
 * - `records`: every record it receives, in order;
 * - `created_by`: each output asset of a `done` record → that record (a later record that outputs the same asset
 *   replaces the entry);
 * - `superseded`: each ID in a record's `supersedes` → that record;
 * - `stale`: a record R is stale when one of its inputs was produced by a record that is superseded or stale; the
 *   producer of an input is the record that created its `resolved_asset`, and for a character, location or style
 *   reference also the record that created that version (`createdBy` of the reducer that defines it); the value is the
 *   superseding record (or the record that made the producer stale). When a record supersedes another, every earlier
 *   record that is (transitively) downstream of the superseded one becomes stale.
 *   A `proj.stale_accept` record with `params.record` removes that record's mark and keeps it removed for the rest of
 *   the chain, and records downstream of it are not stale through it.
 * Request records and `proj.*` records other than `proj.stale_accept` change only `records`. The registry reduces the
 * slice with the `createdBy` of the reducer that defines it; `projReducer.reduce` called on its own finds no version
 * producers.
 */
export const projReducer: Reducer<'proj'> = {
  initial: () => ({ records: [], stale: {}, superseded: {}, created_by: {} }),
  reduce: (slice, record) => reduceProj(slice, record, noVersions),
}

/** The registered reducers, and the state computed from them. */
export class ReducerRegistry {
  /** Component key → reducer, in registration order. */
  private readonly reducers = new Map<keyof ComponentStates, Reducer>()

  /**
   * @param store - the record store, read for chains and project metadata.
   */
  constructor(private readonly store: RecordStore) {}

  /**
   * Register a component's reducer. One reducer per key: a second registration of a key throws `reducer_exists`. At
   * most one registered reducer defines `createdBy` and `assetsOf`: a second one that defines either throws
   * `invalid_params`.
   * @param key - the component key.
   * @param reducer - the reducer.
   * @returns a function that removes the registration.
   */
  register<K extends keyof ComponentStates>(key: K, reducer: Reducer<K>): () => void {
    if (this.reducers.has(key)) throw new ProjectError('reducer_exists', `A reducer for component ${key} is already registered.`)
    for (const hook of ['createdBy', 'assetsOf'] as const) {
      const holder = [...this.reducers].find(([, other]) => other[hook] !== undefined)
      if (reducer[hook] !== undefined && holder !== undefined) {
        throw new ProjectError('invalid_params', `The reducer of ${String(holder[0])} already defines ${hook}; ${key} cannot define it too.`)
      }
    }
    this.reducers.set(key, reducer)
    return () => {
      if (this.reducers.get(key) === reducer) this.reducers.delete(key)
    }
  }

  /**
   * The state of a branch at its head.
   * @param project - the project.
   * @param branch - a branch name; throws `unknown_branch`.
   * @returns the state.
   */
  getState(project: ProjectId, branch: string): ProjectState {
    this.store.getProject(project)
    const stored = this.store.getBranch(project, branch)
    if (stored === undefined) throw new ProjectError('unknown_branch', `Project ${project} has no branch ${branch}.`)
    return this.stateAt(project, branch, stored.head)
  }

  /**
   * The state at any record, labelled with a branch name; the runner uses it for the state at a record's parent.
   * @param project - the project.
   * @param branch - the branch name the state is labelled with.
   * @param head - the record to compute the state at.
   * @returns the state of the effective chain ending at `head`.
   */
  stateAt(project: ProjectId, branch: string, head: RecordId): ProjectState {
    return this.reduceChain(this.store.getProject(project), branch, effectiveChain(this.store, project, head))
  }

  /**
   * Pass a list of records through every reducer, starting from each reducer's initial slice. Pure: the same records
   * always give the same state.
   * @param info - the project's metadata.
   * @param branch - the branch name the state is labelled with.
   * @param records - the effective chain, oldest first; must not be empty.
   * @returns the state at the last record.
   */
  reduceChain(info: ProjectInfo, branch: string, records: ProjectRecord[]): ProjectState {
    const last = records.at(-1)
    if (last === undefined) throw new ProjectError('invalid_params', `Project ${info.id} has no record to compute a state from.`)
    const slices = new Map<keyof ComponentStates, AnySlice>()
    for (const [key, reducer] of this.reducers) slices.set(key, reducer.initial())
    // Each record passes through every reducer in registration order before the next record.
    for (const record of records) {
      for (const [key, reducer] of this.reducers) {
        slices.set(key, this.reduceSlice(reducer, slices.get(key) ?? reducer.initial(), record, slices))
      }
    }
    return { project: info, branch, head: last.id, components: componentStates(slices) }
  }

  /**
   * Apply one more record to a state; accept replay uses it to walk a draft's records on a new `main`.
   * @param state - the state before the record.
   * @param record - the record.
   * @returns the state after it, with `head` set to the record's ID.
   */
  apply(state: ProjectState, record: ProjectRecord): ProjectState {
    const before = new Map<keyof ComponentStates, AnySlice>()
    for (const [key, reducer] of this.reducers) before.set(key, sliceOf(state, key, reducer))
    const slices = new Map<keyof ComponentStates, AnySlice>()
    for (const [key, reducer] of this.reducers) {
      slices.set(key, this.reduceSlice(reducer, before.get(key) ?? reducer.initial(), record, before))
    }
    return { ...state, head: record.id, components: { ...state.components, ...componentStates(slices) } }
  }

  /**
   * Ask every reducer that defines `conflict` whether a record can apply on a state, in registration order.
   * @param state - the state before the record.
   * @param record - a draft record.
   * @returns the first reason, or null when no reducer reports a conflict.
   */
  conflict(state: ProjectState, record: ProjectRecord): string | null {
    for (const [key, reducer] of this.reducers) {
      const reason = reducer.conflict?.(sliceOf(state, key, reducer), record) ?? null
      if (reason !== null) return reason
    }
    return null
  }

  /**
   * The project summary fields of every reducer that defines `agentSummary`, in component key order (keys outside
   * that list follow in registration order).
   * @param state - a state of a branch.
   * @param assets - the asset store, for asset URLs.
   * @returns one field object per such reducer.
   */
  agentSummaries(state: ProjectState, assets: Pick<AssetStore, 'url'>): Array<Record<string, JsonValue>> {
    const order = [...COMPONENT_KEYS]
    const rank = (key: string): number => (order.includes(key) ? order.indexOf(key) : order.length)
    return [...this.reducers].sort(([a], [b]) => rank(String(a)) - rank(String(b)))
      .flatMap(([key, reducer]) => (
        reducer.agentSummary === undefined ? [] : [reducer.agentSummary(sliceOf(state, key, reducer), assets, state)]))
  }

  /**
   * Apply one record to one slice. Project's own `proj` slice also reads the version producers from the slice of the
   * reducer that defines `createdBy`, before the record; `proj` is registered first, so `slices` still holds that slice
   * while `proj` reduces.
   * @param reducer - the reducer of the slice.
   * @param slice - the slice before the record.
   * @param record - the record.
   * @param slices - every slice by key; the slice of the reducer that defines `createdBy` is read before the record.
   * @returns the slice after the record.
   */
  private reduceSlice(reducer: Reducer, slice: AnySlice, record: ProjectRecord, slices: Map<keyof ComponentStates, AnySlice>): AnySlice {
    if (reducer !== projReducer) return reducer.reduce(slice, record)
    return reduceProj(slice as ProjSlice, record, ref => this.versionCreator(slices, ref))
  }

  /**
   * The record that created a version, from `createdBy` of the reducer that defines it.
   * @param slices - every slice by key.
   * @param ref - a character, location or style reference.
   * @returns the record, or null when no registered reducer defines `createdBy` or the version is unknown.
   */
  private versionCreator(slices: Map<keyof ComponentStates, AnySlice>, ref: RecordInputRef): RecordId | null {
    for (const [key, reducer] of this.reducers) {
      if (reducer.createdBy !== undefined) return reducer.createdBy(slices.get(key) ?? reducer.initial(), ref)
    }
    return null
  }

  /**
   * The record that created the version a character, location or style reference names, read from a computed state.
   * @param state - a state of a branch.
   * @param ref - a `{character, version}`, `{location, version}` or `{style, version}` reference.
   * @returns the record, or null when no registered reducer defines `createdBy` or the reference names no known
   *   version.
   */
  versionCreatedBy(state: ProjectState, ref: RecordInputRef): RecordId | null {
    for (const [key, reducer] of this.reducers) {
      if (reducer.createdBy !== undefined) return reducer.createdBy(sliceOf(state, key, reducer), ref)
    }
    return null
  }

  /**
   * The assets a character, location or style reference stands for, from `assetsOf` of the reducer that defines it.
   * @param state - the state at the record's parent.
   * @param ref - a `{character, version}`, `{location, version}` or `{style, version}` reference.
   * @returns the assets, or null when no registered reducer defines `assetsOf` or the version is unknown.
   */
  assetsOf(state: ProjectState, ref: RecordInputRef): AssetId[] | null {
    for (const [key, reducer] of this.reducers) {
      if (reducer.assetsOf !== undefined) return reducer.assetsOf(sliceOf(state, key, reducer), ref)
    }
    return null
  }
}

/**
 * Set one slice of a `components` object under construction.
 * @param components - the object being built.
 * @param key - the component key.
 * @param slice - the key's slice.
 */
function setSlice<K extends keyof ComponentStates>(components: Partial<ComponentStates>, key: K, slice: ComponentStates[K]): void {
  components[key] = slice
}

/**
 * Build the `components` object of a state from slices by component key.
 * @param slices - one slice per registered reducer; Project registers `proj` at start, so the `proj` slice is present.
 * @returns the slices as `ComponentStates`.
 */
function componentStates(slices: Map<keyof ComponentStates, AnySlice>): ComponentStates {
  const components: Partial<ComponentStates> = {}
  for (const [key, slice] of slices) setSlice(components, key, slice)
  return components as ComponentStates
}

/**
 * Read one component's slice from a state by key.
 * @param state - the state.
 * @param key - a registered component key.
 * @param reducer - the reducer registered for the key.
 * @returns the slice; a reducer registered after the state was computed starts from its initial slice.
 */
function sliceOf(state: ProjectState, key: keyof ComponentStates, reducer: Reducer): AnySlice {
  return Object.hasOwn(state.components, key) ? state.components[key] : reducer.initial()
}
