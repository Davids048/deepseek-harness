/**
 * Own asset files, their SQLite index, and file retention for accepted generation requests.
 *
 * A port of `apps/dreamverse/dreamverse/assets/library.py`. The directory layout and the `assets` table match the
 * reference, so the harness and the Python server can open the same `<state root>/assets` directory.
 *
 * @module @dreamverse/assets-manager/library
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'

import { UploadTooLargeError, inspectMedia, mediaTypeForMime, uploadPolicy, type MediaType } from './media.ts'

/** The requested asset is absent or deleted from the library; the reference `AssetNotFoundError(LookupError)`. */
export class AssetNotFoundError extends Error {
  override name = 'AssetNotFoundError'
}

/** One published asset; `filePath` is `<root>/files/<assetId>`. */
export interface AssetRecord {
  readonly assetId: string
  readonly name: string
  readonly mediaType: MediaType
  readonly mimeType: string
  readonly filePath: string
  readonly sizeBytes: number
  readonly width: number | null
  readonly height: number | null
  readonly durationSec: number | null
}

/** The characters for which Python `str.isspace()` is true. */
const PYTHON_WHITESPACE = '[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'

/** Python `str.strip()` without arguments: remove `str.isspace()` characters from both ends. */
const PYTHON_STRIP_PATTERN = new RegExp(`^${PYTHON_WHITESPACE}+|${PYTHON_WHITESPACE}+$`, 'gu')

/**
 * Persist immutable media; defer deleted files until accepted requests release them.
 *
 * Each application owns one library. Every index and retention method runs synchronously, so HTTP uploads and
 * deletions and project admission observe each other's changes in call order.
 */
export class AssetLibrary {
  private readonly filesDirectory: string
  private readonly retained = new Map<string, number>()
  private readonly database: DatabaseSync
  private closed = false

  /**
   * Open the index and finish deletions left by a stopped application.
   * @param root - the directory holding `files/` and `index.sqlite3`; it is created when missing.
   */
  constructor(root: string) {
    this.filesDirectory = path.join(root, 'files')
    mkdirSync(this.filesDirectory, { recursive: true })
    this.database = new DatabaseSync(path.join(root, 'index.sqlite3'))
    this.database.exec(
      `CREATE TABLE IF NOT EXISTS assets (
                    asset_id TEXT PRIMARY KEY, name TEXT NOT NULL, media_type TEXT NOT NULL,
                    mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, width INTEGER,
                    height INTEGER, duration_sec REAL, deleted INTEGER NOT NULL DEFAULT 0
                )`,
    )
    for (const row of this.database.prepare('SELECT asset_id FROM assets WHERE deleted = 1').all()) {
      this.removeDeletedFile(String(row.asset_id))
    }
  }

  /**
   * Copy and validate one upload, then publish its stable ID in the index. A failed upload leaves no file behind.
   * @param content - the complete upload.
   * @param name - the uploaded file name; control characters, `/`, and `\` become `_`, and the result is stripped
   *   and cut to 200 characters, with `Untitled asset` for an empty result.
   * @param mimeType - the MIME type the browser declared.
   * @returns the published record; images carry the MIME type detected from their content.
   * @throws {MediaValidationError} when the MIME type or content fails validation.
   * @throws {UploadTooLargeError} when the upload exceeds its media type's byte limit.
   */
  async add(content: Uint8Array, name: string, mimeType: string): Promise<AssetRecord> {
    const mediaType = mediaTypeForMime(mimeType)
    const maxBytes = uploadPolicy()[mediaType].max_bytes
    if (content.byteLength > maxBytes) {
      throw new UploadTooLargeError(`The ${mediaType} exceeds the ${maxBytes} byte upload limit.`)
    }
    const assetId = randomUUID().replaceAll('-', '')
    const filePath = path.join(this.filesDirectory, assetId)
    try {
      await writeFile(filePath, content, { flag: 'wx' })
      const metadata = await inspectMedia(filePath, mimeType)
      this.database.prepare(
        `INSERT INTO assets
                    (asset_id, name, media_type, mime_type, size_bytes, width, height, duration_sec)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(assetId, displayName(name), metadata.mediaType, metadata.mimeType, content.byteLength,
        metadata.width, metadata.height, metadata.durationSec)
      return this.get(assetId)
    } catch (error) {
      await rm(filePath, { force: true })
      throw error
    }
  }

  /**
   * List the published assets.
   * @returns every asset that is not deleted, most recently added first.
   */
  list(): AssetRecord[] {
    const rows = this.database.prepare('SELECT * FROM assets WHERE deleted = 0 ORDER BY rowid DESC').all()
    return rows.map(row => this.record(row))
  }

  /**
   * Resolve one published asset.
   * @param assetId - the asset ID.
   * @returns the asset record.
   * @throws {AssetNotFoundError} when the asset is absent or deleted.
   */
  get(assetId: string): AssetRecord {
    const row = this.database.prepare('SELECT * FROM assets WHERE asset_id = ? AND deleted = 0').get(assetId)
    if (row === undefined) {
      const quotedAssetId = pythonStringRepr(assetId)
      throw new AssetNotFoundError(`Asset ${quotedAssetId} is unavailable. Select an asset from the library.`)
    }
    return this.record(row)
  }

  /**
   * Resolve all IDs before protecting any file, then protect the files in the request's order.
   * @param assetIds - the asset IDs one request uses; a repeated ID is retained once per occurrence.
   * @returns the records in `assetIds` order.
   * @throws {AssetNotFoundError} for the first unavailable ID; no file is retained then.
   */
  retain(assetIds: readonly string[]): AssetRecord[] {
    const assets = assetIds.map(assetId => this.get(assetId))
    for (const assetId of assetIds) this.retained.set(assetId, (this.retained.get(assetId) ?? 0) + 1)
    return assets
  }

  /**
   * Release one request's files and finish any deletions waiting for that request.
   * @param assetIds - the IDs that one `retain` call accepted.
   * @throws {Error} `Asset release must match an accepted retention.` when an ID is released more often than it is
   *   retained; no count changes then.
   */
  release(assetIds: readonly string[]): void {
    const counts = new Map<string, number>()
    for (const assetId of assetIds) counts.set(assetId, (counts.get(assetId) ?? 0) + 1)
    for (const [assetId, count] of counts) {
      if ((this.retained.get(assetId) ?? 0) < count) throw new Error('Asset release must match an accepted retention.')
    }
    for (const [assetId, count] of counts) this.retained.set(assetId, (this.retained.get(assetId) ?? 0) - count)
    for (const assetId of counts.keys()) {
      if (this.retained.get(assetId) === 0) {
        this.retained.delete(assetId)
        this.removeDeletedFile(assetId)
      }
    }
  }

  /**
   * Hide an asset immediately; preserve its file while generation uses it.
   * @param assetId - the asset ID.
   * @throws {AssetNotFoundError} when the asset is absent or already deleted.
   */
  delete(assetId: string): void {
    this.get(assetId)
    this.database.prepare('UPDATE assets SET deleted = 1 WHERE asset_id = ?').run(assetId)
    if (!this.retained.get(assetId)) this.removeDeletedFile(assetId)
  }

  /** Close the index after the application has drained accepted generation requests; later calls do nothing. */
  close(): void {
    if (this.closed) return
    this.database.close()
    this.closed = true
  }

  /** Keep the tombstone until both file deletion and index removal succeed. */
  private removeDeletedFile(assetId: string): void {
    const row = this.database.prepare('SELECT deleted FROM assets WHERE asset_id = ?').get(assetId)
    if (row !== undefined && row.deleted) {
      rmSync(path.join(this.filesDirectory, assetId), { force: true })
      this.database.prepare('DELETE FROM assets WHERE asset_id = ?').run(assetId)
    }
  }

  /** Convert one `SELECT *` row of the `assets` table; the `deleted` column is dropped. */
  private record(row: Record<string, SQLOutputValue>): AssetRecord {
    const assetId = String(row.asset_id)
    return {
      assetId,
      name: String(row.name),
      mediaType: row.media_type as MediaType,
      mimeType: String(row.mime_type),
      filePath: path.join(this.filesDirectory, assetId),
      sizeBytes: Number(row.size_bytes),
      width: row.width as number | null,
      height: row.height as number | null,
      durationSec: row.duration_sec as number | null,
    }
  }
}

/**
 * The reference display name: `re.sub(r"[\x00-\x1f\x7f/\\]", "_", name).strip()[:200] or "Untitled asset"`.
 * @param name - the uploaded file name.
 * @returns the sanitized name, cut to 200 code points.
 */
function displayName(name: string): string {
  const stripped = name.replace(/[\x00-\x1f\x7f/\\]/gu, '_').replace(PYTHON_STRIP_PATTERN, '')
  return Array.from(stripped).slice(0, 200).join('') || 'Untitled asset'
}

/**
 * Format a string like Python `repr(str)`, including its quote choice and escapes.
 * @param text - the string to format.
 * @returns the quoted representation.
 */
function pythonStringRepr(text: string): string {
  const quote = text.includes('\'') && !text.includes('"') ? '"' : '\''
  let body = ''
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    if (character === quote || character === '\\') body += `\\${character}`
    else if (character === '\t') body += '\\t'
    else if (character === '\n') body += '\\n'
    else if (character === '\r') body += '\\r'
    else if (character === ' ' || !/[\p{C}\p{Z}]/u.test(character)) body += character
    else if (codePoint < 0x100) body += `\\x${codePoint.toString(16).padStart(2, '0')}`
    else if (codePoint < 0x10000) body += `\\u${codePoint.toString(16).padStart(4, '0')}`
    else body += `\\U${codePoint.toString(16).padStart(8, '0')}`
  }
  return `${quote}${body}${quote}`
}
