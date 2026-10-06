/**
 * The Shot render component in a REAL composition: a test-only `cordis.yml` boots the DSH tool registry, the asset
 * pool, `dvProject`, `dvFfmpeg` and `dvShotRender` through the Loader. The generation backend is the only fake: either
 * an in-process `dreamverseGeneration` that renders solid-color clips with ffmpeg, or the real generation client
 * against a fake streaming_v2 HTTP backend. A test-only `bible` reducer stands for the Story bible, so references can
 * name character versions.
 */
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
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
import DreamverseGeneration, { type ModelFacts, type SegmentOutput, type SegmentRequest } from '@dreamverse/generation-client'
import DvAssetPool from '@dv/asset-pool'
import DvFfmpeg from '@dv/ffmpeg'
import DvProject, {
  type AssetId, type CharacterId, type OperationSpec, type OperationToolValue, type ProjectId, type ProjectRecord, type RecordId,
  type RecordInputRef, type Reducer, type RunRequest, type SessionId,
} from '@dv/project'
import { afterEach, describe, expect, it } from 'vitest'
import DvShotRender from '../src/index.ts'
import { assetRecord, backendSeconds, shotGeometry } from '../src/render.ts'

const FFMPEG = process.env['DV_FFMPEG'] ?? '/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg'
const FFPROBE = process.env['DV_FFPROBE'] ?? 'ffprobe'
/** The reference image of the opt-in run against a running backend. */
const REAL_REFERENCE = '/mnt/lustre/vlm-d1su/codes/dsh-dv-hub/elon-musk.jpg'
const REAL_BACKEND = process.env['DV_BACKEND_URL']

const run = promisify(execFile)

/** Frame counts for each whole-second duration from `min` to `max`. */
function framesByDuration(min: number, max: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: max - min + 1 }, (_value, index) => [String(min + index), (min + index) * 24 + 1]))
}

/** A reference-image model with small frames so the fake backend renders quickly. */
function testFacts(): ModelFacts {
  return {
    modelId: 'test-ref2va', name: 'Test Ref2VA', generationModes: { ref2va: 'reference_images' }, unsupportedGenerationModes: {},
    aspectRatios: ['16:9', '9:16'], resolutions: ['720p'], minSegmentDurationSec: 1, maxSegmentDurationSec: 5, maxReferenceImages: 3,
    maxReferenceAspectRatio: 4, usesPreviousFrame: true, frameSizes: { '16:9': { '720p': [192, 112] }, '9:16': { '720p': [112, 192] } },
    numFramesByDurationSec: framesByDuration(1, 5), referenceLabels: ['Picture 1', 'Picture 2', 'Picture 3'],
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

/** A generation backend that renders a solid-color clip for every request and remembers the requests. */
class FakeGeneration {
  facts = testFacts()
  readonly requests: SegmentRequest[] = []
  /** When set, `generateSegment` rejects with this error before streaming. */
  failure: Error | null = null
  /** An event to leave out of the stream, to exercise the stream checks. */
  omit: 'last_frame' | 'done' | null = null
  /** Extra zero bytes appended as one chunk, to exercise write backpressure. */
  padChunkBytes = 0

  model(): Promise<ModelFacts> {
    return Promise.resolve(this.facts)
  }

  async *generateSegment(request: SegmentRequest): AsyncIterable<SegmentOutput> {
    this.requests.push(request)
    if (this.failure !== null) throw this.failure
    const dir = mkdtempSync(join(tmpdir(), 'dv-fake-generation-'))
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
const PLUGINS = { SystemPrompt, ToolRuntime, DvProject, DvFfmpeg, DvAssetPool, DvShotRender, DreamverseGeneration }

interface Fixture {
  ctx: Context
  dir: string
  generation: FakeGeneration
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
 * @param options - which backend to mount (`fake` by default, a URL for the real client, `none` for no backend), and
 *   whether a live stream service is provided.
 * @returns the fixture, with a project bound to chat session `s1` and the test-only character operation.
 */
async function start(options: { backend?: 'fake' | 'none' | { baseUrl: string }; live?: FakeLiveStream } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'dv-shot-render-'))
  const globals = globalThis as typeof globalThis & { __dvShotRenderComposition?: typeof PLUGINS }
  globals.__dvShotRenderComposition = PLUGINS
  const rows: string[] = []
  const row = (id: string, key: keyof typeof PLUGINS, config: string[]): void => {
    writeFileSync(join(dir, `${id}.mjs`), `export default globalThis.__dvShotRenderComposition.${key}\n`)
    rows.push(`- id: ${id}`, `  name: ${pathToFileURL(join(dir, `${id}.mjs`)).href}`, ...config.length === 0 ? [] : ['  config:', ...config.map(line => `    ${line}`)])
  }
  const backend = options.backend ?? 'fake'
  row('system-prompt', 'SystemPrompt', [])
  row('tools', 'ToolRuntime', [])
  row('dv-project', 'DvProject', [`root: ${join(dir, 'projects')}`, `sessionRoot: ${join(dir, 'sessions')}`])
  row('dv-ffmpeg', 'DvFfmpeg', [`ffmpegPath: ${FFMPEG}`, `ffprobePath: ${FFPROBE}`])
  row('dv-asset-pool', 'DvAssetPool', [`root: ${join(dir, 'assets')}`])
  if (typeof backend === 'object') row('dreamverse-generation', 'DreamverseGeneration', [`baseUrl: ${backend.baseUrl}`])
  row('dv-shot-render', 'DvShotRender', ['gpuSecondsPerVideoSecond: 3'])
  writeFileSync(join(dir, 'cordis.yml'), `${rows.join('\n')}\n`)

  const ctx = new Context()
  const generation = new FakeGeneration()
  if (backend === 'fake') ctx.provide('dreamverseGeneration', generation)
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
    ctx, dir, generation, project,
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

/** The registered `shot.render` spec. */
function renderSpec(fixture: Fixture): OperationSpec | undefined {
  return fixture.ctx.dvProject.listOperations().find(spec => spec.name === 'shot.render')
}

describe.skipIf(!existsSync(FFMPEG))('dvShotRender', () => {
  it('registers shot.render with dv_shot_render while the backend is mounted, and removes both on disposal', async () => {
    const fixture = await start()
    expect(renderSpec(fixture)).toMatchObject({ component: 'shot', resource: 'gpu', confirm: 'agent_ask_first', deterministic: false })
    expect(renderSpec(fixture)?.estimate?.({ duration_sec: 2 })).toEqual({ gpu_seconds: 6 })
    expect(renderSpec(fixture)?.estimate?.({})).toEqual({ gpu_seconds: 15 })
    const schema = fixture.ctx.tools.schemas().find(tool => tool.name === 'dv_shot_render')
    expect(schema?.description).toContain('Uses the GPU.')
    expect(JSON.stringify(schema?.parameters)).toContain('continue_from')
    // An approved plan schedules renders with the params `plan`, `plan_version` and `shot`, so the spec declares them.
    expect(Object.keys(renderSpec(fixture)?.params ?? {})).toEqual(expect.arrayContaining(['plan', 'plan_version', 'shot']))
    const entry = [...fixture.ctx.loader.entries()].find(candidate => candidate.options.name.endsWith('/dv-shot-render.mjs'))
    await entry?.fiber?.dispose()
    expect(renderSpec(fixture)).toBeUndefined()
    expect(fixture.ctx.tools.get('dv_shot_render')).toBeUndefined()
    // The reducer went with the plugin: a state no longer has the `shot` slice.
    expect(fixture.ctx.dvProject.getState(fixture.project).components).not.toHaveProperty('shot')
  })

  it('has no shot.render without a generation backend', async () => {
    const fixture = await start({ backend: 'none' })
    expect(renderSpec(fixture)).toBeUndefined()
    expect(fixture.ctx.tools.get('dv_shot_render')).toBeUndefined()
    expect(fixture.ctx.dvProject.getState(fixture.project).components.shot).toEqual({ takes: {}, roots: {} })
    await expect(fixture.ctx.dvShotRender.renderShot({} as never)).rejects.toThrow('needs the dreamverseGeneration service')
  })

  it('renders a take with references and a first frame, keeps the seed, and stores both outputs', async () => {
    const fixture = await start()
    const image = await withCharacter(fixture)
    const shot = await fixture.record('shot.render', { prompt: 'Picture 1 waves', duration_sec: 2, seed: 42 }, [c1()])
    expect(shot).toMatchObject({ status: 'done', component: 'shot', operation: 'shot.render', operation_version: '1', actor: 'user' })
    expect(shot.inputs).toEqual([{ role: 'reference', ref: { character: 'c1', version: 1 }, resolved_asset: image }])
    const pool = fixture.ctx.dvAssetPool
    const size = { width: 192, height: 112 }
    expect(pool.get(shot.outputs[0] as AssetId)).toMatchObject({ mime: 'video/mp4', duration_sec: 2, created_by: shot.id, ...size })
    expect(pool.get(shot.outputs[1] as AssetId)).toMatchObject({ mime: 'image/png', name: `${shot.id.slice(0, 8)}-last.png`, ...size })
    expect((await fixture.ctx.dvFfmpeg.probe(pool.path(shot.outputs[0] as AssetId))).durationSec).toBeCloseTo(2, 0)
    expect(shot.report).toMatchObject({ seed: 42, model: 'test-ref2va', frame_width: 192, num_frames: 49, image_labels: { referenceLabels: ['Picture 1'], firstFrameLabel: null } })
    expect(shot.cost).toMatchObject({ gpu_seconds: 0.25, reused: false })
    expect(fixture.generation.requests[0]).toMatchObject({ prompt: 'Picture 1 waves', frameWidth: 192, frameHeight: 112, numFrames: 49, seed: 42, returnLastFrame: true })
    expect(fixture.generation.requests[0]?.referenceImages[0]?.equals(pool.read(image))).toBe(true)
    expect(renderSpec(fixture)?.summarize(shot)).toBe('shot "Picture 1 waves" (2s, seed 42)')
    const { report: _report, ...withoutReport } = shot
    expect(renderSpec(fixture)?.summarize({ ...withoutReport, params: {} })).toBe('shot "" (?s, seed ?)')
    expect(renderSpec(fixture)?.summarize({ ...withoutReport, params: { prompt: 'x', plan: 'p1', plan_version: 2, shot: 7 } }))
      .toBe('shot 7 of plan p1 v2 "x" (?s, seed ?)')
    // The next shot continues from the last still; the still goes last in the request and gets the next label.
    const next = await fixture.record('shot.render', { prompt: 'keeps waving' }, [c1(), { role: 'first_frame', ref: { record: shot.id, output: 1 } }])
    expect(fixture.generation.requests[1]?.referenceImages).toHaveLength(2)
    expect(fixture.generation.requests[1]?.referenceImages[1]?.equals(pool.read(shot.outputs[1] as AssetId))).toBe(true)
    expect(next.report).toMatchObject({ duration_sec: 1, image_labels: { referenceLabels: ['Picture 1'], firstFrameLabel: 'Picture 2' } })
    expect(renderSpec(fixture)?.summarize(next)).toBe(`shot "keeps waving" (1s, seed ${String(next.report?.['seed'])})`)
    expect(assetRecord(pool, shot.outputs[0] as AssetId)).toMatchObject({ mediaType: 'video', mimeType: 'video/mp4', filePath: pool.path(shot.outputs[0] as AssetId) })
  })

  it('groups the takes of a shot in the shot slice', async () => {
    const fixture = await start()
    await withCharacter(fixture)
    const first = await fixture.record('shot.render', { prompt: 'Picture 1 waves' }, [c1()])
    const retake = await fixture.record('shot.render', { prompt: 'Picture 1 waves slowly' }, [c1()], { based_on: first.id, supersedes: [first.id] })
    const third = await fixture.record('shot.render', { prompt: 'Picture 1 waves twice' }, [c1()], { based_on: retake.id })
    expect(fixture.ctx.dvProject.getState(fixture.project).components.shot).toEqual({
      takes: { [first.id]: [first.id, retake.id, third.id] }, roots: { [retake.id]: first.id, [third.id]: first.id },
    })
  })

  it('runs the agent tool on the session draft, with continue_from as the first frame', async () => {
    const fixture = await start()
    const image = await withCharacter(fixture)
    const shot = value(await fixture.call('dv_shot_render', { reason: 'first shot', prompt: 'Picture 1 waves', duration_sec: 1, inputs: { reference: 'c1@1' } }))
    expect(shot).toMatchObject({ status: 'done', scheduled: [], params: { prompt: 'Picture 1 waves', duration_sec: 1 } })
    expect(shot.outputs.map(output => output.role)).toEqual(['video', 'last_still'])
    const record = fixture.ctx.dvProject.getRecord(fixture.project, brandString<RecordId>(shot.record))
    expect(record).toMatchObject({ actor: 'agent', surface: 'chat', intent: 'first shot', branch: 'draft/s1', component: 'shot', operation: 'shot.render' })
    expect(record.inputs).toEqual([{ role: 'reference', ref: { character: 'c1', version: 1 }, resolved_asset: image }])
    const next = value(await fixture.call('dv_shot_render', { reason: 'second shot', prompt: 'keeps waving', inputs: { reference: [image] }, continue_from: shot.record }))
    expect(next.params).not.toHaveProperty('continue_from')
    expect(fixture.ctx.dvProject.getRecord(fixture.project, brandString<RecordId>(next.record)).inputs.find(input => input.role === 'first_frame'))
      .toEqual({ role: 'first_frame', ref: { record: shot.record, output: 1 }, resolved_asset: shot.outputs[1]?.asset_id })
  })

  it('refuses an agent call without reference images before recording anything', async () => {
    const fixture = await start()
    await fixture.record('bible.character_create', { character: 'c2' })
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    const noImages = await fixture.call('dv_shot_render', { reason: 'cat', prompt: 'a cat', inputs: { reference: 'c2@1' } })
    expect(failure(noImages)).toContain('from 1 to 2 reference images, and this shot has none. Nothing was rendered.')
    expect(failure(await fixture.call('dv_shot_render', { reason: 'cat', prompt: 'a cat' }))).toContain('this shot has none')
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before)
    expect(fixture.generation.requests).toHaveLength(0)
    // A model that renders without references takes the call.
    fixture.generation.facts = { ...testFacts(), generationModes: { t2v: 'text', ref2va: 'reference_images' } }
    expect(failure(await fixture.call('dv_shot_render', { reason: 'cat', prompt: 'a cat', generation_mode: 't2v' }))).not.toContain('this shot has none')
  })

  it('refuses a call of any caller without reference images before recording anything', async () => {
    const fixture = await start()
    await fixture.record('bible.character_create', { character: 'c2' })
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    const c2 = { role: 'reference', ref: { character: brandString<CharacterId>('c2'), version: 1 } }
    await expect(fixture.record('shot.render', { prompt: 'a cat' }, [c2])).rejects.toThrow(
      'The video model renders every shot from 1 to 2 reference images, and this shot has none. Nothing was rendered. Ask the user for a '
      + 'reference image of the subject (they can attach one in the chat; it appears under Imported images), add it as a reference or '
      + 'to the character, then call again.',
    )
    // A render that a plan scheduled is told to update the plan; the plan approval names its shots.
    await expect(fixture.record('shot.render', { prompt: 'a cat', plan: 'p1', plan_version: 1, shot: 2 }, [c2]))
      .rejects.toThrow('from 1 to 2 reference images. Nothing was rendered.')
    await expect(fixture.record('shot.render', { prompt: 'a cat', plan: 'p1', plan_version: 1, shot: 2 }, [c2]))
      .rejects.toThrow('to the character, update the plan with dv_plan_update, then call again.')
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before)
    expect(fixture.generation.requests).toHaveLength(0)
    // The precondition counts a character version's reference images: one image is enough.
    await withCharacter(fixture)
    expect((await fixture.record('shot.render', { prompt: 'Picture 1 waves' }, [c1()])).status).toBe('done')
  })

  it('fails requests the model cannot serve and records stream failures', async () => {
    const fixture = await start()
    const image = await withCharacter(fixture)
    const failed = async (params: Record<string, unknown>, inputs: RunRequest['inputs'] = [c1()]): Promise<string> => {
      const shot = await fixture.record('shot.render', params, inputs)
      expect(shot.status).toBe('failed')
      return shot.error?.message ?? ''
    }
    await expect(fixture.record('shot.render', {}, [c1()])).rejects.toMatchObject({ code: 'invalid_params' })
    expect(await failed({ prompt: '' })).toContain('needs a `prompt`')
    await expect(fixture.record('shot.render', { prompt: 'x' }, [])).rejects.toThrow('this shot has none')
    const three = [c1(), { role: 'reference', ref: { asset: image } }, { role: 'reference', ref: { asset: image } }]
    expect(await failed({ prompt: 'x' }, three)).toContain('requires 1 to 2')
    expect(await failed({ prompt: 'x', duration_sec: 7 })).toContain('duration_sec')
    fixture.generation.omit = 'done'
    expect(await failed({ prompt: 'x' })).toContain('ended before the backend reported completion')
    fixture.generation.omit = 'last_frame'
    expect(await failed({ prompt: 'x' })).toContain('no last frame')
    fixture.generation.omit = null
    fixture.generation.failure = new Error('backend down')
    expect(await failed({ prompt: 'x' })).toBe('backend down')
    expect(fixture.ctx.dvProject.getState(fixture.project).components.shot).toEqual({ takes: {}, roots: {} })
  })

  it('drains large chunks into the video file', async () => {
    const fixture = await start()
    await withCharacter(fixture)
    fixture.generation.padChunkBytes = 256 * 1024
    const shot = await fixture.record('shot.render', { prompt: 'big' }, [c1()])
    expect(fixture.ctx.dvAssetPool.get(shot.outputs[0] as AssetId).size_bytes).toBeGreaterThan(256 * 1024)
  })

  it('broadcasts the shot to the live stream service while the backend streams it', async () => {
    const live = new FakeLiveStream()
    const fixture = await start({ live })
    await withCharacter(fixture)
    const shot = await fixture.record('shot.render', { prompt: 'Picture 1 waves', shot: 3 }, [c1()])
    expect(live.shots).toEqual([{ record: shot.id, init: { mime: 'video/mp4; codecs="avc1.64001f"', segmentIdx: 3 }, bytes: fixture.ctx.dvAssetPool.get(shot.outputs[0] as AssetId).size_bytes, end: 'complete' }])
    fixture.generation.omit = 'done'
    await fixture.record('shot.render', { prompt: 'cut short' }, [c1()])
    expect(live.shots[1]).toMatchObject({ init: { segmentIdx: 0 }, end: 'failed' })
  })
})

describe('shot.render geometry and timings', () => {
  it('derives the geometry from the model facts', () => {
    const facts = testFacts()
    expect(shotGeometry(facts, {})).toEqual({ mode: 'ref2va', aspectRatio: '16:9', resolution: '720p', width: 192, height: 112, durationSec: 1, numFrames: 25 })
    expect(shotGeometry(facts, { aspect_ratio: '9:16', duration_sec: 3 })).toMatchObject({ width: 112, height: 192, numFrames: 73 })
    expect(() => shotGeometry(facts, { generation_mode: 't2v' })).toThrow('generation_mode must be one of ref2va')
    expect(() => shotGeometry(facts, { aspect_ratio: '4:3' })).toThrow('aspect_ratio and resolution')
    expect(() => shotGeometry(facts, { resolution: '480p' })).toThrow('aspect_ratio and resolution')
    expect(() => shotGeometry(facts, { duration_sec: 9 })).toThrow('duration_sec must be a whole number from 1 to 5')
    expect(() => shotGeometry({ ...facts, generationModes: {}, aspectRatios: [], resolutions: [] }, {})).toThrow('generation_mode')
    expect(() => shotGeometry({ ...facts, aspectRatios: [] }, {})).toThrow('aspect_ratio and resolution')
  })

  it('reports the longest backend timing in seconds', () => {
    expect(backendSeconds({ generation_s: 0.25, total_ms: 1500 })).toBe(1.5)
    expect(backendSeconds({})).toBe(0)
  })
})

/** The capabilities a fake streaming_v2 backend reports. */
const CAPABILITIES_BODY = {
  model_id: 'fake-ref2va', name: 'Fake Ref2AV', min_segment_duration_sec: 1, max_segment_duration_sec: 2,
  max_reference_images: 3, max_reference_aspect_ratio: 4.0,
  frame_sizes: { '16:9': { '720p': [192, 112] } }, num_frames_by_duration_sec: { 1: 25, 2: 49 },
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }))
})

/**
 * Start a fake streaming_v2 backend that answers capabilities and streams one rendered clip per request.
 * @param dir - where the clips are rendered.
 * @returns the port and the request bodies.
 */
async function startFakeBackend(dir: string): Promise<{ port: number; requests: Record<string, unknown>[] }> {
  const fake = { port: 0, requests: [] as Record<string, unknown>[] }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify((request.url ?? '').endsWith('/health') ? { status: 'ready' } : CAPABILITIES_BODY))
      return
    }
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => { parts.push(part) })
    request.on('end', () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>
        fake.requests.push(body)
        const rendered = await renderClip(dir, Number(body['width']), Number(body['height']), Number(body['num_frames']))
        response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
        const events: Array<[string, object]> = [
          ['last_frame', { data: rendered.lastFrame.toString('base64') }],
          ['video_start', { mime: 'video/mp4; codecs="avc1.64001f"' }],
          ['video_chunk', { data: rendered.video.toString('base64') }],
          ['done', { timings: { total_s: 0.4 } }],
        ]
        for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        response.end()
      })()
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  fake.port = (server.address() as AddressInfo).port
  return fake
}

describe.skipIf(!existsSync(FFMPEG))('shot.render through the generation client', () => {
  it('sends the wire request the backend expects and stores the streamed clip', async () => {
    const clips = mkdtempSync(join(tmpdir(), 'dv-fake-backend-'))
    disposers.push(() => Promise.resolve(rmSync(clips, { recursive: true, force: true })))
    const backend = await startFakeBackend(clips)
    const fixture = await start({ backend: { baseUrl: `http://127.0.0.1:${backend.port}` } })
    await withCharacter(fixture)
    const shot = await fixture.record('shot.render', { prompt: 'Picture 1 smiles', duration_sec: 2, seed: 7 }, [c1()])
    expect(shot.status).toBe('done')
    expect(backend.requests[0]).toMatchObject({ prompt: 'Picture 1 smiles', width: 192, height: 112, num_frames: 49, seed: 7, return_last_frame: true })
    expect(backend.requests[0]?.['reference_images']).toEqual([Buffer.from('PNG-FAKE').toString('base64')])
    expect(fixture.ctx.dvAssetPool.get(shot.outputs[0] as AssetId).mime).toBe('video/mp4')
    expect((await fixture.ctx.dvFfmpeg.probe(fixture.ctx.dvAssetPool.path(shot.outputs[0] as AssetId))).durationSec).toBeCloseTo(2, 0)
    expect(shot.report).toMatchObject({ model: 'fake-ref2va', timings: { total_s: 0.4 } })
  })

  it.skipIf(REAL_BACKEND === undefined || !existsSync(REAL_REFERENCE))('renders a real five-second shot against the running backend', async () => {
    const fixture = await start({ backend: { baseUrl: REAL_BACKEND as string } })
    await withCharacter(fixture, readFileSync(REAL_REFERENCE))
    const started = performance.now()
    const shot = await fixture.record('shot.render', {
      prompt: 'Picture 1 is a man speaking to the camera in a bright office, slow push-in, natural light.', duration_sec: 5,
    }, [c1()])
    const wallSec = (performance.now() - started) / 1000
    const probe = await fixture.ctx.dvFfmpeg.probe(fixture.ctx.dvAssetPool.path(shot.outputs[0] as AssetId))
    console.log(`[dv real backend] wall ${wallSec.toFixed(1)} s; record cost ${JSON.stringify(shot.cost)}; report ${JSON.stringify(shot.report)}`)
    expect(shot.status).toBe('done')
    expect(probe.durationSec).toBeGreaterThan(4)
  }, 600_000)
})
