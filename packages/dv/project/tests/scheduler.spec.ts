/**
 * Tests of the scheduler: scheduled runs (`after`) start in dependency order, respect the `gpu` limit, fail without
 * running when a record they wait for failed, and `wait` settles when the project has nothing queued or running.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectModules } from './support.ts'
import { createTestProject, startModules, userOrigin } from './support.ts'
import type { OperationContext, OperationSpec, ProjectId, ProjectRecord, RecordId, RunRequest } from '../src/types.ts'

/**
 * An operation spec with test defaults: one optional `prompt` parameter, the `reference` input role, no confirmation,
 * not deterministic, and unlimited resource.
 * @param overrides - the fields to set; `name`, `component` and `execute` are required.
 * @returns the spec.
 */
function operation(overrides: Partial<OperationSpec> & Pick<OperationSpec, 'name' | 'component' | 'execute'>): OperationSpec {
  return {
    version: '1', params: { prompt: { type: 'string' } }, inputRoles: ['reference'], confirm: 'never', deterministic: false,
    resource: 'none', ...overrides,
  }
}

/** @returns a promise with its resolve function, for holding an execute until the test releases it. */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/**
 * Schedule one call as a human edit on `main`.
 * @param m - the modules.
 * @param project - the project.
 * @param name - the operation name.
 * @param prompt - the `prompt` parameter, which the test execute functions use as a label.
 * @param extra - other request fields; `after` defaults to none.
 * @returns the pending record.
 */
async function schedule(
  m: ProjectModules, project: ProjectId, name: string, prompt: string, extra: Partial<RunRequest> = {},
): Promise<ProjectRecord> {
  const result = await m.runner.run({ project, operation: name, params: { prompt }, inputs: [], after: [], ...userOrigin(), ...extra })
  expect(result.record?.status).toBe('pending')
  return result.record as ProjectRecord
}

/**
 * Create one output asset named after the call's prompt.
 * @param context - the execute context.
 * @returns the asset ID.
 */
function importTake(context: OperationContext): ReturnType<OperationContext['importAsset']> {
  return context.importAsset(Buffer.from(`take ${String(context.params['prompt'])}`), { mime: 'video/mp4', name: 'take.mp4' })
}

describe('Scheduler', () => {
  it('runs scheduled records in dependency order', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const order: string[] = []
    const seenInputs: OperationContext['inputs'][] = []
    const first = gate()
    m.runner.registerOperation(operation({
      name: 'shot.render', component: 'shot',
      execute: async (context) => {
        const prompt = String(context.params['prompt'])
        if (prompt === 'A') await first.promise
        order.push(prompt)
        seenInputs.push(context.inputs)
        return { outputs: [importTake(context)] }
      },
    }))

    const a = await schedule(m, project, 'shot.render', 'A')
    const b = await schedule(m, project, 'shot.render', 'B', { after: [a.id] })
    const c = await schedule(m, project, 'shot.render', 'C', { inputs: [{ role: 'reference', ref: { record: b.id, output: 0 } }] })
    expect(m.store.getRecord(project, c.id).inputs[0]?.resolved_asset).toBeNull()
    first.resolve()
    await m.scheduler.wait(project)

    expect(order).toEqual(['A', 'B', 'C'])
    const take = m.store.getRecord(project, b.id).outputs[0]
    expect(m.store.getRecord(project, c.id).inputs[0]?.resolved_asset).toBe(take)
    expect(seenInputs[2]?.[0]?.resolved_asset).toBe(take)
  })

  it('keeps at most one gpu record running', async () => {
    const m = startModules({ cpu: 4, gpu: 1 })
    const project = await createTestProject(m)
    const gates = new Map([['gpu 1', gate()], ['gpu 2', gate()]])
    const started: string[] = []
    let runningGpu = 0
    let mostGpu = 0
    m.runner.registerOperation(operation({
      name: 'shot.render', component: 'shot', resource: 'gpu',
      execute: async (context) => {
        const prompt = String(context.params['prompt'])
        started.push(prompt)
        runningGpu += 1
        mostGpu = Math.max(mostGpu, runningGpu)
        await gates.get(prompt)?.promise
        runningGpu -= 1
        return { outputs: [] }
      },
    }))
    m.runner.registerOperation(operation({
      name: 'timeline.clip_insert', component: 'timeline',
      execute: (context) => {
        started.push(String(context.params['prompt']))
        return Promise.resolve({ outputs: [] })
      },
    }))

    await schedule(m, project, 'shot.render', 'gpu 1')
    const second = await schedule(m, project, 'shot.render', 'gpu 2')
    const edit = await schedule(m, project, 'timeline.clip_insert', 'edit')

    await vi.waitFor(() => { expect(m.store.getRecord(project, edit.id).status).toBe('done') })
    expect(started).toEqual(['gpu 1', 'edit'])
    expect(m.store.getRecord(project, second.id).status).toBe('pending')
    gates.get('gpu 1')?.resolve()
    await vi.waitFor(() => { expect(started).toEqual(['gpu 1', 'edit', 'gpu 2']) })
    gates.get('gpu 2')?.resolve()
    await m.scheduler.wait(project)
    expect(mostGpu).toBe(1)
  })

  it('fails a record whose input record failed', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const held = gate()
    const executed: string[] = []
    m.runner.registerOperation(operation({
      name: 'shot.render', component: 'shot',
      execute: async (context) => {
        executed.push(String(context.params['prompt']))
        await held.promise
        throw new Error('The renderer ran out of memory.')
      },
    }))

    const a = await schedule(m, project, 'shot.render', 'A')
    const b = await schedule(m, project, 'shot.render', 'B', { inputs: [{ role: 'reference', ref: { record: a.id, output: 0 } }] })
    held.resolve()
    await m.scheduler.wait(project)

    expect(m.store.getRecord(project, a.id)).toMatchObject({ status: 'failed', error: { code: 'operation_failed' } })
    const failed = m.store.getRecord(project, b.id)
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'input_failed' } })
    expect(failed.error?.message).toContain(a.id)
    expect(executed).toEqual(['A'])
  })

  it('waits for every scheduled record of a project', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const followUps: RecordId[] = []
    m.runner.registerOperation(operation({
      name: 'plan.approve', component: 'plan',
      // Like a plan approval, the call schedules one more record while it runs.
      execute: async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        const scheduled = await m.runner.run({
          project, operation: 'shot.render', params: { prompt: 'shot 1' }, inputs: [], after: [], ...userOrigin(), actor: 'system',
        })
        followUps.push((scheduled.record as ProjectRecord).id)
        return { outputs: [] }
      },
    }))
    m.runner.registerOperation(operation({
      name: 'shot.render', component: 'shot', resource: 'gpu',
      execute: async (context) => {
        await new Promise(resolve => setTimeout(resolve, 20))
        return { outputs: [importTake(context)] }
      },
    }))

    const approve = await schedule(m, project, 'plan.approve', 'plan 1')
    await m.scheduler.wait(project)

    expect(m.store.getRecord(project, approve.id).status).toBe('done')
    expect(followUps).toHaveLength(1)
    expect(m.store.getRecord(project, followUps[0] as RecordId).status).toBe('done')
    await expect(m.scheduler.wait(project, [approve.id])).resolves.toBeUndefined()
    await expect(m.scheduler.wait(project, [brandString<RecordId>('no-such-record')])).rejects.toMatchObject({ code: 'unknown_record' })
  })
})
