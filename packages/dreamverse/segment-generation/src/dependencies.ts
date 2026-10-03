/**
 * Service members that segment generation consumes. Generation types come from `@dreamverse/generation-client`. The
 * `dreamverseAssetsManager` members restate the file store calls that this package makes, so the package compiles and
 * tests against fakes.
 *
 * @module @dreamverse/segment-generation/dependencies
 */

import type { ModelFacts, SegmentOutput, SegmentRequest } from '@dreamverse/generation-client'

export type { ModelFacts, SegmentOutput, SegmentRequest }

/** The `dreamverseGeneration` members that segment generation calls. */
export interface DreamverseGeneration {
  /** Rejects with a non-`DreamverseValueError` error when the backend is unreachable. */
  model(): Promise<ModelFacts>
  /**
   * Stream one segment. A backend failure rejects with `GenerationSegmentError`; aborting `request.signal` rejects
   * with `signal.reason`.
   */
  generateSegment(request: SegmentRequest): AsyncIterable<SegmentOutput>
}

/** The owner of a file in the file store: the user's library, or one project. */
export type AssetOwner = 'library' | `project:${string}`

/** One file store record. */
export interface AssetRecord {
  readonly assetId: string
  readonly owner: AssetOwner
  readonly name: string
  /** `image`, `video`, or `audio`. */
  readonly mediaType: string
  readonly mimeType: string
  readonly filePath: string
  readonly sizeBytes: number
  readonly width: number | null
  readonly height: number | null
  readonly durationSec: number | null
  /** ISO-8601 UTC time at which the file was complete. */
  readonly createdAt: string
}

/** The owner, name, and MIME type of a file to write. */
export interface AssetWriteOptions {
  owner: AssetOwner
  name: string
  mimeType: string
}

/** One file written in pieces; it exists in the file store only after `commit`. */
export interface AssetWriter {
  readonly assetId: string
  write(chunk: Uint8Array): Promise<void>
  /** Complete the file and index it. */
  commit(): Promise<AssetRecord>
  /** Remove the unfinished file; idempotent, and a no-op after `commit`. */
  abort(): Promise<void>
}

/** The `dreamverseAssetsManager` members that segment generation calls. */
export interface DreamverseAssetsManager {
  createWriter(options: AssetWriteOptions): AssetWriter
  addBytes(options: AssetWriteOptions, bytes: Uint8Array): Promise<AssetRecord>
  /** Delete one file. */
  delete(assetId: string): void
}
