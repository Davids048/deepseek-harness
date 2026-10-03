/**
 * The multiverse page's HTTP API on the DSH web server, under `/multiverse/api`. It translates requests into tree reads
 * and director commands, streams tree snapshots as server-sent events, and serves each node's video and last frame from
 * the multiverse project's files. It keeps no state of its own besides open event streams.
 *
 * @module @dreamverse/multiverse/controller
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Logger } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { AssetNotFoundError, sendFile, type AssetId, type AssetRecord } from '@dreamverse/assets-manager'
import type DreamverseAssetsManager from '@dreamverse/assets-manager'
import { sendJson, serveRoutes, type Route } from '@dreamverse/http-routes'
import type { ProjectId } from '@dreamverse/project-store'
import { lobbyCapabilitiesAsDict } from '@dreamverse/segment-generation'
import type {} from './director.ts'
import { MultiverseNotFoundError, MultiverseRequestError } from './errors.ts'
import type { Multiverse, MultiverseNode, NodeId } from './tree.ts'

export const name = 'dreamverse-multiverse-controller'
export const inject = [
  'webServer', 'dreamverseMultiverseTree', 'dreamverseMultiverseDirector', 'dreamverseGeneration', 'dreamverseAssetsManager',
]

/** Controller configuration. */
export interface Config {
  /** Interval, in milliseconds, of SSE comment lines that keep idle event streams open through proxies. */
  keepaliveMs: number
}

/** Loader validation; the keepalive interval is required. */
export const Config: z<Config> = z.object({
  keepaliveMs: z.natural().min(1).max(2_147_483_647).required(),
})

/** The API path prefix; every route below starts with it. */
const API_PREFIX = '/multiverse/api'
/** The largest JSON request body the API reads. */
const MAX_BODY_BYTES = 64 * 1024

/** One node in the page's JSON. */
export interface WireNode {
  node_id: NodeId
  parent_id: NodeId | null
  depth: number
  label: string
  direction: string
  status: MultiverseNode['status']
  prompt: string | null
  error: string | null
  has_clip: boolean
  has_last_frame: boolean
}

/** One multiverse in the page's JSON; nodes are in creation order. */
export interface WireMultiverse {
  multiverse_id: ProjectId
  created_at: number
  root_id: NodeId
  segment_duration_sec: number
  nodes: WireNode[]
}

/**
 * Describe a multiverse for the page.
 * @param multiverse - the multiverse.
 * @returns its JSON fields.
 */
export function toWireMultiverse(multiverse: Multiverse): WireMultiverse {
  return {
    multiverse_id: multiverse.multiverseId,
    created_at: multiverse.createdAt,
    root_id: multiverse.rootId,
    segment_duration_sec: multiverse.creationConfig.segment_duration_sec,
    nodes: [...multiverse.nodes.values()].map(node => ({
      node_id: node.nodeId,
      parent_id: node.parentId,
      depth: node.depth,
      label: node.label,
      direction: node.direction,
      status: node.status,
      prompt: node.prompt,
      error: node.error,
      has_clip: node.videoAssetId !== null,
      has_last_frame: node.lastFrameAssetId !== null,
    })),
  }
}

/**
 * Register the `/multiverse/api` routes for the plugin's lifetime and close open event streams when it unloads.
 * @param ctx - plugin context.
 * @param config - the event-stream keepalive interval.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('multiverse')
  const streams = new Set<ServerResponse>()
  const routes = buildRoutes(ctx, streams, logger, config.keepaliveMs)
  ctx.effect(() => () => {
    for (const response of streams) response.end()
    streams.clear()
  }, 'multiverse event streams')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (request, response) => { serveRoutes(routes, request, response, logger) },
  }), 'multiverse api')
}

/**
 * Build the route table.
 * @param ctx - plugin context with the tree, director, generation client, and file store.
 * @param streams - the open event-stream responses.
 * @param logger - receives a failure to release a sent file.
 * @param keepaliveMs - the keepalive interval of event streams.
 * @returns the routes in match order.
 */
function buildRoutes(ctx: Context, streams: Set<ServerResponse>, logger: Logger, keepaliveMs: number): Route[] {
  const tree = ctx.dreamverseMultiverseTree
  const director = ctx.dreamverseMultiverseDirector
  const node = (path: string): RegExp => new RegExp(`^${API_PREFIX}/multiverses/([^/]+)/nodes/([^/]+)/${path}$`)
  return [
    {
      method: 'GET', path: new RegExp(`^${API_PREFIX}/capabilities$`),
      handle: async (_request, response) => {
        // The page's creation form reads DreamVerse's `/creation-capabilities` payload; every node is one segment.
        const facts = await ctx.dreamverseGeneration.model()
        sendJson(response, 200, { ...lobbyCapabilitiesAsDict(facts, ctx.dreamverseAssetsManager.uploadPolicy()), segment_counts: [1] })
      },
    },
    {
      method: 'GET', path: new RegExp(`^${API_PREFIX}/multiverses$`),
      handle: (_request, response) => { sendJson(response, 200, tree.list().map(toWireMultiverse)) },
    },
    {
      method: 'POST', path: new RegExp(`^${API_PREFIX}/multiverses$`),
      handle: async (request, response) => {
        await answer(response, async () => toWireMultiverse(await director.create(await readJsonObject(request))), 201)
      },
    },
    {
      method: 'GET', path: new RegExp(`^${API_PREFIX}/multiverses/([^/]+)$`),
      handle: async (_request, response, [id = '']) => {
        await answer(response, () => toWireMultiverse(tree.get(brandString<ProjectId>(id))))
      },
    },
    {
      method: 'GET', path: new RegExp(`^${API_PREFIX}/multiverses/([^/]+)/events$`),
      handle: async (request, response, [id = '']) => {
        await answer(response, () => { openEventStream(ctx, streams, request, response, brandString<ProjectId>(id), keepaliveMs) }, null)
      },
    },
    {
      method: 'POST', path: node('choose'),
      handle: async (_request, response, [id = '', nodeId = '']) => {
        await answer(response, () => { director.choose(brandString<ProjectId>(id), brandString<NodeId>(nodeId)); return {} }, 202)
      },
    },
    {
      method: 'POST', path: node('propose'),
      handle: async (_request, response, [id = '', nodeId = '']) => {
        await answer(response, () => { director.propose(brandString<ProjectId>(id), brandString<NodeId>(nodeId)); return {} }, 202)
      },
    },
    {
      method: 'GET', path: node('clip'),
      handle: async (request, response, [id = '', nodeId = '']) => {
        await answer(response, async () => {
          const { videoAssetId } = tree.node(brandString<ProjectId>(id), brandString<NodeId>(nodeId))
          await sendAsset(request, response, ctx.dreamverseAssetsManager, videoAssetId, logger)
        }, null)
      },
    },
    {
      method: 'GET', path: node('last-frame'),
      handle: async (request, response, [id = '', nodeId = '']) => {
        await answer(response, async () => {
          const { lastFrameAssetId } = tree.node(brandString<ProjectId>(id), brandString<NodeId>(nodeId))
          await sendAsset(request, response, ctx.dreamverseAssetsManager, lastFrameAssetId, logger)
        }, null)
      },
    },
  ]
}

/**
 * Run one route body and answer its result as JSON, or map a tree or director error to 404 or 400.
 * @param response - the response to complete.
 * @param run - the route body; it returns the JSON body, or completes the response itself when `status` is null.
 * @param status - the success status; null when the body completes the response.
 */
async function answer(response: ServerResponse, run: () => unknown, status: number | null = 200): Promise<void> {
  try {
    const body = await run()
    if (status !== null) sendJson(response, status, body)
  } catch (error) {
    if (error instanceof MultiverseNotFoundError) sendJson(response, 404, { detail: error.message })
    else if (error instanceof MultiverseRequestError) sendJson(response, 400, { detail: error.message })
    else throw error
  }
}

/**
 * Send one of a node's files, or 404 when the node has none yet. The file stays retained until the response closes, so
 * deleting the multiverse during the delivery keeps the file until then.
 * @param request - the browser request, whose `Range` header selects the bytes.
 * @param response - the response to complete.
 * @param assets - the file store.
 * @param assetId - the node's video or last-frame file, or null before the node is generated.
 * @param logger - receives a failure to release the file.
 */
async function sendAsset(
  request: IncomingMessage,
  response: ServerResponse,
  assets: Pick<DreamverseAssetsManager, 'retain' | 'release'>,
  assetId: AssetId | null,
  logger: Logger,
): Promise<void> {
  let retained: AssetRecord[] = []
  try {
    if (assetId !== null) retained = assets.retain([assetId])
  } catch (error) {
    if (!(error instanceof AssetNotFoundError)) throw error
  }
  const [asset] = retained
  if (assetId === null || asset === undefined) {
    sendJson(response, 404, { detail: 'Not generated yet.' })
    return
  }
  response.once('close', () => {
    try {
      assets.release([assetId])
    } catch (error) {
      logger.error(error)
    }
  })
  await sendFile(request, response, { path: asset.filePath, mediaType: asset.mimeType, filename: asset.name })
}

/**
 * Stream a multiverse's snapshots: one at once, then one after every change, until the client or the plugin closes.
 * @param ctx - plugin context with the tree.
 * @param streams - the open event-stream responses.
 * @param request - the incoming request.
 * @param response - the response held open for events.
 * @param multiverseId - the multiverse.
 * @param keepaliveMs - the interval of the SSE comment lines that keep the stream open.
 * @throws {MultiverseNotFoundError} for an unknown multiverse, before the stream starts.
 */
function openEventStream(
  ctx: Context,
  streams: Set<ServerResponse>,
  request: IncomingMessage,
  response: ServerResponse,
  multiverseId: ProjectId,
  keepaliveMs: number,
): void {
  const tree = ctx.dreamverseMultiverseTree
  const send = (): void => {
    response.write(`event: multiverse\ndata: ${JSON.stringify(toWireMultiverse(tree.get(multiverseId)))}\n\n`)
  }
  tree.get(multiverseId)
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  streams.add(response)
  send()
  const stopListening = tree.onChange((changedId) => { if (changedId === multiverseId) send() })
  const keepalive = setInterval(() => { response.write(': keepalive\n\n') }, keepaliveMs)
  const close = (): void => {
    clearInterval(keepalive)
    stopListening()
    streams.delete(response)
  }
  request.on('close', close)
  response.on('close', close)
}

/**
 * Read a JSON object request body.
 * @param request - the incoming request.
 * @returns the parsed object.
 * @throws {MultiverseRequestError} for a body over the limit, invalid JSON, or a non-object value.
 */
async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new MultiverseRequestError('The request body is too large.')
    chunks.push(chunk as Buffer)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw new MultiverseRequestError(`The request body is not JSON: ${(error as Error).message}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MultiverseRequestError('The request body must be a JSON object.')
  }
  return value as Record<string, unknown>
}
