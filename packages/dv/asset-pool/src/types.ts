/**
 * Types of the Asset pool component.
 *
 * @module @dv/asset-pool/types
 */
import type { AssetId, RecordId } from '@dv/project'

/**
 * One asset the pool holds, as one line of `assets/index.jsonl` stores it. The pool never decodes media: the width,
 * height and duration are known only when the importer gave them.
 */
export interface Asset {
  /** The SHA-256 hex digest of the bytes, which is also the file name under `objects/`. */
  readonly id: AssetId
  /** The media type, such as `image/png` or `video/mp4`. */
  readonly mime: string
  /** The display name, such as the imported file's name or `still.png`. */
  readonly name: string
  readonly size_bytes: number
  /** The record that created the asset; null for an asset imported outside any record. */
  readonly created_by: RecordId | null
  /** ISO-8601 UTC time of the first import. */
  readonly created_at: string
  /** Pixel width, or null when the importer did not give it. */
  readonly width: number | null
  /** Pixel height, or null when the importer did not give it. */
  readonly height: number | null
  /** Duration of audio or video in seconds, or null when the importer did not give it. */
  readonly duration_sec: number | null
}

/** Where `asset.grab_still` takes the still: the first frame, the last frame, or a time in seconds. */
export type StillAt = 'first' | 'last' | number

/** The `asset` slice: the assets on the canvas of the branch. */
export interface AssetState {
  /** The assets placed on the canvas, in the order they were placed. */
  placed: AssetId[]
}

declare module '@dv/project' {
  interface ComponentStates {
    /** The assets placed on the canvas (Asset pool). */
    asset: AssetState
  }
}
