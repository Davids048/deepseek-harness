/**
 * The Asset pool component in a REAL composition: a test-only `cordis.yml` boots the DSH tool registry, `dvProject`,
 * `dvFfmpeg` and `dvAssetPool` through the Loader, with a stand-in web server as the only fake. The agent's
 * `dv_asset_*` calls and the human's `dvProject.run` calls write records whose outputs the pool holds.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import DvFfmpeg, { FfmpegError } from '@dv/ffmpeg'
import DvProject, {
  ProjectError, type AssetId, type OperationToolValue, type ProjectId, type ProjectRecord, type RecordId, type RecordInput, type SessionId,
} from '@dv/project'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DvAssetPool from '../src/index.ts'

const FFMPEG = process.env['DV_FFMPEG'] ?? '/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg'
const FFPROBE = process.env['DV_FFPROBE'] ?? 'ffprobe'

/** A stand-in for the DSH web server that keeps the registered prefix routes and serves them on a local port. */
class FakeWebServer {
  readonly routes = new Map<string, WebRoute>()
  server: Server | null = null

  register(route: WebRoute): () => void {
    this.routes.set(route.path, route)
    return () => { this.routes.delete(route.path) }
  }

  async listen(): Promise<string> {
    this.server = createServer((request, response) => {
      const route = [...this.routes.values()].find(candidate => (request.url ?? '').startsWith(candidate.path))
      if (route === undefined) response.writeHead(404).end()
      else void route.handler(request, response)
    })
    await new Promise<void>((resolve) => { this.server?.listen(0, '127.0.0.1', resolve) })
    return `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => { this.server?.close(() => { resolve() }) })
  }
}

/** The plugin classes the fixture rows resolve through `globalThis`, because Node imports the rows outside Vite. */
const PLUGINS = { SystemPrompt, ToolRuntime, DvProject, DvFfmpeg, DvAssetPool }

interface Fixture {
  ctx: Context
  dir: string
  web: FakeWebServer
  project: ProjectId
  /** Run one tool as the agent of chat session `s1`, which is bound to `project`. */
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
  /** Run an operation as the human on the canvas. */
  run(operation: string, params: Record<string, unknown>, inputs?: RecordInput[]): Promise<ProjectRecord>
  /** Dispose the composition and keep its directory. */
  stop(): Promise<void>
}

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

/**
 * Boot the composition from a test-only `cordis.yml`.
 * @param options - an existing directory to reuse, and the pool's `publicBaseUrl`.
 * @returns the fixture, with a project bound to chat session `s1`.
 */
async function start(options: { dir?: string; publicBaseUrl?: string } = {}): Promise<Fixture> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'dv-asset-pool-'))
  const globals = globalThis as typeof globalThis & { __dvAssetPoolComposition?: typeof PLUGINS }
  globals.__dvAssetPoolComposition = PLUGINS
  const rows: string[] = []
  const row = (id: string, key: keyof typeof PLUGINS, config: string[]): void => {
    writeFileSync(join(dir, `${id}.mjs`), `export default globalThis.__dvAssetPoolComposition.${key}\n`)
    rows.push(`- id: ${id}`, `  name: ${pathToFileURL(join(dir, `${id}.mjs`)).href}`, ...config.length === 0 ? [] : ['  config:', ...config.map(line => `    ${line}`)])
  }
  row('system-prompt', 'SystemPrompt', [])
  row('tools', 'ToolRuntime', [])
  row('dv-project', 'DvProject', [`root: ${join(dir, 'projects')}`, `sessionRoot: ${join(dir, 'sessions')}`])
  row('dv-ffmpeg', 'DvFfmpeg', [`ffmpegPath: ${FFMPEG}`, `ffprobePath: ${FFPROBE}`])
  row('dv-asset-pool', 'DvAssetPool', [`root: ${join(dir, 'assets')}`, ...options.publicBaseUrl === undefined ? [] : [`publicBaseUrl: ${options.publicBaseUrl}`]])
  writeFileSync(join(dir, 'cordis.yml'), `${rows.join('\n')}\n`)

  const ctx = new Context()
  const web = new FakeWebServer()
  ctx.provide('webServer', web)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await ctx.fiber.dispose()
  }
  disposers.push(async () => {
    await stop()
    rmSync(dir, { recursive: true, force: true })
  })
  const origin = { actor: 'user' as const, surface: 'api' as const, session: null, turn: null, tool_call: null, intent: 'create' }
  const project = (await ctx.dvProject.createProject('pool', origin)).id
  ctx.dvProject.bindSession(brandString<SessionId>('s1'), project)
  let calls = 0
  return {
    ctx, dir, web, project, stop,
    call(name, args) {
      calls += 1
      return ctx.tools.execute({ callId: ToolCallId(`call-${calls}`), name, arguments: args, signal: new AbortController().signal, agent: { id: 's1' } as never })
    },
    async run(operation, params, inputs = []) {
      const { record } = await ctx.dvProject.run({
        project, operation, params, inputs, actor: 'user', surface: 'canvas', session: null, turn: null, tool_call: null, intent: operation,
      })
      if (record === null) throw new Error(`${operation} wrote no record`)
      return record
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

/** A video input of `asset.grab_still`. */
function videoInput(asset: AssetId): RecordInput {
  return { role: 'video', ref: { asset }, resolved_asset: asset }
}

describe('dvAssetPool', () => {
  it('registers its operations with their dv_asset_* tools and the asset store, and removes them on disposal', async () => {
    const fixture = await start()
    const specs = fixture.ctx.dvProject.listOperations().filter(spec => spec.component === 'asset')
    expect(specs.map(spec => [spec.name, spec.deterministic, spec.resource])).toEqual([
      ['asset.import', true, 'none'], ['asset.grab_still', true, 'cpu'], ['asset.place', false, 'none'], ['asset.unplace', false, 'none'],
    ])
    for (const tool of ['dv_asset_import', 'dv_asset_grab_still', 'dv_asset_place', 'dv_asset_unplace']) expect(fixture.ctx.tools.get(tool)).toBeDefined()
    expect(fixture.web.routes.has('/dv/assets')).toBe(true)
    const entry = [...fixture.ctx.loader.entries()].find(candidate => candidate.options.name.endsWith('/dv-asset-pool.mjs'))
    await entry?.fiber?.dispose()
    expect(fixture.ctx.dvProject.listOperations().filter(spec => spec.component === 'asset')).toEqual([])
    expect(fixture.ctx.tools.get('dv_asset_import')).toBeUndefined()
    expect(fixture.web.routes.size).toBe(0)
  })

  it('imports a file or base64 bytes as the agent, records who created the asset, and answers with its URL', async () => {
    const fixture = await start({ publicBaseUrl: 'https://demo.example/' })
    const path = join(fixture.dir, 'face.png')
    writeFileSync(path, 'png bytes')
    const imported = value(await fixture.call('dv_asset_import', { reason: 'bring the reference', path, mime: 'image/png' }))
    const asset = brandString<AssetId>(String(imported.outputs[0]?.asset_id))
    expect(imported).toMatchObject({ status: 'done', summary: 'imported face.png', outputs: [{ role: 'asset', mime: 'image/png', url: `https://demo.example/dv/assets/${asset}` }] })
    const record = fixture.ctx.dvProject.getRecord(fixture.project, brandString<RecordId>(imported.record))
    expect(record).toMatchObject({ actor: 'agent', component: 'asset', operation: 'asset.import', params: { path, mime: 'image/png' }, outputs: [asset] })
    expect(fixture.ctx.dvAssetPool.get(asset)).toMatchObject({ id: asset, mime: 'image/png', name: 'face.png', size_bytes: 9, created_by: record.id, width: null, duration_sec: null })
    expect(fixture.ctx.dvProject.getState(fixture.project).components.proj.created_by[asset]).toBe(record.id)
    const inline = await fixture.run('asset.import', { base64: Buffer.from('hello').toString('base64'), mime: 'text/plain', name: 'note.txt' })
    expect(fixture.ctx.dvAssetPool.read(inline.outputs[0] as AssetId).toString()).toBe('hello')
    const bare = await fixture.run('asset.import', { base64: Buffer.from('x').toString('base64'), mime: 'text/plain' })
    expect(fixture.ctx.dvAssetPool.get(bare.outputs[0] as AssetId).name).toBe('imported')
    const spec = fixture.ctx.dvProject.listOperations().find(entry => entry.name === 'asset.import')
    expect(spec?.summarize(inline)).toBe('imported note.txt')
    expect(spec?.summarize(bare)).toBe('imported bytes')
  })

  it('puts assets on the canvas and takes them off as records, refuses a call that changes nothing, and undo takes a placement back', async () => {
    const fixture = await start()
    const placed = (): AssetId[] => fixture.ctx.dvProject.getState(fixture.project).components.asset.placed
    const assetInput = (asset: AssetId): RecordInput => ({ role: 'asset', ref: { asset }, resolved_asset: asset })
    const a = (await fixture.run('asset.import', { base64: Buffer.from('a').toString('base64'), mime: 'image/png' })).outputs[0] as AssetId
    expect(placed()).toEqual([])
    // An import with `place` puts its output on the canvas.
    const b = (await fixture.run('asset.import', { base64: Buffer.from('b').toString('base64'), mime: 'image/png', place: true })).outputs[0] as AssetId
    expect(placed()).toEqual([b])
    const put = await fixture.run('asset.place', {}, [assetInput(a), assetInput(b)])
    expect(put).toMatchObject({ status: 'done', component: 'asset', operation: 'asset.place', outputs: [] })
    expect(placed()).toEqual([b, a])
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    await expect(fixture.run('asset.place', {}, [assetInput(a)])).rejects.toMatchObject({ code: 'invalid_params' })
    await fixture.run('asset.unplace', {}, [assetInput(b)])
    expect(placed()).toEqual([a])
    await expect(fixture.run('asset.unplace', {}, [assetInput(b)])).rejects.toMatchObject({ code: 'invalid_params' })
    // An asset that no record of the current state created cannot go on the canvas.
    const outside = fixture.ctx.dvAssetPool.importAsset(Buffer.from('outside'), { mime: 'image/png', name: 'o.png' }, null)
    await expect(fixture.run('asset.place', {}, [assetInput(outside)])).rejects.toMatchObject({ code: 'invalid_inputs' })
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before + 1)
    await fixture.ctx.dvProject.undo(fixture.project, { actor: 'user', surface: 'history', session: null, turn: null, tool_call: null, intent: 'undo' })
    expect(placed()).toEqual([b, a])
  })

  it('fails an import without bytes and refuses one without a media type before writing a record', async () => {
    const fixture = await start()
    const empty = await fixture.run('asset.import', { mime: 'text/plain' })
    expect(empty).toMatchObject({ status: 'failed', error: { code: 'operation_failed', message: 'asset.import needs `path` or `base64`.' } })
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    await expect(fixture.run('asset.import', { base64: 'QQ==' })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before)
    expect(failure(await fixture.call('dv_asset_import', { reason: 'nothing', mime: 'text/plain' }))).toContain('needs `path` or `base64`')
  })

  it('stores identical bytes once, replays the index after a restart, and refuses unknown assets', async () => {
    const first = await start()
    const pool = first.ctx.dvAssetPool
    const kept = pool.importAsset(Buffer.from('kept'), { mime: 'text/plain', name: 'a.txt' }, null)
    expect(pool.importAsset(Buffer.from('kept'), { mime: 'text/plain', name: 'b.txt' }, null)).toBe(kept)
    const lost = pool.importAsset(Buffer.from('lost'), { mime: 'text/plain', name: 'lost.txt', width: 4, height: 3, durationSec: 1.5 }, null)
    expect(pool.get(lost)).toMatchObject({ width: 4, height: 3, duration_sec: 1.5, created_by: null })
    expect(pool.get(kept).name).toBe('a.txt')
    expect(pool.list().map(asset => asset.id)).toEqual([kept, lost])
    expect(JSON.parse(readFileSync(join(first.dir, 'assets', 'index.jsonl'), 'utf8').split('\n')[0] ?? '{}')).toMatchObject({ id: kept, size_bytes: 4 })
    const missing = brandString<AssetId>('0'.repeat(64))
    expect(pool.has(missing)).toBe(false)
    expect(() => pool.get(missing)).toThrow(ProjectError)
    expect(() => pool.path(missing)).toThrow(expect.objectContaining({ code: 'unknown_asset' }))
    await first.stop()
    rmSync(join(first.dir, 'assets', 'objects', lost))
    const second = await start({ dir: first.dir })
    expect(second.ctx.dvAssetPool.list().map(asset => asset.id)).toEqual([kept])
  })

  it('serves asset files on /dv/assets/<AssetId>', async () => {
    const fixture = await start()
    const asset = fixture.ctx.dvAssetPool.importAsset(Buffer.from('<svg/>'), { mime: 'image/svg+xml', name: 'a.svg' }, null)
    expect(fixture.ctx.dvAssetPool.url(asset)).toBe(`/dv/assets/${asset}`)
    const base = await fixture.web.listen()
    try {
      const ok = await fetch(`${base}/dv/assets/${asset}`)
      expect(ok.status).toBe(200)
      expect(ok.headers.get('content-type')).toBe('image/svg+xml')
      expect(await ok.text()).toBe('<svg/>')
      expect((await fetch(`${base}/dv/assets/${'0'.repeat(64)}`)).status).toBe(404)
      expect((await fetch(`${base}/dv/assets/list`)).status).toBe(404)
      expect((await fetch(`${base}/dv/assets/${asset}`, { method: 'POST' })).status).toBe(404)
    } finally {
      await fixture.web.close()
    }
  })

  describe.skipIf(!existsSync(FFMPEG))('with ffmpeg', () => {
    /**
     * Render a solid-color video into the pool; `fragmented` writes the fMP4 layout a streaming backend sends.
     * @returns the video asset.
     */
    async function video(fixture: Fixture, color: string, seconds: number, fragmented = false): Promise<AssetId> {
      const layout = fragmented ? ['-movflags', 'frag_keyframe+empty_moov+default_base_moof'] : []
      const name = `${color}-${String(seconds)}.mp4`
      const { outputs } = await fixture.ctx.dvFfmpeg.run({
        argv: ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:d=${String(seconds)}:r=10`, '-pix_fmt', 'yuv420p', ...layout, `{{out:${name}}}`],
        inputs: [], outputs: [name], dir: fixture.dir,
      })
      return fixture.ctx.dvAssetPool.importAsset({ path: outputs[0] as string }, { mime: 'video/mp4', name }, null)
    }

    it('grabs the first, last and a timed still of a video as records whose output is a PNG', async () => {
      const fixture = await start()
      const red = await video(fixture, 'red', 2)
      const first = value(await fixture.call('dv_asset_grab_still', { reason: 'look at the start', at: 'first', inputs: { video: red } }))
      expect(first).toMatchObject({ status: 'done', summary: 'still at first', outputs: [{ role: 'still', mime: 'image/png' }] })
      const record = fixture.ctx.dvProject.getRecord(fixture.project, brandString<RecordId>(first.record))
      expect(record).toMatchObject({ actor: 'agent', component: 'asset', operation: 'asset.grab_still', params: { at: 'first' } })
      expect(record.inputs).toEqual([videoInput(red)])
      const still = record.outputs[0] as AssetId
      expect(fixture.ctx.dvAssetPool.get(still)).toMatchObject({ mime: 'image/png', name: 'still.png', created_by: record.id })
      for (const at of [1, '0.5', 'last']) {
        const timed = await fixture.run('asset.grab_still', { at }, [videoInput(red)])
        expect(timed.status).toBe('done')
        expect(fixture.ctx.dvAssetPool.get(timed.outputs[0] as AssetId).mime).toBe('image/png')
      }
      const spec = fixture.ctx.dvProject.listOperations().find(entry => entry.name === 'asset.grab_still')
      expect(['first', 2, ' 1.5 ', '', 'x', -1, true, undefined].map(at => spec?.summarize({ ...record, params: at === undefined ? {} : { at } })))
        .toEqual(['still at first', 'still at 2', 'still at 1.5', 'still at last', 'still at last', 'still at last', 'still at last', 'still at last'])
      await expect(fixture.run('asset.grab_still', { at: true }, [videoInput(red)])).rejects.toMatchObject({ code: 'invalid_params' })
      const text = fixture.ctx.dvAssetPool.importAsset(Buffer.from('notes'), { mime: 'text/plain', name: 'notes.txt' }, null)
      expect(await fixture.run('asset.grab_still', { at: 'first' }, [videoInput(text)])).toMatchObject({ status: 'failed', error: { code: 'operation_failed' } })
      expect(failure(await fixture.call('dv_asset_grab_still', { reason: 'no video' }))).toContain('needs input "video"')
    })

    it('reads the size and duration of an imported video, decoding it when its header has no duration', async () => {
      const fixture = await start()
      const { outputs } = await fixture.ctx.dvFfmpeg.run({
        argv: ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=2:r=10', '-pix_fmt', 'yuv420p', '{{out:blue.mp4}}'],
        inputs: [], outputs: ['blue.mp4'], dir: fixture.dir,
      })
      const imported = await fixture.run('asset.import', { path: outputs[0], mime: 'video/mp4' })
      const asset = fixture.ctx.dvAssetPool.get(imported.outputs[0] as AssetId)
      expect(asset).toMatchObject({ width: 160, height: 90 })
      expect(asset.duration_sec).toBeCloseTo(2, 1)
      // A header without a duration (a WebM file a browser recorded) is measured by decoding the video stream.
      const probe = vi.spyOn(fixture.ctx.dvFfmpeg, 'probe').mockResolvedValue({
        durationSec: null, videoDurationSec: null, width: 160, height: 90, hasAudio: false, codec: 'h264',
      })
      const other = await fixture.ctx.dvFfmpeg.run({
        argv: ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=160x90:d=3:r=10', '-pix_fmt', 'yuv420p', '{{out:green.mp4}}'],
        inputs: [], outputs: ['green.mp4'], dir: fixture.dir,
      })
      const bare = await fixture.run('asset.import', { path: other.outputs[0], mime: 'video/mp4' })
      expect(probe).toHaveBeenCalled()
      probe.mockRestore()
      expect(fixture.ctx.dvAssetPool.get(bare.outputs[0] as AssetId).duration_sec).toBeCloseTo(3, 1)
    })

    it('puts an import of an undone step on the canvas, and refuses a generated asset whose step was undone', async () => {
      const fixture = await start()
      const red = await video(fixture, 'red', 1)
      const input = (asset: AssetId): RecordInput => ({ role: 'asset', ref: { asset }, resolved_asset: asset })
      const imported = (await fixture.run('asset.import', { base64: Buffer.from('later').toString('base64'), mime: 'image/png', name: 'later.png' })).outputs[0] as AssetId
      const still = (await fixture.run('asset.grab_still', { at: 'first' }, [videoInput(red)])).outputs[0] as AssetId
      const origin = { actor: 'user' as const, surface: 'history' as const, session: null, turn: null, tool_call: null, intent: 'undo' }
      await fixture.ctx.dvProject.undo(fixture.project, origin)
      await fixture.ctx.dvProject.undo(fixture.project, origin)
      // Both steps are undone: the import still belongs to the project, the still does not.
      await expect(fixture.run('asset.place', {}, [input(still)])).rejects.toMatchObject({ code: 'invalid_inputs' })
      expect((await fixture.run('asset.place', {}, [input(imported)])).status).toBe('done')
      expect(fixture.ctx.dvProject.getState(fixture.project).components.asset.placed).toEqual([imported])
    })

    it('reads the last frame of a fragmented video, falls through the seek attempts, and rethrows other failures', async () => {
      const fixture = await start()
      const fragmented = await video(fixture, 'green', 2, true)
      const pool = fixture.ctx.dvAssetPool
      expect(existsSync(await pool.grabStill(fragmented, 'last', mkdtempSync(join(fixture.dir, 'still-'))))).toBe(true)
      // ffprobe keeps running for real; only the ffmpeg attempts are scripted.
      const ffmpeg = fixture.ctx.dvFfmpeg
      const original = ffmpeg.run.bind(ffmpeg)
      const failing = (error: Error, times: number) => {
        let left = times
        return vi.spyOn(ffmpeg, 'run').mockImplementation((request) => {
          if (request.argv[0] === 'ffprobe' || left <= 0) return original(request)
          left -= 1
          return Promise.reject(error)
        })
      }
      // The first attempt (an input seek near the probed duration) fails; the full decode still yields a frame. The
      // counts include the ffprobe call.
      const once = failing(new FfmpegError('ffmpeg did not write declared output', ''), 1)
      expect(existsSync(await pool.grabStill(fragmented, 'last', mkdtempSync(join(fixture.dir, 'still-'))))).toBe(true)
      expect(once).toHaveBeenCalledTimes(3)
      once.mockRestore()
      const always = failing(new FfmpegError('no frame', 'stderr'), Number.POSITIVE_INFINITY)
      await expect(pool.grabStill(fragmented, 'last', fixture.dir)).rejects.toThrow('no frame')
      always.mockRestore()
      const broken = failing(new TypeError('not ffmpeg'), Number.POSITIVE_INFINITY)
      await expect(pool.grabStill(fragmented, 'last', fixture.dir)).rejects.toThrow(TypeError)
      expect(broken).toHaveBeenCalledTimes(2)
      broken.mockRestore()
    })
  })
})
