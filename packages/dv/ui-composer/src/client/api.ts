/**
 * The composer's view of the composer routes of `@dv/agent-integration`: one shared polling store per chat session of
 * the renders that wait for the user's approval, so every card and the pending bar read the same list. The routes
 * themselves are `DvClient` calls.
 *
 * @module @dv/ui-composer/api
 */
import { DvClient } from '@dv/ui-kit/api.ts'
import type { ApprovalCard } from '@dv/ui-kit/types.ts'

/** Milliseconds between approval list refreshes while a card or the bar is mounted. */
const POLL_MS = 1500

/** The client every composer view shares. */
export const composerClient = new DvClient()

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
      const next = await composerClient.listApprovals(this.session)
      if (JSON.stringify(next) === JSON.stringify(this.list)) return
      this.list = next
      for (const listener of this.listeners) listener()
    } catch (error) {
      // The agent integration may be unloaded on the host: keep the last list and try again on the next tick.
      void error
    }
  }

  /**
   * Approve or skip one card, or every card.
   * @param target - an approval ID, or `all`.
   * @param action - approve or skip.
   */
  async answer(target: string, action: 'approve' | 'skip'): Promise<void> {
    await composerClient.answerApprovals(this.session, target, action)
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
