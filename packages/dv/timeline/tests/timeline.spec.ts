/**
 * The Timeline component in a REAL composition: a test-only `cordis.yml` boots the DSH tool registry, `dvProject`,
 * `dvFfmpeg`, the asset pool and `dvTimeline` through the Loader. The agent edits timelines with the `dv_timeline_*`
 * tools on its chat session's draft, the human edits them with `dvProject.run`, and each call becomes one record that
 * the `timeline` slice folds.
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
import DvProject, { type OperationToolValue, type ProjectId, type ProjectRecord, type RecordId, type RunRequest, type SessionId } from '@dv/project'
import { afterEach, describe, expect, it } from 'vitest'
import DvTimeline from '../src/index.ts'

/** The plugin classes the fixture rows resolve through `globalThis`, because Node imports the rows outside Vite. */
const PLUGINS = { SystemPrompt, ToolRuntime, DvProject, DvFfmpeg, DvAssetPool, DvTimeline }

/** The nine operations in registration order. */
const OPERATIONS = [
  'timeline.create', 'timeline.rename', 'timeline.delete', 'timeline.clip_insert', 'timeline.clip_move', 'timeline.clip_remove',
  'timeline.clip_split', 'timeline.clip_trim', 'timeline.clip_replace',
]

interface Fixture {
  ctx: Context
  project: ProjectId
  /** Run one tool as the agent of chat session `s1`, which is bound to `project`. */
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
  /** Run one operation as the human on the timeline panel, on `main`. */
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
  it('registers the nine operations with their dv_timeline_* tools and removes them on disposal', async () => {
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

  it('records the agent\'s timeline edits on its draft and folds them into the timeline slice', async () => {
    const fixture = await start()
    const created = value(await fixture.call('dv_timeline_create', { reason: 'lay out', name: '第 1 集', assets: ['a1', 'a2', 'a3'] }))
    expect(created).toMatchObject({ status: 'done', summary: 'timeline of 3 clips', outputs: [], scheduled: [] })
    const record = fixture.ctx.dvProject.getRecord(fixture.project, brandString<RecordId>(created.record))
    expect(record).toMatchObject({
      actor: 'agent', component: 'timeline', operation: 'timeline.create', branch: 'draft/s1', session: 's1',
      params: { name: '第 1 集', assets: ['a1', 'a2', 'a3'] }, inputs: [], outputs: [], status: 'done',
    })
    const moved = value(await fixture.call('dv_timeline_clip_move', { reason: 'open on the kite', clip: 3, to: 1 }))
    expect(moved.summary).toBe('clip 3 moved to 1')
    expect(value(await fixture.call('dv_timeline_clip_trim', { reason: 'tighten', timeline: 't1', clip: 1, in_sec: 0.5, out_sec: 2 })).summary)
      .toBe('t1 clip 1 trimmed')
    expect(value(await fixture.call('dv_timeline_clip_split', { reason: 'cut', clip: 2, at_sec: 1 })).summary).toBe('clip 2 split at 1s')
    expect(value(await fixture.call('dv_timeline_clip_remove', { reason: 'drop', clip: 4 })).summary).toBe('clip 4 removed')
    expect(value(await fixture.call('dv_timeline_clip_replace', { reason: 'swap', clip: 2, asset: 'b1' })).summary).toBe('clip 2 replaced')
    expect(value(await fixture.call('dv_timeline_clip_insert', { reason: 'add', at: 4, asset: 'b2' })).summary).toBe('clip inserted at 4')
    expect(value(await fixture.call('dv_timeline_create', { reason: 'second', timeline: 't2', assets: [] })).summary).toBe('t2 timeline of 0 clips')
    expect(value(await fixture.call('dv_timeline_rename', { reason: 'name it', timeline: 't2', name: '片尾' })).summary).toBe('t2 renamed to 片尾')
    const draft = fixture.ctx.dvProject.getState(fixture.project, 'draft/s1').components.timeline.timelines
    expect(draft.map(timeline => [timeline.id, timeline.name])).toEqual([['t1', '第 1 集'], ['t2', '片尾']])
    expect(draft[0]?.clips).toEqual([
      { asset: 'a3', in_sec: 0.5, out_sec: 2 }, { asset: 'b1', in_sec: null, out_sec: null },
      { asset: 'a1', in_sec: 1, out_sec: null }, { asset: 'b2', in_sec: null, out_sec: null },
    ])
    expect(value(await fixture.call('dv_timeline_delete', { reason: 'not needed', timeline: 't2' })).summary).toBe('t2 deleted')
    expect(fixture.ctx.dvProject.getState(fixture.project, 'draft/s1').components.timeline.timelines.map(timeline => timeline.id)).toEqual(['t1'])
    // The draft is the agent's; main stays empty until the human accepts it.
    expect(fixture.ctx.dvProject.getState(fixture.project).components.timeline.timelines).toEqual([])
  })

  it('records the human\'s edits on main and assembles a create from the clip inputs it names', async () => {
    const fixture = await start()
    const create = await fixture.run('timeline.create', { assets: ['a1'] })
    expect(create).toMatchObject({ actor: 'user', surface: 'timeline', branch: 'main', operation: 'timeline.create', status: 'done' })
    await fixture.run('timeline.clip_insert', { at: 1, asset: 'a0' })
    expect(fixture.ctx.dvProject.getState(fixture.project).components.timeline.timelines[0]?.clips.map(clip => clip.asset)).toEqual(['a0', 'a1'])
    const spec = fixture.ctx.dvProject.listOperations().find(entry => entry.name === 'timeline.create')
    expect(spec?.summarize({ ...create, params: {}, inputs: [{ role: 'clip', ref: { record: create.id, output: 0 }, resolved_asset: null }] }))
      .toBe('timeline of 1 clips')
  })

  it('fails a call whose timeline or clip does not exist, and refuses invalid params before any record', async () => {
    const fixture = await start()
    await fixture.run('timeline.create', { assets: ['a1', 'a2'] })
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['timeline.rename', { timeline: 't9', name: 'x' }, 'Timeline t9 does not exist.'],
      ['timeline.delete', { timeline: 't9' }, 'Timeline t9 does not exist.'],
      ['timeline.clip_insert', { at: 4, asset: 'a3' }, 'Timeline t1 has 2 clips; position 4 is not between 1 and 3.'],
      ['timeline.clip_move', { clip: 1, to: 3 }, 'Timeline t1 has 2 clips; position 3 is not between 1 and 2.'],
      ['timeline.clip_remove', { clip: 0 }, 'Timeline t1 has 2 clips; position 0 is not between 1 and 2.'],
      ['timeline.clip_split', { clip: 1, at_sec: 0 }, 'Clip 1 of timeline t1 does not play 0s of its asset; split inside its in and out points.'],
      ['timeline.clip_trim', { clip: 2, in_sec: 3, out_sec: 1 }, 'The out point 1s is not after the in point 3s.'],
      ['timeline.clip_replace', { timeline: 't2', clip: 1, asset: 'a3' }, 'Timeline t2 does not exist.'],
    ]
    for (const [operation, params, message] of cases) {
      expect(await fixture.run(operation, params)).toMatchObject({ status: 'failed', error: { code: 'operation_failed', message } })
    }
    // A failed call changes nothing; repeating it fails again because the check runs on every call.
    expect(fixture.ctx.dvProject.getState(fixture.project).components.timeline.timelines[0]?.clips).toHaveLength(2)
    expect(await fixture.run('timeline.clip_remove', { clip: 0 })).toMatchObject({ status: 'failed' })
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before + cases.length + 1)
    await expect(fixture.run('timeline.clip_move', { clip: 1 })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(fixture.run('timeline.clip_split', { clip: 'one', at_sec: 1 })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(failure(await fixture.call('dv_timeline_rename', { reason: 'no name', timeline: 't1' }))).toContain('name')
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before + cases.length + 1)
  })

  it('stops accepting a draft whose clip edit no longer applies to main', async () => {
    const fixture = await start()
    await fixture.run('timeline.create', { assets: ['a1', 'a2'] })
    value(await fixture.call('dv_timeline_clip_remove', { reason: 'drop the second', clip: 2 }))
    await fixture.run('timeline.clip_remove', { clip: 2 })
    const origin = { actor: 'user' as const, surface: 'timeline' as const, session: brandString<SessionId>('s1'), turn: null, tool_call: null, intent: 'accept' }
    await expect(fixture.ctx.dvProject.acceptDraft(fixture.project, origin))
      .rejects.toMatchObject({ code: 'draft_conflict', message: expect.stringContaining('Timeline t1 has 1 clip; position 2 is not between 1 and 1.') })
  })
})
