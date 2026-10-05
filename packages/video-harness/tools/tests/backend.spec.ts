/**
 * `generate.video` through the real DreamVerse generation client: against a fake streaming_v2 backend always, and
 * against a running backend when `VH_BACKEND_URL` names one.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssetId, TurnId } from '@video-harness/oplog'
import { afterEach, describe, expect, it } from 'vitest'
import { renderClip, startTools, type ToolsFixture } from './support.ts'

/** The reference image of the opt-in run against a running backend. */
const REAL_REFERENCE = '/mnt/lustre/vlm-d1su/codes/dsh-dv-hub/elon-musk.jpg'
const REAL_BACKEND = process.env['VH_BACKEND_URL']

const CAPABILITIES_BODY = {
  model_id: 'fake-ref2va', name: 'Fake Ref2AV', min_segment_duration_sec: 1, max_segment_duration_sec: 2,
  max_reference_images: 3, max_reference_aspect_ratio: 4.0,
  frame_sizes: { '16:9': { '720p': [192, 112] } }, num_frames_by_duration_sec: { 1: 25, 2: 49 },
}

interface FakeBackend {
  port: number
  requests: Record<string, unknown>[]
}

const servers: Server[] = []
const fixtures: ToolsFixture[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Start a fake streaming_v2 backend that answers capabilities and streams one rendered clip per generate request. */
async function startFakeBackend(): Promise<FakeBackend> {
  const dir = mkdtempSync(join(tmpdir(), 'vh-fake-backend-'))
  tempDirs.push(dir)
  const fake: FakeBackend = { port: 0, requests: [] }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? ''
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify(path.endsWith('/health') ? { status: 'ready' } : CAPABILITIES_BODY))
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

/** A project whose character c1@1 is the given image file. */
async function projectWith(fixture: ToolsFixture, imagePath: string, mime: string): Promise<{ projectId: ReturnType<ToolsFixture['project']['createProject']>; turn: TurnId }> {
  const projectId = fixture.project.createProject({ title: 'backend' })
  const turn = fixture.project.beginTurn(projectId, { actor: 'user', surface: 'chat', intent: 'start' }).turn
  const upload = await fixture.project.invoke(projectId, { tool: 'asset.upload', inputs: [], params: { path: imagePath, mime }, actor: 'user', surface: 'chat', intent: 'upload', turn })
  await fixture.project.invoke(projectId, { tool: 'entity.character.create', inputs: [], params: { entity: 'c1', name: 'Lead', refs: upload.outputs }, actor: 'user', surface: 'chat', intent: 'character', turn })
  return { projectId, turn }
}

describe('generate.video through the generation client', () => {
  it('sends the wire request the backend expects and stores the streamed clip', async () => {
    const backend = await startFakeBackend()
    const fixture = await startTools({ dsh: false, perception: false, generation: { baseUrl: `http://127.0.0.1:${backend.port}` } })
    fixtures.push(fixture)
    const { projectId, turn } = await projectWith(fixture, fixture.writeFile('ref.png', 'PNG-FAKE'), 'image/png')
    const shot = await fixture.project.invoke(projectId, {
      tool: 'generate.video', inputs: [{ role: 'reference', ref: 'c1@1' }], params: { prompt: 'Picture 1 smiles', duration_sec: 2, seed: 7 },
      actor: 'agent', surface: 'chat', intent: 'shot', turn,
    })
    expect(shot.status).toBe('done')
    expect(backend.requests[0]).toMatchObject({ prompt: 'Picture 1 smiles', width: 192, height: 112, num_frames: 49, seed: 7, return_last_frame: true })
    expect((backend.requests[0]?.['reference_images'] as string[])).toEqual([Buffer.from('PNG-FAKE').toString('base64')])
    expect(fixture.assets.get(shot.outputs[0] as AssetId).mime).toBe('video/mp4')
    expect((await fixture.media.probe(shot.outputs[0] as AssetId)).durationSec).toBeCloseTo(2, 0)
    expect(shot.report).toMatchObject({ model: 'fake-ref2va', timings: { total_s: 0.4 } })
  })

  it.skipIf(REAL_BACKEND === undefined || !existsSync(REAL_REFERENCE))('generates a real five-second shot against the running backend', async () => {
    const fixture = await startTools({ dsh: false, perception: false, generation: { baseUrl: REAL_BACKEND as string } })
    fixtures.push(fixture)
    const { projectId, turn } = await projectWith(fixture, REAL_REFERENCE, 'image/jpeg')
    const started = performance.now()
    const shot = await fixture.project.invoke(projectId, {
      tool: 'generate.video', inputs: [{ role: 'reference', ref: 'c1@1' }],
      params: { prompt: 'Picture 1 is a man speaking to the camera in a bright office, slow push-in, natural light.', duration_sec: 5 },
      actor: 'agent', surface: 'chat', intent: 'real shot', turn,
    })
    const wallSec = (performance.now() - started) / 1000
    const probe = await fixture.media.probe(shot.outputs[0] as AssetId)
    console.log(`[vh real backend] wall ${wallSec.toFixed(1)} s; record cost ${JSON.stringify(shot.cost)}; report ${JSON.stringify(shot.report)}; video ${JSON.stringify(probe)}`)
    expect(shot.status).toBe('done')
    expect(probe.durationSec).toBeGreaterThan(4)
    expect(fixture.assets.get(shot.outputs[1] as AssetId).mime).toBe('image/png')
  }, 600_000)
})
