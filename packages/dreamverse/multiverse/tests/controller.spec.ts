/**
 * The multiverse controller, mounted on the DSH web server with the real tree and director over fake services, serves
 * the page's `/multiverse/api` routes: capabilities, creation, snapshot events, branch choices, and stored media.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http'
import type { Fiber } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as controller from '../src/controller.ts'
import type { WireMultiverse } from '../src/controller.ts'
import { UPLOAD_POLICY, clipBytes, disposeMultiverse, lastFrameBytes, startMultiverse, type MultiverseFixture } from './support.ts'

const fixtures: MultiverseFixture[] = []
const openResponses: IncomingMessage[] = []

afterEach(async () => {
  for (const response of openResponses.splice(0)) response.destroy()
  for (const fixture of fixtures.splice(0)) await disposeMultiverse(fixture)
})

/** Mount the web server on an OS-assigned port and the controller over a fresh tree and director. */
async function start(
  config: controller.Config = { keepaliveMs: 15_000 },
): Promise<MultiverseFixture & { port: number; controllerFiber: Fiber }> {
  const fixture = await startMultiverse()
  fixtures.push(fixture)
  await fixture.root.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' }).await()
  const controllerFiber = fixture.root.plugin(controller, config)
  await controllerFiber.await()
  return { ...fixture, port: fixture.root.webServer.port, controllerFiber }
}

/** Send one request and read the complete response. */
async function call(port: number, method: string, path: string, body?: string) {
  return await new Promise<{ status: number; contentType: string | undefined; body: Buffer }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, agent: false }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, contentType: response.headers['content-type'], body: Buffer.concat(chunks) })
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

/** Send one request and parse its JSON response. */
async function callJson(port: number, method: string, path: string, body?: unknown) {
  const response = await call(port, method, path, body === undefined ? undefined : JSON.stringify(body))
  const json: unknown = JSON.parse(response.body.toString('utf8'))
  return { status: response.status, json }
}

/**
 * Open an event stream and collect its `multiverse` snapshots as they arrive.
 * @returns the response, the snapshots so far, a wait for a snapshot that matches a condition, and the stream end.
 */
async function openEvents(port: number, multiverseId: string) {
  const snapshots: WireMultiverse[] = []
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port, path: `/multiverse/api/multiverses/${multiverseId}/events`, agent: false }, resolve)
      .on('error', reject)
      .end()
  })
  openResponses.push(response)
  let buffered = ''
  let keepalives = 0
  response.setEncoding('utf8')
  response.on('data', (text: string) => {
    buffered += text
    for (let end = buffered.indexOf('\n\n'); end !== -1; end = buffered.indexOf('\n\n')) {
      const event = buffered.slice(0, end)
      buffered = buffered.slice(end + 2)
      if (event === ': keepalive') keepalives += 1
      const data = /^event: multiverse\ndata: (.*)$/s.exec(event)?.[1]
      if (data !== undefined) snapshots.push(JSON.parse(data) as WireMultiverse)
    }
  })
  const ended = new Promise<void>((resolve) => { response.on('end', resolve) })
  /** Wait for the latest snapshot to match a condition. */
  const waitFor = async (condition: (snapshot: WireMultiverse) => boolean): Promise<WireMultiverse> => {
    return await vi.waitUntil(() => {
      const latest = snapshots.at(-1)
      return latest !== undefined && condition(latest) ? latest : false
    })
  }
  return { response, snapshots, waitFor, ended, keepalives: () => keepalives }
}

const CREATE_REQUEST = { prompt: 'A fox and an owl meet at dusk.', reference_asset_ids: ['ref-1'], segment_duration_sec: 6 }

describe('/multiverse/api', () => {
  it('reports the DreamVerse creation capabilities with one segment per node', async () => {
    const { port } = await start()
    const capabilities = await callJson(port, 'GET', '/multiverse/api/capabilities')
    expect(capabilities.status).toBe(200)
    expect(capabilities.json).toMatchObject({
      model_ids: ['h3-ref2va'], generation_modes: ['ref2va'], aspect_ratios: ['16:9'], resolutions: ['720p'],
      min_segment_duration_sec: 5, max_segment_duration_sec: 7, segment_counts: [1], asset_upload: UPLOAD_POLICY,
      reference_inputs: { media_types: ['image'], max_count: 8, conditioning: 'reference' },
    })
  })

  it('creates a multiverse, streams its snapshots, serves the root media, and accepts a branch choice', async () => {
    const fixture = await start()
    const created = await callJson(fixture.port, 'POST', '/multiverse/api/multiverses', CREATE_REQUEST)
    expect(created.status).toBe(201)
    const multiverse = created.json as WireMultiverse
    expect(multiverse).toMatchObject({ segment_duration_sec: 6, nodes: [{ node_id: multiverse.root_id, status: 'generating', has_clip: false }] })
    const events = await openEvents(fixture.port, multiverse.multiverse_id)
    const nodePath = (nodeId: string): string => `/multiverse/api/multiverses/${multiverse.multiverse_id}/nodes/${nodeId}`
    expect((await call(fixture.port, 'GET', `${nodePath(multiverse.root_id)}/clip`)).status).toBe(404)

    ;(await fixture.generation.nextCall()).reply.resolve()
    const snapshot = await events.waitFor(latest => latest.nodes.length === 3)
    expect(snapshot.nodes.map(node => [node.label, node.status, node.has_clip, node.has_last_frame])).toEqual([
      ['Beginning', 'completed', true, true],
      ['Option 1 A', 'proposed', false, false],
      ['Option 1 B', 'proposed', false, false],
    ])
    expect(await call(fixture.port, 'GET', `${nodePath(multiverse.root_id)}/clip`))
      .toEqual({ status: 200, contentType: 'video/mp4', body: clipBytes(1) })
    expect(await call(fixture.port, 'GET', `${nodePath(multiverse.root_id)}/last-frame`))
      .toEqual({ status: 200, contentType: 'image/png', body: lastFrameBytes(1) })

    const branchId = snapshot.nodes[1]!.node_id
    expect(await callJson(fixture.port, 'POST', `${nodePath(branchId)}/choose`)).toEqual({ status: 202, json: {} })
    expect(await callJson(fixture.port, 'POST', `${nodePath(snapshot.nodes[2]!.node_id)}/choose`)).toEqual({
      status: 400, json: { detail: 'Wait for the current scene to finish generating.' },
    })
    expect((await events.waitFor(latest => latest.nodes[1]?.status === 'generating')).nodes[1]?.label).toBe('Option 1 A')
  })

  it('answers 400 for an invalid creation request and 404 for an unknown multiverse or node', async () => {
    const { port } = await start()
    expect(await callJson(port, 'POST', '/multiverse/api/multiverses', ['not', 'an', 'object'])).toEqual({
      status: 400, json: { detail: 'The request body must be a JSON object.' },
    })
    expect(await callJson(port, 'POST', '/multiverse/api/multiverses', { ...CREATE_REQUEST, prompt: '' })).toEqual({
      status: 400, json: { detail: 'A multiverse needs a prompt.' },
    })
    expect((await callJson(port, 'GET', '/multiverse/api/multiverses/missing')).status).toBe(404)
    expect((await callJson(port, 'GET', '/multiverse/api/multiverses/missing/events')).status).toBe(404)
    expect((await callJson(port, 'POST', '/multiverse/api/multiverses/missing/nodes/missing/choose')).status).toBe(404)
  })

  it('sends keepalive comments on an event stream at the configured interval', async () => {
    const fixture = await start({ keepaliveMs: 20 })
    const multiverse = (await callJson(fixture.port, 'POST', '/multiverse/api/multiverses', CREATE_REQUEST)).json as WireMultiverse
    const events = await openEvents(fixture.port, multiverse.multiverse_id)
    await vi.waitUntil(() => events.keepalives() >= 2)
  })

  it('removes its routes and ends open event streams when the controller unloads', async () => {
    const fixture = await start()
    const multiverse = (await callJson(fixture.port, 'POST', '/multiverse/api/multiverses', CREATE_REQUEST)).json as WireMultiverse
    const events = await openEvents(fixture.port, multiverse.multiverse_id)
    await fixture.controllerFiber.dispose()
    await events.ended
    expect((await call(fixture.port, 'GET', '/multiverse/api/capabilities')).status).toBe(404)
  })
})
