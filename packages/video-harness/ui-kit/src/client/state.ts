/**
 * Readings of a folded state that both views need: open drafts, branch names, and asset lookups.
 *
 * @module @video-harness/ui-kit/state
 */
import type { WireAsset, WireState } from './types.ts'

/** An agent draft the user has neither accepted nor rejected. */
export interface OpenDraft {
  turn: string
  branch: string
  intent: string
  /** Records the draft added beyond `main`. */
  ops: number
}

/**
 * The draft branches whose turn the server reports as open; an accepted, rejected, or stopped draft keeps its branch
 * head but is left out.
 * @param state - a folded state of any head.
 * @returns the drafts, oldest first.
 */
export function openDrafts(state: WireState): OpenDraft[] {
  const open = new Set(state.openTurns)
  const drafts: OpenDraft[] = []
  for (const branch of Object.keys(state.heads)) {
    if (!branch.startsWith('draft/')) continue
    const turn = branch.slice('draft/'.length)
    if (!open.has(turn)) continue
    const summary = state.turns[turn]
    drafts.push({ turn, branch, intent: summary?.intent ?? '', ops: summary?.ops.length ?? 0 })
  }
  return drafts
}

/**
 * The branches a user can switch to: `main`, exploration branches, then drafts.
 * @param state - a folded state.
 * @returns the names in that order.
 */
export function branchNames(state: WireState): string[] {
  const names = Object.keys(state.heads)
  const main = names.filter(name => name === 'main')
  const explorations = names.filter(name => name !== 'main' && !name.startsWith('draft/')).sort()
  const drafts = names.filter(name => name.startsWith('draft/'))
  return [...main, ...explorations, ...drafts]
}

/**
 * @param state - a folded state.
 * @returns asset records by ID.
 */
export function assetIndex(state: WireState): Map<string, WireAsset> {
  return new Map(state.assets.map(asset => [asset.id, asset]))
}

/**
 * The video assets of a state, newest first, for insertion into the timeline.
 * @param state - a folded state.
 * @returns the video asset records.
 */
export function videoAssets(state: WireState): WireAsset[] {
  return state.assets.filter(asset => asset.mime.startsWith('video/')).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
