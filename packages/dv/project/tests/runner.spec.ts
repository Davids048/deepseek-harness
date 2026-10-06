/**
 * Tests of the operation runner: recorded runs, the turn's request record, refusals before any write, failures,
 * deterministic reuse, read-only operations, confirmation of agent renders, the lock scope during execution, and the
 * recovery of records an earlier process left unfinished.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectModules } from './support.ts'
import { agentOrigin, createTestProject, readLines, startModules, userOrigin } from './support.ts'
import { Drafts } from '../src/drafts.ts'
import { RecordStore } from '../src/record-store.ts'
import { projReducer, ReducerRegistry } from '../src/reducers.ts'
import { Runner } from '../src/runner.ts'
import { Scheduler } from '../src/scheduler.ts'
import { MAIN_BRANCH } from '../src/shared.ts'
import type {
  ApprovalChannel, AssetId, OperationSpec, PendingApproval, ProjectId, ProjectRecord, RecordOrigin, RunRequest,
} from '../src/types.ts'

/**
 * An operation spec with test defaults: one optional `prompt` and `seed` parameter, the `reference` input role, no
 * confirmation, not deterministic, unlimited resource, and an execute function that creates nothing.
 * @param overrides - the fields to set; `name` and `component` are required.
 * @returns the spec.
 */
function operation(overrides: Partial<OperationSpec> & Pick<OperationSpec, 'name' | 'component'>): OperationSpec {
  return {
    version: '1', params: { prompt: { type: 'string' }, seed: { type: 'integer' } }, inputRoles: ['reference'], confirm: 'never',
    deterministic: false, resource: 'none', execute: () => Promise.resolve({ outputs: [] }), ...overrides,
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
 * @returns the text of the project's `records.jsonl` and `branches.json`.
 */
function files(m: ProjectModules, project: ProjectId): string {
  return readFileSync(join(m.root, project, 'records.jsonl'), 'utf8') + readFileSync(join(m.root, project, 'branches.json'), 'utf8')
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

  it('writes the turn\'s request record once', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    m.runner.registerOperation(operation({ name: 'timeline.clip_insert', component: 'timeline' }))

    const origin = agentOrigin('turn-1')
    await m.runner.run(request(project, 'timeline.clip_insert', origin, { request_text: 'cut the kite scene in two' }))
    await m.runner.run(request(project, 'timeline.clip_insert', origin, { request_text: 'cut the kite scene in two' }))

    const records = m.store.listRecords(project)
    const requests = records.filter(record => record.kind === 'request')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      component: 'proj', operation: null, actor: 'user', surface: 'chat', intent: 'cut the kite scene in two', status: 'done',
    })
    const firstOperation = records.findIndex(record => record.operation === 'timeline.clip_insert')
    expect(records.indexOf(requests[0] as ProjectRecord)).toBe(firstOperation - 1)
    expect(records[firstOperation]?.parents).toEqual([requests[0]?.id])
  })

  it('adds the records an operation replaces to the record\'s supersedes', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    m.runner.registerOperation(operation({ name: 'timeline.clip_insert', component: 'timeline' }))
    const first = (await m.runner.run(request(project, 'timeline.clip_insert'))).record!
    const second = (await m.runner.run(request(project, 'timeline.clip_insert'))).record!
    const seen: string[] = []
    // The spec replaces the head of the state it is given, which is the working branch before the call.
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

    // Agent calls: a refused call must not open the session's draft either.
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

  it('asks before an agent render in ask-first mode', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    m.runner.registerOperation(operation({
      name: 'shot.render', component: 'shot', confirm: 'agent_ask_first', estimate: () => ({ gpu_seconds: 40 }),
    }))
    const approvals: Array<{ approval: PendingApproval; answer: (approved: boolean) => void }> = []
    m.runner.registerApprovalChannel({
      asksFirst: () => true,
      requestApproval: approval => new Promise((resolve) => {
        approvals.push({ approval, answer: resolve })
        approval.signal.addEventListener('abort', () => { resolve(false) })
      }),
    })

    // Approved: the record waits pending until the card answers, then runs.
    const approved = m.runner.run(request(project, 'shot.render', agentOrigin()))
    await vi.waitFor(() => { expect(approvals).toHaveLength(1) })
    const card = approvals[0]
    expect(card?.approval.gpu_seconds).toBe(40)
    expect(m.store.getRecord(project, card?.approval.record.id as ProjectRecord['id']).status).toBe('pending')
    card?.answer(true)
    expect((await approved).record?.status).toBe('done')

    // Skipped: the record ends cancelled without running.
    const skipped = m.runner.run(request(project, 'shot.render', agentOrigin()))
    await vi.waitFor(() => { expect(approvals).toHaveLength(2) })
    approvals[1]?.answer(false)
    expect((await skipped).record).toMatchObject({ status: 'cancelled', error: { code: 'skipped' } })

    // Stopped: aborting the turn's signal ends the wait.
    const stop = new AbortController()
    const stopped = m.runner.run(request(project, 'shot.render', agentOrigin(), { signal: stop.signal }))
    await vi.waitFor(() => { expect(approvals).toHaveLength(3) })
    stop.abort()
    expect((await stopped).record).toMatchObject({ status: 'cancelled', error: { code: 'stopped' } })

    // An already-aborted signal shows no card.
    const early = await m.runner.run(request(project, 'shot.render', agentOrigin(), { signal: AbortSignal.abort() }))
    expect(early.record).toMatchObject({ status: 'cancelled', error: { code: 'stopped' } })
    expect(approvals).toHaveLength(3)
  })

  it('does not ask for human calls or in direct mode', async () => {
    const m = startModules()
    const project = await createTestProject(m)
    m.runner.registerOperation(operation({ name: 'shot.render', component: 'shot', confirm: 'agent_ask_first' }))
    let asksFirst = true
    const requestApproval = vi.fn<ApprovalChannel['requestApproval']>(() => Promise.resolve(false))
    m.runner.registerApprovalChannel({ asksFirst: () => asksFirst, requestApproval })

    const human = await m.runner.run(request(project, 'shot.render', userOrigin()))
    asksFirst = false
    const direct = await m.runner.run(request(project, 'shot.render', agentOrigin()))

    expect(human.record?.status).toBe('done')
    expect(direct.record?.status).toBe('done')
    expect(requestApproval).not.toHaveBeenCalled()
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
      const head = m.store.getBranch(project, MAIN_BRANCH)?.head as ProjectRecord['id']
      const record = m.store.append(project, {
        parents: [head], branch: MAIN_BRANCH, kind: 'operation', component: 'shot', operation: 'shot.render', operation_version: '1',
        ...userOrigin(), params: {}, inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: false, status: 'pending',
      })
      return status === 'running' ? m.store.update(project, { update: record.id, status: 'running' }) : record
    }))

    // A new process loads the same root and recovers.
    const store = new RecordStore(m.root, () => undefined)
    const reducers = new ReducerRegistry(store)
    const holder: { runner: Runner | null } = { runner: null }
    const scheduler = new Scheduler(store, (id, record) => (holder.runner as Runner).execute(id, record), { cpu: 1, gpu: 1 })
    holder.runner = new Runner({ store, drafts: new Drafts(store, reducers), reducers, scheduler, assets: m.assets })
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
