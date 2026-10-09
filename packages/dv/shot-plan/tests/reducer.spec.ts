/** The pure `plan` reducer: plan versions, their approval, the agent summary, and records it ignores. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectRecord, ProjectState, RecordId } from '@dv/project'
import { describe, expect, it } from 'vitest'
import { planReducer } from '../src/reducer.ts'

let counter = 0

/** A finished record of one operation with the given fields. */
function record(operation: string | null, params: Record<string, unknown> = {}, fields: Partial<ProjectRecord> = {}): ProjectRecord {
  counter += 1
  return {
    id: brandString<RecordId>(`record-${counter}`), parents: [], kind: 'operation', component: 'plan', operation,
    operation_version: '1', actor: 'user', surface: 'api', turn: null, session: null, tool_call: null, intent: 'x', params, inputs: [],
    outputs: [], based_on: null, supersedes: [], deterministic: true, status: 'done', created_at: new Date().toISOString(), ...fields,
  }
}

/** Reduce records in order from the initial slice. */
function reduceAll(records: ProjectRecord[]) {
  return records.reduce((slice, next) => planReducer.reduce(slice, next), planReducer.initial())
}

describe('plan reducer', () => {
  it('adds version 1 at plan.create, the next version at plan.update, and marks the version a finished approval names', () => {
    const failed = record('plan.create', { shots: [] }, { status: 'failed' })
    const created = record('plan.create', { title: 't', shots: [{ prompt: 'a' }] }, { report: { plan: 'p1', version: 1 } })
    const revised = record('plan.update', { plan: 'p1', shots: [{ prompt: 'b' }] }, { report: { plan: 'p1', version: 2 } })
    const running = record('plan.approve', { plan: 'p1' }, { status: 'running' })
    const latest = record('plan.approve', { plan: 'p1' }, { report: { plan: 'p1', version: 2, scheduled: [] } })
    const first = record('plan.approve', { plan: 'p1', version: 1 })
    const v1 = { title: 't', shots: [{ prompt: 'a' }], version: 1, created_by: created.id, approved_by: null }
    const v2 = { shots: [{ prompt: 'b' }], version: 2, created_by: revised.id, approved_by: null }
    expect(reduceAll([failed, created, revised, running]).plans).toEqual({ p1: [v1, v2] })
    expect(reduceAll([created, revised, latest, first]).plans).toEqual({
      p1: [{ ...v1, approved_by: first.id }, { ...v2, approved_by: latest.id }],
    })
    // Without a version param or report, an approval approves the latest version.
    expect(reduceAll([created, record('plan.approve', { plan: 'p1' })]).plans['p1' as never]?.[0]?.approved_by).not.toBeNull()
  })

  it('ignores other components\' records, unknown plans and versions, and creates without a plan ID', () => {
    const created = record('plan.create', { shots: [{ prompt: 'a' }] }, { report: { plan: 'p1', version: 1 } })
    const slice = reduceAll([created])
    expect(planReducer.reduce(slice, record('timeline.create', { plan: 'p1' }, { component: 'timeline' }))).toBe(slice)
    expect(planReducer.reduce(slice, record('plan.approve', {}))).toBe(slice)
    expect(planReducer.reduce(slice, record('plan.approve', { plan: 'p9' }))).toBe(slice)
    expect(planReducer.reduce(slice, record('plan.approve', { plan: 'p1', version: 3 }))).toBe(slice)
    expect(planReducer.reduce(slice, record('plan.update', { plan: 'p9', shots: [{ prompt: 'b' }] }))).toBe(slice)
    expect(planReducer.reduce(slice, record('plan.create', { shots: [{ prompt: 'b' }] }))).toBe(slice)
    expect(planReducer.reduce(slice, record('plan.create', { shots: [] }, { report: { plan: 'p1', version: 1 } }))).toBe(slice)
  })

  it('lists each plan once in the agent summary with its latest version, approved version and shot count', () => {
    const created = record('plan.create', { title: 'dance', shots: [{ prompt: 'a' }] }, { report: { plan: 'p1', version: 1 } })
    const approved = record('plan.approve', { plan: 'p1' })
    const revised = record('plan.update', { plan: 'p1', title: 'dance', shots: [{ prompt: 'a' }, { prompt: 'b' }] })
    const other = record('plan.create', { shots: [{ prompt: 'c' }] }, { report: { plan: 'p2', version: 1 } })
    const slice = reduceAll([created, approved, revised, other])
    expect(planReducer.agentSummary?.(slice, { url: asset => asset }, {} as ProjectState)).toEqual({
      plans: [
        { plan: 'p1', title: 'dance', version: 2, approved_version: 1, shots: 2 },
        { plan: 'p2', title: null, version: 1, approved_version: null, shots: 1 },
      ],
    })
  })
})
