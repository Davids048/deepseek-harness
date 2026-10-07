/**
 * The Shot render component in a REAL composition: a test-only `cordis.yml` boots the DSH tool registry, the asset
 * pool, `dvProject`, `dvFfmpeg` and `dvShotRender` through the Loader. The render mode providers are the only fakes:
 * an in-process `dvRef2va` and `dvT2va` that render solid-color clips with ffmpeg. A test-only `bible` reducer stands
 * for the Story bible, so references can name character versions.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
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
  type AssetId, type CharacterId, type OperationSpec, type OperationToolValue, type ProjectId, type ProjectRecord, type RecordId,
  type RecordInputRef, type Reducer, type RunRequest, type SessionId,
} from '@dv/project'
import type { RenderModelFacts, RenderStreamEvent, Ref2vaRequest, T2vaRequest } from '@dv/render-modes'
import { afterEach, describe, expect, it } from 'vitest'
import DvShotRender from '../src/index.ts'
import { backendSeconds, imageLabels, shotGeometry } from '../src/render.ts'

const FFMPEG = process.env['DV_FFMPEG'] ?? '/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg'
const FFPROBE = process.env['DV_FFPROBE'] ?? 'ffprobe'

const run = promisify(execFile)

/** Frame counts for each whole-second duration from `min` to `max`. */
function framesByDuration(min: number, max: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: max - min + 1 }, (_value, index) => [String(min + index), (min + index) * 24 + 1]))
}

/** A model with small frames so the fake providers render quickly; `ref2va` takes two reference images. */
function testFacts(mode: 'ref2va' | 't2va'): RenderModelFacts {
  return {
    modelId: `test-${mode}`, name: `Test ${mode}`, aspectRatios: ['16:9', '9:16'], resolutions: ['720p'],
    frameSizes: { '16:9': { '720p': [192, 112] }, '9:16': { '720p': [112, 192] } }, minDurationSec: 1, maxDurationSec: 5,
    numFramesByDurationSec: framesByDuration(1, 5), maxReferenceImages: mode === 'ref2va' ? 2 : 0,
    imageLabels: mode === 'ref2va' ? ['Picture 1', 'Picture 2', 'Picture 3'] : [], gpuSecondsPerVideoSecond: mode === 'ref2va' ? 3 : 1.5,
  }
}

/**
 * Render a solid-color clip and its last frame with ffmpeg.
 * @returns the bytes of the clip and the frame.
 */
async function renderClip(dir: string, width: number, height: number, numFrames: number): Promise<{ video: Buffer; lastFrame: Buffer }> {
  const video = join(dir, 'clip.mp4')
  const frame = join(dir, 'last.png')
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x3366cc:s=${width}x${height}:d=${(numFrames / 24).toFixed(3)}:r=24`, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video])
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-sseof', '-0.05', '-i', video, '-frames:v', '1', frame])
  return { video: readFileSync(video), lastFrame: readFileSync(frame) }
}

/** A render mode provider that renders a solid-color clip for every request and remembers the requests. */
class FakeRenderer<Request extends Ref2vaRequest | T2vaRequest> {
  readonly requests: Request[] = []
  /** When set, `render` rejects with this error before streaming. */
  failure: Error | null = null
  /** An event to leave out of the stream, to exercise the stream checks. */
  omit: 'last_frame' | 'done' | null = null
  /** Extra zero bytes appended as one chunk, to exercise write backpressure. */
  padChunkBytes = 0

  constructor(public facts: RenderModelFacts) {}

  model(): Promise<RenderModelFacts> {
    return Promise.resolve(this.facts)
  }

  ready(): Promise<{ ready: boolean; detail: string | null }> {
    return Promise.resolve({ ready: true, detail: null })
  }

  async *render(request: Request): AsyncIterable<RenderStreamEvent> {
    this.requests.push(request)
    if (this.failure !== null) throw this.failure
    const dir = mkdtempSync(join(tmpdir(), 'dv-fake-render-'))
    try {
      const rendered = await renderClip(dir, request.frameWidth, request.frameHeight, request.numFrames)
      if (this.omit !== 'last_frame') yield { kind: 'last_frame', png: rendered.lastFrame }
      yield { kind: 'video_start', mime: 'video/mp4; codecs="avc1.64001f"' }
      const half = Math.floor(rendered.video.length / 2)
      yield { kind: 'chunk', bytes: rendered.video.subarray(0, half) }
      yield { kind: 'chunk', bytes: rendered.video.subarray(half) }
      if (this.padChunkBytes > 0) yield { kind: 'chunk', bytes: Buffer.alloc(this.padChunkBytes) }
      if (this.omit !== 'done') yield { kind: 'done', timings: { generation_s: 0.25, encode_s: 0.05 } }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** One live shot as the fake live stream service saw it. */
interface LiveShot {
  record: RecordId
  init: { mime: string; segmentIdx: number }
  bytes: number
  end: 'complete' | 'failed' | null
}

/** A live stream service that remembers what each shot sent. */
class FakeLiveStream {
  readonly shots: LiveShot[] = []

  openSegment(_project: ProjectId, record: RecordId, init: { mime: string; segmentIdx: number }) {
    const shot: LiveShot = { record, init, bytes: 0, end: null }
    this.shots.push(shot)
    return {
      chunk: (bytes: Uint8Array) => { shot.bytes += bytes.byteLength },
      complete: () => { shot.end = 'complete' },
      fail: () => { shot.end = 'failed' },
    }
  }
}

/** The test-only Story bible slice: each character's versions, each with its reference images and its record. */
type BibleSlice = Record<string, Array<{ references: AssetId[]; record: RecordId }>>

/** The test-only `bible.character_create`: records a character version whose references are its input assets. */
const characterCreate: OperationSpec = {
  name: 'bible.character_create', component: 'bible', version: '1', description: 'Register a character.',
  params: { character: { type: 'string', required: true, description: 'The character ID.' } },
  inputs: { reference: { type: 'image', many: true, description: 'Reference images.' } },
  outputs: [], deterministic: true, resource: 'none', confirm: 'never', summarize: () => 'character',
  execute: () => Promise.resolve({ outputs: [] }),
}

/** The version a character reference names in the test-only slice. */
function versionOf(slice: BibleSlice, ref: RecordInputRef) {
  return 'character' in ref ? slice[ref.character]?.[ref.version - 1] ?? null : null
}

/** The test-only `bible` reducer, which answers `createdBy` and `assetsOf` the way the Story bible does. */
const bibleReducer: Reducer<never> & { initial(): BibleSlice } = {
  initial: () => ({}),
  reduce(slice: BibleSlice, record: ProjectRecord): BibleSlice {
    if (record.operation !== 'bible.character_create' || record.status !== 'done') return slice
    const id = String(record.params['character'])
    const references = record.inputs.flatMap(input => input.resolved_asset === null ? [] : [input.resolved_asset])
    return { ...slice, [id]: [...slice[id] ?? [], { references, record: record.id }] }
  },
  createdBy: (slice: BibleSlice, ref: RecordInputRef) => versionOf(slice, ref)?.record ?? null,
  assetsOf: (slice: BibleSlice, ref: RecordInputRef) => versionOf(slice, ref)?.references ?? null,
} as never

/** The plugin classes the fixture rows resolve through `globalThis`, because Node imports the rows outside Vite. */
const PLUGINS = { SystemPrompt, ToolRuntime, DvProject, DvFfmpeg, DvAssetPool, DvShotRender }

interface Fixture {
  ctx: Context
  dir: string
  ref2va: FakeRenderer<Ref2vaRequest>
  t2va: FakeRenderer<T2vaRequest>
  project: ProjectId
  /** Store bytes in the asset pool. */
  put(bytes: Uint8Array, mime: string, name: string): AssetId
  /** Run one operation as the human, on `main`. */
  record(operation: string, params: Record<string, unknown>, inputs?: RunRequest['inputs'], extra?: Partial<RunRequest>): Promise<ProjectRecord>
  /** Run one tool as the agent of chat session `s1`, which is bound to `project`. */
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
}

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

/**
 * Boot the composition from a test-only `cordis.yml`.
 * @param options - the render modes whose fake providers are mounted (both by default), whether a live stream service
 *   is provided, and the GPU budget of a turn.
 * @returns the fixture, with a project bound to chat session `s1` and the test-only character operation.
 */
async function start(options: { modes?: Array<'ref2va' | 't2va'>; live?: FakeLiveStream; budget?: number } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'dv-shot-render-'))
  const globals = globalThis as typeof globalThis & { __dvShotRenderComposition?: typeof PLUGINS }
  globals.__dvShotRenderComposition = PLUGINS
  const rows: string[] = []
  const row = (id: string, key: keyof typeof PLUGINS, config: string[]): void => {
    writeFileSync(join(dir, `${id}.mjs`), `export default globalThis.__dvShotRenderComposition.${key}\n`)
    rows.push(`- id: ${id}`, `  name: ${pathToFileURL(join(dir, `${id}.mjs`)).href}`, ...config.length === 0 ? [] : ['  config:', ...config.map(line => `    ${line}`)])
  }
  const modes = options.modes ?? ['ref2va', 't2va']
  row('system-prompt', 'SystemPrompt', [])
  row('tools', 'ToolRuntime', [])
  row('dv-project', 'DvProject', [
    `root: ${join(dir, 'projects')}`, `sessionRoot: ${join(dir, 'sessions')}`, `confirmGpuSecondsThreshold: ${options.budget ?? 60}`,
  ])
  row('dv-ffmpeg', 'DvFfmpeg', [`ffmpegPath: ${FFMPEG}`, `ffprobePath: ${FFPROBE}`])
  row('dv-asset-pool', 'DvAssetPool', [`root: ${join(dir, 'assets')}`])
  row('dv-shot-render', 'DvShotRender', [])
  writeFileSync(join(dir, 'cordis.yml'), `${rows.join('\n')}\n`)

  const ctx = new Context()
  const ref2va = new FakeRenderer<Ref2vaRequest>(testFacts('ref2va'))
  const t2va = new FakeRenderer<T2vaRequest>(testFacts('t2va'))
  if (modes.includes('ref2va')) ctx.provide('dvRef2va', ref2va)
  if (modes.includes('t2va')) ctx.provide('dvT2va', t2va)
  if (options.live !== undefined) ctx.provide('vhStream', options.live) // names:allow (the live stream service keeps its name)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  ctx.effect(() => ctx.dvProject.registerReducer('bible' as never, bibleReducer))
  ctx.effect(() => ctx.dvProject.registerOperation(characterCreate))
  const origin = { actor: 'user' as const, surface: 'api' as const, session: null, turn: null, tool_call: null }
  const project = (await ctx.dvProject.createProject('shots', { ...origin, intent: 'create' })).id
  ctx.dvProject.bindSession(brandString<SessionId>('s1'), project)
  let calls = 0
  return {
    ctx, dir, ref2va, t2va, project,
    put: (bytes, mime, name) => ctx.dvAssetPool.importAsset(bytes, { mime, name }, null),
    async record(operation, params, inputs = [], extra = {}) {
      const result = await ctx.dvProject.run({ ...origin, project, operation, params, inputs, intent: operation, ...extra })
      if (result.record === null) throw new Error(`${operation} wrote no record`)
      return result.record
    },
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

/** The error message of a failed tool call. */
function failure(result: ToolExecutionResult): string {
  return result.isError ? result.error.message : ''
}

/** A project whose character c1@1 has one reference image. */
async function withCharacter(fixture: Fixture, bytes: Uint8Array = Buffer.from('PNG-FAKE')): Promise<AssetId> {
  const image = fixture.put(bytes, 'image/png', 'face.png')
  await fixture.record('bible.character_create', { character: 'c1' }, [{ role: 'reference', ref: { asset: image } }])
  return image
}

/** The reference input of character c1 at version `version`. */
function c1(version = 1): RunRequest['inputs'][number] {
  return { role: 'reference', ref: { character: brandString<CharacterId>('c1'), version } }
}

/** The registered spec of a render operation. */
function renderSpec(fixture: Fixture, name = 'shot.render_ref2va'): OperationSpec | undefined {
  return fixture.ctx.dvProject.listOperations().find(spec => spec.name === name)
}

describe.skipIf(!existsSync(FFMPEG))('dvShotRender', () => {
  it('registers one operation and tool per mounted render mode, and removes them on disposal', async () => {
    const fixture = await start()
    // Each estimate uses the GPU rate its provider reports in the model facts.
    for (const [name, rate] of [['shot.render_ref2va', 3], ['shot.render_t2va', 1.5]] as const) {
      expect(renderSpec(fixture, name)).toMatchObject({ component: 'shot', resource: 'gpu', confirm: 'over_gpu_budget', deterministic: false })
      expect(renderSpec(fixture, name)?.estimate?.({ duration_sec: 2 })).toEqual({ gpu_seconds: 2 * rate })
      expect(renderSpec(fixture, name)?.estimate?.({})).toEqual({ gpu_seconds: 5 * rate })
      // An approved plan schedules renders with the params `plan`, `plan_version` and `shot`, so the spec declares them.
      expect(Object.keys(renderSpec(fixture, name)?.params ?? {})).toEqual(expect.arrayContaining(['plan', 'plan_version', 'shot']))
      expect(Object.keys(renderSpec(fixture, name)?.params ?? {})).not.toContain('generation_mode')
    }
    const ref2va = fixture.ctx.tools.schemas().find(tool => tool.name === 'dv_shot_render_ref2va')
    expect(ref2va?.description).toContain('Needs at least one reference image')
    expect(ref2va?.description).toContain('Uses the GPU.')
    expect(JSON.stringify(ref2va?.parameters)).toContain('continue_from')
    expect(JSON.stringify(ref2va?.parameters)).toContain('user_requested')
    const t2va = fixture.ctx.tools.schemas().find(tool => tool.name === 'dv_shot_render_t2va')
    expect(t2va?.description).toContain('from a prompt only')
    expect(JSON.stringify(t2va?.parameters)).not.toContain('continue_from')
    expect(renderSpec(fixture, 'shot.render_t2va')?.inputs).toEqual({})
    const entry = [...fixture.ctx.loader.entries()].find(candidate => candidate.options.name.endsWith('/dv-shot-render.mjs'))
    await entry?.fiber?.dispose()
    expect(renderSpec(fixture)).toBeUndefined()
    expect(fixture.ctx.tools.get('dv_shot_render_ref2va')).toBeUndefined()
    expect(fixture.ctx.tools.get('dv_shot_render_t2va')).toBeUndefined()
    // The reducer went with the plugin: a state no longer has the `shot` slice.
    expect(fixture.ctx.dvProject.getState(fixture.project).components).not.toHaveProperty('shot')
  })

  it('exposes no t2va tool while only the ref2va render mode is mounted', async () => {
    const fixture = await start({ modes: ['ref2va'] })
    expect(fixture.ctx.tools.get('dv_shot_render_ref2va')).toBeDefined()
    expect(fixture.ctx.tools.get('dv_shot_render_t2va')).toBeUndefined()
    expect(renderSpec(fixture, 'shot.render_t2va')).toBeUndefined()
    await expect(fixture.record('shot.render_t2va', { prompt: 'a cat' })).rejects.toThrow()
  })

  it('has no render operation without a render mode', async () => {
    const fixture = await start({ modes: [] })
    expect(renderSpec(fixture)).toBeUndefined()
    expect(fixture.ctx.tools.schemas().filter(tool => tool.name.startsWith('dv_shot_render'))).toEqual([])
    expect(fixture.ctx.dvProject.getState(fixture.project).components.shot).toEqual({ takes: {}, roots: {} })
    const call = (operation: string) => ({ record: { operation }, params: { prompt: 'x' } }) as never
    await expect(fixture.ctx.dvShotRender.renderShot(call('shot.render_ref2va'))).rejects.toThrow('needs the dvRef2va service')
    await expect(fixture.ctx.dvShotRender.renderShot(call('shot.render_t2va'))).rejects.toThrow('needs the dvT2va service')
  })

  it('renders a ref2va take with references and a first frame, keeps the seed, and stores both outputs', async () => {
    const fixture = await start()
    const image = await withCharacter(fixture)
    const shot = await fixture.record('shot.render_ref2va', { prompt: 'Picture 1 waves', duration_sec: 2, seed: 42 }, [c1()])
    expect(shot).toMatchObject({ status: 'done', component: 'shot', operation: 'shot.render_ref2va', operation_version: '1', actor: 'user' })
    expect(shot.inputs).toEqual([{ role: 'reference', ref: { character: 'c1', version: 1 }, resolved_asset: image }])
    const pool = fixture.ctx.dvAssetPool
    const size = { width: 192, height: 112 }
    expect(pool.get(shot.outputs[0] as AssetId)).toMatchObject({ mime: 'video/mp4', duration_sec: 2, created_by: shot.id, ...size })
    expect(pool.get(shot.outputs[1] as AssetId)).toMatchObject({ mime: 'image/png', name: `${shot.id.slice(0, 8)}-last.png`, ...size })
    expect((await fixture.ctx.dvFfmpeg.probe(pool.path(shot.outputs[0] as AssetId))).durationSec).toBeCloseTo(2, 0)
    expect(shot.report).toMatchObject({ seed: 42, model: 'test-ref2va', frame_width: 192, num_frames: 49, image_labels: { referenceLabels: ['Picture 1'], firstFrameLabel: null } })
    expect(shot.report).not.toHaveProperty('generation_mode')
    expect(shot.cost).toMatchObject({ gpu_seconds: 0.25, reused: false })
    expect(fixture.ref2va.requests[0]).toMatchObject({ prompt: 'Picture 1 waves', frameWidth: 192, frameHeight: 112, numFrames: 49, seed: 42, firstFrame: null })
    expect(fixture.ref2va.requests[0]?.references[0]?.equals(pool.read(image))).toBe(true)
    expect(renderSpec(fixture)?.summarize(shot)).toBe('shot "Picture 1 waves" (2s, seed 42)')
    const { report: _report, ...withoutReport } = shot
    expect(renderSpec(fixture)?.summarize({ ...withoutReport, params: {} })).toBe('shot "" (?s, seed ?)')
    expect(renderSpec(fixture)?.summarize({ ...withoutReport, params: { prompt: 'x', plan: 'p1', plan_version: 2, shot: 7 } }))
      .toBe('shot 7 of plan p1 v2 "x" (?s, seed ?)')
    // The next shot continues from the last still; the still is the first frame and gets the label after the references.
    const next = await fixture.record('shot.render_ref2va', { prompt: 'keeps waving' }, [c1(), { role: 'first_frame', ref: { record: shot.id, output: 1 } }])
    expect(fixture.ref2va.requests[1]?.references).toHaveLength(1)
    expect(fixture.ref2va.requests[1]?.firstFrame?.equals(pool.read(shot.outputs[1] as AssetId))).toBe(true)
    expect(next.report).toMatchObject({ duration_sec: 1, image_labels: { referenceLabels: ['Picture 1'], firstFrameLabel: 'Picture 2' } })
    expect(renderSpec(fixture)?.summarize(next)).toBe(`shot "keeps waving" (1s, seed ${String(next.report?.['seed'])})`)
  })

  it('renders a t2va take from the prompt only', async () => {
    const fixture = await start()
    const shot = await fixture.record('shot.render_t2va', { prompt: 'A baker opens the shutters', duration_sec: 3, seed: 5, aspect_ratio: '9:16' })
    expect(shot).toMatchObject({ status: 'done', component: 'shot', operation: 'shot.render_t2va', inputs: [] })
    expect(fixture.t2va.requests).toEqual([{ prompt: 'A baker opens the shutters', frameWidth: 112, frameHeight: 192, numFrames: 73, seed: 5 }])
    expect(fixture.ref2va.requests).toHaveLength(0)
    expect(shot.report).toMatchObject({ seed: 5, model: 'test-t2va', aspect_ratio: '9:16', resolution: '720p', duration_sec: 3, frame_width: 112 })
    expect(shot.report).not.toHaveProperty('image_labels')
    expect(fixture.ctx.dvAssetPool.get(shot.outputs[1] as AssetId)).toMatchObject({ mime: 'image/png', width: 112, height: 192 })
    expect(renderSpec(fixture, 'shot.render_t2va')?.summarize(shot)).toBe('shot "A baker opens the shutters" (3s, seed 5)')
    // A t2va take's last still can start a ref2va shot.
    await withCharacter(fixture)
    const next = await fixture.record('shot.render_ref2va', { prompt: 'Picture 1 enters' }, [c1(), { role: 'first_frame', ref: { record: shot.id, output: 1 } }])
    expect(next.status).toBe('done')
  })

  it('groups the takes of a shot in the shot slice for every render mode', async () => {
    const fixture = await start()
    await withCharacter(fixture)
    const first = await fixture.record('shot.render_ref2va', { prompt: 'Picture 1 waves' }, [c1()])
    const retake = await fixture.record('shot.render_ref2va', { prompt: 'Picture 1 waves slowly' }, [c1()], { based_on: first.id, supersedes: [first.id] })
    const third = await fixture.record('shot.render_t2va', { prompt: 'A man waves twice' }, [], { based_on: retake.id })
    expect(fixture.ctx.dvProject.getState(fixture.project).components.shot).toEqual({
      takes: { [first.id]: [first.id, retake.id, third.id] }, roots: { [retake.id]: first.id, [third.id]: first.id },
    })
  })

  it('runs the agent tools on the session draft, with continue_from as the first frame', async () => {
    const fixture = await start()
    const image = await withCharacter(fixture)
    const shot = value(await fixture.call('dv_shot_render_ref2va', { reason: 'first shot', prompt: 'Picture 1 waves', duration_sec: 1, inputs: { reference: 'c1@1' } }))
    expect(shot).toMatchObject({ status: 'done', scheduled: [], params: { prompt: 'Picture 1 waves', duration_sec: 1 } })
    expect(shot.outputs.map(output => output.role)).toEqual(['video', 'last_still'])
    const record = fixture.ctx.dvProject.getRecord(fixture.project, brandString<RecordId>(shot.record))
    expect(record).toMatchObject({ actor: 'agent', surface: 'chat', intent: 'first shot', branch: 'draft/s1', component: 'shot', operation: 'shot.render_ref2va' })
    expect(record.inputs).toEqual([{ role: 'reference', ref: { character: 'c1', version: 1 }, resolved_asset: image }])
    const next = value(await fixture.call('dv_shot_render_ref2va', { reason: 'second shot', prompt: 'keeps waving', inputs: { reference: [image] }, continue_from: shot.record }))
    expect(next.params).not.toHaveProperty('continue_from')
    expect(fixture.ctx.dvProject.getRecord(fixture.project, brandString<RecordId>(next.record)).inputs.find(input => input.role === 'first_frame'))
      .toEqual({ role: 'first_frame', ref: { record: shot.record, output: 1 }, resolved_asset: shot.outputs[1]?.asset_id })
    const fromText = value(await fixture.call('dv_shot_render_t2va', { reason: 'establishing shot', prompt: 'A quiet street at dawn', duration_sec: 1 }))
    expect(fixture.ctx.dvProject.getRecord(fixture.project, brandString<RecordId>(fromText.record)))
      .toMatchObject({ actor: 'agent', branch: 'draft/s1', operation: 'shot.render_t2va', inputs: [] })
  })

  it('asks for the user\'s agreement once a turn passes the GPU budget', async () => {
    const fixture = await start({ budget: 5 })
    await withCharacter(fixture)
    const args = { reason: 'long shot', prompt: 'Picture 1 walks a long way', duration_sec: 2, inputs: { reference: 'c1@1' } }
    const refused = failure(await fixture.call('dv_shot_render_ref2va', args))
    expect(refused).toContain('dv_shot_render_ref2va would bring this turn to about 6 GPU seconds, above the 5 s budget.')
    expect(refused).toContain('Render shot from references, 2 s: "Picture 1 walks a long way"')
    expect(fixture.ref2va.requests).toHaveLength(0)
    expect(value(await fixture.call('dv_shot_render_ref2va', { ...args, user_requested: true })).status).toBe('done')
    const summary = renderSpec(fixture, 'shot.render_t2va')?.confirmSummary?.({
      args: {}, request: { params: { prompt: 'x', plan: 'p1', plan_version: 1, shot: 3 } }, state: {}, exec: {},
    } as never, {} as never)
    expect(summary).toEqual({ text: 'Render shot 3 of plan p1 v1 from text: "x"', gpu_seconds: 7.5 })
  })

  it('refuses an agent call without reference images before recording anything', async () => {
    const fixture = await start()
    await fixture.record('bible.character_create', { character: 'c2' })
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    const noImages = await fixture.call('dv_shot_render_ref2va', { reason: 'cat', prompt: 'a cat', inputs: { reference: 'c2@1' } })
    expect(failure(noImages)).toContain('from 1 to 2 reference images, and this shot has none. Nothing was rendered.')
    // With the t2va render mode mounted, the refusal names it.
    expect(failure(noImages)).toContain('can be rendered from text with dv_shot_render_t2va')
    expect(failure(await fixture.call('dv_shot_render_ref2va', { reason: 'cat', prompt: 'a cat' }))).toContain('this shot has none')
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before)
    expect(fixture.ref2va.requests).toHaveLength(0)
  })

  it('refuses a call of any caller without reference images before recording anything', async () => {
    const fixture = await start({ modes: ['ref2va'] })
    await fixture.record('bible.character_create', { character: 'c2' })
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    const c2 = { role: 'reference', ref: { character: brandString<CharacterId>('c2'), version: 1 } }
    await expect(fixture.record('shot.render_ref2va', { prompt: 'a cat' }, [c2])).rejects.toThrow(
      'dv_shot_render_ref2va renders a shot from 1 to 2 reference images, and this shot has none. Nothing was rendered. Ask the user '
      + 'for a reference image of the subject (they can attach one in the chat; it appears under Imported images), add it as a '
      + 'reference or to the character, then call again.',
    )
    // A render that a plan scheduled is told to update the plan; the plan approval names its shots.
    await expect(fixture.record('shot.render_ref2va', { prompt: 'a cat', plan: 'p1', plan_version: 1, shot: 2 }, [c2]))
      .rejects.toThrow('from 1 to 2 reference images. Nothing was rendered.')
    await expect(fixture.record('shot.render_ref2va', { prompt: 'a cat', plan: 'p1', plan_version: 1, shot: 2 }, [c2]))
      .rejects.toThrow(/to the character, update the plan with dv_plan_update, then call again\.$/)
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before)
    expect(fixture.ref2va.requests).toHaveLength(0)
    // The precondition counts a character version's reference images: one image is enough.
    await withCharacter(fixture)
    expect((await fixture.record('shot.render_ref2va', { prompt: 'Picture 1 waves' }, [c1()])).status).toBe('done')
  })

  it('fails requests the model cannot serve and records stream failures', async () => {
    const fixture = await start()
    const image = await withCharacter(fixture)
    const failed = async (params: Record<string, unknown>, inputs: RunRequest['inputs'] = [c1()], operation = 'shot.render_ref2va'): Promise<string> => {
      const shot = await fixture.record(operation, params, inputs)
      expect(shot.status).toBe('failed')
      return shot.error?.message ?? ''
    }
    await expect(fixture.record('shot.render_ref2va', {}, [c1()])).rejects.toMatchObject({ code: 'invalid_params' })
    expect(await failed({ prompt: '' })).toContain('shot.render_ref2va needs a `prompt`')
    expect(await failed({ prompt: '' }, [], 'shot.render_t2va')).toContain('shot.render_t2va needs a `prompt`')
    await expect(fixture.record('shot.render_ref2va', { prompt: 'x' }, [])).rejects.toThrow('this shot has none')
    const three = [c1(), { role: 'reference', ref: { asset: image } }, { role: 'reference', ref: { asset: image } }]
    expect(await failed({ prompt: 'x' }, three)).toContain('requires 1 to 2 reference images; this shot has 3')
    expect(await failed({ prompt: 'x', duration_sec: 7 })).toContain('duration_sec')
    expect(await failed({ prompt: 'x', resolution: '4k' }, [], 'shot.render_t2va')).toContain('aspect_ratio and resolution')
    fixture.ref2va.omit = 'done'
    expect(await failed({ prompt: 'x' })).toContain('ended before the backend reported completion')
    fixture.ref2va.omit = 'last_frame'
    expect(await failed({ prompt: 'x' })).toContain('no last frame')
    fixture.ref2va.omit = null
    fixture.ref2va.failure = new Error('backend down')
    expect(await failed({ prompt: 'x' })).toBe('backend down')
    fixture.t2va.failure = new Error('t2va backend down')
    expect(await failed({ prompt: 'x' }, [], 'shot.render_t2va')).toBe('t2va backend down')
    expect(fixture.ctx.dvProject.getState(fixture.project).components.shot).toEqual({ takes: {}, roots: {} })
  })

  it('drains large chunks into the video file', async () => {
    const fixture = await start()
    await withCharacter(fixture)
    fixture.ref2va.padChunkBytes = 256 * 1024
    const shot = await fixture.record('shot.render_ref2va', { prompt: 'big' }, [c1()])
    expect(fixture.ctx.dvAssetPool.get(shot.outputs[0] as AssetId).size_bytes).toBeGreaterThan(256 * 1024)
  })

  it('broadcasts the shot to the live stream service while the provider streams it', async () => {
    const live = new FakeLiveStream()
    const fixture = await start({ live })
    await withCharacter(fixture)
    const shot = await fixture.record('shot.render_ref2va', { prompt: 'Picture 1 waves', shot: 3 }, [c1()])
    expect(live.shots).toEqual([{ record: shot.id, init: { mime: 'video/mp4; codecs="avc1.64001f"', segmentIdx: 3 }, bytes: fixture.ctx.dvAssetPool.get(shot.outputs[0] as AssetId).size_bytes, end: 'complete' }])
    fixture.ref2va.omit = 'done'
    await fixture.record('shot.render_ref2va', { prompt: 'cut short' }, [c1()])
    expect(live.shots[1]).toMatchObject({ init: { segmentIdx: 0 }, end: 'failed' })
  })
})

describe('render geometry, image labels and timings', () => {
  it('derives the geometry from the model facts', () => {
    const facts = testFacts('ref2va')
    expect(shotGeometry(facts, {})).toEqual({ aspectRatio: '16:9', resolution: '720p', width: 192, height: 112, durationSec: 1, numFrames: 25 })
    expect(shotGeometry(facts, { aspect_ratio: '9:16', duration_sec: 3 })).toMatchObject({ width: 112, height: 192, numFrames: 73 })
    expect(() => shotGeometry(facts, { aspect_ratio: '4:3' })).toThrow('aspect_ratio and resolution')
    expect(() => shotGeometry(facts, { resolution: '480p' })).toThrow('aspect_ratio and resolution')
    expect(() => shotGeometry(facts, { duration_sec: 9 })).toThrow('duration_sec must be a whole number from 1 to 5')
    expect(() => shotGeometry({ ...facts, aspectRatios: [] }, {})).toThrow('aspect_ratio and resolution')
  })

  it('labels the reference images in order, then the first frame', () => {
    const facts = testFacts('ref2va')
    expect(imageLabels(facts, 2, true)).toEqual({ referenceLabels: ['Picture 1', 'Picture 2'], firstFrameLabel: 'Picture 3' })
    expect(imageLabels(facts, 1, false)).toEqual({ referenceLabels: ['Picture 1'], firstFrameLabel: null })
    expect(imageLabels(facts, 3, true)).toEqual({ referenceLabels: ['Picture 1', 'Picture 2', 'Picture 3'], firstFrameLabel: null })
  })

  it('reports the longest backend timing in seconds', () => {
    expect(backendSeconds({ generation_s: 0.25, total_ms: 1500 })).toBe(1.5)
    expect(backendSeconds({})).toBe(0)
  })
})
