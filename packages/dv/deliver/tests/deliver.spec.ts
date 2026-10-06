/**
 * The Deliver component in a REAL composition: a test-only `cordis.yml` boots the DSH tool registry, the asset pool,
 * `dvProject`, `dvFfmpeg`, `dvTimeline` and `dvDeliver` through the Loader. Real ffmpeg trims and joins the clips of a
 * timeline; the agent's `dv_deliver_timeline_export` call and a direct `dvProject.run` call both write a
 * `deliver.timeline_export` record whose output is the joined video.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import DvFfmpeg, { FfmpegError } from '@dv/ffmpeg'
import DvProject, { type AssetId, type OperationToolValue, type ProjectId, type RecordId, type RunResult, type SessionId } from '@dv/project'
import DvTimeline from '@dv/timeline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DvDeliver from '../src/index.ts'

const FFMPEG = process.env['DV_FFMPEG'] ?? '/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg'
const FFPROBE = process.env['DV_FFPROBE'] ?? 'ffprobe'

/** The plugin classes the fixture rows resolve through `globalThis`, because Node imports the rows outside Vite. */
const PLUGINS = { SystemPrompt, ToolRuntime, DvAssetPool, DvProject, DvFfmpeg, DvTimeline, DvDeliver }

interface Fixture {
  ctx: Context
  dir: string
  project: ProjectId
  /** Write a solid-color test video with ffmpeg and import it into the asset pool. */
  clip(color: string, size: string, seconds: number): Promise<AssetId>
  /** Run one operation as the user on the timeline surface. */
  run(operation: string, params: Record<string, unknown>): Promise<RunResult>
  /** Run one tool as the agent of chat session `s1`, which is bound to `project`. */
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
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
  const dir = mkdtempSync(join(tmpdir(), 'dv-deliver-'))
  const globals = globalThis as typeof globalThis & { __dvDeliverComposition?: typeof PLUGINS }
  globals.__dvDeliverComposition = PLUGINS
  const rows: string[] = []
  const row = (id: string, key: keyof typeof PLUGINS, config: string[]): void => {
    writeFileSync(join(dir, `${id}.mjs`), `export default globalThis.__dvDeliverComposition.${key}\n`)
    rows.push(`- id: ${id}`, `  name: ${pathToFileURL(join(dir, `${id}.mjs`)).href}`, ...config.length === 0 ? [] : ['  config:', ...config.map(line => `    ${line}`)])
  }
  row('system-prompt', 'SystemPrompt', [])
  row('tools', 'ToolRuntime', [])
  row('dv-project', 'DvProject', [`root: ${join(dir, 'projects')}`, `sessionRoot: ${join(dir, 'sessions')}`])
  row('dv-ffmpeg', 'DvFfmpeg', [`ffmpegPath: ${FFMPEG}`, `ffprobePath: ${FFPROBE}`])
  row('dv-asset-pool', 'DvAssetPool', [`root: ${join(dir, 'assets')}`])
  row('dv-timeline', 'DvTimeline', [])
  row('dv-deliver', 'DvDeliver', [])
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
  const origin = { actor: 'user' as const, surface: 'timeline' as const, session: null, turn: null, tool_call: null }
  const project = (await ctx.dvProject.createProject('deliver', { ...origin, intent: 'create' })).id
  ctx.dvProject.bindSession(brandString<SessionId>('s1'), project)
  let calls = 0
  let clips = 0
  return {
    ctx, dir, project,
    async clip(color, size, seconds) {
      clips += 1
      const name = `clip-${clips}.mp4`
      await ctx.dvFfmpeg.run({
        argv: ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=${seconds}:r=10`, '-pix_fmt', 'yuv420p', `{{out:${name}}}`],
        inputs: [], outputs: [name], dir,
      })
      return ctx.dvAssetPool.importAsset({ path: join(dir, name) }, { mime: 'video/mp4', name }, null)
    },
    run: (operation, params) => ctx.dvProject.run({ project, operation, params, inputs: [], ...origin, intent: operation }),
    call(name, args) {
      calls += 1
      return ctx.tools.execute({ callId: ToolCallId(`call-${calls}`), name, arguments: args, signal: new AbortController().signal, agent: { id: 's1' } as never })
    },
  }
}

/** The value of a successful operation tool call. */
function value(result: ToolExecutionResult): OperationToolValue {
  if (result.isError) throw new Error(result.error.message)
  return result.value as OperationToolValue
}

describe('dvDeliver', () => {
  it('registers deliver.timeline_export with its dv_deliver_timeline_export tool and removes both on disposal', async () => {
    const fixture = await start()
    const specs = fixture.ctx.dvProject.listOperations().filter(spec => spec.component === 'deliver')
    expect(specs.map(spec => [spec.name, spec.deterministic, spec.resource])).toEqual([['deliver.timeline_export', false, 'cpu']])
    expect(fixture.ctx.tools.schemas().find(tool => tool.name === 'dv_deliver_timeline_export')?.description).toContain('Export a timeline')
    const entry = [...fixture.ctx.loader.entries()].find(candidate => candidate.options.name.endsWith('/dv-deliver.mjs'))
    await entry?.fiber?.dispose()
    expect(fixture.ctx.dvProject.listOperations().filter(spec => spec.component === 'deliver')).toEqual([])
    expect(fixture.ctx.tools.get('dv_deliver_timeline_export')).toBeUndefined()
  })

  it('fails the record for an unknown timeline, a project without timelines and an empty timeline, and refuses invalid params', async () => {
    const fixture = await start()
    const none = await fixture.run('deliver.timeline_export', {})
    expect(none.record).toMatchObject({ status: 'failed', error: { code: 'operation_failed', message: 'The project has no timeline to export.' } })
    await fixture.run('timeline.create', { timeline: 't1', assets: [] })
    const unknown = await fixture.run('deliver.timeline_export', { timeline: 't9' })
    expect(unknown.record).toMatchObject({ status: 'failed', error: { message: 'Unknown timeline "t9".' } })
    const empty = await fixture.run('deliver.timeline_export', { timeline: 't1' })
    expect(empty.record).toMatchObject({ status: 'failed', error: { message: 'Timeline t1 has no clips to export.' } })
    const records = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    await expect(fixture.run('deliver.timeline_export', { timeline: 5 })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(records)
  })

  it.skipIf(!existsSync(FFMPEG))('exports a timeline for the agent, trimming a clip with an in and out point to its range', async () => {
    const fixture = await start()
    const red = await fixture.clip('red', '160x90', 1)
    const blue = await fixture.clip('blue', '160x90', 2)
    await fixture.run('timeline.create', { timeline: 't1', name: 'Pilot', assets: [red, blue] })
    await fixture.run('timeline.clip_trim', { clip: 'cl2', in_sec: 0.5, out_sec: 1.5 })
    const exported = value(await fixture.call('dv_deliver_timeline_export', { reason: 'export the pilot', timeline: 't1' }))
    expect(exported).toMatchObject({ status: 'done', summary: 'exported timeline t1', outputs: [{ role: 'video', mime: 'video/mp4' }] })
    const record = fixture.ctx.dvProject.getRecord(fixture.project, brandString<RecordId>(exported.record))
    expect(record).toMatchObject({
      actor: 'agent', component: 'deliver', operation: 'deliver.timeline_export', params: { timeline: 't1' }, inputs: [], status: 'done',
    })
    const video = record.outputs[0] as AssetId
    expect(fixture.ctx.dvAssetPool.get(video)).toMatchObject({ mime: 'video/mp4', name: 'Pilot.mp4' })
    const probe = await fixture.ctx.dvFfmpeg.probe(fixture.ctx.dvAssetPool.path(video))
    expect(probe).toMatchObject({ width: 160, height: 90 })
    expect(probe.durationSec ?? 0).toBeCloseTo(2, 0)
  })

  it.skipIf(!existsSync(FFMPEG))('re-encodes at the first clip\'s frame size when stream copy fails, and exports the first timeline by default', async () => {
    const fixture = await start()
    const large = await fixture.clip('red', '160x90', 1)
    const small = await fixture.clip('green', '80x60', 1)
    await fixture.run('timeline.create', { timeline: 't1', assets: [large, small] })
    // ffmpeg's stream copy accepts these two files, so the test makes it fail as it does for clips of different codecs.
    const run = fixture.ctx.dvFfmpeg.run.bind(fixture.ctx.dvFfmpeg)
    const copy = vi.spyOn(fixture.ctx.dvFfmpeg, 'run').mockImplementation(request => (request.argv.includes('list.txt')
      ? Promise.reject(new FfmpegError('copy failed', 'mismatch'))
      : run(request)))
    const exported = await fixture.run('deliver.timeline_export', {})
    expect(exported.record).toMatchObject({ actor: 'user', surface: 'timeline', status: 'done', params: {} })
    const spec = fixture.ctx.dvProject.listOperations().find(entry => entry.name === 'deliver.timeline_export')
    expect(exported.record === null ? '' : spec?.summarize(exported.record)).toBe('exported the first timeline')
    expect(copy.mock.calls.some(([request]) => request.argv.includes('-filter_complex'))).toBe(true)
    copy.mockRestore()
    const probe = await fixture.ctx.dvFfmpeg.probe(fixture.ctx.dvAssetPool.path(exported.outputs[0] as AssetId))
    expect(probe).toMatchObject({ width: 160, height: 90 })
    expect(probe.durationSec ?? 0).toBeCloseTo(2, 0)
  })
})
