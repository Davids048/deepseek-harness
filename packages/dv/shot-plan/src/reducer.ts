/**
 * The pure reducer of the Shot plan component: the `plan` slice from the finished `plan.*` records.
 *
 * @module @dv/shot-plan/reducer
 */
import type { Reducer } from '@dv/project'
import type { PlanSummary } from './types.ts'

/**
 * The `plan` reducer: every finished `plan.create` and `plan.update` record, and the finished `plan.approve` record
 * that approved it. Records of other components and records that are not `done` leave the slice unchanged.
 */
export const planReducer: Reducer<'plan'> = {
  initial: () => ({ plans: [] }),
  reduce(slice, record) {
    if (record.status !== 'done') return slice
    if (record.operation === 'plan.create' || record.operation === 'plan.update') {
      return { plans: [...slice.plans, { record: record.id, approved: false, approved_by: null }] }
    }
    if (record.operation === 'plan.approve' && typeof record.params['plan'] === 'string') {
      const plan = record.params['plan']
      const approve = (summary: PlanSummary): PlanSummary => ({ ...summary, approved: true, approved_by: record.id })
      return { plans: slice.plans.map(summary => summary.record === plan ? approve(summary) : summary) }
    }
    return slice
  },
  agentSummary(slice) {
    return { plans: slice.plans.map(summary => ({ record: summary.record, approved: summary.approved, approved_by: summary.approved_by })) }
  },
}
