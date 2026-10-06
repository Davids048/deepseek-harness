/**
 * Browser client of the composer routes in `@video-harness/mentions`: per-session composer modes and the generation
 * approvals, with one shared polling store per session so every card and the pending bar read the same list.
 *
 * @module @video-harness/ui-composer/api
 */

/** The two composer choices of a chat session. */
export interface ComposerMode {
  confirm: 'ask' | 'direct'
  speed: 'quality' | 'speed'
}

/** One reference of a waiting generation. */
export interface ApprovalReference {
  role: string
  ref: string
  assetId: string | null
  url: string | null
}

/** One generation waiting for the user. */
export interface ApprovalCard {
  id: string
  sessionId: string
  callId: string
  tool: string
  summary: string
  prompt: string
  durationSec: number | null
  model: string
  estimateGpuSeconds: number
  references: ApprovalReference[]
  createdAt: string
}

const MODE_ROUTE = '/api/vh/composer/mode'
const APPROVALS_ROUTE = '/api/vh/composer/approvals'

/** Milliseconds between approval list refreshes while a card or the bar is mounted. */
const POLL_MS = 1500

/** Read a JSON response, throwing its error message on a failure status. */
async function decode<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${String(response.status)}`
    throw new Error(error)
  }
  return body as T
}

/**
 * @param session - a chat session.
 * @returns its composer choices.
 */
export async function readMode(session: string): Promise<ComposerMode> {
  return decode(await fetch(`${MODE_ROUTE}?session=${encodeURIComponent(session)}`))
}

/**
 * Change a session's composer choices.
 * @param session - a chat session.
 * @param patch - the choices to change.
 * @returns the choices afterwards.
 */
export async function writeMode(session: string, patch: Partial<ComposerMode>): Promise<ComposerMode> {
  return decode(await fetch(MODE_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session, ...patch }) }))
}

/** One session's approval list, refreshed while it has subscribers. */
class ApprovalStore {
  private list: ApprovalCard[] = []
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly session: string) {}

  /** @returns the latest list. */
  readonly snapshot = (): ApprovalCard[] => this.list

  /**
   * @param listener - called after the list changes.
   * @returns the unsubscribe function.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.timer === null) {
      void this.refresh()
      this.timer = setInterval(() => { void this.refresh() }, POLL_MS)
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.timer !== null) {
        clearInterval(this.timer)
        this.timer = null
      }
    }
  }

  /** Fetch the list and notify when it changed. */
  async refresh(): Promise<void> {
    try {
      const next = await decode<ApprovalCard[]>(await fetch(`${APPROVALS_ROUTE}?session=${encodeURIComponent(this.session)}`))
      if (JSON.stringify(next) === JSON.stringify(this.list)) return
      this.list = next
      for (const listener of this.listeners) listener()
    } catch (error) {
      // The composer plugin may be unloaded on the host: keep the last list and try again on the next tick.
      void error
    }
  }

  /**
   * Approve or skip one card, or every card.
   * @param target - an approval ID, or `all`.
   * @param action - approve or skip.
   */
  async answer(target: string, action: 'approve' | 'skip'): Promise<void> {
    const body = target === 'all' ? { session: this.session, all: true, action } : { session: this.session, id: target, action }
    await decode(await fetch(APPROVALS_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    await this.refresh()
  }
}

const stores = new Map<string, ApprovalStore>()

/**
 * @param session - a chat session.
 * @returns the session's shared approval store.
 */
export function approvalStore(session: string): ApprovalStore {
  let store = stores.get(session)
  if (store === undefined) {
    store = new ApprovalStore(session)
    stores.set(session, store)
  }
  return store
}
