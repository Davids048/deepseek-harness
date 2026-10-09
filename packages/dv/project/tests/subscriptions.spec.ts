/** Subscriptions tests: delivery order, removal, delivery during changes to the listener set, and listener errors. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import { Subscriptions } from '../src/subscriptions.ts'
import type { ProjectEvent, ProjectId, RecordId } from '../src/types.ts'

const PROJECT = brandString<ProjectId>('project-1')
const OTHER_PROJECT = brandString<ProjectId>('project-2')
const EVENT: ProjectEvent = {
  kind: 'record',
  record: {
    id: brandString<RecordId>('record-1'), parents: [], kind: 'operation', component: 'proj', operation: 'proj.create',
    operation_version: '1', actor: 'user', surface: 'canvas', turn: null, session: null, tool_call: null, intent: 'create',
    params: {}, inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: true, status: 'done',
    created_at: '2026-01-01T00:00:00.000Z',
  },
}

describe('Subscriptions', () => {
  it('delivers events in subscription order and stops after removal', () => {
    const subscriptions = new Subscriptions()
    const calls: string[] = []
    const removeFirst = subscriptions.subscribe(PROJECT, () => { calls.push('first') })
    subscriptions.subscribe(PROJECT, () => { calls.push('second') })
    subscriptions.subscribe(OTHER_PROJECT, () => { calls.push('other project') })

    subscriptions.emit(PROJECT, EVENT)
    expect(calls).toEqual(['first', 'second'])

    removeFirst()
    removeFirst()
    subscriptions.emit(PROJECT, EVENT)
    expect(calls).toEqual(['first', 'second', 'second'])
  })

  it('delivers the current event to the listeners subscribed when delivery started', () => {
    const subscriptions = new Subscriptions()
    const calls: string[] = []
    let removeSecond = (): void => undefined
    subscriptions.subscribe(PROJECT, () => {
      calls.push('first')
      removeSecond()
      subscriptions.subscribe(PROJECT, () => { calls.push('added') })
    })
    removeSecond = subscriptions.subscribe(PROJECT, () => { calls.push('second') })

    subscriptions.emit(PROJECT, EVENT)
    expect(calls).toEqual(['first', 'second'])
  })

  it('keeps delivering when a listener throws', () => {
    const subscriptions = new Subscriptions()
    const errors: unknown[] = []
    subscriptions.onListenerError = (error) => { errors.push(error) }
    const failure = new Error('listener failed')
    const received: ProjectEvent[] = []
    subscriptions.subscribe(PROJECT, () => { throw failure })
    subscriptions.subscribe(PROJECT, (event) => { received.push(event) })

    subscriptions.emit(PROJECT, EVENT)
    expect(received).toEqual([EVENT])
    expect(errors).toEqual([failure])
  })
})
