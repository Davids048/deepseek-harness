/**
 * The FastH3 8-Step V2 text-to-video provider in a REAL composition: a test-only `cordis.yml` boots the DSH skill
 * registry, the render mode registries, and the provider through the Loader. The FastVideo streaming_v2 server is the
 * only fake: an HTTP server that answers the capabilities and health routes and streams fixed bytes for every render.
 * An opt-in test renders against a running server named by `DV_T2VA_BACKEND_URL`.
 */
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as RenderModes from '@dv/render-modes'
import type { RenderStreamEvent } from '@dv/render-modes'
import { afterEach, describe, expect, it } from 'vitest'
import * as FastH3T2va from '../src/index.ts'

const REAL_BACKEND = process.env['DV_T2VA_BACKEND_URL']

/** The capabilities the fake server reports. */
const CAPABILITIES_BODY = {
  model_id: 'fake-t2va', name: 'Fake T2AV', min_segment_duration_sec: 5, max_segment_duration_sec: 6, max_reference_images: 0,
  frame_sizes: { '16:9': { '720p': [1344, 768] } }, num_frames_by_duration_sec: { 5: 124, 6: 158 },
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/**
 * Start a fake streaming_v2 server that answers capabilities and health and streams fixed bytes for every render.
 * @returns the server URL and the render request bodies.
 */
async function startFakeServer(): Promise<{ url: string; requests: Record<string, unknown>[] }> {
  const requests: Record<string, unknown>[] = []
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify((request.url ?? '').endsWith('/health') ? { status: 'ready' } : CAPABILITIES_BODY))
      return
    }
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => { parts.push(part) })
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      const events: Array<[string, object]> = [
        ['last_frame', { data: Buffer.from('LAST').toString('base64') }],
        ['video_start', { mime: 'video/mp4; codecs="avc1.64001f"' }],
        ['video_chunk', { data: Buffer.from('VIDEO').toString('base64') }],
        ['done', { timings: { total_s: 0.4 } }],
      ]
      for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      response.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

/** The plugin classes the fixture rows resolve through `globalThis`, because Node imports the rows outside Vite. */
const PLUGINS = {
  SkillRegistry,
  RenderModes: { name: RenderModes.name, apply: RenderModes.apply },
  FastH3T2va: { name: FastH3T2va.name, inject: FastH3T2va.inject, Config: FastH3T2va.Config, apply: FastH3T2va.apply },
}

/**
 * Boot the skill registry, the render mode registries, and the provider from a test-only `cordis.yml`.
 * @param baseUrl - the streaming_v2 server.
 * @param backends - the backend names of the provider rows, one row each; omitted, one row with the default name.
 * @returns the root context.
 */
async function start(baseUrl: string, backends: string[] = []): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'dv-fasth3-t2va-'))
  const globals = globalThis as typeof globalThis & { __dvFastH3T2va?: typeof PLUGINS }
  globals.__dvFastH3T2va = PLUGINS
  const rows: string[] = []
  const providers = backends.length === 0
    ? [['dv-fasth3-t2va', 'FastH3T2va', [`baseUrl: ${baseUrl}`]] as const]
    : backends.map(backend => [`dv-fasth3-t2va-${backend}`, 'FastH3T2va', [`backend: ${backend}`, `baseUrl: ${baseUrl}`]] as const)
  for (const [id, key, config] of [['skills', 'SkillRegistry', []] as const, ['dv-render-modes', 'RenderModes', []] as const, ...providers]) {
    writeFileSync(join(dir, `${id}.mjs`), `export default globalThis.__dvFastH3T2va.${key}\n`)
    rows.push(`- id: ${id}`, `  name: ${pathToFileURL(join(dir, `${id}.mjs`)).href}`, ...config.length === 0 ? [] : ['  config:', ...config.map(line => `    ${line}`)])
  }
  writeFileSync(join(dir, 'cordis.yml'), `${rows.join('\n')}\n`)
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  return ctx
}

/**
 * The renderer a provider row registered.
 * @param ctx - the root context.
 * @param backend - the backend name.
 * @returns the renderer.
 */
function renderer(ctx: Context, backend = 'fasth3'): RenderModes.T2vaRenderer {
  const registered = ctx.dvT2va.get(backend)
  if (registered === undefined) throw new Error(`no t2va backend ${backend}`)
  return registered
}

/** Collect a render stream. */
async function collect(stream: AsyncIterable<RenderStreamEvent>): Promise<RenderStreamEvent[]> {
  const events: RenderStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('dvT2va from FastH3 8-Step V2', () => {
  it('reports the model facts of a text-to-video model', async () => {
    const server = await startFakeServer()
    const ctx = await start(server.url)
    expect(await renderer(ctx).model()).toEqual({
      modelId: 'fake-t2va', name: 'Fake T2AV', aspectRatios: ['16:9'], resolutions: ['720p'],
      frameSizes: { '16:9': { '720p': [1344, 768] } }, minDurationSec: 5, maxDurationSec: 6, numFramesByDurationSec: { 5: 124, 6: 158 },
      maxReferenceImages: 0, imageLabels: [], gpuSecondsPerVideoSecond: 1.5,
    })
    expect(await renderer(ctx).ready()).toEqual({ ready: true, detail: null })
    // The streaming_v2 client stays private to the provider.
    expect(ctx.get('dreamverseGeneration')).toBeUndefined()
  })

  it('sends the prompt without reference images and returns the server stream', async () => {
    const server = await startFakeServer()
    const ctx = await start(server.url)
    const events = await collect(renderer(ctx).render({ prompt: 'A quiet street at dawn', frameWidth: 1344, frameHeight: 768, numFrames: 124, seed: 7 }))
    expect(server.requests[0]).toEqual({
      prompt: 'A quiet street at dawn', width: 1344, height: 768, num_frames: 124, seed: 7, return_last_frame: true, reference_images: [],
    })
    expect(events.map(event => event.kind)).toEqual(['last_frame', 'video_start', 'chunk', 'done'])
    expect(events[0]).toEqual({ kind: 'last_frame', png: Buffer.from('LAST') })
  })

  it('registers its renderer and prompt skill, and removes both on disposal', async () => {
    const server = await startFakeServer()
    const ctx = await start(server.url)
    const skill = await ctx.skills.get('fasth3-t2va-prompting')
    expect(skill?.description).toContain('dv_shot_render_t2va')
    expect(skill?.content).toContain('integrated_multimodal_description:')
    expect(ctx.dvT2va.backends()).toEqual(['fasth3'])
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name.endsWith('/dv-fasth3-t2va.mjs'))
    await entry?.fiber?.dispose()
    expect(await ctx.skills.get('fasth3-t2va-prompting')).toBeUndefined()
    expect(ctx.dvT2va.backends()).toEqual([])
  })

  it('registers one renderer per provider row, each under its own backend name', async () => {
    const server = await startFakeServer()
    const ctx = await start(server.url, ['fasth3-a', 'fasth3-b'])
    expect(ctx.dvT2va.backends()).toEqual(['fasth3-a', 'fasth3-b'])
    expect(renderer(ctx, 'fasth3-a')).not.toBe(renderer(ctx, 'fasth3-b'))
    expect((await renderer(ctx, 'fasth3-b').model()).modelId).toBe((await renderer(ctx, 'fasth3-a').model()).modelId)
  })

  it.skipIf(REAL_BACKEND === undefined)('renders a real five-second shot against the running server', async () => {
    const ctx = await start(REAL_BACKEND as string)
    const facts = await renderer(ctx).model()
    const [width, height] = facts.frameSizes[facts.aspectRatios[0] ?? '']?.[facts.resolutions[0] ?? ''] ?? [0, 0]
    const events = await collect(renderer(ctx).render({
      prompt: 'integrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium-wide shot frames a quiet street at dawn.'
        + '\n\noverall_soundscape: Birds and distant traffic.\n\nnon_diegetic_music: N/A',
      frameWidth: width, frameHeight: height, numFrames: facts.numFramesByDurationSec['5'] ?? 0, seed: 1,
    }))
    expect(events.map(event => event.kind)).toEqual(expect.arrayContaining(['last_frame', 'video_start', 'chunk', 'done']))
  }, 600_000)
})
