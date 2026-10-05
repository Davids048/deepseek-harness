import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, describe, expect, it } from 'vitest'
import VhOpLog, {
  MAIN_BRANCH, OpLogError, statusAdvances, type AssetId, type OpDraft, type OpId, type OpLogEvent, type ProjectId, type TurnId,
} from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

async function start(root = mkdtempSync(join(tmpdir(), 'vh-oplog-'))): Promise<{ log: VhOpLog; root: string; context: Context }> {
  if (!roots.includes(root)) roots.push(root)
  const context = new Context()
  contexts.push(context)
  await context.plugin(VhOpLog, { root }).await()
  return { log: context.vhOpLog, root, context }
}

function draft(turn: string, branch = MAIN_BRANCH, extra: Partial<OpDraft> = {}): OpDraft {
  return {
    parents: [], turn: brandString<TurnId>(turn), branch, actor: 'user', surface: 'api', intent: 'test', kind: 'tool',
    tool: { name: 'noop', version: '1' }, inputs: [], params: {}, outputs: [], status: 'pending', deterministic: true, ...extra,
  }
}

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('vhOpLog', () => {
  it('appends records in order and enforces the head as parent', async () => {
    const { log } = await start()
    const project = log.createProject({ title: 't' })
    expect(log.listProjects().map(info => info.projectId)).toEqual([project])
    expect(log.project(project).title).toBe('t')
    const first = log.append(project, draft('t1'), null)
    expect(first.parents).toEqual([])
    expect(() => log.append(project, draft('t1'), null)).toThrow(OpLogError)
    const second = log.append(project, draft('t1'), first.id)
    expect(second.parents).toEqual([first.id])
    expect(log.heads(project)).toEqual({ [MAIN_BRANCH]: second.id })
    expect(log.all(project).map(op => op.id)).toEqual([first.id, second.id])
    expect(log.ancestors(project, second.id).map(op => op.id)).toEqual([first.id, second.id])
    expect(() => log.get(project, brandString<OpId>('nope'))).toThrow(OpLogError)
    expect(() => log.heads(brandString<ProjectId>('nope'))).toThrow(OpLogError)
  })

  it('patches status forward only and keeps the file append-only', async () => {
    const { log, root } = await start()
    const project = log.createProject({ title: 't' })
    const op = log.append(project, draft('t1'), null)
    log.update(project, op.id, { status: 'running' })
    const done = log.update(project, op.id, { status: 'done', outputs: [], cost: { wall_s: 1 } })
    expect(done.status).toBe('done')
    expect(done.cost).toEqual({ wall_s: 1 })
    expect(() => log.update(project, op.id, { status: 'pending' })).toThrow(OpLogError)
    expect(log.update(project, op.id, { status: 'done' }).status).toBe('done')
    const lines = readFileSync(join(root, project, 'ops.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(4)
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ patch: op.id, status: 'running' })
  })

  it('creates branches, moves heads, and replays everything after a restart', async () => {
    const first = await start()
    const project = first.log.createProject({ title: 't' })
    const a = first.log.append(project, draft('t1'), null)
    const b = first.log.append(project, draft('t1'), a.id)
    const branchOp = first.log.createBranch(project, 'x', a.id, brandString<TurnId>('t2'))
    expect(branchOp.kind).toBe('branch')
    expect(branchOp.parents).toEqual([a.id])
    expect(() => first.log.createBranch(project, 'x', a.id)).toThrow(OpLogError)
    const c = first.log.append(project, draft('t2', 'x'), branchOp.id)
    first.log.moveHead(project, MAIN_BRANCH, a.id)
    expect(() => { first.log.moveHead(project, 'nope', a.id) }).toThrow(OpLogError)
    expect(first.log.heads(project)).toEqual({ [MAIN_BRANCH]: a.id, x: c.id })
    expect(first.log.ancestors(project, c.id).map(op => op.id)).toEqual([a.id, branchOp.id, c.id])
    first.log.update(project, b.id, { status: 'failed', error: 'boom' })
    await first.context.fiber.dispose()
    const second = await start(first.root)
    expect(second.log.heads(project)).toEqual({ [MAIN_BRANCH]: a.id, x: c.id })
    expect(second.log.get(project, b.id)).toMatchObject({ status: 'failed', error: 'boom' })
    expect(second.log.all(project)).toHaveLength(4)
    expect(() => second.log.append(project, draft('t3', 'y', { kind: 'branch' }), brandString<OpId>('missing'))).toThrow(OpLogError)
  })

  it('notifies subscribers of appends, patches, and head moves until unsubscribed', async () => {
    const { log } = await start()
    const project = log.createProject({ title: 't' })
    const events: OpLogEvent[] = []
    const stop = log.subscribe(project, (event) => { events.push(event) })
    const op = log.append(project, draft('t1'), null)
    log.update(project, op.id, { status: 'done' })
    log.moveHead(project, MAIN_BRANCH, op.id)
    stop()
    log.append(project, draft('t1'), op.id)
    expect(events.map(event => event.kind)).toEqual(['append', 'patch', 'head'])
    expect(log.mainBranch).toBe(MAIN_BRANCH)
  })

  it('replays a patch for an unknown record as a no-op and tolerates a missing heads.json', async () => {
    const first = await start()
    const project = first.log.createProject({ title: 't' })
    const op = first.log.append(project, draft('t1'), null)
    first.log.update(project, op.id, { inputs: [{ role: 'clip', ref: brandString<AssetId>('a'.repeat(64)), resolved: brandString<AssetId>('a'.repeat(64)) }] })
    const { appendFileSync, rmSync: remove } = await import('node:fs')
    appendFileSync(join(first.root, project, 'ops.jsonl'), `${JSON.stringify({ patch: 'ghost', status: 'done' })}\n`)
    remove(join(first.root, project, 'heads.json'))
    await first.context.fiber.dispose()
    const second = await start(first.root)
    expect(second.log.get(project, op.id).inputs).toHaveLength(1)
    expect(second.log.heads(project)).toEqual({})
    expect(second.log.all(project)).toHaveLength(1)
  })

  it('replays a project that has records in neither file', async () => {
    const first = await start()
    const project = first.log.createProject({ title: 'empty' })
    await first.context.fiber.dispose()
    rmSync(join(first.root, project, 'ops.jsonl'))
    const second = await start(first.root)
    expect(second.log.heads(project)).toEqual({})
    expect(second.log.all(project)).toEqual([])
  })

  it('ignores a stray directory without project.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vh-oplog-'))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(root, 'stray'))
    const { log } = await start(root)
    expect(log.listProjects()).toEqual([])
  })

  it('orders statuses', () => {
    expect(statusAdvances('pending', 'running')).toBe(true)
    expect(statusAdvances('running', 'failed')).toBe(true)
    expect(statusAdvances('done', 'running')).toBe(false)
    expect(statusAdvances('failed', 'failed')).toBe(true)
  })
})
