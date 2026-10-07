/**
 * The FastH3 Ref2VA provider in a REAL composition: a test-only `cordis.yml` boots the DSH skill registry and the
 * provider through the Loader. The FastVideo streaming_v2 server is the only fake: an HTTP server that answers the
 * capabilities and health routes and streams fixed bytes for every render. An opt-in test renders against a running
 * server named by `DV_BACKEND_URL`.
 */
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { RenderStreamEvent } from '@dv/render-modes'
import { afterEach, describe, expect, it } from 'vitest'
import FastH3Ref2vaRenderer from '../src/index.ts'

/** The reference image of the opt-in run against a running server. */
const REAL_REFERENCE = '/mnt/lustre/vlm-d1su/codes/dsh-dv-hub/elon-musk.jpg'
const REAL_BACKEND = process.env['DV_BACKEND_URL']

/** The capabilities the fake server reports. */
const CAPABILITIES_BODY = {
  model_id: 'fake-ref2va', name: 'Fake Ref2AV', min_segment_duration_sec: 5, max_segment_duration_sec: 6,
  max_reference_images: 3, max_reference_aspect_ratio: 4.0,
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
const PLUGINS = { SkillRegistry, FastH3Ref2vaRenderer }

/**
 * Boot the skill registry and the provider from a test-only `cordis.yml`.
 * @param baseUrl - the streaming_v2 server.
 * @returns the root context.
 */
async function start(baseUrl: string): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'dv-fasth3-ref2va-'))
  const globals = globalThis as typeof globalThis & { __dvFastH3Ref2va?: typeof PLUGINS }
  globals.__dvFastH3Ref2va = PLUGINS
  const rows: string[] = []
  for (const [id, key, config] of [['skills', 'SkillRegistry', []], ['dv-fasth3-ref2va', 'FastH3Ref2vaRenderer', [`baseUrl: ${baseUrl}`]]] as const) {
    writeFileSync(join(dir, `${id}.mjs`), `export default globalThis.__dvFastH3Ref2va.${key}\n`)
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

/** Collect a render stream. */
async function collect(stream: AsyncIterable<RenderStreamEvent>): Promise<RenderStreamEvent[]> {
  const events: RenderStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('dvRef2va from FastH3 Ref2VA', () => {
  it('reports the model facts with one request image kept for the first frame', async () => {
    const server = await startFakeServer()
    const ctx = await start(server.url)
    expect(await ctx.dvRef2va.model()).toEqual({
      modelId: 'fake-ref2va', name: 'Fake Ref2AV', aspectRatios: ['16:9'], resolutions: ['720p'],
      frameSizes: { '16:9': { '720p': [1344, 768] } }, minDurationSec: 5, maxDurationSec: 6, numFramesByDurationSec: { 5: 124, 6: 158 },
      maxReferenceImages: 2, imageLabels: ['Picture 1', 'Picture 2', 'Picture 3'], gpuSecondsPerVideoSecond: 4,
    })
    expect(await ctx.dvRef2va.ready()).toEqual({ ready: true, detail: null })
    // The streaming_v2 client stays private to the provider.
    expect(ctx.get('dreamverseGeneration')).toBeUndefined()
  })

  it('sends the reference images, then the first frame, and returns the server stream', async () => {
    const server = await startFakeServer()
    const ctx = await start(server.url)
    const request = { prompt: 'Picture 1 smiles', frameWidth: 1344, frameHeight: 768, numFrames: 124, seed: 7 }
    const events = await collect(ctx.dvRef2va.render({ ...request, references: [Buffer.from('REF1'), Buffer.from('REF2')], firstFrame: Buffer.from('FIRST') }))
    expect(server.requests[0]).toEqual({
      prompt: 'Picture 1 smiles', width: 1344, height: 768, num_frames: 124, seed: 7, return_last_frame: true,
      reference_images: ['REF1', 'REF2', 'FIRST'].map(text => Buffer.from(text).toString('base64')),
    })
    expect(events.map(event => event.kind)).toEqual(['last_frame', 'video_start', 'chunk', 'done'])
    expect(events[2]).toEqual({ kind: 'chunk', bytes: Buffer.from('VIDEO') })
    await collect(ctx.dvRef2va.render({ ...request, references: [Buffer.from('REF1')], firstFrame: null }))
    expect(server.requests[1]?.['reference_images']).toEqual([Buffer.from('REF1').toString('base64')])
  })

  it('registers its prompt skill and removes the skill and the service on disposal', async () => {
    const server = await startFakeServer()
    const ctx = await start(server.url)
    const skill = await ctx.skills.get('fasth3-ref2va-prompting')
    expect(skill?.description).toContain('dv_shot_render_ref2va')
    expect(skill?.content).toContain('Every shot needs at least one reference image.')
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name.endsWith('/dv-fasth3-ref2va.mjs'))
    await entry?.fiber?.dispose()
    expect(await ctx.skills.get('fasth3-ref2va-prompting')).toBeUndefined()
    expect(ctx.get('dvRef2va')).toBeUndefined()
  })

  it.skipIf(REAL_BACKEND === undefined || !existsSync(REAL_REFERENCE))('renders a real five-second shot against the running server', async () => {
    const ctx = await start(REAL_BACKEND as string)
    const facts = await ctx.dvRef2va.model()
    const [width, height] = facts.frameSizes[facts.aspectRatios[0] ?? '']?.[facts.resolutions[0] ?? ''] ?? [0, 0]
    const events = await collect(ctx.dvRef2va.render({
      prompt: 'Picture 1 is a man speaking to the camera in a bright office, slow push-in, natural light.',
      references: [readFileSync(REAL_REFERENCE)], firstFrame: null, frameWidth: width, frameHeight: height,
      numFrames: facts.numFramesByDurationSec['5'] ?? 0, seed: 1,
    }))
    expect(events.map(event => event.kind)).toEqual(expect.arrayContaining(['last_frame', 'video_start', 'chunk', 'done']))
  }, 600_000)
})
