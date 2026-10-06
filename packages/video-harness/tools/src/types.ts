/**
 * Types of the structured tools: what a tool declares beyond the operation spec that `dvProject` runs, so the agent,
 * the views, and the confirmation policy can read the same declaration; and the state slices of the stage 2 bridge
 * reducers that this package registers for the timeline, the story bible, the shot plan, and shot renders.
 *
 * @module @video-harness/tools/types
 */
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { AssetId, OperationSpec, ProjectRecord, RecordId } from '@dv/project'

/** The kind of artifact an input or output carries. */
export type ArtifactType = 'image' | 'video' | 'audio' | 'text' | 'json' | 'any'

/** One named input of a tool. */
export interface InputSpec {
  type: ArtifactType
  description: string
  required?: boolean
  /** Whether the role accepts several references, such as every reference image of a shot. */
  many?: boolean
  /** Whether the role accepts `<id>@<version>` references to a character, location, or style in addition to assets. */
  entity?: boolean
}

/** One output of a tool, in the order the tool returns them. */
export interface OutputSpec {
  role: string
  type: ArtifactType
}

/** A structured tool: an operation spec plus the declaration the agent and the views read. */
export interface ToolSpec extends OperationSpec {
  /** The model-facing description. */
  summary: string
  inputs: Record<string, InputSpec>
  /** The JSON schema of `params`, in the DSH tool parameter format; also the canvas form. */
  params: ParameterSchemaSpec
  outputs: OutputSpec[]
  /**
   * One line for a chat card or a canvas node.
   * @param record - the finished record.
   * @returns the line.
   */
  summarize(record: ProjectRecord): string
}

/** One version of a character, location, or style, as the `bible` bridge reducer rebuilds it from its records. */
export interface EntityVersion {
  kind: string
  version: number
  /** Display name, such as the character's name. */
  name: string
  description: string
  refs: AssetId[]
  /** The record that wrote this version. */
  updatedBy: RecordId
}

/** One clip of a timeline. */
export interface SequenceItem {
  /** 1-based position. */
  slot: number
  assetId: AssetId
  /** Playback range inside the asset, or null for the whole asset. */
  inSec: number | null
  outSec: number | null
}

/** One timeline of a project: an ordered list of clips with an ID and a display title. */
export interface SequenceState {
  /** Stable ID that the timeline records name in their `sequence` param, such as `v1`. */
  id: string
  title: string
  items: SequenceItem[]
}

/** A plan record and whether a finished `plan.approve` record approved it. */
export interface PlanSummary {
  op: RecordId
  approved: boolean
  approvedBy: RecordId | null
}

/** The shots and settings a `plan.create` record stores and `plan.approve` turns into shot renders. */
export interface PlanDocument {
  title?: string
  /** `chained`: each shot after the first starts from its predecessor's last frame; `independent`: shots only share the references. */
  continuity?: 'independent' | 'chained'
  /** References every shot carries unless it names its own: `<id>@<version>` or asset IDs. */
  references?: string[]
  aspect_ratio?: string
  resolution?: string
  generation_mode?: string
  seed?: number
  shots: Array<{
    prompt: string
    duration_sec?: number
    references?: string[]
    seed?: number
  }>
}

declare module '@dv/project' {
  interface ComponentStates {
    /** The timelines of the project (stage 2 bridge reducer of this package). */
    timeline: {
      /** The first timeline, the default target of records without a `sequence` param. */
      sequence: { items: SequenceItem[] } | null
      /** Every timeline, in creation order. */
      sequences: SequenceState[]
    }
    /** Characters, locations, and styles with their versions (stage 2 bridge reducer of this package). */
    bible: {
      /** Every version of each character, location, and style, by ID. */
      entities: Record<string, EntityVersion[]>
    }
    /** Plans and their approvals (stage 2 bridge reducer of this package). */
    plan: {
      plans: PlanSummary[]
    }
    /** Takes of one shot (stage 2 bridge reducer of this package). */
    shot: {
      /** The root record of each shot → the root and every record that is `based_on` it, directly or through others. */
      takes: Record<RecordId, RecordId[]>
      /** Each record with a `based_on` → its root record; the reducer's index for `takes`. */
      roots: Record<RecordId, RecordId>
    }
  }
}
