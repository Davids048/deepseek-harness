/** The pure `plan` reducer: finished plans, their approval, and records it ignores. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectRecord, RecordId } from '@dv/project'
import { describe, expect, it } from 'vitest'
import { planReducer } from '../src/reducer.ts'

let counter = 0

/** A finished record of one operation with the given fields. */
function record(operation: string | null, params: Record<string, unknown> = {}, fields: Partial<ProjectRecord> = {}): ProjectRecord {
  counter += 1
  return {
    id: brandString<RecordId>(`record-${counter}`), parents: [], branch: 'main', kind: 'operation', component: 'plan', operation,
    operation_version: '1', actor: 'user', surface: 'api', turn: null, session: null, tool_call: null, intent: 'x', params, inputs: [],
    outputs: [], based_on: null, supersedes: [], deterministic: true, status: 'done', created_at: new Date().toISOString(), ...fields,
  }
}

/** Reduce records in order from the initial slice. */
function reduceAll(records: ProjectRecord[]) {
  return records.reduce((slice, next) => planReducer.reduce(slice, next), planReducer.initial())
}

describe('plan reducer', () => {
  it('lists finished plans and marks the one a finished approval names', () => {
    const failed = record('plan.create', { shots: [] }, { status: 'failed' })
    const created = record('plan.create', { shots: [{ prompt: 'a' }] })
    const revised = record('plan.update', { shots: [{ prompt: 'b' }] })
    const running = record('plan.approve', { plan: revised.id }, { status: 'running' })
    const done = record('plan.approve', { plan: revised.id })
    expect(reduceAll([failed, created, revised, running]).plans).toEqual([
      { record: created.id, approved: false, approved_by: null }, { record: revised.id, approved: false, approved_by: null },
    ])
    expect(reduceAll([failed, created, revised, running, done]).plans).toEqual([
      { record: created.id, approved: false, approved_by: null }, { record: revised.id, approved: true, approved_by: done.id },
    ])
  })

  it('ignores other components\' records, requests, and approvals without a plan param', () => {
    const created = record('plan.create', { shots: [{ prompt: 'a' }] })
    const slice = reduceAll([created])
    expect(planReducer.reduce(slice, record('timeline.create', { plan: created.id }, { component: 'timeline' }))).toBe(slice)
    expect(planReducer.reduce(slice, record(null, {}, { kind: 'request', component: 'proj' }))).toBe(slice)
    expect(planReducer.reduce(slice, record('plan.approve', {}))).toBe(slice)
    expect(planReducer.reduce(slice, record('plan.approve', { plan: 'unknown' })).plans).toEqual(slice.plans)
  })

  it('lists every plan with its approval in the agent summary', () => {
    const created = record('plan.create', { shots: [{ prompt: 'a' }] })
    const done = record('plan.approve', { plan: created.id })
    expect(planReducer.agentSummary?.(reduceAll([created, done]), { url: asset => asset })).toEqual({
      plans: [{ record: created.id, approved: true, approved_by: done.id }],
    })
  })
})
