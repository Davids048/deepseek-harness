/**
 * The Shot plan component in a REAL composition: a test-only `cordis.yml` boots the DSH tool registry, `dvProject`,
 * `dvFfmpeg`, the asset pool, `dvTimeline` and `dvShotPlan` through the Loader. `plan.approve` schedules other
 * components' operations by name: the timeline operations of the real `dvTimeline`, and a stand-in `shot.render`
 * registered with `dvProject` that imports a small video and a last still without a generation backend. The browser
 * stories run the approval against the real components.
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
  type AssetId, type OperationSpec, type OperationToolValue, type ProjectId, type ProjectRecord, type RecordId, type RunRequest,
  type SessionId,
} from '@dv/project'
import DvTimeline from '@dv/timeline'
import { afterEach, describe, expect, it } from 'vitest'
import DvShotPlan from '../src/index.ts'

const FFMPEG = process.env['DV_FFMPEG'] ?? '/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg'
const FFPROBE = process.env['DV_FFPROBE'] ?? 'ffprobe'

/** The plugin classes the fixture rows resolve through `globalThis`, because Node imports the rows outside Vite. */
const PLUGINS = { SystemPrompt, ToolRuntime, DvProject, DvFfmpeg, DvAssetPool, DvTimeline, DvShotPlan }

/** A user action outside any chat session: it lands on `main` directly. */
const USER = { actor: 'user' as const, surface: 'canvas' as const, session: null, turn: null, tool_call: null }

interface Fixture {
  ctx: Context
  project: ProjectId
  /** Store bytes in the asset pool. */
  put(bytes: string, mime: string, name: string): AssetId
  /** Run one tool as the agent of chat session `s1`, which is bound to `project`. */
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
  /** Run one operation on `main` as the user and return its record. */
  record(operation: string, params: Record<string, unknown>, extra?: Partial<RunRequest>): Promise<ProjectRecord>
  /** The records of the project's `main` that ran one operation. */
  recordsOf(operation: string): ProjectRecord[]
}

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

/**
 * The stand-in for the `shot.render` that `plan.approve` schedules: its name, input roles and output order match the
 * real Shot render component.
 * @param precondition - the stand-in render's precondition, when the test needs one.
 * @returns the spec.
 */
function standIns(precondition?: OperationSpec['precondition']): OperationSpec[] {
  const base = { version: '1', description: 'stand-in', deterministic: false, confirm: 'never' as const, summarize: () => 'stand-in' }
  return [
    {
      ...base, name: 'shot.render', component: 'shot', resource: 'gpu', params: {
        prompt: { type: 'string', required: true }, plan: { type: 'string' }, shot: { type: 'integer' }, duration_sec: { type: 'integer' },
        aspect_ratio: { type: 'string' }, resolution: { type: 'string' }, generation_mode: { type: 'string' }, seed: { type: 'integer' },
      },
      inputs: {
        reference: { type: 'image', many: true, bible: true, description: 'References.' },
        first_frame: { type: 'image', description: 'The first frame.' },
      },
      outputs: [{ role: 'video', type: 'video' }, { role: 'last_still', type: 'image' }],
      ...precondition === undefined ? {} : { precondition },
      execute: context => Promise.resolve({
        outputs: [
          context.importAsset(Buffer.from(`video ${String(context.params['prompt'])}`), { mime: 'video/mp4', name: 'shot.mp4' }),
          context.importAsset(Buffer.from(`frame ${String(context.params['prompt'])}`), { mime: 'image/png', name: 'last.png' }),
        ],
      }),
    },
  ]
}

/**
 * Boot the composition from a test-only `cordis.yml`, with the stand-ins registered beside it.
 * @param precondition - the stand-in render's precondition, when the test needs one.
 * @returns the fixture, with a project bound to chat session `s1`.
 */
async function start(precondition?: OperationSpec['precondition']): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'dv-shot-plan-'))
  const globals = globalThis as typeof globalThis & { __dvShotPlanComposition?: typeof PLUGINS }
  globals.__dvShotPlanComposition = PLUGINS
  const rows: string[] = []
  const row = (id: string, key: keyof typeof PLUGINS, config: string[]): void => {
    writeFileSync(join(dir, `${id}.mjs`), `export default globalThis.__dvShotPlanComposition.${key}\n`)
    rows.push(`- id: ${id}`, `  name: ${pathToFileURL(join(dir, `${id}.mjs`)).href}`, ...config.length === 0 ? [] : ['  config:', ...config.map(line => `    ${line}`)])
  }
  row('system-prompt', 'SystemPrompt', [])
  row('tools', 'ToolRuntime', [])
  row('dv-project', 'DvProject', [`root: ${join(dir, 'projects')}`, `sessionRoot: ${join(dir, 'sessions')}`])
  row('dv-ffmpeg', 'DvFfmpeg', [`ffmpegPath: ${FFMPEG}`, `ffprobePath: ${FFPROBE}`])
  row('dv-asset-pool', 'DvAssetPool', [`root: ${join(dir, 'assets')}`])
  row('dv-timeline', 'DvTimeline', [])
  row('dv-shot-plan', 'DvShotPlan', [])
  writeFileSync(join(dir, 'cordis.yml'), `${rows.join('\n')}\n`)

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  const removers = standIns(precondition).map(spec => ctx.dvProject.registerOperation(spec))
  disposers.push(async () => {
    for (const remove of removers) remove()
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const project = (await ctx.dvProject.createProject('plans', { ...USER, intent: 'create' })).id
  ctx.dvProject.bindSession(brandString<SessionId>('s1'), project)
  let calls = 0
  return {
    ctx, project,
    put: (bytes, mime, name) => ctx.dvAssetPool.importAsset(Buffer.from(bytes), { mime, name }, null),
    call(name, args) {
      calls += 1
      return ctx.tools.execute({ callId: ToolCallId(`call-${calls}`), name, arguments: args, signal: new AbortController().signal, agent: { id: 's1' } as never })
    },
    async record(operation, params, extra = {}) {
      const result = await ctx.dvProject.run({ ...USER, project, operation, params, inputs: [], intent: operation, ...extra })
      if (result.record === null) throw new Error(`${operation} wrote no record`)
      return result.record
    },
    recordsOf: operation => ctx.dvProject.getState(project).components.proj.records.filter(record => record.operation === operation),
  }
}

/** The value of a successful operation tool call. */
function value(result: ToolExecutionResult): OperationToolValue {
  if (result.isError) throw new Error(result.error.message)
  return result.value as OperationToolValue
}

/** The spec of a registered operation. */
function spec(fixture: Fixture, name: string): OperationSpec | undefined {
  return fixture.ctx.dvProject.listOperations().find(entry => entry.name === name)
}

describe('dvShotPlan', () => {
  it('registers the three operations with their dv_plan_* tools and the plan reducer, and removes them on disposal', async () => {
    const fixture = await start()
    const specs = fixture.ctx.dvProject.listOperations().filter(entry => entry.component === 'plan')
    expect(specs.map(entry => [entry.name, entry.confirm, entry.deterministic])).toEqual([
      ['plan.create', 'never', true], ['plan.update', 'never', true], ['plan.approve', 'agent_ask_first', false],
    ])
    for (const name of ['dv_plan_create', 'dv_plan_update', 'dv_plan_approve']) expect(fixture.ctx.tools.get(name), name).toBeDefined()
    expect(JSON.stringify(fixture.ctx.tools.schemas().find(tool => tool.name === 'dv_plan_approve')?.parameters)).not.toContain('"inputs"')
    expect(fixture.ctx.dvProject.getState(fixture.project).components.plan).toEqual({ plans: [] })
    const entry = [...fixture.ctx.loader.entries()].find(candidate => candidate.options.name.endsWith('/dv-shot-plan.mjs'))
    await entry?.fiber?.dispose()
    expect(fixture.ctx.dvProject.listOperations().filter(candidate => candidate.component === 'plan')).toEqual([])
    expect(fixture.ctx.tools.get('dv_plan_create')).toBeUndefined()
    expect(fixture.ctx.dvProject.getState(fixture.project).components).not.toHaveProperty('plan')
  })

  it('stores the agent\'s plan as JSON, revises it, and lists both in the plan slice', async () => {
    const fixture = await start()
    const shots = [{ prompt: 'Picture 1 starts dancing', duration_sec: 1 }, { prompt: 'keeps dancing', duration_sec: 2 }]
    const created = value(await fixture.call('dv_plan_create', { reason: 'propose', title: 'dance', continuity: 'chained', references: ['c1@1'], shots }))
    expect(created).toMatchObject({ status: 'done', summary: 'plan with 2 shots', outputs: [{ role: 'plan', mime: 'application/json' }] })
    const record = fixture.ctx.dvProject.getRecord(fixture.project, brandString<RecordId>(created.record))
    expect(record).toMatchObject({
      actor: 'agent', surface: 'chat', component: 'plan', operation: 'plan.create', intent: 'propose', inputs: [],
      params: { title: 'dance', continuity: 'chained', references: ['c1@1'], shots },
    })
    const stored = JSON.parse(fixture.ctx.dvAssetPool.read(record.outputs[0] as AssetId).toString('utf8')) as unknown
    expect(stored).toEqual({ title: 'dance', continuity: 'chained', references: ['c1@1'], shots })
    expect(fixture.ctx.dvShotPlan.getPlan(fixture.project, created.record)).toEqual(stored)
    const revised = value(await fixture.call('dv_plan_update', { reason: 'shorter', shots: [{ prompt: 'one' }], based_on: created.record }))
    expect(revised.summary).toBe('plan updated (1 shots)')
    const update = fixture.ctx.dvProject.getRecord(fixture.project, brandString<RecordId>(revised.record))
    expect(update).toMatchObject({ operation: 'plan.update', based_on: created.record })
    const draft = fixture.ctx.dvProject.workingBranch(fixture.project, brandString<SessionId>('s1')).name
    expect(fixture.ctx.dvProject.getState(fixture.project, draft).components.plan.plans).toEqual([
      { record: created.record, approved: false, approved_by: null }, { record: revised.record, approved: false, approved_by: null },
    ])
    expect(spec(fixture, 'plan.create')?.summarize({ ...record, params: {} })).toBe('plan with 0 shots')
  })

  it('approves a chained plan into ordered shot renders and one timeline, written by the system actor', async () => {
    const fixture = await start()
    const picture = fixture.put('face', 'image/png', 'face.png')
    const plan = await fixture.record('plan.create', {
      continuity: 'chained', references: [picture], aspect_ratio: '16:9', seed: 7,
      shots: [{ prompt: 'one', duration_sec: 1 }, { prompt: 'two', duration_sec: 2, seed: 9 }],
    })
    const approved = value(await fixture.call('dv_plan_approve', { reason: 'the user said go', plan: plan.id }))
    expect(approved).toMatchObject({ status: 'done', summary: `plan ${plan.id.slice(0, 8)} approved` })
    expect(approved.scheduled).toHaveLength(3)
    await fixture.ctx.dvProject.wait(fixture.project)
    const draft = fixture.ctx.dvProject.workingBranch(fixture.project, brandString<SessionId>('s1')).name
    const state = fixture.ctx.dvProject.getState(fixture.project, draft)
    const shots = state.components.proj.records.filter(record => record.operation === 'shot.render')
    expect(shots.map(shot => shot.params)).toEqual([
      { prompt: 'one', plan: plan.id, shot: 1, duration_sec: 1, aspect_ratio: '16:9', seed: 7 },
      { prompt: 'two', plan: plan.id, shot: 2, duration_sec: 2, aspect_ratio: '16:9', seed: 9 },
    ])
    expect(shots.every(shot => shot.actor === 'system' && shot.surface === 'chat' && shot.session === 's1' && shot.status === 'done')).toBe(true)
    expect(shots[0]?.inputs).toEqual([{ role: 'reference', ref: { asset: picture }, resolved_asset: picture }])
    expect(shots[1]?.inputs[1]).toEqual({ role: 'first_frame', ref: { record: shots[0]?.id, output: 1 }, resolved_asset: shots[0]?.outputs[1] })
    const timeline = state.components.proj.records.find(record => record.operation === 'timeline.create')
    expect(timeline).toMatchObject({ actor: 'system', status: 'done', params: { timeline: 't1', plan: plan.id } })
    expect(timeline?.inputs.map(input => input.resolved_asset)).toEqual(shots.map(shot => shot.outputs[0]))
    expect(approved.scheduled).toEqual([...shots.map(shot => shot.id), timeline?.id])
    expect(state.components.timeline.timelines[0]?.clips.map(clip => clip.asset)).toEqual(shots.map(shot => shot.outputs[0]))
    expect(state.components.plan.plans).toEqual([{ record: plan.id, approved: true, approved_by: approved.record }])
  })

  it('updates the plan\'s timeline when the plan is approved again, and creates a timeline for another plan', async () => {
    const fixture = await start()
    const picture = fixture.put('face', 'image/png', 'face.png')
    const plan = await fixture.record('plan.create', { references: [picture], shots: [{ prompt: 'one' }] })
    const other = await fixture.record('plan.create', { references: [picture], shots: [{ prompt: 'two' }] })
    const layouts = async (): Promise<unknown[]> => {
      await fixture.ctx.dvProject.wait(fixture.project)
      return fixture.ctx.dvProject.getState(fixture.project).components.proj.records
        .filter(record => record.component === 'timeline').map(record => [record.operation, record.params, record.status])
    }
    // Each approval waits for the scheduled records of the one before, so it sees the timeline they laid out.
    for (const approved of [plan, plan, other]) {
      await fixture.record('plan.approve', { plan: approved.id })
      await fixture.ctx.dvProject.wait(fixture.project)
    }
    expect(await layouts()).toEqual([
      ['timeline.create', { timeline: 't1', plan: plan.id }, 'done'],
      ['timeline.update', { timeline: 't1', plan: plan.id }, 'done'],
      ['timeline.create', { timeline: 't2', plan: other.id }, 'done'],
    ])
    const timelines = fixture.ctx.dvProject.getState(fixture.project).components.timeline.timelines
    const renders = fixture.recordsOf('shot.render')
    expect(timelines.map(timeline => [timeline.id, timeline.clips.map(clip => clip.asset)]))
      .toEqual([['t1', [renders[1]?.outputs[0]]], ['t2', [renders[2]?.outputs[0]]]])
  })

  it('updates the timeline of the plan an approved plan.update is based on', async () => {
    const fixture = await start()
    const picture = fixture.put('face', 'image/png', 'face.png')
    const plan = await fixture.record('plan.create', { references: [picture], shots: [{ prompt: 'one' }] })
    await fixture.record('plan.approve', { plan: plan.id })
    await fixture.ctx.dvProject.wait(fixture.project)
    const updated = await fixture.record('plan.update', { references: [picture], shots: [{ prompt: 'two' }] }, { based_on: plan.id })
    await fixture.record('plan.approve', { plan: updated.id })
    await fixture.ctx.dvProject.wait(fixture.project)
    const layouts = fixture.ctx.dvProject.getState(fixture.project).components.proj.records
      .filter(record => record.component === 'timeline').map(record => [record.operation, record.params])
    expect(layouts).toEqual([
      ['timeline.create', { timeline: 't1', plan: plan.id }],
      ['timeline.update', { timeline: 't1', plan: updated.id }],
    ])
  })

  it('gives independent shots only their references, and a shot\'s own references replace the plan\'s', async () => {
    const fixture = await start()
    const shared = fixture.put('shared', 'image/png', 'shared.png')
    const own = fixture.put('own', 'image/png', 'own.png')
    const plan = await fixture.record('plan.create', {
      continuity: 'independent', references: [shared], shots: [{ prompt: 'a' }, { prompt: 'b', references: [own] }, { prompt: 'c', references: [] }],
    })
    await fixture.record('plan.approve', { plan: plan.id })
    await fixture.ctx.dvProject.wait(fixture.project)
    expect(fixture.recordsOf('shot.render').map(shot => shot.inputs.map(input => input.ref))).toEqual([[{ asset: shared }], [{ asset: own }], []])
    expect(fixture.recordsOf('shot.render').map(shot => shot.actor)).toEqual(['system', 'system', 'system'])
  })

  it('refuses an approval before its record when shots break the render precondition, naming every refused shot', async () => {
    // The stand-in render refuses a shot without a reference, the way Shot render does when the model needs reference images.
    const fixture = await start((request) => {
      if (request.inputs.some(input => input.role === 'reference')) return Promise.resolve()
      return Promise.reject(new Error('The video model renders every shot from 1 to 3 reference images. Nothing was rendered.'))
    })
    const picture = fixture.put('face', 'image/png', 'face.png')
    const plan = await fixture.record('plan.create', {
      shots: [{ prompt: 'one', references: [picture] }, { prompt: 'two' }, { prompt: 'three' }],
    })
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    const message = 'Shot 2, 3 of the plan have no reference image. The video model renders every shot from 1 to 3 reference images. '
      + 'Nothing was rendered.'
    await expect(fixture.record('plan.approve', { plan: plan.id })).rejects.toThrow(message)
    // The agent is refused the same way before any question or record.
    const call = await fixture.call('dv_plan_approve', { reason: 'go', plan: plan.id })
    expect(call.isError && call.error.message).toBe(message)
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before)
    const single = await fixture.record('plan.create', { references: [picture], shots: [{ prompt: 'one' }, { prompt: 'two', references: [] }] })
    await expect(fixture.record('plan.approve', { plan: single.id })).rejects.toThrow('Shot 2 of the plan has no reference image.')
    // A plan whose every shot has a reference is approved; an unknown plan record is refused before its record too.
    const covered = await fixture.record('plan.create', { references: [picture], shots: [{ prompt: 'one' }] })
    expect((await fixture.record('plan.approve', { plan: covered.id })).status).toBe('done')
    await expect(fixture.record('plan.approve', { plan: 'ghost' })).rejects.toMatchObject({ code: 'unknown_record' })
    await fixture.ctx.dvProject.wait(fixture.project)
  })

  it('fails plans without shots, approvals of records that hold no plan, and unknown references', async () => {
    const fixture = await start()
    const empty = await fixture.record('plan.create', { shots: [] })
    expect(empty).toMatchObject({ status: 'failed', error: { code: 'operation_failed', message: 'plan.create needs at least one shot.' } })
    expect((await fixture.record('plan.update', { shots: [] })).error?.message).toBe('plan.update needs at least one shot.')
    await expect(fixture.record('plan.create', { title: 'no shots' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(fixture.record('plan.approve', {})).rejects.toMatchObject({ code: 'invalid_params' })
    expect(fixture.ctx.dvProject.getState(fixture.project).components.plan.plans).toEqual([])
    const notPlan = await fixture.record('plan.approve', { plan: empty.id })
    expect(notPlan).toMatchObject({ status: 'failed', error: { message: expect.stringContaining(`Record '${empty.id}' stored no plan`) } })
    const unknown = await fixture.record('plan.create', { references: ['c9@1'], shots: [{ prompt: 'x' }] })
    const approval = await fixture.record('plan.approve', { plan: unknown.id })
    expect(approval.error?.message).toBe("Unknown character, location, or style version 'c9@1'.")
    expect(fixture.recordsOf('shot.render')).toEqual([])
    expect(() => fixture.ctx.dvShotPlan.getPlan(fixture.project, 'ghost')).toThrow(expect.objectContaining({ code: 'unknown_record' }))
  })
})
