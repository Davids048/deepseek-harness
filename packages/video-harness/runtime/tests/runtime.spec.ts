import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MAIN_BRANCH, type AssetId, type EntityId, type OpId, type ProjectId, type TurnId } from '@video-harness/oplog'
import { afterEach, describe, expect, it } from 'vitest'
import { ffmpegAvailable, RuntimeError, type InvokeRequest } from '../src/index.ts'
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

/** A project with one uploaded image registered as character c1@1. */
async function projectWithCharacter(fixture: RuntimeFixture): Promise<{ projectId: ProjectId; image: AssetId; turn: TurnId }> {
  const projectId = fixture.project.createProject({ title: 'p' })
  const turn = fixture.project.beginTurn(projectId, { ...user, intent: 'start' }).turn
  const upload = await fixture.project.invoke(projectId, { tool: 'asset.upload', inputs: [], params: { path: fixture.writeImage('a.png'), mime: 'image/png' }, ...user, intent: 'upload', turn })
  const image = upload.outputs[0] as AssetId
  await fixture.project.invoke(projectId, { tool: 'entity.create', inputs: [], params: { entity: 'c1', name: 'A', refs: [image] }, ...user, intent: 'character', turn })
  return { projectId, image, turn }
}

/** A project with a main head only, for fixtures without built-in tools. */
async function projectWithCharacterTools(fixture: RuntimeFixture): Promise<{ projectId: ProjectId; turn: TurnId }> {
  const projectId = fixture.project.createProject({ title: 'p' })
  const turn = fixture.project.beginTurn(projectId, { ...user, intent: 'start' }).turn
  return { projectId, turn }
}

function request(tool: string, turn: TurnId, params: Record<string, unknown> = {}, inputs: InvokeRequest['inputs'] = []): InvokeRequest {
  return { tool, inputs, params, ...agent, intent: tool, turn }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

describe('vhProject', () => {
  it('creates a project with a main head and lists the built-in tools', async () => {
    const fixture = await start()
    const projectId = fixture.project.createProject({ title: 'p' })
    const state = fixture.project.fold(projectId)
    expect(state.ops).toHaveLength(1)
    expect(state.ops[0]?.kind).toBe('intent')
    expect(fixture.project.toolNames()).toContain('generate.video')
    const bare = await start({ builtinTools: false })
    expect(bare.project.toolNames()).toEqual([])
    expect(() => fixture.project.fold(brandString<ProjectId>('missing'))).toThrow()
  })

  it('records uploads and entity versions, and resolves entity references to assets', async () => {
    const fixture = await start()
    const { projectId, image, turn } = await projectWithCharacter(fixture)
    const state = fixture.project.fold(projectId)
    expect(state.assets.has(image)).toBe(true)
    expect(state.entities[brandString<EntityId>('c1')]).toMatchObject([{ version: 1, refs: [image], name: 'A' }])
    const plan = await fixture.project.invoke(projectId, request('plan.create', turn, { plan: { shots: 1 } }))
    expect(plan.kind).toBe('plan')
    expect(fixture.assets.read(plan.outputs[0] as AssetId).toString()).toContain('"shots": 1')
    const emptyPlan = await fixture.project.invoke(projectId, request('plan.create', turn))
    expect(fixture.assets.read(emptyPlan.outputs[0] as AssetId).toString()).toBe('{}')
    const upload = await fixture.project.invoke(projectId, request('asset.upload', turn, { path: fixture.writeImage('named.png'), mime: 'image/png' }))
    expect(fixture.assets.get(upload.outputs[0] as AssetId).name).toBe('named.png')
    // A turn the runtime never opened writes to main.
    const stray = await fixture.project.invoke(projectId, request('plan.create', brandString<TurnId>('never-opened'), { plan: {} }))
    expect(stray.branch).toBe(MAIN_BRANCH)
    await expect(fixture.project.invoke(projectId, request('generate.video', turn, {}, [{ role: 'reference', ref: 'c1@9' }]))).rejects.toThrow(RuntimeError)
    await expect(fixture.project.invoke(projectId, request('generate.video', turn, {}, [{ role: 'reference', ref: brandString<AssetId>('0'.repeat(64)) }]))).rejects.toThrow(RuntimeError)
    await expect(fixture.project.invoke(projectId, request('nope', turn))).rejects.toThrow(RuntimeError)
    await expect(fixture.project.invoke(projectId, { ...request('asset.upload', turn), branch: 'ghost' })).rejects.toThrow(RuntimeError)
    await expect(fixture.project.invoke(projectId, request('entity.update', turn, { entity: 'c9', refs: [] }))).rejects.toThrow(RuntimeError)
  })

  it.skipIf(!hasFfmpeg)('generates placeholder clips, trims deterministically with a cache, and marks staleness', async () => {
    const fixture = await start()
    const { projectId, turn } = await projectWithCharacter(fixture)
    const shot1 = await fixture.project.invoke(projectId, request('generate.video', turn, { prompt: 'one', durationSec: 1 }, [{ role: 'reference', ref: 'c1@1' }]))
    expect(shot1.status).toBe('done')
    expect(shot1.inputs[0]?.resolved).toBeTruthy()
    const shot2 = await fixture.project.invoke(projectId, request('generate.video', turn, { prompt: 'two', durationSec: 1 }, [{ role: 'reference', ref: 'c1@1' }, { role: 'first_frame', ref: shot1.outputs[1] as AssetId }]))
    await fixture.project.invoke(projectId, request('sequence.create', turn, { assets: [shot1.outputs[0], shot2.outputs[0]] }))
    const trim = await fixture.project.invoke(projectId, request('clip.trim', turn, { startSec: 0.5 }, [{ role: 'clip', ref: shot1.outputs[0] as AssetId }]))
    expect(fixture.assets.get(trim.outputs[0] as AssetId).mime).toBe('video/mp4')
    const bounded = await fixture.project.invoke(projectId, request('clip.trim', turn, { startSec: 0.2, endSec: 0.6 }, [{ role: 'clip', ref: shot1.outputs[0] as AssetId }]))
    expect(bounded.outputs).toHaveLength(1)
    const again = await fixture.project.invoke(projectId, request('clip.trim', turn, { startSec: 0.5 }, [{ role: 'clip', ref: shot1.outputs[0] as AssetId }]))
    expect(again.cost?.cached).toBe(true)
    expect(again.outputs).toEqual(trim.outputs)
    await fixture.project.invoke(projectId, request('sequence.replace', turn, { slot: 1, asset: trim.outputs[0] }))
    await fixture.project.invoke(projectId, request('sequence.set_range', turn, { slot: 2, inSec: 0.2, outSec: 0.8 }))
    await fixture.project.invoke(projectId, request('sequence.insert', turn, { at: 1, asset: shot2.outputs[0] }))
    await fixture.project.invoke(projectId, request('sequence.move', turn, { from: 1, to: 3 }))
    let state = fixture.project.fold(projectId)
    expect(state.sequence?.items.map(item => item.slot)).toEqual([1, 2, 3])
    expect(state.sequence?.items[2]?.assetId).toBe(shot2.outputs[0])
    expect(state.sequence?.items[1]).toMatchObject({ inSec: 0.2, outSec: 0.8 })
    expect(Object.keys(state.stale)).toEqual([])
    // Replacing the character reference stales both shots and the trim, but not the sequence edits.
    const upload = await fixture.project.invoke(projectId, request('asset.upload', turn, { path: fixture.writeImage('b.png'), mime: 'image/png' }))
    const update = await fixture.project.invoke(projectId, request('entity.update', turn, { entity: 'c1', refs: upload.outputs }))
    expect(update.supersedes).toHaveLength(1)
    state = fixture.project.fold(projectId)
    expect(state.entities[brandString<EntityId>('c1')]?.at(-1)?.version).toBe(2)
    expect(state.stale[shot1.id]?.because).toBe(update.id)
    expect(state.stale[shot2.id]).toBeDefined()
    expect(state.stale[trim.id]).toBeDefined()
    const characterCreate = state.ops.find(op => op.tool?.name === 'entity.create')?.id as OpId
    expect(state.superseded).toEqual({ [characterCreate]: update.id })
    // A failing tool records the failure and rethrows.
    await expect(fixture.project.invoke(projectId, request('clip.trim', turn, { startSec: 0 }))).rejects.toThrow('clip.trim needs a `clip` input.')
    const failed = fixture.project.fold(projectId).ops.at(-1)
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toContain('clip')
  })

  it('opens draft turns, accepts by fast-forward, refuses when main moved, rejects, and undoes', async () => {
    const fixture = await start()
    const { projectId, turn } = await projectWithCharacter(fixture)
    const mainBefore = fixture.log.heads(projectId)[MAIN_BRANCH] as OpId
    const draft = fixture.project.beginTurn(projectId, { ...agent, intent: 'draft' })
    expect(draft.branch).toBe(`draft/${draft.turn}`)
    const planned = await fixture.project.invoke(projectId, request('plan.create', draft.turn, { plan: {} }))
    expect(planned.branch).toBe(draft.branch)
    const draftState = fixture.project.fold(projectId, draft.branch)
    expect(draftState.turns[draft.turn]?.accepted).toBe(false)
    expect(fixture.project.fold(projectId).ops.map(op => op.id)).not.toContain(planned.id)
    // Main moves underneath the draft: acceptance is refused.
    await fixture.project.invoke(projectId, { ...request('plan.create', turn, { plan: { late: true } }), ...user })
    expect(() => { fixture.project.acceptTurn(projectId, draft.turn) }).toThrow(RuntimeError)
    fixture.project.rejectTurn(projectId, draft.turn)
    expect(fixture.project.fold(projectId, draft.branch).turns[draft.turn]?.rejected).toBe(true)
    expect(() => { fixture.project.rejectTurn(projectId, draft.turn) }).toThrow(RuntimeError)
    // A fresh draft accepts and the approve record becomes main's head.
    const second = fixture.project.beginTurn(projectId, { ...agent, intent: 'second' })
    await fixture.project.invoke(projectId, request('plan.create', second.turn, { plan: { n: 2 } }))
    fixture.project.acceptTurn(projectId, second.turn)
    let state = fixture.project.fold(projectId)
    expect(state.ops.at(-1)?.kind).toBe('approve')
    expect(state.turns[second.turn]?.accepted).toBe(true)
    expect(state.plans).toHaveLength(2)
    // Undo removes the latest turn from main; the records stay in the log.
    const undone = fixture.project.undoLatestTurn(projectId)
    expect(undone).toBe(second.turn)
    state = fixture.project.fold(projectId)
    expect(state.plans).toHaveLength(1)
    expect(fixture.log.all(projectId).some(op => op.turn === second.turn)).toBe(true)
    // Accepting a user turn is a no-op on main; undoing back to the creation record is refused.
    const userTurn = fixture.project.beginTurn(projectId, { ...user, intent: 'u' })
    fixture.project.acceptTurn(projectId, userTurn.turn)
    expect(fixture.log.heads(projectId)[MAIN_BRANCH]).not.toBe(mainBefore)
    while (fixture.project.fold(projectId).ops.length > 1) fixture.project.undoLatestTurn(projectId)
    expect(() => fixture.project.undoLatestTurn(projectId)).toThrow(RuntimeError)
    expect(() => fixture.project.beginTurn(brandString<ProjectId>('missing'), { ...user, intent: 'x' })).toThrow()
  })

  it('reopens the draft turns an earlier process left open', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vh-restart-'))
    const fixture = await start({ root })
    const projectId = fixture.project.createProject({ title: 'restart', actor: 'user', surface: 'chat' })
    const kept = fixture.project.beginTurn(projectId, { actor: 'agent', surface: 'chat', intent: 'kept open' })
    // A plan approval inside the draft is an `approve` record too, but not the one that closes the turn.
    fixture.log.append(projectId, {
      parents: [], turn: kept.turn, branch: kept.branch, actor: 'agent', surface: 'chat', intent: 'approve plan', kind: 'approve',
      tool: { name: 'plan.approve', version: '1' }, inputs: [], params: { plan: 'p1' }, outputs: [], status: 'done', deterministic: true,
    }, fixture.log.heads(projectId)[kept.branch] as OpId)
    const accepted = fixture.project.beginTurn(projectId, { actor: 'agent', surface: 'chat', intent: 'accepted' })
    fixture.project.acceptTurn(projectId, accepted.turn)
    const rejected = fixture.project.beginTurn(projectId, { actor: 'agent', surface: 'chat', intent: 'rejected' })
    fixture.project.rejectTurn(projectId, rejected.turn)
    fixture.project.createBranch(projectId, 'alt', kept.base)
    // A draft head whose chain has no branch record for it is not a turn the runtime can reopen.
    fixture.log.createBranch(projectId, 'draft/ghost', kept.base)
    fixture.log.moveHead(projectId, 'draft/ghost', kept.base)
    const exploration = fixture.project.beginTurn(projectId, { actor: 'agent', surface: 'chat', intent: 'alt', branch: 'alt' })
    await fixture.dispose()
    const restarted = await startRuntime({ root })
    fixtures.push(restarted)
    expect(restarted.project.openTurn(kept.turn)).toEqual(kept)
    expect(restarted.project.openTurn(accepted.turn)).toBeUndefined()
    expect(restarted.project.openTurn(rejected.turn)).toBeUndefined()
    expect(restarted.project.openTurn(exploration.turn)).toBeUndefined()
    await restarted.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  it('branches from any record and folds each branch independently', async () => {
    const fixture = await start()
    const { projectId, turn } = await projectWithCharacter(fixture)
    const at = fixture.project.fold(projectId).head
    await fixture.project.invoke(projectId, request('plan.create', turn, { plan: { main: true } }))
    const branchOp = fixture.project.createBranch(projectId, 'alt', at)
    expect(branchOp.parents).toEqual([at])
    const altTurn = fixture.project.beginTurn(projectId, { ...user, intent: 'alt' })
    await fixture.project.invoke(projectId, { ...request('plan.create', altTurn.turn, { plan: { alt: true } }), branch: 'alt' })
    const alt = fixture.project.fold(projectId, 'alt')
    const main = fixture.project.fold(projectId)
    expect(alt.plans).toHaveLength(1)
    expect(main.plans).toHaveLength(1)
    expect(alt.ops.some(op => op.kind === 'branch')).toBe(true)
    expect(fixture.project.createBranch(projectId, 'from-main', MAIN_BRANCH).parents).toEqual([main.head])
  })

  it('registers and removes tools, and reports ffmpeg availability', async () => {
    const fixture = await start({ builtinTools: false })
    const spec = { name: 'echo', version: '1', deterministic: true, execute: () => Promise.resolve({ outputs: [] }) }
    const remove = fixture.project.registerTool(spec)
    expect(fixture.project.toolNames()).toEqual(['echo'])
    const replacement = { ...spec, version: '2' }
    fixture.project.registerTool(replacement)
    remove()
    expect(fixture.project.toolNames()).toEqual(['echo'])
    const { projectId, turn } = await projectWithCharacterTools(fixture)
    const op = await fixture.project.invoke(projectId, request('echo', turn))
    expect(op.status).toBe('done')
    expect(await ffmpegAvailable('/nonexistent/ffmpeg')).toBe(false)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the runtime must record non-Error rejections too.
    fixture.project.registerTool({ name: 'shout', version: '1', deterministic: false, execute: () => Promise.reject('plain string') })
    await expect(fixture.project.invoke(projectId, request('shout', turn))).rejects.toBe('plain string')
    expect(fixture.project.fold(projectId).ops.at(-1)).toMatchObject({ status: 'failed', error: 'plain string' })
    // A project the log created without records has no main head yet.
    const bare = fixture.log.createProject({ title: 'bare' })
    expect(() => fixture.project.beginTurn(bare, { ...user, intent: 'x' })).toThrow(RuntimeError)
    expect(() => fixture.project.undoLatestTurn(bare)).toThrow(RuntimeError)
  })

  it('groups takes by the record they derive from', async () => {
    const fixture = await start({ builtinTools: false })
    fixture.project.registerTool({ name: 'echo', version: '1', deterministic: false, execute: () => Promise.resolve({ outputs: [] }) })
    const { projectId, turn } = await projectWithCharacterTools(fixture)
    const root = await fixture.project.invoke(projectId, request('echo', turn))
    const take = await fixture.project.invoke(projectId, { ...request('echo', turn), base_op: root.id })
    const takeOfTake = await fixture.project.invoke(projectId, { ...request('echo', turn), base_op: take.id })
    const orphan = await fixture.project.invoke(projectId, { ...request('echo', turn), base_op: brandString<OpId>('not-in-chain') })
    const state = fixture.project.fold(projectId)
    expect(state.takes[root.id]).toEqual([root.id, take.id, takeOfTake.id])
    expect(state.takes[orphan.id]).toEqual([orphan.id, orphan.id])
  })

  it('reports plan approval and accept_stale records', async () => {
    const fixture = await start()
    const { projectId, turn } = await projectWithCharacter(fixture)
    const plan = await fixture.project.invoke(projectId, request('plan.create', turn, { plan: {} }))
    const head = fixture.log.heads(projectId)[MAIN_BRANCH] ?? null
    fixture.log.append(projectId, { parents: [], turn, branch: MAIN_BRANCH, ...user, intent: 'ok', kind: 'approve', inputs: [], params: { plan: plan.id }, outputs: [], status: 'done', deterministic: true }, head)
    const upload = await fixture.project.invoke(projectId, request('asset.upload', turn, { path: fixture.writeImage('c.png'), mime: 'image/png' }))
    const consumer = await fixture.project.invoke(projectId, request('plan.create', turn, { plan: { uses: 1 } }, [{ role: 'reference', ref: upload.outputs[0] as AssetId }]))
    const replacement = await fixture.project.invoke(projectId, { ...request('asset.upload', turn, { path: fixture.writeImage('d.png'), mime: 'image/png' }), supersedes: [upload.id] })
    let state = fixture.project.fold(projectId)
    expect(state.plans[0]).toMatchObject({ op: plan.id, approved: true })
    expect(state.superseded[upload.id]).toBe(replacement.id)
    expect(state.stale[consumer.id]?.because).toBe(replacement.id)
    const headNow = fixture.log.heads(projectId)[MAIN_BRANCH] ?? null
    fixture.log.append(projectId, { parents: [], turn, branch: MAIN_BRANCH, ...user, intent: 'keep', kind: 'accept_stale', inputs: [], params: { op: consumer.id }, outputs: [], status: 'done', deterministic: true }, headNow)
    state = fixture.project.fold(projectId)
    expect(state.stale[consumer.id]).toBeUndefined()
  })
})
