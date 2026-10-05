/**
 * Types of the project runtime: the folded state that views project, the invoke request, and the tool registration.
 *
 * @module @video-harness/runtime/types
 */
import type { AssetId, EntityId, InputRef, Op, OpId, OpInput, ProjectId, TurnId } from '@video-harness/oplog'
import type VhAssets from '@video-harness/assets'

/** One version of an entity, as the fold reconstructs it from `entity.*` operations. */
export interface EntityVersion {
  kind: string
  version: number
  /** Display name, such as the character's name. */
  name: string
  description: string
  refs: AssetId[]
  /** The operation that wrote this version. */
  updatedBy: OpId
}

/** One clip on the single timeline track. */
export interface SequenceItem {
  /** 1-based position. */
  slot: number
  assetId: AssetId
  /** Playback range inside the asset, or null for the whole asset. */
  inSec: number | null
  outSec: number | null
}

/** One video of a project: an ordered list of clips with an ID and a display title. */
export interface SequenceState {
  /** Stable ID that `sequence.*` records name in their `sequence` param, such as `v1`. */
  id: string
  title: string
  items: SequenceItem[]
}

/** Why an operation is stale. */
export interface StaleMark {
  /** The operation whose output replaced one of this operation's inputs, or an input's producer. */
  because: OpId
}

/** What the fold knows about one turn. */
export interface TurnSummary {
  ops: OpId[]
  actor: Op['actor']
  surface: Op['surface']
  intent: string
  /** Whether the turn's records are on the accepted history of the folded head. */
  accepted: boolean
  rejected: boolean
}

/** A plan operation and whether an `approve` record followed it. */
export interface PlanSummary {
  op: OpId
  approved: boolean
  approvedBy: OpId | null
}

/** Everything a view needs, derived from the records reachable from one head. */
export interface ProjectState {
  projectId: ProjectId
  head: OpId
  /** The records from the project's first record to the head, in order. */
  ops: Op[]
  /** Every asset the records produced or uploaded. */
  assets: Set<AssetId>
  /** The asset each record produced, by asset: who to blame when it is replaced. */
  producers: Record<AssetId, OpId>
  entities: Record<EntityId, EntityVersion[]>
  /** The first video of the project, the default target of `sequence.*` records without a `sequence` param. */
  sequence: { items: SequenceItem[] } | null
  /** Every video of the project, in creation order. */
  sequences: SequenceState[]
  stale: Record<OpId, StaleMark>
  /** Records whose outputs a later record replaced (`supersedes`), by the replacing record. */
  superseded: Record<OpId, OpId>
  turns: Record<TurnId, TurnSummary>
  /** Alternative results for the same slot: the root operation and every `base_op` descendant, keyed by the root. */
  takes: Record<OpId, OpId[]>
  plans: PlanSummary[]
}

/** What a tool costs to run; the scheduler keeps one concurrency limit per class. */
export type ToolCost = 'free' | 'cpu' | 'gpu'

/** What `invoke` and `schedule` receive: the record fields the caller decides, and the tool to run. */
export interface InvokeRequest {
  tool: string
  /** Asset IDs, `entity@version` references, or `<op_id>#<index>` references to outputs of earlier records. */
  inputs: Array<{ role: string; ref: InputRef }>
  params: Record<string, unknown>
  actor: Op['actor']
  surface: Op['surface']
  intent: string
  turn: TurnId
  /** The branch to append to; defaults to the turn's draft branch when one is open, else `main`. */
  branch?: string
  base_op?: OpId
  supersedes?: OpId[]
}

/** An input after the runtime resolved entity versions to assets. */
export interface ResolvedInput extends OpInput {
  resolved: AssetId | null
  /** The entity version an entity reference pointed at, when the input was one. */
  entity?: EntityVersion
}

/** What a tool's `execute` sees. */
export interface ToolExecution {
  projectId: ProjectId
  op: Op
  inputs: ResolvedInput[]
  params: Record<string, unknown>
  assets: VhAssets
  /** The state at the branch head when the record was appended; tools that edit entities or the sequence read it. */
  state: ProjectState
  /** A directory the tool may write scratch files into; removed after the call. */
  scratchDir: string
}

/** What a tool's `execute` returns. */
export interface ToolResult {
  outputs: AssetId[]
  cost?: Op['cost']
  /** Facts about the run the record keeps as `report`, such as the seed a generator drew or the probe a reader took. */
  report?: Record<string, unknown>
}

/** A tool the runtime can invoke. */
export interface RuntimeToolSpec {
  name: string
  version: string
  /** Identical inputs and params always give identical outputs, so results may be cached and replayed. */
  deterministic: boolean
  /** The concurrency class the scheduler runs the tool in; defaults to `cpu`. */
  cost?: ToolCost
  execute(execution: ToolExecution): Promise<ToolResult>
}

/** How the scheduler orders a queued record beyond the producers its inputs name. */
export interface ScheduleOptions {
  /** Records that must finish before this one runs, in addition to the producers of `<op_id>#<index>` inputs. */
  after?: OpId[]
}

/** The shots and settings a `plan.create` record stores and `plan.approve` turns into generation records. */
export interface PlanDocument {
  title?: string
  /** `chained`: each shot after the first starts from its predecessor's last frame; `independent`: shots only share the references. */
  continuity?: 'independent' | 'chained'
  /** References every shot carries unless it names its own: entity versions or asset IDs. */
  references?: InputRef[]
  aspect_ratio?: string
  resolution?: string
  generation_mode?: string
  seed?: number
  shots: Array<{
    prompt: string
    duration_sec?: number
    references?: InputRef[]
    seed?: number
  }>
}
