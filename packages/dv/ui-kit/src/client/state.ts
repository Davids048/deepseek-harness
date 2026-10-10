/**
 * Readings of the project state that every view needs: asset lookups and the render operations.
 *
 * @module @dv/ui-kit/state
 */
import type { Asset, WireState } from './types.ts'

/** The render operations, one per render mode; their records are the takes. */
export const RENDER_OPERATIONS: readonly string[] = ['shot.render_ref2va', 'shot.render_t2va']

/**
 * @param operation - a record's operation, or null for a record without one.
 * @returns whether the record renders a take.
 */
export function isRenderOperation(operation: string | null | undefined): boolean {
  return operation !== null && operation !== undefined && RENDER_OPERATIONS.includes(operation)
}

/**
 * @param state - the project state.
 * @returns assets by ID.
 */
export function assetIndex(state: WireState): Map<string, Asset> {
  return new Map(state.assets.map(asset => [asset.id, asset]))
}

/**
 * The video assets of a state, newest first, for insertion into the timeline.
 * @param state - the project state.
 * @returns the video assets.
 */
export function videoAssets(state: WireState): Asset[] {
  return state.assets.filter(asset => asset.mime.startsWith('video/')).sort((a, b) => b.created_at.localeCompare(a.created_at))
}
