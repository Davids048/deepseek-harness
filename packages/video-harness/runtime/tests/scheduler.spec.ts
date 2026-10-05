import { brandString } from '@deepseek-ai/dsh-brand'
import { MAIN_BRANCH, type AssetId, type OpId, type ProjectId, type TurnId } from '@video-harness/oplog'
import { afterEach, describe, expect, it } from 'vitest'
import { ffmpegAvailable, RuntimeError, type InvokeRequest, type RuntimeToolSpec } from '../src/index.ts'
import { FFMPEG, startRuntime, type RuntimeFixture } from './support.ts'

const fixtures: RuntimeFixture[] = []
const user = { actor: 'user' as const, surface: 'chat' as const }
const agent = { actor: 'agent' as const, surface: 'chat' as const }
const hasFfmpeg = await ffmpegAvailable(FFMPEG)

async function start(options: Parameters<typeof startRuntime>[0] = {}): Promise<RuntimeFixture> {
  const fixture = await startRuntime(options)
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

function request(tool: string, turn: TurnId, params: Record<string, unknown> = {}, inputs: InvokeRequest['inputs'] = []): InvokeRequest {
  return { tool, inputs, params, ...agent, intent: tool, turn }
}

/** A project with one uploaded image registered as character c1@1. */
async function projectWithCharacter(fixture: RuntimeFixture): Promise<{ projectId: ProjectId; image: AssetId; turn: TurnId }> {
  const projectId = fixture.project.createProject({ title: 'p' })
  const turn = fixture.project.beginTurn(projectId, { ...user, intent: 'start' }).turn
  const upload = await fixture.project.invoke(projectId, { tool: 'asset.upload', inputs: [], params: { path: fixture.writeImage('a.png'), mime: 'image/png' }, ...user, intent: 'upload', turn })
  const image = upload.outputs[0] as AssetId
  await fixture.project.invoke(projectId, { tool: 'entity.create', inputs: [], params: { entity: 'c1', name: 'A', refs: [image] }, ...user, intent: 'character', turn })
  return { projectId, image, turn }
}

/** A tool that records its calls and settles when told to. */
function gate(name: string, cost?: RuntimeToolSpec['cost']): { spec: RuntimeToolSpec; started: string[]; release(): void } {
  const waiters: Array<() => void> = []
  const started: string[] = []
  return {
    started,
    release: () => { for (const resolve of waiters.splice(0)) resolve() },
    spec: {
      name, version: '1', deterministic: false, ...cost === undefined ? {} : { cost },
      execute(execution) {
        const label = execution.params['label']
        started.push(typeof label === 'string' ? label : execution.op.id)
        return new Promise((resolve) => { waiters.push(() => { resolve({ outputs: [] }) }) })
      },
    },
  }
}

describe.skipIf(!hasFfmpeg)('scheduler', () => {
  it('runs queued records once their producers finish, resolving output references late', async () => {
    const fixture = await start()
    const { projectId, turn } = await projectWithCharacter(fixture)
    const shot = fixture.project.schedule(projectId, request('generate.video', turn, { prompt: 'one', durationSec: 1 }, [{ role: 'reference', ref: 'c1@1' }]))
    expect(shot.status).toBe('pending')
    const trim = fixture.project.schedule(projectId, request('clip.trim', turn, { startSec: 0.2 }, [{ role: 'clip', ref: `${shot.id}#0` }]))
    expect(trim.inputs[0]?.resolved).toBeNull()
    // An immediate invoke on the same unfinished output is refused and recorded as failed.
    await expect(fixture.project.invoke(projectId, request('clip.trim', turn, { startSec: 0.1 }, [{ role: 'clip', ref: `${shot.id}#0` }]))).rejects.toThrow(RuntimeError)
    expect(fixture.project.fold(projectId).ops.at(-1)?.status).toBe('failed')
    await fixture.project.whenIdle(projectId)
    await fixture.project.whenIdle(projectId)
    const done = fixture.log.get(projectId, trim.id)
    expect(done.status).toBe('done')
    expect(done.inputs[0]?.resolved).toBe(fixture.log.get(projectId, shot.id).outputs[0])
    expect(fixture.assets.get(done.outputs[0] as AssetId).mime).toBe('video/mp4')
    // A reference to an output the producer never wrote fails the consumer when it runs.
    const missing = fixture.project.schedule(projectId, request('clip.trim', turn, { startSec: 0.2 }, [{ role: 'clip', ref: `${shot.id}#7` }]))
    await fixture.project.whenIdle(projectId)
    expect(fixture.log.get(projectId, missing.id).status).toBe('failed')
    expect(fixture.log.get(projectId, missing.id).error).toContain('has no output 7')
  })

  it('fails consumers of a failed producer and honours `after`', async () => {
    const fixture = await start()
    const { projectId, turn } = await projectWithCharacter(fixture)
    const broken = fixture.project.schedule(projectId, request('clip.trim', turn, { startSec: 0 }))
    const consumer = fixture.project.schedule(projectId, request('sequence.create', turn, {}, [{ role: 'clip', ref: `${broken.id}#0` }]))
    const after = fixture.project.schedule(projectId, request('plan.create', turn, { plan: {} }), { after: [broken.id] })
    await fixture.project.whenIdle(projectId)
    expect(fixture.log.get(projectId, broken.id).status).toBe('failed')
    expect(fixture.log.get(projectId, consumer.id).status).toBe('failed')
    expect(fixture.log.get(projectId, consumer.id).error).toContain(`Upstream record '${broken.id}' failed`)
    expect(fixture.log.get(projectId, after.id).error).toContain('Upstream')
  })

  it('limits each cost class and defaults unlabelled tools to the cpu class', async () => {
    const fixture = await start({ builtinTools: false })
    const projectId = fixture.project.createProject({ title: 'bare' })
    const turn = fixture.project.beginTurn(projectId, { ...user, intent: 'start' }).turn
    const gpu = gate('slow.gpu', 'gpu')
    const cpu = gate('slow.cpu')
    fixture.project.registerTool(gpu.spec)
    fixture.project.registerTool(cpu.spec)
    const first = fixture.project.schedule(projectId, request('slow.gpu', turn, { label: 'g1' }))
    const second = fixture.project.schedule(projectId, request('slow.gpu', turn, { label: 'g2' }))
    for (let index = 0; index < 5; index += 1) fixture.project.schedule(projectId, request('slow.cpu', turn, { label: `c${index}` }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(gpu.started).toEqual(['g1'])
    expect(cpu.started).toEqual(['c0', 'c1', 'c2', 'c3'])
    expect(fixture.log.get(projectId, first.id).status).toBe('running')
    expect(fixture.log.get(projectId, second.id).status).toBe('pending')
    gpu.release()
    cpu.release()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(gpu.started).toEqual(['g1', 'g2'])
    expect(cpu.started).toHaveLength(5)
    gpu.release()
    cpu.release()
    await fixture.project.whenIdle(projectId)
    expect(fixture.project.fold(projectId).ops.filter(op => op.status === 'done' && op.kind === 'tool')).toHaveLength(7)
  })

  it('schedules an approved plan as chained shots plus a sequence, and as independent shots', async () => {
    const fixture = await start()
    const { projectId, turn } = await projectWithCharacter(fixture)
    const plan = await fixture.project.invoke(projectId, request('plan.create', turn, {
      plan: { continuity: 'chained', references: ['c1@1'], seed: 5, aspect_ratio: '16:9', shots: [{ prompt: 'one', duration_sec: 1 }, { prompt: 'two', duration_sec: 1, seed: 9, references: [] }] },
    }))
    const approve = await fixture.project.invoke(projectId, request('plan.approve', turn, { plan: plan.id }))
    expect(approve.kind).toBe('approve')
    await fixture.project.whenIdle(projectId)
    let state = fixture.project.fold(projectId)
    const shots = state.ops.filter(op => op.tool?.name === 'generate.video')
    expect(shots.map(op => op.status)).toEqual(['done', 'done'])
    expect(shots[0]?.params).toMatchObject({ prompt: 'one', plan: plan.id, shot: 1, seed: 5, aspect_ratio: '16:9', duration_sec: 1 })
    expect(shots[0]?.inputs.map(input => input.role)).toEqual(['reference'])
    expect(shots[1]?.params).toMatchObject({ seed: 9 })
    expect(shots[1]?.inputs).toEqual([{ role: 'first_frame', ref: `${shots[0]?.id}#1`, resolved: shots[0]?.outputs[1] }])
    expect(state.sequence?.items.map(item => item.assetId)).toEqual(shots.map(op => op.outputs[0]))
    expect(state.plans[0]).toMatchObject({ op: plan.id, approved: true, approvedBy: approve.id })
    const independent = await fixture.project.invoke(projectId, request('plan.create', turn, { plan: { shots: [{ prompt: 'a' }, { prompt: 'b' }] } }))
    await fixture.project.invoke(projectId, request('plan.approve', turn, { plan: independent.id }))
    await fixture.project.whenIdle(projectId)
    state = fixture.project.fold(projectId)
    const later = state.ops.filter(op => op.tool?.name === 'generate.video').slice(2)
    expect(later.every(op => op.inputs.length === 0 && op.status === 'done')).toBe(true)
    // Approving a record that stored no plan is refused before anything is recorded.
    const empty = await fixture.project.invoke(projectId, request('sequence.move', turn, { from: 1, to: 2 }))
    const count = fixture.log.all(projectId).length
    await expect(fixture.project.invoke(projectId, request('plan.approve', turn, { plan: empty.id }))).rejects.toThrow('stored no plan document')
    expect(fixture.log.all(projectId)).toHaveLength(count)
  })

  it('replays deterministic consumers and repoints sequence slots when a record is superseded', async () => {
    const fixture = await start()
    const { projectId, turn, image } = await projectWithCharacter(fixture)
    const shot1 = await fixture.project.invoke(projectId, request('generate.video', turn, { prompt: 'one', durationSec: 1 }, [{ role: 'reference', ref: 'c1@1' }]))
    const shot2 = await fixture.project.invoke(projectId, request('generate.video', turn, { prompt: 'two', durationSec: 1 }, [{ role: 'first_frame', ref: shot1.outputs[1] as AssetId }]))
    const trim = await fixture.project.invoke(projectId, request('clip.trim', turn, { startSec: 0.2 }, [{ role: 'clip', ref: shot1.outputs[0] as AssetId }]))
    const refTrim = await fixture.project.invoke(projectId, request('clip.trim', turn, { startSec: 0.1 }, [{ role: 'clip', ref: 'c1@1' }])).catch(() => null)
    await fixture.project.invoke(projectId, request('sequence.create', turn, { assets: [trim.outputs[0], shot2.outputs[0], shot1.outputs[0]] }))
    // A deterministic consumer whose tool is gone is left alone, as is one without outputs; one with an entity input
    // keeps that reference on replay and keeps inputs the replacement did not touch.
    const derive: RuntimeToolSpec = { name: 'derive', version: '1', deterministic: true, execute: execution => Promise.resolve({ outputs: [execution.assets.put(Buffer.from(execution.inputs.map(input => input.resolved).join()), { mime: 'text/plain' })] }) }
    const removeGone = fixture.project.registerTool({ ...derive, name: 'gone' })
    const gone = await fixture.project.invoke(projectId, request('gone', turn, {}, [{ role: 'clip', ref: shot1.outputs[0] as AssetId }]))
    removeGone()
    const echo: RuntimeToolSpec = { name: 'echo', version: '1', deterministic: true, execute: () => Promise.resolve({ outputs: [] }) }
    fixture.project.registerTool(echo)
    const echoed = await fixture.project.invoke(projectId, request('echo', turn, {}, [{ role: 'clip', ref: shot1.outputs[0] as AssetId }]))
    fixture.project.registerTool(derive)
    const derived = await fixture.project.invoke(projectId, request('derive', turn, {}, [{ role: 'ref', ref: 'c1@1' }, { role: 'clip', ref: shot1.outputs[0] as AssetId }, { role: 'other', ref: shot2.outputs[0] as AssetId }]))
    const retake = await fixture.project.invoke(projectId, { ...request('generate.video', turn, { prompt: 'one again', durationSec: 1 }, [{ role: 'reference', ref: 'c1@1' }]), base_op: shot1.id, supersedes: [shot1.id] })
    await fixture.project.whenIdle(projectId)
    const state = fixture.project.fold(projectId)
    const replays = state.ops.filter(op => op.params['replayed_from'] !== undefined)
    const replayedTrim = replays.find(op => op.tool?.name === 'clip.trim')
    expect(replayedTrim).toMatchObject({ status: 'done', base_op: trim.id, supersedes: [trim.id], deterministic: true, actor: 'system' })
    expect(replayedTrim?.inputs[0]?.ref).toBe(retake.outputs[0])
    expect(replayedTrim?.cost?.cached).toBeUndefined()
    expect(replays.some(op => op.tool?.name === 'echo' || op.tool?.name === 'gone')).toBe(false)
    expect(replays.some(op => op.tool?.name === 'generate.video')).toBe(false)
    expect(replays.some(op => op.tool?.name === 'sequence.create')).toBe(false)
    expect(state.stale[gone.id]).toBeDefined()
    const replayedDerive = replays.find(op => op.tool?.name === 'derive')
    expect(replayedDerive?.inputs.map(input => input.ref)).toEqual(['c1@1', retake.outputs[0], shot2.outputs[0]])
    expect(replayedDerive?.base_op).toBe(derived.id)
    expect(state.superseded[trim.id]).toBe(replayedTrim?.id)
    expect(state.sequence?.items.map(item => item.assetId)).toEqual([replayedTrim?.outputs[0], shot2.outputs[0], retake.outputs[0]])
    expect(state.stale[shot2.id]).toBeDefined()
    expect(state.stale[echoed.id]).toBeDefined()
    expect(refTrim === null || state.stale[refTrim.id] === undefined).toBe(true)
    // Superseding a record without outputs replays nothing; replacing a clip that only the sequence shows repoints its slot.
    const before = fixture.log.all(projectId).length
    await fixture.project.invoke(projectId, { ...request('sequence.move', turn, { from: 1, to: 2 }), supersedes: [echoed.id] })
    const swap = await fixture.project.invoke(projectId, { ...request('asset.upload', turn, { path: fixture.writeImage('b.png'), mime: 'image/png' }), supersedes: [shot2.id] })
    await fixture.project.whenIdle(projectId)
    // Three records: the move, the upload, the slot repoint; plus one replay of `derive`, which read the replaced clip.
    expect(fixture.log.all(projectId).length).toBe(before + 4)
    expect(fixture.project.fold(projectId).sequence?.items.map(item => item.assetId)).toContain(swap.outputs[0])
    expect(image).toBeDefined()
  })

  it('serves the cache to scheduled deterministic records and ignores the replay marker in the key', async () => {
    const fixture = await start()
    const { projectId, turn } = await projectWithCharacter(fixture)
    const shot = await fixture.project.invoke(projectId, request('generate.video', turn, { prompt: 'one', durationSec: 1 }, [{ role: 'reference', ref: 'c1@1' }]))
    const trim = await fixture.project.invoke(projectId, request('clip.trim', turn, { startSec: 0.2 }, [{ role: 'clip', ref: shot.outputs[0] as AssetId }]))
    const again = fixture.project.schedule(projectId, request('clip.trim', turn, { startSec: 0.2, replayed_from: trim.id }, [{ role: 'clip', ref: `${shot.id}#0` }]))
    await fixture.project.whenIdle(projectId)
    expect(fixture.log.get(projectId, again.id)).toMatchObject({ status: 'done', outputs: trim.outputs, cost: { cached: true } })
    await fixture.project.whenIdle(projectId)
  })

  it('opens turns on exploration branches without drafts', async () => {
    const fixture = await start()
    const { projectId, turn } = await projectWithCharacter(fixture)
    fixture.project.createBranch(projectId, 'alt', MAIN_BRANCH)
    expect(() => fixture.project.beginTurn(projectId, { ...agent, intent: 'x', branch: 'ghost' })).toThrow(RuntimeError)
    const open = fixture.project.beginTurn(projectId, { ...agent, intent: 'explore', branch: 'alt' })
    expect(open).toMatchObject({ branch: 'alt', draft: false })
    const op = await fixture.project.invoke(projectId, request('plan.create', open.turn, { plan: { alt: true } }))
    expect(op.branch).toBe('alt')
    fixture.project.acceptTurn(projectId, open.turn)
    expect(fixture.project.openTurn(open.turn)).toBeUndefined()
    expect(fixture.project.fold(projectId).plans).toHaveLength(0)
    expect(fixture.project.fold(projectId, 'alt').plans).toHaveLength(1)
    expect(fixture.project.beginTurn(projectId, { ...agent, intent: 'draft' }).draft).toBe(true)
    expect(brandString<OpId>(turn)).toBe(turn)
  })
})

describe('scheduler disposal', () => {
  it('starts nothing after the plugin is disposed, even when a running record finishes later', async () => {
    const fixture = await start({ builtinTools: false })
    let release: () => void = () => {}
    const slow: RuntimeToolSpec = {
      name: 'slow', version: '1', deterministic: false, cost: 'gpu',
      execute: () => new Promise((resolve) => { release = () => { resolve({ outputs: [] }) } }),
    }
    fixture.project.registerTool(slow)
    const projectId = fixture.project.createProject({ title: 'late' })
    const turn = brandString<TurnId>('turn-late')
    const running = fixture.project.schedule(projectId, request('slow', turn, {}, []))
    const queued = fixture.project.schedule(projectId, request('slow', turn, {}, []))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fixture.log.get(projectId, running.id).status).toBe('running')
    await fixture.context.fiber.dispose()
    release()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fixture.log.get(projectId, queued.id).status).toBe('pending')
  })
})
