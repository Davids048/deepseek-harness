/**
 * The Inspector component in a REAL composition: a test-only `cordis.yml` boots the DSH tool registry, the asset pool,
 * `dvProject`, `dvFfmpeg` and `dvInspector` through the Loader, with the model, the default model and the attachment
 * service as the fakes. The agent's `dv_inspect_*` calls answer as reads and write no record.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import DvAssetPool from '@dv/asset-pool'
import DvFfmpeg from '@dv/ffmpeg'
import DvProject, { type AssetId, type OperationToolValue, type ProjectId, type SessionId } from '@dv/project'
import { afterEach, describe, expect, it } from 'vitest'
import DvInspector from '../src/index.ts'

const FFMPEG = process.env['VH_FFMPEG'] ?? '/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg'
const FFPROBE = process.env['VH_FFPROBE'] ?? 'ffprobe'

/** The answer the fake model gives. */
const ANSWER = 'A red kite over a beach.'

/** A model that answers every request with one text reply. */
class FakeLlm {
  readonly requests: GenerateOptions[] = []
  reply: string | Error = ANSWER
  /** What the route declares; undefined declares nothing. */
  modalities: string[] | undefined = ['text', 'image']

  resolveModelInfo(): Promise<{ inputModalities?: string[] }> {
    return Promise.resolve(this.modalities === undefined ? {} : { inputModalities: this.modalities })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const reply = this.reply
    return (async function* (): AsyncGenerator<StreamChunk> {
      if (reply instanceof Error) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: reply.message, code: 'TEST' } } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'looking' } }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: reply }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

/** An attachment service that accepts every image. */
class FakeAttachments {
  readonly saved: Array<{ mediaType: string; name?: string }> = []

  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }) {
    this.saved.push(input)
    return Promise.resolve({ attachmentId: `att-${this.saved.length}`, mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1 })
  }
}

/** The plugin classes the fixture rows resolve through `globalThis`, because Node imports the rows outside Vite. */
const PLUGINS = { SystemPrompt, ToolRuntime, DvProject, DvFfmpeg, DvAssetPool, DvInspector }

interface Fixture {
  ctx: Context
  dir: string
  llm: FakeLlm
  attachments: FakeAttachments
  route: { provider: string; model: string; reasoningEffort?: string }
  project: ProjectId
  /** Store bytes in the asset pool. */
  put(bytes: Uint8Array, mime: string, name: string): AssetId
  /** Run one tool as the agent of chat session `s1`, which is bound to `project`. */
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
}

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

/**
 * Boot the composition from a test-only `cordis.yml`.
 * @param options - whether the model services are mounted, and the inspector's `imageInput`.
 * @returns the fixture, with a project bound to chat session `s1`.
 */
async function start(options: { models?: boolean; imageInput?: boolean } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'dv-inspector-'))
  const globals = globalThis as typeof globalThis & { __dvInspectorComposition?: typeof PLUGINS }
  globals.__dvInspectorComposition = PLUGINS
  const rows: string[] = []
  const row = (id: string, key: keyof typeof PLUGINS, config: string[]): void => {
    writeFileSync(join(dir, `${id}.mjs`), `export default globalThis.__dvInspectorComposition.${key}\n`)
    rows.push(`- id: ${id}`, `  name: ${pathToFileURL(join(dir, `${id}.mjs`)).href}`, ...config.length === 0 ? [] : ['  config:', ...config.map(line => `    ${line}`)])
  }
  row('system-prompt', 'SystemPrompt', [])
  row('tools', 'ToolRuntime', [])
  row('dv-project', 'DvProject', [`root: ${join(dir, 'projects')}`, `sessionRoot: ${join(dir, 'sessions')}`])
  row('dv-ffmpeg', 'DvFfmpeg', [`ffmpegPath: ${FFMPEG}`, `ffprobePath: ${FFPROBE}`])
  row('dv-asset-pool', 'DvAssetPool', [`root: ${join(dir, 'assets')}`])
  row('dv-inspector', 'DvInspector', options.imageInput === false ? ['imageInput: false'] : [])
  writeFileSync(join(dir, 'cordis.yml'), `${rows.join('\n')}\n`)

  const ctx = new Context()
  const llm = new FakeLlm()
  const attachments = new FakeAttachments()
  const route: Fixture['route'] = { provider: 'test-provider', model: 'test-vision' }
  if (options.models !== false) {
    ctx.provide('llm', llm)
    ctx.provide('agentDefaultModel', { currentSelection: () => route })
    ctx.provide('attachments', attachments)
  }
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const origin = { actor: 'user' as const, surface: 'api' as const, session: null, turn: null, tool_call: null, intent: 'create' }
  const project = (await ctx.dvProject.createProject('inspect', origin)).id
  ctx.dvProject.bindSession(brandString<SessionId>('s1'), project)
  let calls = 0
  return {
    ctx, dir, llm, attachments, route, project,
    put: (bytes, mime, name) => ctx.dvAssetPool.importAsset(bytes, { mime, name }, null),
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

/** One red 1×1 PNG. */
const RED_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')

describe('dvInspector', () => {
  it('registers both reads with their dv_inspect_* tools and removes them on disposal', async () => {
    const fixture = await start()
    const specs = fixture.ctx.dvProject.listOperations().filter(spec => spec.component === 'inspect')
    expect(specs.map(spec => [spec.name, spec.readOnly])).toEqual([['inspect.asset', true], ['inspect.image', true]])
    expect(fixture.ctx.tools.get('dv_inspect_asset')).toBeDefined()
    expect(fixture.ctx.tools.schemas().find(tool => tool.name === 'dv_inspect_image')?.description).toContain('A read that writes no record.')
    const entry = [...fixture.ctx.loader.entries()].find(candidate => candidate.options.name.endsWith('/dv-inspector.mjs'))
    await entry?.fiber?.dispose()
    expect(fixture.ctx.dvProject.listOperations().filter(spec => spec.component === 'inspect')).toEqual([])
    expect(fixture.ctx.tools.get('dv_inspect_image')).toBeUndefined()
  })

  it('shows an image to the default model and answers as a read', async () => {
    const fixture = await start()
    const image = fixture.put(RED_PNG, 'image/png', 'kite.png')
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    const look = value(await fixture.call('dv_inspect_image', { reason: 'look at the kite', question: 'What color is the kite?', inputs: { image } }))
    expect(look).toMatchObject({ record: '', status: 'done', outputs: [], report: { question: 'What color is the kite?', answer: ANSWER, model: 'test-vision' } })
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before)
    expect(fixture.attachments.saved).toMatchObject([{ mediaType: 'image/png', name: 'kite.png' }])
    expect(fixture.llm.requests[0]).toMatchObject({ provider: 'test-provider', model: 'test-vision', maxTokens: 1024 })
    expect(fixture.llm.requests[0]?.messages[0]?.content).toMatchObject([{ type: 'image', attachment: { attachmentId: 'att-1' } }, { type: 'text', text: 'What color is the kite?' }])
    expect(fixture.llm.requests[0]).not.toHaveProperty('reasoningEffort')
    fixture.route.reasoningEffort = 'low'
    const defaulted = value(await fixture.call('dv_inspect_image', { reason: 'look again', inputs: { image } }))
    expect(String((defaulted.report as Record<string, unknown>)['question'])).toContain('Describe this image')
    expect(fixture.llm.requests[1]).toMatchObject({ reasoningEffort: 'low' })
    const spec = fixture.ctx.dvProject.listOperations().find(entry => entry.name === 'inspect.image')
    const record = fixture.ctx.dvProject.getState(fixture.project).components.proj.records[0]
    expect(record === undefined ? '' : spec?.summarize({ ...record, report: { answer: ANSWER } })).toBe(`inspected: ${ANSWER}`)
    expect(record === undefined ? '' : spec?.summarize({ ...record, report: { unsupported: 'no' } })).toBe('inspected: images unsupported')
  })

  it('explains why it cannot look, and fails for other media types, missing inputs and model errors', async () => {
    const fixture = await start()
    const image = fixture.put(RED_PNG, 'image/png', 'kite.png')
    const text = fixture.put(Buffer.from('notes'), 'text/plain', 'notes.txt')
    expect(failure(await fixture.call('dv_inspect_image', { reason: 'no image' }))).toContain('needs input "image"')
    expect(failure(await fixture.call('dv_inspect_image', { reason: 'text', inputs: { image: text } })))
      .toContain('needs a PNG, JPEG, WebP, or GIF image; the input is text/plain')
    fixture.llm.modalities = ['text']
    const textOnly = value(await fixture.call('dv_inspect_image', { reason: 'text model', inputs: { image } }))
    expect(textOnly.report).toMatchObject({ answer: null, unsupported: expect.stringContaining('does not accept image input') })
    fixture.llm.modalities = undefined
    expect(value(await fixture.call('dv_inspect_image', { reason: 'unknown model', inputs: { image } })).report)
      .toMatchObject({ unsupported: expect.stringContaining('does not accept image input') })
    expect(fixture.attachments.saved).toHaveLength(0)
    fixture.llm.modalities = ['image']
    fixture.llm.reply = new Error('quota')
    expect(failure(await fixture.call('dv_inspect_image', { reason: 'quota', inputs: { image } }))).toBe('The model call failed: quota')
  })

  it('reports images as unsupported when the deployment switches image input off', async () => {
    const fixture = await start({ imageInput: false })
    const image = fixture.put(RED_PNG, 'image/png', 'kite.png')
    const off = value(await fixture.call('dv_inspect_image', { reason: 'look', question: 'what?', inputs: { image } }))
    expect(off.report).toMatchObject({ question: 'what?', answer: null, unsupported: expect.stringContaining('text-only') })
    expect(fixture.llm.requests).toHaveLength(0)
  })

  it('has no inspect.image without the model services', async () => {
    const fixture = await start({ models: false })
    expect(fixture.ctx.dvProject.listOperations().map(spec => spec.name)).toContain('inspect.asset')
    expect(fixture.ctx.tools.get('dv_inspect_image')).toBeUndefined()
    await expect(fixture.ctx.dvInspector.inspectImage(fixture.put(RED_PNG, 'image/png', 'kite.png'), 'q'))
      .rejects.toThrow('needs the llm, agentDefaultModel and attachments services')
  })

  it.skipIf(!existsSync(FFMPEG))('reads an asset\'s metadata with ffprobe as a read', async () => {
    const fixture = await start()
    const clipPath = join(fixture.dir, 'clip.mp4')
    await fixture.ctx.dvFfmpeg.run({
      argv: ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=1:r=10', '-pix_fmt', 'yuv420p', '{{out:clip.mp4}}'],
      inputs: [], outputs: ['clip.mp4'], dir: fixture.dir,
    })
    const clip = fixture.ctx.dvAssetPool.importAsset({ path: clipPath }, { mime: 'video/mp4', name: 'clip.mp4' }, null)
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    const read = value(await fixture.call('dv_inspect_asset', { reason: 'how long is it', inputs: { asset: clip } }))
    expect(read).toMatchObject({ record: '', outputs: [], report: { width: 160, height: 90, has_audio: false, codec: 'h264', video_duration_sec: expect.any(Number) } })
    expect((read.report as { duration_sec: number }).duration_sec).toBeCloseTo(1, 0)
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before)
    const text = fixture.put(Buffer.from('notes'), 'text/plain', 'notes.txt')
    expect(failure(await fixture.call('dv_inspect_asset', { reason: 'not media', inputs: { asset: text } }))).toContain('ffprobe exited with')
    const spec = fixture.ctx.dvProject.listOperations().find(entry => entry.name === 'inspect.asset')
    const record = fixture.ctx.dvProject.getState(fixture.project).components.proj.records[0]
    expect(record === undefined ? '' : spec?.summarize({ ...record, inputs: [{ role: 'asset', ref: { asset: clip }, resolved_asset: clip }] }))
      .toBe(`inspected ${clip.slice(0, 8)}`)
    expect(record === undefined ? '' : spec?.summarize(record)).toBe('inspected asset')
  })
})
