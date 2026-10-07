/**
 * Readings of a branch state that every view needs: open drafts, branch names, and asset lookups.
 *
 * @module @dv/ui-kit/state
 */
import type { Asset, DraftCounts, WireState } from './types.ts'

/** A chat session's open draft: its branch spans the session's agent turns until the human accepts or discards it. */
export interface OpenDraft {
  /** `draft/<session>`. */
  branch: string
  session: string
  counts: DraftCounts
}

/**
 * Every open draft of the project, one per chat session that has one.
 * @param state - a branch state.
 * @returns the drafts, in branch-name order.
 */
export function openDrafts(state: WireState): OpenDraft[] {
  const drafts: OpenDraft[] = []
  for (const branch of state.branches) {
    if (branch.session === null || branch.counts === null) continue
    drafts.push({ branch: branch.name, session: branch.session, counts: branch.counts })
  }
  return drafts
}

/**
 * The open draft of one chat session: the draft that its accept and discard act on.
 * @param state - a branch state.
 * @param session - the chat session, or null outside any chat session.
 * @returns the draft, or null when the session has none open.
 */
export function sessionDraft(state: WireState, session: string | null): OpenDraft | null {
  return session === null ? null : openDrafts(state).find(draft => draft.session === session) ?? null
}

/**
 * The branches a user can show: `main`, then the drafts.
 * @param state - a branch state.
 * @returns the names in that order.
 */
export function branchNames(state: WireState): string[] {
  const names = Object.keys(state.heads)
  return [...names.filter(name => name === 'main'), ...names.filter(name => name.startsWith('draft/'))]
}

/**
 * @param state - a branch state.
 * @returns assets by ID.
 */
export function assetIndex(state: WireState): Map<string, Asset> {
  return new Map(state.assets.map(asset => [asset.id, asset]))
}

/**
 * The video assets of a state, newest first, for insertion into the timeline.
 * @param state - a branch state.
 * @returns the video assets.
 */
export function videoAssets(state: WireState): Asset[] {
  return state.assets.filter(asset => asset.mime.startsWith('video/')).sort((a, b) => b.created_at.localeCompare(a.created_at))
}
