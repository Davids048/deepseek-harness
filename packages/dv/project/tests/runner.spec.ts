/**
 * Tests of the operation runner: recorded runs, refusals before any write, failures, deterministic reuse, read-only
 * operations, runs of operations that ask for confirmation, the lock scope during execution, and the recovery of
 * records an earlier process left unfinished.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectModules } from './support.ts'
import { agentOrigin, createTestProject, readLines, startModules, userOrigin } from './support.ts'
import { RecordStore } from '../src/record-store.ts'
import { projReducer, ReducerRegistry } from '../src/reducers.ts'
import { Runner } from '../src/runner.ts'
import { Scheduler } from '../src/scheduler.ts'
import type {
  AssetId, OperationSpec, ProjectId, ProjectRecord, RecordOrigin, RunRequest,
} from '../src/types.ts'

/**
 * An operation spec with test defaults: one optional `prompt` and `seed` parameter, the `reference` input role, no
 * confirmation, not deterministic, unlimited resource, and an execute function that creates nothing.
 * @param overrides - the fields to set; `name` and `component` are required.
 * @returns the spec.
 */
function operation(overrides: Partial<OperationSpec> & Pick<OperationSpec, 'name' | 'component'>): OperationSpec {
  return {
    version: '1', params: { prompt: { type: 'string' }, seed: { type: 'integer' } }, confirm: 'never',
    inputs: { reference: { type: 'image', description: 'A reference.', many: true } }, outputs: [], description: 'A test operation.',
    summarize: () => 'ran', deterministic: false, resource: 'none', execute: () => Promise.resolve({ outputs: [] }), ...overrides,
  }
}

/**
 * A run request with test defaults.
 * @param project - the project.
 * @param name - the operation name.
 * @param origin - who runs it.
 * @param extra - other request fields.
 * @returns the request.
 */
function request(project: ProjectId, name: string, origin: RecordOrigin = userOrigin(), extra: Partial<RunRequest> = {}): RunRequest {
  return { project, operation: name, params: { prompt: 'a red kite' }, inputs: [], ...origin, ...extra }
}

/** @returns a promise with its resolve function, for holding an execute or an approval until the test releases it. */
function gate<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/**
 * @param m - the modules.
 * @param project - the project.
 * @returns the text of the project's `records.jsonl`.
 */
function files(m: ProjectModules, project: ProjectId): string {
  return readFileSync(join(m.root, project, 'records.jsonl'), 'utf8')
}

/**
 * @param m - the modules.
 * @param project - the project.
 * @param name - an operation name.
 * @returns the project's records of that operation, in write order.
 */
function recordsOf(m: ProjectModules, project: ProjectId, name: string): ProjectRecord[] {
  return m.store.listRecords(project).filter(record => record.operation === name)
}

describe('Runner', () => {
  it('runs an operation and records its outputs', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    m.runner.registerOperation(operation({
      name: 'shot.render', component: 'shot', resource: 'gpu',
      execute: async (context) => {
        await new Promise(resolve => setTimeout(resolve, 20))
        const take = context.importAsset(Buffer.from('take of a red kite'), { mime: 'video/mp4', name: 'take.mp4', durationSec: 2 })
        return { outputs: [take], report: { seed: 7 }, cost: { gpu_seconds: 3 } }
      },
    }))

    const result = await m.runner.run(request(project, 'shot.render'))

    const record = result.record
    expect(record?.status).toBe('done')
    expect(record?.outputs).toHaveLength(1)
    expect(result.outputs).toEqual(record?.outputs)
    expect(result.report).toEqual({ seed: 7 })
    expect(record?.report).toEqual({ seed: 7 })
    expect(record?.cost?.reused).toBe(false)
    expect(record?.cost?.gpu_seconds).toBe(3)
    expect(record?.cost?.wall_seconds).toBeGreaterThan(0)
    expect(m.assets.created.get(record?.outputs[0] as AssetId)).toBe(record?.id)
    const lines = readLines(m.root, project).filter(line => line['id'] === record?.id || line['update'] === record?.id)
    expect(lines.map(line => line['status'])).toEqual(['pending', 'running', 'done'])
  })

  it('adds the records an operation replaces to the record\'s supersedes', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    m.runner.registerOperation(operation({ name: 'timeline.clip_insert', component: 'timeline' }))
    const first = (await m.runner.run(request(project, 'timeline.clip_insert'))).record!
    const second = (await m.runner.run(request(project, 'timeline.clip_insert'))).record!
    const seen: string[] = []
    // The spec replaces the head of the state it is given, which is the project's state before the call.
    m.runner.registerOperation(operation({
      name: 'bible.character_update', component: 'bible',
      supersedes: (params, state) => {
        seen.push(String(params.prompt))
        return [state.head]
      },
    }))
    const update = await m.runner.run(request(project, 'bible.character_update', userOrigin(), { supersedes: [first.id, second.id] }))
    expect(seen).toEqual(['a red kite'])
    expect(update.record?.supersedes).toEqual([first.id, second.id])
    const next = await m.runner.run(request(project, 'bible.character_update'))
    expect(next.record?.supersedes).toEqual([update.record?.id])
  })

  it('refuses invalid params, unknown inputs and unfinished inputs before writing', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const held = gate()
    m.runner.registerOperation(operation({
      name: 'shot.render', component: 'shot',
      execute: async (context) => {
        await held.promise
        return { outputs: [context.importAsset(Buffer.from('take'), { mime: 'video/mp4', name: 'take.mp4' })] }
      },
    }))
    const running = m.runner.run(request(project, 'shot.render'))
    await vi.waitFor(() => { expect(recordsOf(m, project, 'shot.render')[0]?.status).toBe('running') })
    const producer = recordsOf(m, project, 'shot.render')[0] as ProjectRecord
    const before = files(m, project)
    const eventCount = m.events.length

    // Agent calls are refused the same way.
    const agent = agentOrigin()
    const refusals: Array<[Partial<RunRequest>, string]> = [
      [{ params: { prompt: 5 } }, 'invalid_params'],
      [{ inputs: [{ role: 'mask', ref: { asset: m.assets.add('mask') } }] }, 'invalid_inputs'],
      [{ inputs: [{ role: 'reference', ref: { asset: brandString<AssetId>('no-such-asset') } }] }, 'unknown_asset'],
      [{ inputs: [{ role: 'reference', ref: { record: producer.id, output: 0 } }] }, 'input_not_ready'],
    ]
    for (const [extra, code] of refusals) {
      await expect(m.runner.run(request(project, 'shot.render', agent, extra))).rejects.toMatchObject({ code })
    }
    await expect(m.runner.run(request(project, 'unregistered', agent))).rejects.toMatchObject({ code: 'unknown_operation' })

    expect(files(m, project)).toBe(before)
    expect(m.events).toHaveLength(eventCount)
    held.resolve()
    expect((await running).record?.status).toBe('done')
  })

  it('refuses a call that the operation\'s precondition refuses, before writing', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const seen: string[] = []
    const precondition = (call: RunRequest, state: { head: string }): Promise<void> => {
      seen.push(state.head)
      return call.params['prompt'] === 'refuse' ? Promise.reject(new Error('This shot has no reference image.')) : Promise.resolve()
    }
    m.runner.registerOperation(operation({ name: 'shot.render', component: 'shot', precondition }))
    m.runner.registerOperation(operation({ name: 'inspect.image', component: 'inspect', readOnly: true, precondition }))
    const before = files(m, project)
    const head = m.store.line(project)?.at
    const eventCount = m.events.length

    // An agent call that is refused writes nothing; a read-only call is refused the same way.
    for (const name of ['shot.render', 'inspect.image']) {
      await expect(m.runner.run(request(project, name, agentOrigin(), { params: { prompt: 'refuse' } })))
        .rejects.toThrow('This shot has no reference image.')
    }
    expect(files(m, project)).toBe(before)
    expect(m.events).toHaveLength(eventCount)
    expect(seen).toEqual([head, head])
    expect((await m.runner.run(request(project, 'shot.render'))).record?.status).toBe('done')
  })

  it('fails the record when execute throws', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    m.runner.registerOperation(operation({
      name: 'shot.render', component: 'shot', execute: () => Promise.reject(new Error('The renderer ran out of memory.')),
    }))

    const result = await m.runner.run(request(project, 'shot.render'))

    expect(result.record).toMatchObject({
      status: 'failed', error: { code: 'operation_failed', message: 'The renderer ran out of memory.' },
    })
    expect(result.outputs).toEqual([])
    expect(m.store.getRecord(project, result.record?.id as ProjectRecord['id']).finished_at).toBeDefined()
  })

  it('reuses outputs of an identical deterministic call', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    let calls = 0
    m.runner.registerOperation(operation({
      name: 'asset.grab_still', component: 'asset', deterministic: true,
      execute: (context) => {
        calls += 1
        const still = context.importAsset(Buffer.from(`still ${String(calls)}`), { mime: 'image/png', name: 'still.png' })
        return Promise.resolve({ outputs: [still] })
      },
    }))
    const video = m.assets.add('a video')
    const inputs: RunRequest['inputs'] = [{ role: 'reference', ref: { asset: video } }]

    const first = await m.runner.run(request(project, 'asset.grab_still', userOrigin(), { params: { prompt: 'frame', seed: 1 }, inputs }))
    const second = await m.runner.run(request(project, 'asset.grab_still', userOrigin(), { params: { seed: 1, prompt: 'frame' }, inputs }))

    expect(calls).toBe(1)
    expect(second.record).toMatchObject({ status: 'done', cost: { gpu_seconds: 0, wall_seconds: 0, reused: true } })
    expect(second.outputs).toEqual(first.outputs)
    expect(second.record?.started_at).toBeUndefined()
  })

  it('writes no record for a read-only operation', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const seen: Array<ProjectRecord | null> = []
    m.runner.registerOperation(operation({
      name: 'inspect.image', component: 'inspect', readOnly: true,
      execute: (context) => {
        seen.push(context.record)
        return Promise.resolve({ outputs: [], report: { caption: 'a red kite over a beach' } })
      },
    }))
    const before = files(m, project)

    const result = await m.runner.run(request(project, 'inspect.image', agentOrigin(), {
      inputs: [{ role: 'reference', ref: { asset: m.assets.add('an image') } }],
    }))

    expect(result).toEqual({ record: null, outputs: [], report: { caption: 'a red kite over a beach' } })
    expect(seen).toEqual([null])
    expect(files(m, project)).toBe(before)
  })

  it('runs an operation that asks for confirmation at once for every caller, holding no call', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    m.runner.registerOperation(operation({
      name: 'shot.render_ref2va', component: 'shot', confirm: 'over_gpu_budget', estimate: () => ({ gpu_seconds: 400 }),
      confirmSummary: () => ({ text: 'render', gpu_seconds: 400 }),
    }))
    m.runner.registerOperation(operation({
      name: 'plan.approve', component: 'plan', confirm: 'always', confirmSummary: () => ({ text: 'approve', gpu_seconds: 0 }),
    }))
    // The agent's agreement is checked by the operation's tool; the run path itself never waits for it.
    expect((await m.runner.run(request(project, 'shot.render_ref2va', agentOrigin()))).record?.status).toBe('done')
    expect((await m.runner.run(request(project, 'plan.approve', agentOrigin()))).record?.status).toBe('done')
    expect((await m.runner.run(request(project, 'plan.approve', userOrigin()))).record?.status).toBe('done')
    expect(() => m.runner.registerOperation(operation({ name: 'shot.render_t2va', component: 'shot', confirm: 'always' })))
      .toThrow(expect.objectContaining({ code: 'invalid_params' }))
  })

  it('refuses an operation whose name does not start with its component key', () => {
    const m = startModules()
    expect(() => m.runner.registerOperation(operation({ name: 'timeline.create', component: 'deliver' })))
      .toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(() => m.runner.registerOperation(operation({ name: 'shot', component: 'shot' })))
      .toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(m.runner.listOperations()).toEqual([])
  })

  it('lets other edits run while a render executes', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    const held = gate()
    m.runner.registerOperation(operation({
      name: 'shot.render', component: 'shot', resource: 'gpu',
      execute: async () => {
        await held.promise
        return { outputs: [] }
      },
    }))
    m.runner.registerOperation(operation({ name: 'timeline.clip_insert', component: 'timeline' }))

    const render = m.runner.run(request(project, 'shot.render'))
    await vi.waitFor(() => { expect(recordsOf(m, project, 'shot.render')[0]?.status).toBe('running') })
    const edit = await m.runner.run(request(project, 'timeline.clip_insert'))

    expect(edit.record?.status).toBe('done')
    expect(recordsOf(m, project, 'shot.render')[0]?.status).toBe('running')
    held.resolve()
    expect((await render).record?.status).toBe('done')
  })

  it('ends unfinished records at start', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    // An earlier process wrote one pending and one running record, then stopped.
    const unfinished = await m.store.lock(project, () => ['pending', 'running'].map((status) => {
      const head = m.store.line(project)!.at
      const record = m.store.append(project, {
        parents: [head], kind: 'operation', component: 'shot', operation: 'shot.render', operation_version: '1',
        ...userOrigin(), params: {}, inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: false, status: 'pending',
      })
      return status === 'running' ? m.store.update(project, { update: record.id, status: 'running' }) : record
    }))

    // A new process loads the same root and recovers.
    const store = new RecordStore(m.root, () => undefined)
    const reducers = new ReducerRegistry(store)
    const holder: { runner: Runner | null } = { runner: null }
    const scheduler = new Scheduler(store, (id, record) => (holder.runner as Runner).execute(id, record), { cpu: 1, gpu: 1 })
    holder.runner = new Runner({ store, reducers, scheduler, assets: m.assets })
    store.load()
    reducers.register('proj', projReducer)
    await holder.runner.recover()
    scheduler.dispose()

    for (const record of unfinished) {
      expect(store.getRecord(project, record.id)).toMatchObject({
        status: 'cancelled', error: { code: 'stopped', message: 'The server stopped before the call finished.' },
      })
    }
    expect(readLines(m.root, project).filter(line => line['status'] === 'cancelled')).toHaveLength(2)
  })
})
