/**
 * The Shot plan component in a REAL composition: a test-only `cordis.yml` boots the DSH tool registry, `dvProject`,
 * `dvFfmpeg`, the asset pool, `dvTimeline` and `dvShotPlan` through the Loader. `plan.approve` schedules other
 * components' operations by name: the timeline operations of the real `dvTimeline`, and stand-ins for the Shot render
 * operations `shot.render_ref2va` and `shot.render_t2va` registered with `dvProject`, which import a small video and a
 * last still without a generation backend. The browser stories run the approval against the real components.
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
import { afterEach, describe, expect, it, vi } from 'vitest'
import DvShotPlan, { type PlanId } from '../src/index.ts'

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

/** What a test changes in the composition: the stand-in renders and the render modes they serve. */
interface StartOptions {
  /** The precondition of the stand-in `shot.render_ref2va`. */
  precondition?: OperationSpec['precondition']
  /** Awaited before each stand-in render imports its outputs, with the shot's prompt; a throw fails the render. */
  before?: (prompt: string) => Promise<void>
  /** The render modes with a registered stand-in render operation; both by default. */
  modes?: Array<'ref2va' | 't2va'>
}

/** The GPU seconds the stand-in renders estimate per video second. */
const GPU_SECONDS_PER_VIDEO_SECOND = 4

/**
 * The stand-ins for the render operations that `plan.approve` schedules: their names, params, input roles, output order
 * and estimate match the real Shot render component.
 * @param options - the precondition, the wait, and the render modes.
 * @returns the specs.
 */
function standIns(options: StartOptions): OperationSpec[] {
  const base = { version: '1', description: 'stand-in', deterministic: false, confirm: 'never' as const, summarize: () => 'stand-in' }
  const params = {
    prompt: { type: 'string', required: true }, plan: { type: 'string' }, plan_version: { type: 'integer' }, shot: { type: 'integer' },
    duration_sec: { type: 'integer' }, aspect_ratio: { type: 'string' }, resolution: { type: 'string' }, seed: { type: 'integer' },
  } as const
  const render = (mode: 'ref2va' | 't2va'): OperationSpec => ({
    ...base, name: `shot.render_${mode}`, component: 'shot', resource: 'gpu', params,
    inputs: mode === 'ref2va'
      ? {
        reference: { type: 'image', many: true, bible: true, description: 'References.' },
        first_frame: { type: 'image', description: 'The first frame.' },
      }
      : {},
    outputs: [{ role: 'video', type: 'video' }, { role: 'last_still', type: 'image' }],
    estimate: ({ duration_sec: duration }) => ({ gpu_seconds: (typeof duration === 'number' ? duration : 5) * GPU_SECONDS_PER_VIDEO_SECOND }),
    ...mode === 'ref2va' && options.precondition !== undefined ? { precondition: options.precondition } : {},
    execute: async (context) => {
      await options.before?.(String(context.params['prompt']))
      return {
        outputs: [
          context.importAsset(Buffer.from(`video ${String(context.params['prompt'])}`), { mime: 'video/mp4', name: 'shot.mp4' }),
          context.importAsset(Buffer.from(`frame ${String(context.params['prompt'])}`), { mime: 'image/png', name: 'last.png' }),
        ],
      }
    },
  })
  return (options.modes ?? ['ref2va', 't2va']).map(render)
}

/**
 * Boot the composition from a test-only `cordis.yml`, with the stand-ins registered beside it.
 * @param options - the stand-in renders' precondition, wait, and render modes.
 * @returns the fixture, with a project bound to chat session `s1`.
 */
async function start(options: StartOptions = {}): Promise<Fixture> {
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
  const removers = standIns(options).map(spec => ctx.dvProject.registerOperation(spec))
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

/** A `ref2va` shot with a prompt and the other fields given. */
function ref(prompt: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { mode: 'ref2va', prompt, ...fields }
}

describe('dvShotPlan', () => {
  it('registers the three operations with their dv_plan_* tools and the plan reducer, and removes them on disposal', async () => {
    const fixture = await start()
    const specs = fixture.ctx.dvProject.listOperations().filter(entry => entry.component === 'plan')
    expect(specs.map(entry => [entry.name, entry.confirm, entry.deterministic])).toEqual([
      ['plan.create', 'never', true], ['plan.update', 'never', true], ['plan.approve', 'always', false],
    ])
    for (const name of ['dv_plan_create', 'dv_plan_update', 'dv_plan_approve']) expect(fixture.ctx.tools.get(name), name).toBeDefined()
    expect(JSON.stringify(fixture.ctx.tools.schemas().find(tool => tool.name === 'dv_plan_approve')?.parameters)).not.toContain('"inputs"')
    expect(fixture.ctx.dvProject.getState(fixture.project).components.plan).toEqual({ plans: {} })
    const entry = [...fixture.ctx.loader.entries()].find(candidate => candidate.options.name.endsWith('/dv-shot-plan.mjs'))
    await entry?.fiber?.dispose()
    expect(fixture.ctx.dvProject.listOperations().filter(candidate => candidate.component === 'plan')).toEqual([])
    expect(fixture.ctx.tools.get('dv_plan_create')).toBeUndefined()
    expect(fixture.ctx.dvProject.getState(fixture.project).components).not.toHaveProperty('plan')
  })

  it('stores the agent\'s plan as JSON under a new plan ID with its shot lines and GPU estimate, and writes the next version', async () => {
    const fixture = await start()
    const picture = fixture.put('face', 'image/png', 'face.png')
    const shots = [ref('Picture 1 starts dancing', { duration_sec: 1 }), ref('keeps dancing', { duration_sec: 2, continue_previous: true })]
    const created = value(await fixture.call('dv_plan_create', { reason: 'propose', title: 'dance', references: [picture], shots }))
    expect(created).toMatchObject({ status: 'done', summary: 'plan with 2 shots', outputs: [{ role: 'plan', mime: 'application/json' }] })
    // The report shows what approving the plan renders and its GPU estimate (duration × 4 GPU seconds per video second).
    expect(created.report).toEqual({
      plan: 'p1', version: 1, gpu_seconds: 3 * GPU_SECONDS_PER_VIDEO_SECOND,
      shots: ['shot 1 (ref2va, 1 s): Picture 1 starts dancing', 'shot 2 (ref2va, 2 s, continues from the previous shot): keeps dancing'],
    })
    const record = fixture.ctx.dvProject.getRecord(fixture.project, brandString<RecordId>(created.record))
    expect(record).toMatchObject({
      actor: 'agent', surface: 'chat', component: 'plan', operation: 'plan.create', intent: 'propose', inputs: [],
      params: { title: 'dance', references: [picture], shots },
    })
    const stored = JSON.parse(fixture.ctx.dvAssetPool.read(record.outputs[0] as AssetId).toString('utf8')) as unknown
    expect(stored).toEqual({ title: 'dance', references: [picture], shots })
    const revised = value(await fixture.call('dv_plan_update', { reason: 'shorter', plan: 'p1', shots: [{ mode: 't2va', prompt: 'one' }] }))
    expect(revised).toMatchObject({
      summary: 'plan updated (1 shots)',
      report: { plan: 'p1', version: 2, shots: ['shot 1 (t2va): one'], gpu_seconds: 5 * GPU_SECONDS_PER_VIDEO_SECOND },
    })
    const state = fixture.ctx.dvProject.getState(fixture.project)
    expect(state.components.plan.plans).toEqual({
      p1: [
        { title: 'dance', references: [picture], shots, version: 1, created_by: created.record, approved_by: null },
        { shots: [{ mode: 't2va', prompt: 'one' }], version: 2, created_by: revised.record, approved_by: null },
      ],
    })
    expect(fixture.ctx.dvShotPlan.getPlan(state, 'p1')).toMatchObject({ version: 2 })
    expect(fixture.ctx.dvShotPlan.getPlan(state, 'p1', 1)).toMatchObject({ version: 1, title: 'dance' })
    // A second plan gets the next ID; plan IDs are never reused within the project.
    const other = value(await fixture.call('dv_plan_create', { reason: 'another story', shots: [ref('x')] }))
    expect(other.report).toMatchObject({ plan: 'p2', version: 1 })
    expect(spec(fixture, 'plan.create')?.summarize({ ...record, params: {} })).toBe('plan with 0 shots')
    // A shot without a render mode is refused by the tool's params.
    expect((await fixture.call('dv_plan_create', { reason: 'no mode', shots: [{ prompt: 'x' }] })).isError).toBe(true)
  })

  it('approves a plan into ordered shot renders of each shot\'s render mode and one timeline, written by the system actor', async () => {
    const fixture = await start()
    const picture = fixture.put('face', 'image/png', 'face.png')
    await fixture.record('plan.create', {
      references: [picture], aspect_ratio: '16:9', seed: 7,
      shots: [ref('one', { duration_sec: 1 }), ref('two', { duration_sec: 2, seed: 9, continue_previous: true }), { mode: 't2va', prompt: 'three' }],
    })
    const approved = value(await fixture.call('dv_plan_approve', { reason: 'the user said go', plan: 'p1', user_approved: true }))
    expect(approved).toMatchObject({ status: 'done', summary: 'plan p1 v1 approved' })
    expect(approved.scheduled).toHaveLength(4)
    await fixture.ctx.dvProject.wait(fixture.project)
    const state = fixture.ctx.dvProject.getState(fixture.project)
    const shots = state.components.proj.records.filter(record => record.component === 'shot')
    expect(shots.map(shot => [shot.operation, shot.params])).toEqual([
      ['shot.render_ref2va', { prompt: 'one', plan: 'p1', plan_version: 1, shot: 1, duration_sec: 1, aspect_ratio: '16:9', seed: 7 }],
      ['shot.render_ref2va', { prompt: 'two', plan: 'p1', plan_version: 1, shot: 2, duration_sec: 2, aspect_ratio: '16:9', seed: 9 }],
      ['shot.render_t2va', { prompt: 'three', plan: 'p1', plan_version: 1, shot: 3, aspect_ratio: '16:9', seed: 7 }],
    ])
    expect(shots.every(shot => shot.actor === 'system' && shot.surface === 'chat' && shot.session === 's1' && shot.status === 'done')).toBe(true)
    expect(shots[0]?.inputs).toEqual([{ role: 'reference', ref: { asset: picture }, resolved_asset: picture }])
    expect(shots[1]?.inputs[1]).toEqual({ role: 'first_frame', ref: { record: shots[0]?.id, output: 1 }, resolved_asset: shots[0]?.outputs[1] })
    // The t2va shot carries no references and does not continue from shot 2.
    expect(shots[2]?.inputs).toEqual([])
    const timeline = state.components.proj.records.find(record => record.operation === 'timeline.create')
    expect(timeline).toMatchObject({ actor: 'system', status: 'done', params: { timeline: 't1', plan: 'p1' } })
    expect(timeline?.inputs.map(input => input.resolved_asset)).toEqual(shots.map(shot => shot.outputs[0]))
    expect(approved.scheduled).toEqual([...shots.map(shot => shot.id), timeline?.id])
    expect(approved.report).toEqual({ plan: 'p1', version: 1, scheduled: approved.scheduled })
    expect(state.components.timeline.timelines[0]?.clips.map(clip => clip.asset)).toEqual(shots.map(shot => shot.outputs[0]))
    expect(state.components.plan.plans['p1' as PlanId]?.[0]?.approved_by).toBe(approved.record)
  })

  it('reports the shots an approval renders and their GPU estimate, and refuses the agent\'s approval without the user\'s agreement', async () => {
    const fixture = await start()
    const picture = fixture.put('face', 'image/png', 'face.png')
    await fixture.record('plan.create', { title: 'dance', references: [picture], shots: [ref('one', { duration_sec: 2 }), ref('two')] })
    await fixture.record('plan.approve', { plan: 'p1' })
    await fixture.ctx.dvProject.wait(fixture.project)
    const long = 'x'.repeat(100)
    const update = await fixture.record('plan.update', {
      plan: 'p1', title: 'dance', references: [picture],
      shots: [ref('one', { duration_sec: 2 }), ref('two'), ref(long, { duration_sec: 3, continue_previous: true }), { mode: 't2va', prompt: 'four' }],
    })
    const text = [
      'Approve plan p1 v2 "dance": render 2 of 4 shots and lay every shot on the plan\'s timeline.',
      '- shot 1: keeps its take',
      '- shot 2: keeps its take',
      `- shot 3 (ref2va, 3 s, continues from the previous shot): ${'x'.repeat(80)}…`,
      '- shot 4 (t2va): four',
    ].join('\n')
    // The update's report carries the same shot lines and estimate.
    expect(update.report).toEqual({
      plan: 'p1', version: 2, shots: text.split('\n').slice(1).map(line => line.slice(2)), gpu_seconds: (3 + 5) * GPU_SECONDS_PER_VIDEO_SECOND,
    })
    const state = fixture.ctx.dvProject.getState(fixture.project)
    const request = { ...USER, project: fixture.project, operation: 'plan.approve', params: { plan: 'p1' }, inputs: [], intent: 'go' }
    expect(spec(fixture, 'plan.approve')?.confirmSummary?.({ args: {}, request, state, exec: {} as never }, state))
      .toEqual({ text, gpu_seconds: (3 + 5) * GPU_SECONDS_PER_VIDEO_SECOND })
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    const refused = await fixture.call('dv_plan_approve', { reason: 'go', plan: 'p1' })
    expect(refused.isError && refused.error.message).toContain(text)
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before)
  })

  it('lays out the timeline at approval with placeholder clips that fill as each render finishes', async () => {
    const releases = new Map<string, () => void>()
    const fixture = await start({
      before: async (prompt) => {
        await new Promise<void>((resolve) => { releases.set(prompt, resolve) })
        if (prompt === 'two') throw new Error('The renderer ran out of memory.')
      },
    })
    const picture = fixture.put('face', 'image/png', 'face.png')
    await fixture.record('plan.create', { references: [picture], shots: [ref('one'), ref('two')] })
    await fixture.record('plan.approve', { plan: 'p1' })
    const clips = (): unknown => fixture.ctx.dvProject.getState(fixture.project).components.timeline.timelines
      .map(timeline => [timeline.id, timeline.clips.map(clip => [clip.id, clip.asset, clip.source?.record])])
    const [one, two] = fixture.recordsOf('shot.render_ref2va')

    // The timeline exists at once, done, with one placeholder clip per shot.
    expect(fixture.recordsOf('timeline.create').map(record => record.status)).toEqual(['done'])
    expect(clips()).toEqual([['t1', [['cl1', null, one?.id], ['cl2', null, two?.id]]]])

    // Each finished render fills its clip; a failed render leaves its placeholder and the timeline stays.
    await vi.waitFor(() => { expect(releases.has('one')).toBe(true) })
    releases.get('one')?.()
    await fixture.ctx.dvProject.wait(fixture.project, [one?.id as RecordId])
    const take = fixture.recordsOf('shot.render_ref2va')[0]?.outputs[0]
    expect(clips()).toEqual([['t1', [['cl1', take, one?.id], ['cl2', null, two?.id]]]])
    await vi.waitFor(() => { expect(releases.has('two')).toBe(true) })
    releases.get('two')?.()
    await fixture.ctx.dvProject.wait(fixture.project)
    expect(fixture.recordsOf('shot.render_ref2va')[1]?.status).toBe('failed')
    expect(clips()).toEqual([['t1', [['cl1', take, one?.id], ['cl2', null, two?.id]]]])
  })

  it('renders only new or changed shots of a later version, reuses the other takes, and updates the plan\'s timeline', async () => {
    const fixture = await start()
    const picture = fixture.put('face', 'image/png', 'face.png')
    const one = ref('one', { duration_sec: 1 })
    const two = ref('two', { duration_sec: 1, continue_previous: true })
    await fixture.record('plan.create', { references: [picture], shots: [one, two] })
    await fixture.record('plan.approve', { plan: 'p1' })
    await fixture.ctx.dvProject.wait(fixture.project)
    const [first, second] = fixture.recordsOf('shot.render_ref2va')
    // Version 2 appends shot 3: shots 1 and 2 keep their takes, and shot 3 starts from shot 2's last still.
    await fixture.record('plan.update', { plan: 'p1', references: [picture], shots: [one, two, ref('three', { continue_previous: true })] })
    expect(fixture.ctx.dvShotPlan.shotsToRender(fixture.ctx.dvProject.getState(fixture.project), 'p1')).toEqual([3])
    const extended = await fixture.record('plan.approve', { plan: 'p1' })
    await fixture.ctx.dvProject.wait(fixture.project)
    const renders = fixture.recordsOf('shot.render_ref2va')
    expect(renders).toHaveLength(3)
    expect(renders[2]?.params).toEqual({ prompt: 'three', plan: 'p1', plan_version: 2, shot: 3 })
    expect(renders[2]?.inputs.map(input => input.ref)).toEqual([{ asset: picture }, { record: second?.id, output: 1 }])
    expect(extended.report).toEqual({ plan: 'p1', version: 2, scheduled: [renders[2]?.id, fixture.recordsOf('timeline.update')[0]?.id] })
    let state = fixture.ctx.dvProject.getState(fixture.project)
    expect(state.components.timeline.timelines.map(timeline => [timeline.id, timeline.clips.map(clip => clip.asset)]))
      .toEqual([['t1', [first?.outputs[0], second?.outputs[0], renders[2]?.outputs[0]]]])
    expect(fixture.recordsOf('timeline.update').map(record => record.params)).toEqual([{ timeline: 't1', plan: 'p1' }])
    // Version 3 changes shot 1: every continuing shot after it renders again; approving version 2 again renders nothing.
    await fixture.record('plan.update', { plan: 'p1', references: [picture], shots: [ref('uno'), two, ref('three', { continue_previous: true })] })
    expect(fixture.ctx.dvShotPlan.shotsToRender(fixture.ctx.dvProject.getState(fixture.project), 'p1')).toEqual([1, 2, 3])
    expect(fixture.ctx.dvShotPlan.shotsToRender(fixture.ctx.dvProject.getState(fixture.project), 'p1', 2)).toEqual([])
    const again = await fixture.record('plan.approve', { plan: 'p1', version: 2 })
    await fixture.ctx.dvProject.wait(fixture.project)
    expect(fixture.recordsOf('shot.render_ref2va')).toHaveLength(3)
    expect((again.report?.['scheduled'] as unknown[]).length).toBe(1)
    state = fixture.ctx.dvProject.getState(fixture.project)
    expect(state.components.plan.plans['p1' as PlanId]?.map(version => version.approved_by !== null)).toEqual([true, true, false])
    expect(spec(fixture, 'plan.approve')?.summarize(again)).toBe('plan p1 v2 approved')
  })

  it('reuses only takes on the approving branch, makes shots without continue_previous reusable one by one, and renders a shot whose mode changed', async () => {
    const fixture = await start()
    const picture = fixture.put('face', 'image/png', 'face.png')
    await fixture.record('plan.create', { references: [picture], shots: [ref('a'), ref('b'), { mode: 't2va', prompt: 'c' }] })
    // The agent's approval lands on the forked branch b2; main holds none of the takes, so every shot would render there.
    const branch = (await fixture.ctx.dvProject.createBranch(fixture.project, null)).name
    value(await fixture.call('dv_plan_approve', { reason: 'go', plan: 'p1', user_approved: true }))
    await fixture.ctx.dvProject.wait(fixture.project)
    expect(fixture.ctx.dvShotPlan.shotsToRender(fixture.ctx.dvProject.getState(fixture.project, branch), 'p1')).toEqual([])
    expect(fixture.ctx.dvShotPlan.shotsToRender(fixture.ctx.dvProject.getState(fixture.project, 'main'), 'p1')).toEqual([1, 2, 3])
    // Shot 2 changes, shot 3 changes its render mode with the same prompt, shot 4 is new; shot 1 keeps its take.
    value(await fixture.call('dv_plan_update', {
      reason: 'change', plan: 'p1', references: [picture], shots: [ref('a'), ref('B'), ref('c'), { mode: 't2va', prompt: 'd' }],
    }))
    expect(fixture.ctx.dvShotPlan.shotsToRender(fixture.ctx.dvProject.getState(fixture.project, branch), 'p1')).toEqual([2, 3, 4])
  })

  it('updates the plan\'s timeline when the plan is approved again, and creates a timeline for another plan', async () => {
    const fixture = await start()
    const picture = fixture.put('face', 'image/png', 'face.png')
    await fixture.record('plan.create', { references: [picture], shots: [ref('one')] })
    await fixture.record('plan.create', { references: [picture], shots: [ref('two')] })
    // Each approval waits for the scheduled records of the one before, so it sees the timeline they laid out.
    for (const plan of ['p1', 'p1', 'p2']) {
      await fixture.record('plan.approve', { plan })
      await fixture.ctx.dvProject.wait(fixture.project)
    }
    const layouts = fixture.ctx.dvProject.getState(fixture.project).components.proj.records
      .filter(record => record.component === 'timeline').map(record => [record.operation, record.params, record.status])
    expect(layouts).toEqual([
      ['timeline.create', { timeline: 't1', plan: 'p1' }, 'done'],
      ['timeline.update', { timeline: 't1', plan: 'p1' }, 'done'],
      ['timeline.create', { timeline: 't2', plan: 'p2' }, 'done'],
    ])
    const timelines = fixture.ctx.dvProject.getState(fixture.project).components.timeline.timelines
    const renders = fixture.recordsOf('shot.render_ref2va')
    // The second approval of p1 reused its take, so only two shots rendered.
    expect(renders).toHaveLength(2)
    expect(timelines.map(timeline => [timeline.id, timeline.clips.map(clip => clip.asset)]))
      .toEqual([['t1', [renders[0]?.outputs[0]]], ['t2', [renders[1]?.outputs[0]]]])
  })

  it('gives ref2va shots only their references, a shot\'s own references replace the plan\'s, and t2va shots get none', async () => {
    const fixture = await start()
    const shared = fixture.put('shared', 'image/png', 'shared.png')
    const own = fixture.put('own', 'image/png', 'own.png')
    await fixture.record('plan.create', {
      references: [shared], shots: [ref('a'), ref('b', { references: [own] }), ref('c', { references: [] }), { mode: 't2va', prompt: 'd' }],
    })
    await fixture.record('plan.approve', { plan: 'p1' })
    await fixture.ctx.dvProject.wait(fixture.project)
    const renders = fixture.ctx.dvProject.getState(fixture.project).components.proj.records.filter(record => record.component === 'shot')
    expect(renders.map(shot => [shot.operation, shot.inputs.map(input => input.ref)])).toEqual([
      ['shot.render_ref2va', [{ asset: shared }]], ['shot.render_ref2va', [{ asset: own }]], ['shot.render_ref2va', []], ['shot.render_t2va', []],
    ])
    expect(renders.map(shot => shot.actor)).toEqual(['system', 'system', 'system', 'system'])
  })

  it('refuses a plan before its record when a shot names a render mode that is not served or breaks a render-mode rule', async () => {
    // Only ref2va is served, as when the t2va backend is not mounted.
    const fixture = await start({ modes: ['ref2va'] })
    const picture = fixture.put('face', 'image/png', 'face.png')
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    await expect(fixture.record('plan.create', { references: [picture], shots: [ref('a'), { mode: 't2va', prompt: 'b' }] })).rejects.toThrow(
      'The plan cannot be rendered as written. Shot 2 uses render mode t2va, which this project cannot render (there is no '
      + 'dv_shot_render_t2va tool); render modes available: ref2va.',
    )
    const refused = await fixture.call('dv_plan_create', {
      reason: 'rules', shots: [ref('a', { continue_previous: true }), { mode: 't2va', prompt: 'b', references: [picture], continue_previous: true }],
    })
    expect(refused.isError && refused.error.message).toBe([
      'The plan cannot be rendered as written.',
      'Shot 1 has no previous shot to continue; remove its continue_previous.',
      'Shot 2 uses render mode t2va, which this project cannot render (there is no dv_shot_render_t2va tool); render modes available: ref2va.',
      'Shot 2 uses render mode t2va, which takes no reference images; remove its references or use ref2va.',
      'Shot 2 uses render mode t2va, which cannot start from the previous shot; continue_previous needs ref2va.',
    ].join(' '))
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before)
    // plan.update checks the same rules; plan.approve also refuses a stored plan whose render mode is no longer served.
    await fixture.record('plan.create', { references: [picture], shots: [ref('a')] })
    await expect(fixture.record('plan.update', { plan: 'p1', shots: [{ mode: 't2va', prompt: 'b' }] })).rejects.toThrow('Shot 1 uses render mode t2va')
    const t2va = standIns({ modes: ['t2va'] }).map(entry => fixture.ctx.dvProject.registerOperation(entry))
    await fixture.record('plan.update', { plan: 'p1', shots: [{ mode: 't2va', prompt: 'b' }] })
    for (const remove of t2va) remove()
    await expect(fixture.record('plan.approve', { plan: 'p1' })).rejects.toThrow('Shot 1 uses render mode t2va')
    expect(fixture.recordsOf('plan.approve')).toEqual([])
  })

  it('refuses an approval before its record when shots break the render precondition, naming every refused shot', async () => {
    // The stand-in ref2va render refuses a shot without a reference, the way Shot render does.
    const fixture = await start({
      precondition: (request) => {
        if (request.inputs.some(input => input.role === 'reference')) return Promise.resolve()
        return Promise.reject(new Error('The video model renders every shot from 1 to 3 reference images. Nothing was rendered.'))
      },
    })
    const picture = fixture.put('face', 'image/png', 'face.png')
    await fixture.record('plan.create', { shots: [ref('one', { references: [picture] }), ref('two'), ref('three'), { mode: 't2va', prompt: 'four' }] })
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    const message = 'Shot 2, 3 of the plan are refused by its render operation. The video model renders every shot from 1 to 3 reference '
      + 'images. Nothing was rendered.'
    await expect(fixture.record('plan.approve', { plan: 'p1' })).rejects.toThrow(message)
    // The agent is refused the same way before it is asked to get the user's agreement, and before any record.
    const call = await fixture.call('dv_plan_approve', { reason: 'go', plan: 'p1' })
    expect(call.isError && call.error.message).toBe(message)
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before)
    await fixture.record('plan.create', { references: [picture], shots: [ref('one'), ref('two', { references: [] })] })
    await expect(fixture.record('plan.approve', { plan: 'p2' })).rejects.toThrow('Shot 2 of the plan is refused by its render operation.')
    // A plan whose every ref2va shot has a reference is approved; an unknown plan or version is refused before its record too.
    await fixture.record('plan.create', { references: [picture], shots: [ref('one'), { mode: 't2va', prompt: 'two' }] })
    expect((await fixture.record('plan.approve', { plan: 'p3' })).status).toBe('done')
    await expect(fixture.record('plan.approve', { plan: 'ghost' })).rejects.toThrow("Unknown plan 'ghost'")
    await expect(fixture.record('plan.approve', { plan: 'p3', version: 2 })).rejects.toThrow("Plan 'p3' has no version 2; it has 1.")
    await fixture.ctx.dvProject.wait(fixture.project)
  })

  it('fails plans without shots, and refuses updates of unknown plans and unknown references', async () => {
    const fixture = await start()
    const empty = await fixture.record('plan.create', { shots: [] })
    expect(empty).toMatchObject({ status: 'failed', error: { code: 'operation_failed', message: 'plan.create needs at least one shot.' } })
    await expect(fixture.record('plan.create', { title: 'no shots' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(fixture.record('plan.approve', {})).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(fixture.record('plan.update', { plan: 'p1', shots: [ref('x')] })).rejects.toThrow("Unknown plan 'p1'")
    expect(fixture.ctx.dvProject.getState(fixture.project).components.plan.plans).toEqual({})
    // An unknown reference is refused before the record, for the plan's references and a shot's own.
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    await expect(fixture.record('plan.create', { references: ['c9@1'], shots: [ref('x')] }))
      .rejects.toThrow("Unknown character, location, or style version 'c9@1'.")
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before)
    await fixture.record('plan.create', { shots: [{ mode: 't2va', prompt: 'x' }] })
    await expect(fixture.record('plan.update', { plan: 'p1', shots: [ref('x', { references: ['s9@1'] })] }))
      .rejects.toThrow("Unknown character, location, or style version 's9@1'.")
    expect((await fixture.record('plan.update', { plan: 'p1', shots: [] })).error?.message).toBe('plan.update needs at least one shot.')
    expect(fixture.recordsOf('shot.render_ref2va')).toEqual([])
    expect(() => fixture.ctx.dvShotPlan.getPlan(fixture.ctx.dvProject.getState(fixture.project), 'ghost')).toThrow("Unknown plan 'ghost'")
  })
})
