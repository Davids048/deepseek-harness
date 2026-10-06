/**
 * Types of the Shot plan component: the plan a `plan.create` or `plan.update` record stores, its shots, and the `plan`
 * state slice. A plan is identified by the record ID of the `plan.create` or `plan.update` record that stored it, and a
 * shot by its 1-based position in the plan.
 *
 * @module @dv/shot-plan/types
 */
import type { RecordId } from '@dv/project'

/** One shot of a plan, in the snake_case of tool params. */
export interface Shot {
  /** The complete prompt of the shot. */
  prompt: string
  /** Seconds; the render uses the model minimum when absent. */
  duration_sec?: number
  /** Character, location or style versions (`c1@1`) or asset IDs this shot uses instead of the plan's references. */
  references?: string[]
  seed?: number
}

/** The shots and settings a `plan.create` or `plan.update` record stores, and `plan.approve` turns into shot renders. */
export interface Plan {
  title?: string
  /** `chained`: each shot after the first starts from its predecessor's last still; `independent`: shots only share the references. */
  continuity?: 'independent' | 'chained'
  /** References every shot carries unless it names its own: `<id>@<version>` or asset IDs. */
  references?: string[]
  aspect_ratio?: string
  resolution?: string
  generation_mode?: string
  seed?: number
  shots: Shot[]
}

/** A plan record and whether a finished `plan.approve` record approved it. */
export interface PlanSummary {
  /** The `plan.create` or `plan.update` record that stored the plan. */
  record: RecordId
  approved: boolean
  /** The `plan.approve` record that approved the plan, or null while it waits for approval. */
  approved_by: RecordId | null
}

/** The `plan` slice: every finished plan of the branch, oldest first. */
export interface PlanState {
  plans: PlanSummary[]
}

declare module '@dv/project' {
  interface ComponentStates {
    /** Plans and their approvals (the Shot plan component's reducer). */
    plan: PlanState
  }
}
