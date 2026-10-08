/**
 * The Timeline component in a REAL composition: a test-only `cordis.yml` boots the DSH tool registry, `dvProject`,
 * `dvFfmpeg`, the asset pool and `dvTimeline` through the Loader. The agent edits timelines with the `dv_timeline_*`
 * tools on the project's current branch, the human edits them with `dvProject.run`, and each call becomes one record that
 * the `timeline` slice folds. Clips are named by the clip IDs that the records store in `report.clips`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import DvAssetPool from '@dv/asset-pool'
import DvFfmpeg from '@dv/ffmpeg'
import DvProject, {
  type OperationToolValue, type ProjectId, type ProjectRecord, type RecordId, type RecordOrigin, type RunRequest, type RunResult,
  type SessionId,
} from '@dv/project'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DvTimeline from '../src/index.ts'

/** The plugin classes the fixture rows resolve through `globalThis`, because Node imports the rows outside Vite. */
const PLUGINS = { SystemPrompt, ToolRuntime, DvProject, DvFfmpeg, DvAssetPool, DvTimeline }

/** The human on the timeline panel, outside any chat session; switches branches in the tests. */
const HUMAN: RecordOrigin = { actor: 'user', surface: 'timeline', session: null, turn: null, tool_call: null, intent: 'switch' }

/** The ten operations in registration order. */
const OPERATIONS = [
  'timeline.create', 'timeline.update', 'timeline.rename', 'timeline.delete', 'timeline.clip_insert', 'timeline.clip_move', 'timeline.clip_remove',
  'timeline.clip_split', 'timeline.clip_trim', 'timeline.clip_replace',
]

interface Fixture {
  ctx: Context
  project: ProjectId
  /** Run one tool as the agent of chat session `s1`, which is bound to `project`. */
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
  /** Run one operation as the human on the timeline panel, on the project's current branch. */
  run(operation: string, params: Record<string, unknown>, inputs?: RunRequest['inputs']): Promise<ProjectRecord>
}

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

/**
 * Boot the composition from a test-only `cordis.yml`.
 * @returns the fixture, with a project bound to chat session `s1`.
 */
async function start(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'dv-timeline-'))
  const globals = globalThis as typeof globalThis & { __dvTimelineComposition?: typeof PLUGINS }
  globals.__dvTimelineComposition = PLUGINS
  const rows: string[] = []
  const row = (id: string, key: keyof typeof PLUGINS, config: string[]): void => {
    writeFileSync(join(dir, `${id}.mjs`), `export default globalThis.__dvTimelineComposition.${key}\n`)
    rows.push(`- id: ${id}`, `  name: ${pathToFileURL(join(dir, `${id}.mjs`)).href}`, ...config.length === 0 ? [] : ['  config:', ...config.map(line => `    ${line}`)])
  }
  row('system-prompt', 'SystemPrompt', [])
  row('tools', 'ToolRuntime', [])
  row('dv-project', 'DvProject', [`root: ${join(dir, 'projects')}`, `sessionRoot: ${join(dir, 'sessions')}`])
  // The agent tools describe outputs through the asset pool, so the pool and its ffmpeg runner are mounted too.
  row('dv-ffmpeg', 'DvFfmpeg', ['ffmpegPath: ffmpeg', 'ffprobePath: ffprobe'])
  row('dv-asset-pool', 'DvAssetPool', [`root: ${join(dir, 'assets')}`])
  row('dv-timeline', 'DvTimeline', [])
  writeFileSync(join(dir, 'cordis.yml'), `${rows.join('\n')}\n`)

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const origin = { actor: 'user' as const, surface: 'timeline' as const, session: null, turn: null, tool_call: null, intent: 'edit' }
  const project = (await ctx.dvProject.createProject('timeline', origin)).id
  ctx.dvProject.bindSession(brandString<SessionId>('s1'), project)
  let calls = 0
  return {
    ctx, project,
    call(name, args) {
      calls += 1
      return ctx.tools.execute({ callId: ToolCallId(`call-${calls}`), name, arguments: args, signal: new AbortController().signal, agent: { id: 's1' } as never })
    },
    async run(operation, params, inputs = []) {
      const result = await ctx.dvProject.run({ ...origin, project, operation, params, inputs })
      if (result.record === null) throw new Error(`${operation} wrote no record`)
      return result.record
    },
  }
}

/** A promise with its resolver, to hold a stand-in render until the test releases it. */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** The value of a successful operation tool call. */
function value(result: ToolExecutionResult): OperationToolValue {
  if (result.isError) throw new Error(result.error.message)
  return result.value as OperationToolValue
}

/** The error message of a failed tool call. */
function failure(result: ToolExecutionResult): string {
  return result.isError ? result.error.message : ''
}

describe('dvTimeline', () => {
  it('registers the ten operations with their dv_timeline_* tools and removes them on disposal', async () => {
    const fixture = await start()
    const specs = fixture.ctx.dvProject.listOperations().filter(spec => spec.component === 'timeline')
    expect(specs.map(spec => spec.name)).toEqual(OPERATIONS)
    expect(specs.every(spec => spec.outputs.length === 0 && spec.resource === 'none' && spec.confirm === 'never')).toBe(true)
    for (const name of OPERATIONS) expect(fixture.ctx.tools.get(`dv_${name.replace('.', '_')}`)).toBeDefined()
    expect(fixture.ctx.dvProject.getState(fixture.project).components.timeline).toEqual({ timelines: [] })
    const entry = [...fixture.ctx.loader.entries()].find(candidate => candidate.options.name.endsWith('/dv-timeline.mjs'))
    await entry?.fiber?.dispose()
    expect(fixture.ctx.dvProject.listOperations().filter(spec => spec.component === 'timeline')).toEqual([])
    expect(fixture.ctx.tools.get('dv_timeline_clip_move')).toBeUndefined()
    expect(fixture.ctx.dvProject.getState(fixture.project).components).not.toHaveProperty('timeline')
  })

  it('records the agent\'s timeline edits on the project\'s current branch and folds them into the timeline slice', async () => {
    const fixture = await start()
    const created = value(await fixture.call('dv_timeline_create', { reason: 'lay out', name: '开场', assets: ['a1', 'a2', 'a3'] }))
    expect(created).toMatchObject({ status: 'done', summary: 'timeline of 3 clips', outputs: [], scheduled: [] })
    const record = fixture.ctx.dvProject.getRecord(fixture.project, brandString<RecordId>(created.record))
    expect(record).toMatchObject({
      actor: 'agent', component: 'timeline', operation: 'timeline.create', operation_version: '2', branch: 'main', session: 's1',
      params: { name: '开场', assets: ['a1', 'a2', 'a3'] }, inputs: [], outputs: [], status: 'done', report: { clips: ['cl1', 'cl2', 'cl3'] },
    })
    const moved = value(await fixture.call('dv_timeline_clip_move', { reason: 'open on the kite', clip: 'cl3', to: 1 }))
    expect(moved.summary).toBe('clip cl3 moved to 1')
    expect(value(await fixture.call('dv_timeline_clip_trim', { reason: 'tighten', clip: 'cl3', in_sec: 0.5, out_sec: 2 })).summary)
      .toBe('clip cl3 trimmed')
    const split = value(await fixture.call('dv_timeline_clip_split', { reason: 'cut', clip: 'cl1', at_sec: 1 }))
    expect([split.summary, split.report]).toEqual(['clip cl1 split at 1s', { clips: ['cl4'] }])
    expect(value(await fixture.call('dv_timeline_clip_remove', { reason: 'drop', clip: 'cl2' })).summary).toBe('clip cl2 removed')
    expect(value(await fixture.call('dv_timeline_clip_replace', { reason: 'swap', clip: 'cl1', asset: 'b1' })).summary).toBe('clip cl1 replaced')
    expect(value(await fixture.call('dv_timeline_clip_insert', { reason: 'add', at: 4, asset: 'b2' })).summary).toBe('clip cl5 inserted at 4')
    expect(value(await fixture.call('dv_timeline_create', { reason: 'second', timeline: 't2', assets: [] })).summary).toBe('t2 timeline of 0 clips')
    expect(value(await fixture.call('dv_timeline_rename', { reason: 'name it', timeline: 't2', name: '片尾' })).summary).toBe('t2 renamed to 片尾')
    const timelines = fixture.ctx.dvProject.getState(fixture.project).components.timeline.timelines
    expect(timelines.map(timeline => [timeline.id, timeline.name])).toEqual([['t1', '开场'], ['t2', '片尾']])
    expect(timelines[0]?.clips).toEqual([
      { id: 'cl3', asset: 'a3', source: null, in_sec: 0.5, out_sec: 2 }, { id: 'cl1', asset: 'b1', source: null, in_sec: null, out_sec: null },
      { id: 'cl4', asset: 'a1', source: null, in_sec: 1, out_sec: null }, { id: 'cl5', asset: 'b2', source: null, in_sec: null, out_sec: null },
    ])
    expect(value(await fixture.call('dv_timeline_delete', { reason: 'not needed', timeline: 't2' })).summary).toBe('t2 deleted')
    expect(fixture.ctx.dvProject.getState(fixture.project).components.timeline.timelines.map(timeline => timeline.id)).toEqual(['t1'])
  })

  it('records the human\'s edits on main, replaces clips with timeline.update, and assembles a create from clip inputs', async () => {
    const fixture = await start()
    const create = await fixture.run('timeline.create', { assets: ['a1'] })
    expect(create).toMatchObject({ actor: 'user', surface: 'timeline', branch: 'main', operation: 'timeline.create', status: 'done' })
    await fixture.run('timeline.clip_insert', { at: 1, asset: 'a0' })
    const clips = (): unknown => fixture.ctx.dvProject.getState(fixture.project).components.timeline.timelines[0]?.clips
      .map(clip => [clip.id, clip.asset])
    expect(clips()).toEqual([['cl2', 'a0'], ['cl1', 'a1']])
    // create only creates; update replaces every clip of an existing timeline with clips that get new IDs.
    expect(await fixture.run('timeline.create', { assets: ['b1'] })).toMatchObject({
      status: 'failed', error: { message: 'Timeline t1 exists; call dv_timeline_update to replace its clips.' },
    })
    const update = await fixture.run('timeline.update', { timeline: 't1', assets: ['b1', 'b2'] })
    expect(update).toMatchObject({ status: 'done', report: { clips: ['cl3', 'cl4'] } })
    expect(clips()).toEqual([['cl3', 'b1'], ['cl4', 'b2']])
    expect(fixture.ctx.dvProject.getState(fixture.project).components.timeline.timelines[0]?.name).toBe('')
    expect(await fixture.run('timeline.update', { timeline: 't2', assets: [] })).toMatchObject({
      status: 'failed', error: { message: 'Timeline t2 does not exist.' },
    })
    const spec = fixture.ctx.dvProject.listOperations().find(entry => entry.name === 'timeline.update')
    expect(spec?.summarize({ ...update, params: { timeline: 't1' }, inputs: [{ role: 'clip', ref: { record: create.id, output: 0 }, resolved_asset: null }] }))
      .toBe('t1 timeline updated (1 clips)')
  })

  it('fails a call whose timeline or clip does not exist, and refuses invalid params before any record', async () => {
    const fixture = await start()
    await fixture.run('timeline.create', { assets: ['a1', 'a2'] })
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['timeline.rename', { timeline: 't9', name: 'x' }, 'Timeline t9 does not exist.'],
      ['timeline.delete', { timeline: 't9' }, 'Timeline t9 does not exist.'],
      ['timeline.clip_insert', { at: 4, asset: 'a3' }, 'Timeline t1 has 2 clips; position 4 is not between 1 and 3.'],
      ['timeline.clip_move', { clip: 'cl1', to: 3 }, 'Timeline t1 has 2 clips; position 3 is not between 1 and 2.'],
      ['timeline.clip_remove', { clip: 'cl9' }, 'Clip cl9 does not exist.'],
      ['timeline.clip_split', { clip: 'cl1', at_sec: 0 }, 'Clip cl1 of timeline t1 does not play 0s of its asset; split inside its in and out points.'],
      ['timeline.clip_trim', { clip: 'cl2', in_sec: 3, out_sec: 1 }, 'The out point 1s is not after the in point 3s.'],
      ['timeline.clip_replace', { clip: 'cl3', asset: 'a3' }, 'Clip cl3 does not exist.'],
    ]
    for (const [operation, params, message] of cases) {
      expect(await fixture.run(operation, params)).toMatchObject({ status: 'failed', error: { code: 'operation_failed', message } })
    }
    // A failed call changes nothing; repeating it fails again because the check runs on every call.
    expect(fixture.ctx.dvProject.getState(fixture.project).components.timeline.timelines[0]?.clips).toHaveLength(2)
    expect(await fixture.run('timeline.clip_remove', { clip: 'cl9' })).toMatchObject({ status: 'failed' })
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before + cases.length + 1)
    await expect(fixture.run('timeline.clip_move', { clip: 'cl1' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(fixture.run('timeline.clip_split', { clip: 1, at_sec: 1 })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(fixture.run('timeline.update', { assets: [] })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(failure(await fixture.call('dv_timeline_rename', { reason: 'no name', timeline: 't1' }))).toContain('name')
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before + cases.length + 1)
  })

  it('keeps clip IDs unique across branches', async () => {
    const fixture = await start()
    await fixture.run('timeline.create', { assets: ['a1', 'a2'] })
    const branch = (await fixture.ctx.dvProject.createBranch(fixture.project, null)).name
    // The forked branch and main add a clip each; the project-wide numbering gives them different IDs.
    expect(value(await fixture.call('dv_timeline_clip_insert', { reason: 'add', at: 3, asset: 'd1' })).report).toEqual({ clips: ['cl3'] })
    await fixture.ctx.dvProject.switchBranch(fixture.project, 'main', HUMAN)
    expect(await fixture.run('timeline.clip_insert', { at: 3, asset: 'm1' })).toMatchObject({ branch: 'main', report: { clips: ['cl4'] } })
    await fixture.ctx.dvProject.switchBranch(fixture.project, branch, HUMAN)
    value(await fixture.call('dv_timeline_clip_move', { reason: 'open on it', clip: 'cl3', to: 1 }))
    const clipsOn = (name: string): unknown => fixture.ctx.dvProject.getState(fixture.project, name).components.timeline.timelines[0]?.clips
      .map(clip => [clip.id, clip.asset])
    expect(clipsOn(branch)).toEqual([['cl3', 'd1'], ['cl1', 'a1'], ['cl2', 'a2']])
    expect(clipsOn('main')).toEqual([['cl1', 'a1'], ['cl2', 'a2'], ['cl4', 'm1']])
  })

  it('lays out a render that is not done as a placeholder clip that becomes ready when the render is done', async () => {
    const fixture = await start()
    const renders = [gate(), gate()]
    const render = (index: number): Promise<RunResult> => fixture.ctx.dvProject.run({
      actor: 'user', surface: 'timeline', session: null, turn: null, tool_call: null, intent: 'render', project: fixture.project,
      operation: 'shot.render', params: { shot: index }, inputs: [],
    })
    fixture.ctx.dvProject.registerOperation({
      name: 'shot.render', component: 'shot', version: '1', description: 'stand-in', params: {}, inputs: {},
      outputs: [{ role: 'video', type: 'video' }], confirm: 'never', deterministic: false, resource: 'none', summarize: () => 'stand-in',
      execute: async (context) => {
        const index = Number(context.params['shot'])
        await renders[index]?.promise
        if (index === 1) throw new Error('The renderer ran out of memory.')
        return { outputs: [context.importAsset(Buffer.from('take'), { mime: 'video/mp4', name: 'take.mp4' })] }
      },
    })
    const running = [render(0), render(1)]
    // The history lists the newest record first.
    const [first, second] = await vi.waitFor(() => {
      const found = fixture.ctx.dvProject.listHistory({ project: fixture.project, operation: 'shot.render' }).map(entry => entry.record.id)
      expect(found).toHaveLength(2)
      return found.reverse()
    })
    if (first === undefined || second === undefined) throw new Error('the renders wrote no records')

    // The create is done at once with one placeholder clip per render; trim and split refuse a placeholder.
    const inputs = [first, second].map(record => ({ role: 'clip', ref: { record, output: 0 } }))
    expect(await fixture.run('timeline.create', { plan: 'p1' }, inputs)).toMatchObject({ status: 'done', report: { clips: ['cl1', 'cl2'] } })
    const clips = (): unknown => fixture.ctx.dvProject.getState(fixture.project).components.timeline.timelines[0]?.clips
      .map(clip => [clip.id, clip.asset === null ? null : 'ready', clip.source?.record])
    expect(clips()).toEqual([['cl1', null, first], ['cl2', null, second]])
    expect(await fixture.run('timeline.clip_trim', { clip: 'cl1', in_sec: 1 })).toMatchObject({
      status: 'failed', error: { message: 'Clip cl1 is still rendering.' },
    })
    expect(await fixture.run('timeline.clip_split', { clip: 'cl2', at_sec: 1 })).toMatchObject({
      status: 'failed', error: { message: 'Clip cl2 is still rendering.' },
    })

    // A done render fills its clip; a failed render leaves its clip a placeholder and the timeline in place.
    for (const held of renders) held.resolve()
    await Promise.all(running)
    expect(clips()).toEqual([['cl1', 'ready', first], ['cl2', null, second]])
    expect(fixture.ctx.dvProject.getRecord(fixture.project, second).status).toBe('failed')
  })

  it('keeps a placeholder clip on a forked branch and fills it when the render is done', async () => {
    const fixture = await start()
    const held = gate()
    fixture.ctx.dvProject.registerOperation({
      name: 'shot.render', component: 'shot', version: '1', description: 'stand-in', params: {}, inputs: {},
      outputs: [{ role: 'video', type: 'video' }], confirm: 'never', deterministic: false, resource: 'none', summarize: () => 'stand-in',
      execute: async (context) => {
        await held.promise
        return { outputs: [context.importAsset(Buffer.from('take'), { mime: 'video/mp4', name: 'take.mp4' })] }
      },
    })
    const running = fixture.ctx.dvProject.run({
      actor: 'user', surface: 'timeline', session: null, turn: null, tool_call: null, intent: 'render', project: fixture.project,
      operation: 'shot.render', params: {}, inputs: [],
    })
    const render = await vi.waitFor(() => {
      const [found] = fixture.ctx.dvProject.listHistory({ project: fixture.project, operation: 'shot.render' })
      if (found === undefined) throw new Error('the render wrote no record')
      return found.record.id
    })
    // The agent lays the render out on a branch forked after the render started; main gets another timeline.
    const branch = (await fixture.ctx.dvProject.createBranch(fixture.project, null)).name
    const laidOut = await fixture.call('dv_timeline_create', { reason: 'lay out', inputs: { clip: [`${render}#0`] } })
    expect(value(laidOut)).toMatchObject({ status: 'done', scheduled: [], report: { clips: ['cl1'] } })
    await fixture.ctx.dvProject.switchBranch(fixture.project, 'main', HUMAN)
    await fixture.run('timeline.create', { timeline: 't2', assets: ['m1'] })
    const t1 = (): unknown => fixture.ctx.dvProject.getState(fixture.project, branch).components.timeline.timelines.find(entry => entry.id === 't1')?.clips
    expect(t1()).toEqual([{ id: 'cl1', asset: null, source: { record: render, output: 0 }, in_sec: null, out_sec: null }])
    held.resolve()
    await running
    const [take] = fixture.ctx.dvProject.getRecord(fixture.project, render).outputs
    expect(t1()).toEqual([{ id: 'cl1', asset: take, source: { record: render, output: 0 }, in_sec: null, out_sec: null }])
    expect(fixture.ctx.dvProject.getState(fixture.project, 'main').components.timeline.timelines.map(entry => entry.id)).toEqual(['t2'])
  })
})
