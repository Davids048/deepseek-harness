/**
 * The multiverse page's client for the `/multiverse/api` routes that `@dreamverse/multiverse/controller` serves.
 *
 * @module @dreamverse/ui-multiverse/client/api
 */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { parseLobbyCapabilities, type LobbyCreationCapabilities } from '@dreamverse/project-controller/client/creationCapabilities.ts'
import type { CreationInitPayload } from '@dreamverse/project-controller/client/creationPayload.ts'
import type { ProjectId } from '@dreamverse/project-controller/client/ids.ts'
import { assetErrorText } from '@dreamverse/ui-kit/problemText.ts'
import type {} from './locales.ts'

/**
 * The ID of one multiverse node. It uses the brand label of the host `NodeId` of `@dreamverse/multiverse/tree`, so the
 * IDs that the page sends back have the host's type.
 */
export type NodeId = Branded<'MultiverseNodeId'>

/** A node's life cycle; `proposed` nodes have no video yet. */
export type NodeStatus = 'proposed' | 'generating' | 'completed' | 'failed'

/** One node, as `toWireMultiverse` in `@dreamverse/multiverse/controller` describes it. */
export interface WireNode {
  node_id: NodeId
  parent_id: NodeId | null
  depth: number
  label: string
  direction: string
  status: NodeStatus
  prompt: string | null
  error: string | null
  has_clip: boolean
  has_last_frame: boolean
}

/** One multiverse; nodes are in creation order. */
export interface WireMultiverse {
  multiverse_id: ProjectId
  created_at: number
  root_id: NodeId
  segment_duration_sec: number
  nodes: WireNode[]
}

/** One node as the response JSON carries it, before {@link brandMultiverse} brands its IDs. */
type NodeJson = Omit<WireNode, 'node_id' | 'parent_id'> & { node_id: string; parent_id: string | null }

/** One multiverse as the response JSON carries it, before {@link brandMultiverse} brands its IDs. */
type MultiverseJson = Omit<WireMultiverse, 'multiverse_id' | 'root_id' | 'nodes'> & {
  multiverse_id: string
  root_id: string
  nodes: NodeJson[]
}

/**
 * Brand the IDs of a multiverse that a response carries.
 * @param json - the response's multiverse.
 * @returns the same multiverse with branded IDs.
 */
function brandMultiverse(json: MultiverseJson): WireMultiverse {
  return {
    ...json,
    multiverse_id: brandString<ProjectId>(json.multiverse_id),
    root_id: brandString<NodeId>(json.root_id),
    nodes: json.nodes.map(node => ({
      ...node,
      node_id: brandString<NodeId>(node.node_id),
      parent_id: node.parent_id === null ? null : brandString<NodeId>(node.parent_id),
    })),
  }
}

/** A creation request: the opening scene and the DreamVerse creation choices; the server makes every node one segment. */
export type CreateRequest = CreationInitPayload & { prompt: string }

const API = '/multiverse/api'

/** An error status whose response carries no `detail` message; the page describes it from the status. */
export class RequestFailedError extends Error {
  /**
   * @param status - the HTTP status of the response.
   */
  constructor(readonly status: number) {
    super(`Request failed with HTTP ${status}`)
  }
}

/**
 * Parse a JSON response, or throw the API's `detail` message for an error status.
 * @param response - the API response.
 * @returns the parsed body.
 * @throws Error with the response's `detail`, or {@link RequestFailedError} when it has none.
 */
async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { detail?: string } | null
  if (!response.ok) {
    const detail = body?.detail ?? null
    throw detail === null ? new RequestFailedError(response.status) : new Error(detail)
  }
  return body as T
}

/**
 * Describe a failed page action for display: the server's message verbatim, or the localized status or asset request
 * failure.
 * @param cause - the rejection of an API call.
 * @param t - the multiverse page's translate function.
 * @returns the text that the page shows.
 */
export function failureText(cause: unknown, t: TranslateNS<'dreamverse.multiverse'>): string {
  if (cause instanceof RequestFailedError) return t('request.failed', { status: cause.status })
  return assetErrorText(cause, String(cause), t)
}

/**
 * Read the choices for a new multiverse, in the DreamVerse `/creation-capabilities` format.
 * @returns the served model's creation capabilities.
 * @throws Error for an error status or a payload that is not creation capabilities.
 */
export async function fetchCapabilities(): Promise<LobbyCreationCapabilities> {
  const capabilities = parseLobbyCapabilities(await readJson<unknown>(await fetch(`${API}/capabilities`)))
  if (capabilities === null) throw new Error('Invalid model capabilities.')
  return capabilities
}

/**
 * Create a multiverse; its root starts generating.
 * @param request - the opening scene, the creation choices, and the reference asset IDs.
 * @returns the new multiverse.
 */
export async function createMultiverse(request: CreateRequest): Promise<WireMultiverse> {
  return brandMultiverse(await readJson<MultiverseJson>(await fetch(`${API}/multiverses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
  })))
}

/**
 * Generate a proposed branch, or retry a failed node.
 * @param multiverseId - the multiverse.
 * @param nodeId - the node.
 */
export async function chooseNode(multiverseId: ProjectId, nodeId: NodeId): Promise<void> {
  await readJson<object>(await fetch(`${nodeUrl(multiverseId, nodeId)}/choose`, { method: 'POST' }))
}

/**
 * Propose branches again under a generated node whose proposal failed.
 * @param multiverseId - the multiverse.
 * @param nodeId - the node.
 */
export async function proposeAgain(multiverseId: ProjectId, nodeId: NodeId): Promise<void> {
  await readJson<object>(await fetch(`${nodeUrl(multiverseId, nodeId)}/propose`, { method: 'POST' }))
}

/**
 * @param multiverseId - the multiverse.
 * @param nodeId - the node.
 * @returns the URL of the node's routes.
 */
export function nodeUrl(multiverseId: ProjectId, nodeId: NodeId): string {
  return `${API}/multiverses/${encodeURIComponent(multiverseId)}/nodes/${encodeURIComponent(nodeId)}`
}

/** How often the page reads the open multiverse. */
const POLL_INTERVAL_MS = 1000

/**
 * Report the multiverse's snapshot now and after every change, by reading it once a second. The page polls instead of
 * reading the `events` route because a Cloudflare quick tunnel holds back the body of a server-sent event stream until
 * the response ends, so a page opened through the tunnel would never receive a snapshot.
 * @param multiverseId - the multiverse.
 * @param onSnapshot - called with the first snapshot and with each snapshot that differs from the previous one.
 * @param onError - called for each failed read; polling continues.
 * @returns the function that stops polling.
 */
export function subscribeMultiverse(
  multiverseId: ProjectId,
  onSnapshot: (multiverse: WireMultiverse) => void,
  onError: () => void,
): () => void {
  let stopped = false
  let previous = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = async (): Promise<void> => {
    try {
      const response = await fetch(`${API}/multiverses/${encodeURIComponent(multiverseId)}`, { cache: 'no-store' })
      const snapshot = await readJson<MultiverseJson>(response)
      const text = JSON.stringify(snapshot)
      if (!stopped && text !== previous) {
        previous = text
        onSnapshot(brandMultiverse(snapshot))
      }
    } catch {
      // A failed read leaves the last snapshot on the page; the next read retries.
      if (!stopped) onError()
    }
    if (!stopped) timer = setTimeout(() => { void poll() }, POLL_INTERVAL_MS)
  }
  void poll()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
