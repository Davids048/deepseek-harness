import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { OpId, ProjectId } from '@video-harness/oplog'
import { generateVideoTool } from '@video-harness/tools'
import { afterEach, describe, expect, it } from 'vitest'
import VhStream, { SegmentBroadcaster, type StreamFrame } from '../src/index.ts'
import { startTools, type ToolsFixture } from '../../tools/tests/support.ts'

const PROJECT = brandString<ProjectId>('p1')
const OP = brandString<OpId>('op-1')

/** A stand-in for the DSH web server: keeps routes and serves upgrades on a local port. */
class FakeWebServer {
  private readonly upgrades = new Map<string, WebUpgradeRoute>()
  readonly server: Server = createServer((_request, response) => { response.writeHead(404).end() })

  register(_route: WebRoute): () => void {
    return () => {}
  }

  registerUpgrade(route: WebUpgradeRoute): () => void {
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  async listen(): Promise<number> {
    this.server.on('upgrade', (request, socket, head) => {
      const route = this.upgrades.get(new URL(String(request.url), 'http://localhost').pathname)
      if (route === undefined) socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      else route.handler(request, socket, head)
    })
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    return (this.server.address() as AddressInfo).port
  }
}

/** Collect every message of a browser socket in arrival order; binary messages become their byte length. */
function collect(socket: WebSocket): Array<Record<string, unknown> | number> {
  const messages: Array<Record<string, unknown> | number> = []
  socket.binaryType = 'arraybuffer'
  socket.addEventListener('message', (event) => {
    const data: unknown = event.data
    messages.push(typeof data === 'string' ? JSON.parse(data) as Record<string, unknown> : (data as ArrayBuffer).byteLength)
  })
  return messages
}

const until = async (check: () => boolean, label: string): Promise<void> => {
  for (let tries = 0; tries < 200; tries += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('SegmentBroadcaster', () => {
  it('replays an in-flight segment to a late subscriber and completes it for everyone', () => {
    const broadcaster = new SegmentBroadcaster(1024)
    const early: StreamFrame[] = []
    broadcaster.subscribe(PROJECT, (frame) => { early.push(frame) })
    const stream = broadcaster.openSegment(PROJECT, OP, { mime: 'video/mp4', segmentIdx: 2 })
    stream.chunk(new Uint8Array([1, 2, 3]))
    const late: StreamFrame[] = []
    broadcaster.subscribe(PROJECT, (frame) => { late.push(frame) })
    stream.chunk(new Uint8Array([4]))
    stream.complete()
    expect(early.map(frame => frame.kind === 'json' ? frame.data['type'] : frame.data.byteLength)).toEqual(['media_init', 3, 1, 'media_segment_complete'])
    expect(late.map(frame => frame.kind === 'json' ? frame.data['type'] : frame.data.byteLength)).toEqual(['media_init', 3, 1, 'media_segment_complete'])
    expect(early[0]).toEqual({ kind: 'json', data: { type: 'media_init', segment_idx: 2, mime: 'video/mp4', stream_id: OP } })
    expect(broadcaster.inFlight(PROJECT)).toEqual([])
  })
})

describe('/vh/ws', () => {
  it('serves subscribed browsers the media framing and refuses what the Connection rejects', async () => {
    const context = new Context()
    const web = new FakeWebServer()
    let reject = false
    context.provide('webServer', web)
    context.provide('connection', { requestRejection: () => reject ? 401 : undefined })
    await context.plugin(VhStream, { bufferBytes: 1024, pingMs: 50 }).await()
    const port = await web.listen()
    cleanups.push(async () => { await context.fiber.dispose(); web.server.close() })

    const socket = new WebSocket(`ws://127.0.0.1:${port}/vh/ws`)
    const messages = collect(socket)
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve()); socket.addEventListener('error', () => reject(new Error('socket error'))) })
    socket.send(JSON.stringify({ type: 'subscribe', project_id: PROJECT }))
    await until(() => messages.length >= 1, 'the subscribed acknowledgement')
    const stream = context.vhStream.openSegment(PROJECT, OP, { mime: 'video/mp4; codecs="avc1.64001f"', segmentIdx: 1 })
    stream.chunk(new Uint8Array(70_000))
    stream.chunk(new Uint8Array([9, 9]))
    stream.complete()
    await until(() => messages.length >= 5, 'the completed segment')
    expect(messages).toEqual([
      { type: 'subscribed', project_id: PROJECT, in_flight: [] },
      { type: 'media_init', segment_idx: 1, mime: 'video/mp4; codecs="avc1.64001f"', stream_id: OP },
      70_000,
      2,
      { type: 'media_segment_complete', segment_idx: 1, stream_id: OP },
    ])
    expect(context.vhStream.openSockets).toBe(1)
    socket.close()
    await until(() => context.vhStream.openSockets === 0, 'the socket to close')

    reject = true
    const status = await new Promise<number>((resolve, rejectRequest) => {
      const upgrade = httpRequest({ host: '127.0.0.1', port, path: '/vh/ws', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } })
      upgrade.on('response', (response: IncomingMessage) => { resolve(response.statusCode ?? 0); response.resume() })
      upgrade.on('error', rejectRequest)
      upgrade.end()
    })
    expect(status).toBe(401)
  })
})

describe('generate.video with a live sink', () => {
  it('broadcasts the shot while the backend streams it', async () => {
    const fixture: ToolsFixture = await startTools({ dsh: false, perception: false })
    cleanups.push(() => fixture.dispose())
    const broadcaster = new SegmentBroadcaster(1024 * 1024)
    fixture.project.registerTool(generateVideoTool(fixture.generation, () => broadcaster))
    const projectId = fixture.project.createProject({ title: 'live' })
    const frames: StreamFrame[] = []
    broadcaster.subscribe(projectId, (frame) => { frames.push(frame) })
    const turn = fixture.project.beginTurn(projectId, { actor: 'user', surface: 'chat', intent: 'start' }).turn
    const upload = await fixture.project.invoke(projectId, { tool: 'asset.upload', inputs: [], params: { path: fixture.writeFile('ref.png', 'PNG'), mime: 'image/png' }, actor: 'user', surface: 'chat', intent: 'upload', turn })
    await fixture.project.invoke(projectId, { tool: 'entity.character.create', inputs: [], params: { entity: 'c1', name: 'Lead', refs: upload.outputs }, actor: 'user', surface: 'chat', intent: 'character', turn })
    const shot = await fixture.project.invoke(projectId, {
      tool: 'generate.video', inputs: [{ role: 'reference', ref: 'c1@1' }], params: { prompt: 'Picture 1 waves', duration_sec: 1, shot: 3 },
      actor: 'agent', surface: 'chat', intent: 'shot', turn,
    })
    expect(shot.status).toBe('done')
    const kinds = frames.map(frame => frame.kind === 'json' ? frame.data['type'] : 'chunk')
    expect(kinds).toEqual(['media_init', 'chunk', 'chunk', 'media_segment_complete'])
    expect(frames[0]).toEqual({ kind: 'json', data: { type: 'media_init', segment_idx: 3, mime: 'video/mp4; codecs="avc1.64001f"', stream_id: shot.id } })
    const streamed = frames.filter(frame => frame.kind === 'binary').reduce((total, frame) => total + frame.data.byteLength, 0)
    expect(streamed).toBe(fixture.assets.get(shot.outputs[0] as never).sizeBytes)
  })
})
