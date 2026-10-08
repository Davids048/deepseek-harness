/**
 * Readings of a branch state that every view needs: branch labels and asset lookups.
 *
 * @module @dv/ui-kit/state
 */
import type { PickText } from './locale.ts'
import type { Asset, Branch, HistoryEntry, WireState } from './types.ts'

/** The name pattern of forked branches. */
const FORKED_BRANCH = /^b(\d+)$/

/**
 * The label a view shows for a branch: the title the human gave it, else 主线 / Main for `main`, 分支 n / Branch n for
 * `b<n>`, and the branch name for any other branch.
 * @param branch - the branch.
 * @param t - the interface language's string picker.
 * @returns the label.
 */
export function branchLabel(branch: Pick<Branch, 'name' | 'title'>, t: PickText): string {
  if (branch.title !== null) return branch.title
  if (branch.name === 'main') return t('主线', 'Main')
  const forked = FORKED_BRANCH.exec(branch.name)
  return forked === null ? branch.name : t(`分支 ${forked[1] ?? ''}`, `Branch ${forked[1] ?? ''}`)
}

/**
 * The branch a history entry belongs to as the views show it: the current branch when its line holds the record, else
 * the branch the record was written on when that line still holds it, else the first branch whose line holds it.
 * @param entry - a history entry.
 * @param current - the project's current branch.
 * @returns the branch name, or null for a record on no branch line.
 */
export function entryBranch(entry: Pick<HistoryEntry, 'record' | 'branches'>, current: string | null): string | null {
  if (current !== null && entry.branches.includes(current)) return current
  return entry.branches.includes(entry.record.branch) ? entry.record.branch : entry.branches[0] ?? null
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
