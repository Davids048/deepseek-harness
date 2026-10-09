/** The pure `shot` reducer: finished render takes of every render mode grouped under the root record of their `based_on` chain. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectRecord, RecordId } from '@dv/project'
import { describe, expect, it } from 'vitest'
import { shotReducer } from '../src/reducer.ts'
import type { ShotState } from '../src/types.ts'

/** A finished `shot.render_ref2va` record with the given ID and `based_on`, changed by `overrides`. */
function record(id: string, basedOn: string | null, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: brandString<RecordId>(id), parents: [], kind: 'operation', component: 'shot', operation: 'shot.render_ref2va',
    operation_version: '1', actor: 'user', surface: 'canvas', turn: null, session: null, tool_call: null, intent: id, params: {},
    inputs: [], outputs: [], based_on: basedOn === null ? null : brandString<RecordId>(basedOn), supersedes: [], deterministic: false,
    status: 'done', created_at: '2026-10-06T00:00:00Z', ...overrides,
  }
}

/** The slice after reducing `records` in order. */
function reduceAll(records: ProjectRecord[]): ShotState {
  return records.reduce((slice, item) => shotReducer.reduce(slice, item), shotReducer.initial())
}

describe('shot reducer', () => {
  it('groups takes under the root record of their based_on chain', () => {
    const t2va = { operation: 'shot.render_t2va' }
    const slice = reduceAll([record('r1', null), record('r2', 'r1'), record('r3', 'r2', t2va), record('s1', null, t2va), record('s2', 's1')])
    expect(slice).toEqual({ takes: { r1: ['r1', 'r2', 'r3'], s1: ['s1', 's2'] }, roots: { r2: 'r1', r3: 'r1', s2: 's1' } })
  })

  it('ignores unfinished takes and records of other operations', () => {
    const initial = shotReducer.initial()
    expect(initial).toEqual({ takes: {}, roots: {} })
    for (const other of [
      record('r2', 'r1', { status: 'running' }),
      record('r2', 'r1', { status: 'failed' }),
      record('p2', 'p1', { component: 'plan', operation: 'plan.update' }),
    ]) expect(shotReducer.reduce(initial, other)).toBe(initial)
  })
})
