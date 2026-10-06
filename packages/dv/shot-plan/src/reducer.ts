/**
 * The pure reducer of the Shot plan component: the `plan` slice from the finished `plan.*` records.
 *
 * @module @dv/shot-plan/reducer
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectRecord, Reducer } from '@dv/project'
import type { Plan, PlanId, PlanState, PlanVersion } from './types.ts'

/**
 * The plan version that the params of a `plan.create` or `plan.update` call describe; the `plan` param of
 * `plan.update` names the plan and is not part of the version.
 * @param params - the validated params.
 * @returns the plan.
 */
export function planOf(params: Record<string, unknown>): Plan {
  const { shots, plan: _plan, ...rest } = params
  return { ...rest, shots: Array.isArray(shots) ? shots as Plan['shots'] : [] }
}

/** The PlanId a finished `plan.create` record stored in `report.plan`, or null for a record without one. */
export function reportedPlan(record: Pick<ProjectRecord, 'report'>): PlanId | null {
  const plan = record.report?.['plan']
  return typeof plan === 'string' ? brandString<PlanId>(plan) : null
}

/**
 * The version number a `plan.approve` record approves: its `version` param, else the `report.version` it resolved when
 * it ran, else the plan's latest version.
 * @param record - the `plan.approve` record.
 * @param versions - the plan's versions, oldest first.
 * @returns the version number.
 */
export function approvedVersion(record: Pick<ProjectRecord, 'params' | 'report'>, versions: readonly PlanVersion[]): number {
  const param = record.params['version']
  if (typeof param === 'number') return param
  const reported = record.report?.['version']
  return typeof reported === 'number' ? reported : versions.length
}

/** The `plan` slice with one plan's versions replaced. */
function withVersions(slice: PlanState, plan: PlanId, versions: PlanVersion[]): PlanState {
  return { plans: { ...slice.plans, [plan]: versions } }
}

/**
 * The `plan` reducer: a finished `plan.create` adds version 1 of the plan its `report.plan` names, a finished
 * `plan.update` adds the next version of the plan its `plan` param names, and a finished `plan.approve` sets
 * `approved_by` of the version it approved. Records of other components, records that are not `done`, and records
 * that name an unknown plan or version leave the slice unchanged.
 */
export const planReducer: Reducer<'plan'> = {
  initial: () => ({ plans: {} }),
  reduce(slice, record) {
    if (record.status !== 'done') return slice
    const created = { ...planOf(record.params), created_by: record.id, approved_by: null }
    if (record.operation === 'plan.create') {
      const plan = reportedPlan(record)
      if (plan === null || slice.plans[plan] !== undefined) return slice
      return withVersions(slice, plan, [{ ...created, version: 1 }])
    }
    const plan = typeof record.params['plan'] === 'string' ? brandString<PlanId>(record.params['plan']) : null
    const versions = plan === null ? undefined : slice.plans[plan]
    if (plan === null || versions === undefined) return slice
    if (record.operation === 'plan.update') return withVersions(slice, plan, [...versions, { ...created, version: versions.length + 1 }])
    if (record.operation === 'plan.approve') {
      const version = approvedVersion(record, versions)
      if (versions[version - 1] === undefined) return slice
      return withVersions(slice, plan, versions.map(entry => entry.version === version ? { ...entry, approved_by: record.id } : entry))
    }
    return slice
  },
  agentSummary(slice) {
    // Each plan once: its latest version, the latest approved version (null before any approval), and the shot count.
    return {
      plans: Object.entries(slice.plans).flatMap(([plan, versions]) => {
        const latest = versions.at(-1)
        if (latest === undefined) return []
        const approved = versions.findLast(entry => entry.approved_by !== null)
        return [{
          plan, title: latest.title ?? null, version: latest.version, approved_version: approved?.version ?? null,
          shots: latest.shots.length,
        }]
      }),
    }
  },
}
