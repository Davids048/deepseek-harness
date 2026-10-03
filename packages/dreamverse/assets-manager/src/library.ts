/**
 * Own every DreamVerse file (user uploads to the library and files that projects own), their SQLite index, and file
 * retention for accepted generation requests.
 *
 * The upload rules and the `files/<asset_id>` layout come from `apps/dreamverse/dreamverse/assets/library.py`. The
 * index carries `SCHEMA_VERSION` in `PRAGMA user_version`; opening a version 0 index (the reference layout, possibly
 * with the `asset_references` table of earlier harness builds) migrates it to the current version.
 *
 * @module @dreamverse/assets-manager/library
 */
import { randomUUID } from 'node:crypto'
import { constants, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { copyFile, open, rename, rm, writeFile, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

import {
  UploadTooLargeError, describeMedia, inspectMedia, mediaTypeForMime, mediaTypeForMimePrefix, uploadPolicy, type MediaType,
} from './media.ts'

/** The index schema version that this build reads and writes, stored in `PRAGMA user_version`. */
export const SCHEMA_VERSION = 1

/** The requested asset is absent or deleted from the library; the reference `AssetNotFoundError(LookupError)`. */
export class AssetNotFoundError extends Error {
  override name = 'AssetNotFoundError'
}

/**
 * The ID of one file in the file store, which names the file under `files/`. The page's `AssetId` in
 * `@dreamverse/assets-manager/client/assets.ts` uses the same brand label.
 */
export type AssetId = Branded<'DreamverseAssetId'>

/** The party that owns a file: the user's library, or one project. Every file has exactly one owner. */
export type AssetOwner = 'library' | `project:${string}`

/**
 * The owner of the files of one project.
 * @param projectId - the project ID.
 * @returns `project:<projectId>`.
 */
export function projectOwner(projectId: string): AssetOwner {
  return `project:${projectId}`
}

/** One published file; `filePath` is `<root>/files/<assetId>`. */
export interface AssetRecord {
  readonly assetId: AssetId
  readonly owner: AssetOwner
  readonly name: string
  readonly mediaType: MediaType
  readonly mimeType: string
  readonly filePath: string
  readonly sizeBytes: number
  readonly width: number | null
  readonly height: number | null
  readonly durationSec: number | null
  /** ISO-8601 UTC time at which the file was complete. */
  readonly createdAt: string
}

/** The owner, display name, and MIME type of a file that the harness writes. */
export interface AssetWriteOptions {
  owner: AssetOwner
  name: string
  /** An `image/`, `video/`, or `audio/` MIME type, possibly with parameters such as `codecs`; stored unchanged. */
  mimeType: string
}

/** One file written in pieces: `<root>/files/<assetId>.partial` until `commit` publishes it. */
export interface AssetWriter {
  readonly assetId: AssetId
  /** Append bytes; rejects after `commit` or `abort`. */
  write(chunk: Uint8Array): Promise<void>
  /** Inspect the written bytes, rename the partial file, and index it; any failure removes the file. */
  commit(): Promise<AssetRecord>
  /** Remove the partial file. Idempotent; a no-op after `commit`. */
  abort(): Promise<void>
}

/** The characters for which Python `str.isspace()` is true. */
const PYTHON_WHITESPACE = '[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'

/** Python `str.strip()` without arguments: remove `str.isspace()` characters from both ends. */
const PYTHON_STRIP_PATTERN = new RegExp(`^${PYTHON_WHITESPACE}+|${PYTHON_WHITESPACE}+$`, 'gu')

/**
 * Persist immutable media; defer deleted files until accepted requests release them; refuse to delete media that a
 * stored project uses.
 *
 * Each application owns one library. Every index and retention method runs synchronously, so HTTP uploads and
 * deletions and project admission observe each other's changes in call order.
 */
export class AssetLibrary {
  private readonly filesDirectory: string
  private readonly retained = new Map<AssetId, number>()
  private readonly database: DatabaseSync
  private closed = false

  /**
   * Open and migrate the index, remove partial files left by a stopped application, and finish its deletions.
   * @param root - the directory holding `files/` and `index.sqlite3`; it is created when missing.
   * @throws {Error} when the index has a schema version newer than `SCHEMA_VERSION`.
   */
  constructor(root: string) {
    this.filesDirectory = path.join(root, 'files')
    mkdirSync(this.filesDirectory, { recursive: true })
    const indexPath = path.join(root, 'index.sqlite3')
    this.database = new DatabaseSync(indexPath)
    try {
      migrateIndex(this.database, indexPath, this.filesDirectory)
    } catch (error) {
      this.database.close()
      throw error
    }
    for (const name of readdirSync(this.filesDirectory)) {
      if (name.endsWith(PARTIAL_SUFFIX)) rmSync(path.join(this.filesDirectory, name), { force: true })
    }
    for (const row of this.database.prepare('SELECT asset_id FROM assets WHERE deleted = 1').all()) {
      this.removeDeletedFile(brandString<AssetId>(String(row.asset_id)))
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
    const assetId = newAssetId()
    const filePath = path.join(this.filesDirectory, assetId)
    try {
      await writeFile(filePath, content, { flag: 'wx' })
      const metadata = await inspectMedia(filePath, mimeType)
      this.insert({ assetId, owner: 'library', name: displayName(name), sizeBytes: content.byteLength, ...metadata })
      return this.get(assetId)
    } catch (error) {
      await rm(filePath, { force: true })
      throw error
    }
  }

  /**
   * Start writing one file in pieces. The writer creates `<root>/files/<assetId>.partial` on its first write; `commit`
   * reads the file's facts without upload limits, renames it to `<assetId>`, and indexes it.
   * @param options - the file's owner, display name (sanitized like an upload name), and MIME type.
   * @returns the writer.
   * @throws {MediaValidationError} when the MIME type is not an image, video, or audio type.
   */
  createWriter(options: AssetWriteOptions): AssetWriter {
    mediaTypeForMimePrefix(options.mimeType)
    return new PartialFileWriter(newAssetId(), this.filesDirectory, async (assetId, sizeBytes, filePath) => {
      const metadata = await describeMedia(filePath, options.mimeType)
      await rename(filePath, path.join(this.filesDirectory, assetId))
      try {
        this.insert({ assetId, owner: options.owner, name: displayName(options.name), sizeBytes, ...metadata })
      } catch (error) {
        await rm(path.join(this.filesDirectory, assetId), { force: true })
        throw error
      }
      return this.get(assetId)
    })
  }

  /**
   * Write one complete file, such as a last-frame PNG.
   * @param options - the file's owner, display name, and MIME type.
   * @param bytes - the file content.
   * @returns the published record.
   * @throws {MediaValidationError} when the MIME type or the content is not a decodable image, video, or audio file;
   *   no file remains then.
   */
  async addBytes(options: AssetWriteOptions, bytes: Uint8Array): Promise<AssetRecord> {
    const writer = this.createWriter(options)
    try {
      await writer.write(bytes)
      return await writer.commit()
    } catch (error) {
      await writer.abort()
      throw error
    }
  }

  /**
   * Copy a published file for another owner. The copy has a new ID, the source's facts, and its own lifetime: deleting
   * either file leaves the other. The source stays retained while its bytes are copied.
   * @param assetId - the source file.
   * @param owner - the owner of the copy.
   * @returns the copy's record.
   * @throws {AssetNotFoundError} when the source is absent or deleted.
   */
  async copy(assetId: AssetId, owner: AssetOwner): Promise<AssetRecord> {
    const [source] = this.retain([assetId])
    if (source === undefined) throw new Error(`Retaining asset ${assetId} returned no record.`)
    const copyId = newAssetId()
    const copyPath = path.join(this.filesDirectory, copyId)
    try {
      await copyFile(source.filePath, copyPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      this.insert({ ...source, assetId: copyId, owner })
      return this.get(copyId)
    } catch (error) {
      await rm(copyPath, { force: true })
      throw error
    } finally {
      this.release([assetId])
    }
  }

  /**
   * List one owner's published files.
   * @param owner - the owner; the user's library by default.
   * @returns every file of the owner that is not deleted, most recently added first.
   */
  list(owner: AssetOwner = 'library'): AssetRecord[] {
    const rows = this.database.prepare('SELECT * FROM assets WHERE deleted = 0 AND owner = ? ORDER BY rowid DESC').all(owner)
    return rows.map(row => this.record(row))
  }

  /**
   * Resolve one published asset.
   * @param assetId - the asset ID.
   * @returns the asset record.
   * @throws {AssetNotFoundError} when the asset is absent or deleted.
   */
  get(assetId: AssetId): AssetRecord {
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
  retain(assetIds: readonly AssetId[]): AssetRecord[] {
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
  release(assetIds: readonly AssetId[]): void {
    const counts = new Map<AssetId, number>()
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
   * Hide a file immediately; preserve it on disk while a retention holds it.
   * @param assetId - the asset ID.
   * @throws {AssetNotFoundError} when the asset is absent or already deleted.
   */
  delete(assetId: AssetId): void {
    this.get(assetId)
    this.database.prepare('UPDATE assets SET deleted = 1 WHERE asset_id = ?').run(assetId)
    if (!this.retained.get(assetId)) this.removeDeletedFile(assetId)
  }

  /**
   * Delete every published file of one owner, as `delete` does for each. The caller ensures that no writer for this
   * owner is still open: a later commit would publish a file for an owner that no longer exists.
   * @param owner - the owner whose files to delete.
   */
  deleteOwnedBy(owner: AssetOwner): void {
    const rows = this.database.prepare('SELECT asset_id FROM assets WHERE deleted = 0 AND owner = ?').all(owner)
    for (const row of rows) this.delete(brandString<AssetId>(String(row.asset_id)))
  }

  /** Close the index after the application has drained accepted generation requests; later calls do nothing. */
  close(): void {
    if (this.closed) return
    this.database.close()
    this.closed = true
  }

  /** Keep the tombstone until both file deletion and index removal succeed. */
  private removeDeletedFile(assetId: AssetId): void {
    const row = this.database.prepare('SELECT deleted FROM assets WHERE asset_id = ?').get(assetId)
    if (row !== undefined && row.deleted) {
      rmSync(path.join(this.filesDirectory, assetId), { force: true })
      this.database.prepare('DELETE FROM assets WHERE asset_id = ?').run(assetId)
    }
  }

  /** Index one complete file under `files/<assetId>`, stamped with the current time. */
  private insert(fields: Omit<AssetRecord, 'filePath' | 'createdAt'>): void {
    this.database.prepare(
      `INSERT INTO assets
                    (asset_id, owner, name, media_type, mime_type, size_bytes, width, height, duration_sec, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(fields.assetId, fields.owner, fields.name, fields.mediaType, fields.mimeType, fields.sizeBytes,
      fields.width, fields.height, fields.durationSec, new Date().toISOString())
  }

  /** Convert one `SELECT *` row of the `assets` table; the `deleted` column is dropped. */
  private record(row: Record<string, SQLOutputValue>): AssetRecord {
    const assetId = brandString<AssetId>(String(row.asset_id))
    return {
      assetId,
      owner: parseOwner(row.owner),
      name: String(row.name),
      mediaType: row.media_type as MediaType,
      mimeType: String(row.mime_type),
      filePath: path.join(this.filesDirectory, assetId),
      sizeBytes: Number(row.size_bytes),
      width: row.width as number | null,
      height: row.height as number | null,
      durationSec: row.duration_sec as number | null,
      createdAt: String(row.created_at),
    }
  }
}

/** The suffix of a file that a writer has not committed. */
const PARTIAL_SUFFIX = '.partial'

/** A new asset ID: 32 lowercase hexadecimal digits. */
function newAssetId(): AssetId {
  return brandString<AssetId>(randomUUID().replaceAll('-', ''))
}

/**
 * Read an owner column value; the index is a durable file, so an unknown value is an error.
 * @param value - the stored `owner` value.
 * @returns the owner.
 * @throws {Error} for a value that is neither `library` nor `project:<project_id>`.
 */
function parseOwner(value: SQLOutputValue | undefined): AssetOwner {
  if (value === 'library') return 'library'
  if (typeof value === 'string' && value.startsWith('project:') && value.length > 'project:'.length) {
    return projectOwner(value.slice('project:'.length))
  }
  throw new Error(`The asset index holds an unknown owner ${JSON.stringify(value)}.`)
}

/**
 * Bring an index to `SCHEMA_VERSION` in one transaction. Version 0 is the unversioned layout: the reference `assets`
 * table, possibly with the `asset_references` table. Version 1 adds `owner` (existing files belong to the library)
 * and `created_at` (taken from each file's modification time), indexes `owner`, and drops `asset_references`.
 * @param database - the open index.
 * @param indexPath - the index file, named in errors.
 * @param filesDirectory - the `files/` directory, for the modification times.
 * @throws {Error} when the index has a newer schema version than this build.
 */
function migrateIndex(database: DatabaseSync, indexPath: string, filesDirectory: string): void {
  const version = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  if (version > SCHEMA_VERSION) {
    throw new Error(`The asset index ${indexPath} has schema version ${version}; this build reads version ${SCHEMA_VERSION}.`)
  }
  if (version === SCHEMA_VERSION) return
  database.exec('BEGIN')
  try {
    database.exec(
      `CREATE TABLE IF NOT EXISTS assets (
                    asset_id TEXT PRIMARY KEY, name TEXT NOT NULL, media_type TEXT NOT NULL,
                    mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, width INTEGER,
                    height INTEGER, duration_sec REAL, deleted INTEGER NOT NULL DEFAULT 0
                )`,
    )
    database.exec('ALTER TABLE assets ADD COLUMN owner TEXT NOT NULL DEFAULT \'library\'')
    database.exec('ALTER TABLE assets ADD COLUMN created_at TEXT')
    const stamp = database.prepare('UPDATE assets SET created_at = ? WHERE asset_id = ?')
    for (const row of database.prepare('SELECT asset_id FROM assets').all()) {
      const assetId = String(row.asset_id)
      stamp.run(fileTime(path.join(filesDirectory, assetId)), assetId)
    }
    database.exec('CREATE INDEX assets_owner ON assets (owner)')
    database.exec('DROP TABLE IF EXISTS asset_references')
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

/**
 * The modification time of a file as ISO-8601 UTC; a file that is already gone (a pending deletion) gets the current
 * time.
 * @param filePath - the file.
 * @returns the time.
 */
function fileTime(filePath: string): string {
  try {
    return statSync(filePath).mtime.toISOString()
  } catch {
    // ENOENT: the file of a tombstoned row may already be removed; its row is deleted when the library opens.
    return new Date().toISOString()
  }
}

/**
 * Write one file to `<assetId>.partial`, then hand it to `publish`. A failed or aborted write leaves no file.
 */
class PartialFileWriter implements AssetWriter {
  private readonly partialPath: string
  private handle: FileHandle | null = null
  private sizeBytes = 0
  private state: 'open' | 'committing' | 'committed' | 'aborted' = 'open'

  /**
   * @param assetId - the ID that the published file gets.
   * @param filesDirectory - the `files/` directory.
   * @param publish - reads the partial file's facts, renames it to `<assetId>`, indexes it, and returns its record.
   */
  constructor(
    readonly assetId: AssetId,
    filesDirectory: string,
    private readonly publish: (assetId: AssetId, sizeBytes: number, partialPath: string) => Promise<AssetRecord>,
  ) {
    this.partialPath = path.join(filesDirectory, `${assetId}${PARTIAL_SUFFIX}`)
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.state !== 'open') throw new Error(`The writer of asset ${this.assetId} is ${this.state}.`)
    this.handle ??= await open(this.partialPath, 'wx')
    await this.handle.write(chunk)
    this.sizeBytes += chunk.byteLength
  }

  async commit(): Promise<AssetRecord> {
    if (this.state !== 'open') throw new Error(`The writer of asset ${this.assetId} is ${this.state}.`)
    this.state = 'committing'
    try {
      this.handle ??= await open(this.partialPath, 'wx')
      await this.handle.close()
      this.handle = null
      const record = await this.publish(this.assetId, this.sizeBytes, this.partialPath)
      this.state = 'committed'
      return record
    } catch (error) {
      this.state = 'open'
      await this.abort()
      throw error
    }
  }

  async abort(): Promise<void> {
    if (this.state === 'committed' || this.state === 'aborted') return
    this.state = 'aborted'
    const handle = this.handle
    this.handle = null
    await handle?.close()
    await rm(this.partialPath, { force: true })
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
