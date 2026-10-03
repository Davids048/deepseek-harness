/** Verify file owners, index migration, writers and copies, upload validation, and deferred deletion in `AssetLibrary`. */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AssetLibrary, AssetNotFoundError, SCHEMA_VERSION, projectOwner, type AssetId } from '../src/library.ts'
import { MediaValidationError, UploadTooLargeError } from '../src/media.ts'
import {
  FFPROBE_ON_PATH, animatedImageBytes, fixturePath, imageBytes, temporaryDirectory, type TemporaryDirectory,
} from './support.ts'

const DECODE_MESSAGE = 'The image could not be decoded. Use PNG, JPEG, or WebP.'
const UNSUPPORTED_CONTENT_MESSAGE = 'Unsupported image content. Use PNG, JPEG, or WebP.'
const STILL_IMAGE_MESSAGE = 'Upload a still image, or upload the animation as a video.'

let temporary: TemporaryDirectory
let root: string
let library: AssetLibrary

beforeEach(() => {
  temporary = temporaryDirectory()
  root = path.join(temporary.directory, 'assets')
  library = new AssetLibrary(root)
})

afterEach(() => {
  library.close()
  temporary.cleanup()
})

/** The file names under `<root>/files`. */
function storedFiles(): string[] {
  return fs.readdirSync(path.join(root, 'files'))
}

describe('AssetLibrary persistence', () => {
  it('persists metadata and content across a restart', async () => {
    const content = await imageBytes('png')
    const asset = await library.add(content, 'portrait.png', 'image/png')
    expect(asset).toMatchObject({
      owner: 'library', mediaType: 'image', mimeType: 'image/png', width: 16, height: 12, durationSec: null,
    })
    expect(Number.isNaN(Date.parse(asset.createdAt))).toBe(false)
    expect(asset.assetId).toMatch(/^[0-9a-f]{32}$/u)
    expect(asset.filePath).toBe(path.join(root, 'files', asset.assetId))
    expect(asset.sizeBytes).toBe(content.byteLength)
    expect(fs.readFileSync(asset.filePath)).toEqual(content)
    library.close()
    const reopened = new AssetLibrary(root)
    expect(reopened.get(asset.assetId)).toEqual(asset)
    expect(reopened.list()).toEqual([asset])
    reopened.close()
    reopened.close()
  })

  it('creates a version 1 index with the owner column, its index, and no reference table', () => {
    library.close()
    const index = new DatabaseSync(path.join(root, 'index.sqlite3'))
    const columns = index.prepare('PRAGMA table_info(assets)').all().map(column => [column.name, column.type])
    const version = index.prepare('PRAGMA user_version').get()?.user_version
    const tables = index.prepare('SELECT name FROM sqlite_master WHERE type IN (\'table\', \'index\') ORDER BY name').all()
    index.close()
    library = new AssetLibrary(root)
    expect(columns).toEqual([
      ['asset_id', 'TEXT'], ['name', 'TEXT'], ['media_type', 'TEXT'], ['mime_type', 'TEXT'], ['size_bytes', 'INTEGER'],
      ['width', 'INTEGER'], ['height', 'INTEGER'], ['duration_sec', 'REAL'], ['deleted', 'INTEGER'],
      ['owner', 'TEXT'], ['created_at', 'TEXT'],
    ])
    expect(version).toBe(SCHEMA_VERSION)
    expect(tables.map(table => table.name)).toEqual(['assets', 'assets_owner', 'sqlite_autoindex_assets_1'])
  })

  it('lists assets newest first', async () => {
    const content = await imageBytes('png')
    const first = await library.add(content, 'first.png', 'image/png')
    const second = await library.add(content, 'second.png', 'image/png')
    const third = await library.add(content, 'third.png', 'image/png')
    expect(library.list()).toEqual([third, second, first])
    library.delete(second.assetId)
    expect(library.list()).toEqual([third, first])
  })

  it('reports an unavailable ID with the Python representation of the ID', () => {
    const unavailable = (assetId: string) => `Asset ${assetId} is unavailable. Select an asset from the library.`
    const get = (assetId: string) => library.get(brandString<AssetId>(assetId))
    expect(() => get('missing')).toThrow(new AssetNotFoundError(unavailable('\'missing\'')))
    expect(() => get('it\'s')).toThrow(unavailable('"it\'s"'))
    expect(() => get('both \' and "')).toThrow(unavailable('\'both \\\' and "\''))
    expect(() => get('tab\there\\ctl\x01\x7f')).toThrow(unavailable('\'tab\\there\\\\ctl\\x01\\x7f\''))
    expect(() => get('nbsp\xa0bom﻿é😀\ud800')).toThrow(unavailable('\'nbsp\\xa0bom\\ufeffé😀\\ud800\''))
  })
})

describe('AssetLibrary retention', () => {
  it('hides a deleted asset until every accepted request releases its file', async () => {
    const asset = await library.add(await imageBytes('png'), 'portrait.png', 'image/png')
    const firstRound = library.retain([asset.assetId])
    const secondRound = library.retain([asset.assetId])
    expect(firstRound).toEqual([asset])
    expect(secondRound).toEqual([asset])
    library.delete(asset.assetId)
    expect(library.list()).toEqual([])
    expect(() => library.retain([asset.assetId])).toThrow(AssetNotFoundError)
    expect(() => {
      library.delete(asset.assetId)
    }).toThrow(AssetNotFoundError)
    expect(fs.existsSync(asset.filePath)).toBe(true)
    library.release([asset.assetId])
    expect(fs.existsSync(asset.filePath)).toBe(true)
    library.release([asset.assetId])
    expect(fs.existsSync(asset.filePath)).toBe(false)
  })

  it('preserves request order and retains nothing when an ID is missing', async () => {
    const content = await imageBytes('png')
    const first = await library.add(content, 'first.png', 'image/png')
    const second = await library.add(content, 'second.png', 'image/png')
    expect(library.retain([second.assetId, first.assetId])).toEqual([second, first])
    library.release([second.assetId, first.assetId])
    expect(() => library.retain([first.assetId, brandString<AssetId>('missing')])).toThrow(AssetNotFoundError)
    library.delete(first.assetId)
    expect(fs.existsSync(first.filePath)).toBe(false)
    expect(fs.existsSync(second.filePath)).toBe(true)
  })

  it('rejects a release beyond the accepted retention without changing counts', async () => {
    const asset = await library.add(await imageBytes('png'), 'portrait.png', 'image/png')
    library.retain([asset.assetId])
    expect(() => {
      library.release([asset.assetId, asset.assetId])
    }).toThrow('Asset release must match an accepted retention.')
    library.delete(asset.assetId)
    expect(fs.existsSync(asset.filePath)).toBe(true)
    library.release([asset.assetId])
    expect(fs.existsSync(asset.filePath)).toBe(false)
    expect(() => {
      library.release([asset.assetId])
    }).toThrow('Asset release must match an accepted retention.')
  })

  it('finishes a persisted deletion when the next library opens', async () => {
    const asset = await library.add(await imageBytes('png'), 'portrait.png', 'image/png')
    library.retain([asset.assetId])
    library.delete(asset.assetId)
    library.close()
    expect(fs.existsSync(asset.filePath)).toBe(true)
    library = new AssetLibrary(root)
    expect(library.list()).toEqual([])
    expect(fs.existsSync(asset.filePath)).toBe(false)
  })
})

describe('AssetLibrary index migration', () => {
  it('migrates a version 0 index: files belong to the library, created_at is the file time, references are dropped', async () => {
    library.close()
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(path.join(root, 'files'), { recursive: true })
    const content = await imageBytes('png')
    fs.writeFileSync(path.join(root, 'files', 'old'), content)
    const mtime = new Date('2026-09-01T12:00:00.000Z')
    fs.utimesSync(path.join(root, 'files', 'old'), mtime, mtime)
    const index = new DatabaseSync(path.join(root, 'index.sqlite3'))
    index.exec(`CREATE TABLE assets (
                    asset_id TEXT PRIMARY KEY, name TEXT NOT NULL, media_type TEXT NOT NULL,
                    mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, width INTEGER,
                    height INTEGER, duration_sec REAL, deleted INTEGER NOT NULL DEFAULT 0)`)
    index.exec('CREATE TABLE asset_references (asset_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY (asset_id, project_id))')
    index.prepare('INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)').run('old', 'old.png', 'image', 'image/png', content.length, 16, 12, null)
    index.prepare('INSERT INTO asset_references VALUES (?, ?)').run('old', 'project-a')
    index.close()

    library = new AssetLibrary(root)
    expect(library.list()).toEqual([{
      assetId: 'old', owner: 'library', name: 'old.png', mediaType: 'image', mimeType: 'image/png',
      filePath: path.join(root, 'files', 'old'), sizeBytes: content.length, width: 16, height: 12, durationSec: null,
      createdAt: mtime.toISOString(),
    }])
    library.delete(brandString<AssetId>('old'))
    expect(fs.existsSync(path.join(root, 'files', 'old'))).toBe(false)
    library.close()
    const migrated = new DatabaseSync(path.join(root, 'index.sqlite3'))
    const tables = migrated.prepare('SELECT name FROM sqlite_master WHERE type = \'table\'').all().map(table => table.name)
    const version = migrated.prepare('PRAGMA user_version').get()?.user_version
    migrated.close()
    library = new AssetLibrary(root)
    expect([tables, version]).toEqual([['assets'], SCHEMA_VERSION])
  })

  it('refuses an index with a newer schema version and leaves it unchanged', () => {
    library.close()
    const indexPath = path.join(root, 'index.sqlite3')
    const index = new DatabaseSync(indexPath)
    index.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    index.close()
    expect(() => new AssetLibrary(root)).toThrow(
      `The asset index ${indexPath} has schema version ${SCHEMA_VERSION + 1}; this build reads version ${SCHEMA_VERSION}.`)
    const reopened = new DatabaseSync(indexPath)
    expect(reopened.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION + 1)
    reopened.close()
    fs.rmSync(root, { recursive: true, force: true })
    library = new AssetLibrary(root)
  })

  it('removes partial files left by a stopped application', () => {
    library.close()
    fs.writeFileSync(path.join(root, 'files', 'abc.partial'), 'unfinished')
    library = new AssetLibrary(root)
    expect(storedFiles()).toEqual([])
  })
})

describe('AssetLibrary owners', () => {
  it('lists each owner\'s files and deletes one owner\'s files, keeping a retained file until its release', async () => {
    const content = await imageBytes('png')
    const owner = projectOwner('p1')
    const libraryImage = await library.add(content, 'portrait.png', 'image/png')
    const first = await library.addBytes({ owner, name: 'frame-1.png', mimeType: 'image/png' }, content)
    const second = await library.addBytes({ owner, name: 'frame-2.png', mimeType: 'image/png' }, content)
    const other = await library.addBytes({ owner: projectOwner('p2'), name: 'frame.png', mimeType: 'image/png' }, content)
    expect(owner).toBe('project:p1')
    expect(library.list()).toEqual([libraryImage])
    expect(library.list(owner)).toEqual([second, first])

    library.retain([first.assetId])
    library.deleteOwnedBy(owner)
    expect(library.list(owner)).toEqual([])
    expect(() => library.get(first.assetId)).toThrow(AssetNotFoundError)
    expect([fs.existsSync(first.filePath), fs.existsSync(second.filePath)]).toEqual([true, false])
    library.release([first.assetId])
    expect(fs.existsSync(first.filePath)).toBe(false)
    expect(library.list(projectOwner('p2'))).toEqual([other])
    expect(library.list()).toEqual([libraryImage])
  })

  it('copies a file for another owner with a new ID, the same bytes and facts, and its own lifetime', async () => {
    const content = await imageBytes('png')
    const source = await library.add(content, 'portrait.png', 'image/png')
    const copy = await library.copy(source.assetId, projectOwner('p1'))
    expect(copy).toMatchObject({
      owner: 'project:p1', name: 'portrait.png', mediaType: 'image', mimeType: 'image/png', sizeBytes: content.length,
      width: 16, height: 12, durationSec: null,
    })
    expect(copy.assetId).not.toBe(source.assetId)
    expect(fs.readFileSync(copy.filePath)).toEqual(content)
    library.delete(source.assetId)
    expect(library.get(copy.assetId)).toEqual(copy)
    expect(fs.existsSync(copy.filePath)).toBe(true)
    await expect(library.copy(source.assetId, projectOwner('p2'))).rejects.toThrow(AssetNotFoundError)
  })
})

describe('AssetLibrary writers', () => {
  it('publishes a file written in pieces and leaves no partial file', async () => {
    const content = await imageBytes('png', 20, 10)
    const writer = library.createWriter({ owner: projectOwner('p1'), name: 'last/frame.png', mimeType: 'image/png' })
    await writer.write(content.subarray(0, 10))
    expect(storedFiles()).toEqual([`${writer.assetId}.partial`])
    await writer.write(content.subarray(10))
    const asset = await writer.commit()
    expect(asset).toMatchObject({
      assetId: writer.assetId, owner: 'project:p1', name: 'last_frame.png', mediaType: 'image', mimeType: 'image/png',
      sizeBytes: content.length, width: 20, height: 10, durationSec: null,
    })
    expect(storedFiles()).toEqual([writer.assetId])
    expect(fs.readFileSync(asset.filePath)).toEqual(content)
    await writer.abort()
    expect(library.get(asset.assetId)).toEqual(asset)
    await expect(writer.write(content)).rejects.toThrow(`The writer of asset ${writer.assetId} is committed.`)
  })

  it('removes the partial file when a writer is aborted', async () => {
    const writer = library.createWriter({ owner: projectOwner('p1'), name: 'clip.mp4', mimeType: 'video/mp4' })
    await writer.write(Buffer.from('partial video'))
    await writer.abort()
    await writer.abort()
    expect(storedFiles()).toEqual([])
    await expect(writer.commit()).rejects.toThrow(`The writer of asset ${writer.assetId} is aborted.`)
    expect(library.list(projectOwner('p1'))).toEqual([])
  })

  it('leaves no file when the written content does not decode, and rejects other MIME types up front', async () => {
    const writer = library.createWriter({ owner: projectOwner('p1'), name: 'frame.png', mimeType: 'image/png' })
    await writer.write(Buffer.from('not an image'))
    await expect(writer.commit()).rejects.toThrow(new MediaValidationError('The image could not be decoded.'))
    await expect(library.addBytes({ owner: projectOwner('p1'), name: 'empty.png', mimeType: 'image/png' }, Buffer.alloc(0)))
      .rejects.toThrow(new MediaValidationError('The file is empty.'))
    expect(() => library.createWriter({ owner: projectOwner('p1'), name: 'notes.txt', mimeType: 'text/plain' }))
      .toThrow(new MediaValidationError('Files must have an image, video, or audio MIME type; got "text/plain".'))
    expect(storedFiles()).toEqual([])
    expect(library.list(projectOwner('p1'))).toEqual([])
  })

  it.skipIf(!FFPROBE_ON_PATH)('reads a written video\'s facts without the upload limits and keeps its codecs MIME type', async () => {
    const mimeType = 'video/mp4; codecs="avc1.42C028, mp4a.40.2"'
    const content = fs.readFileSync(fixturePath('video-16x16-5.1.mp4'))
    const asset = await library.addBytes({ owner: projectOwner('p1'), name: 'segment.mp4', mimeType }, content)
    expect(asset).toMatchObject({ mediaType: 'video', mimeType, width: 16, height: 16, sizeBytes: content.length })
    expect(asset.durationSec).toBeGreaterThan(0)
  })
})

describe('AssetLibrary uploads', () => {
  it.each([
    ['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'],
  ] as const)('stores the %s MIME type detected from content for every declared image type', async (format, detected) => {
    const content = await imageBytes(format)
    const assets = []
    for (const declared of ['image/png', 'image/jpeg', 'image/webp']) {
      const asset = await library.add(content, 'portrait.jpg', declared)
      expect(asset).toMatchObject({ mediaType: 'image', mimeType: detected, name: 'portrait.jpg', width: 16, height: 12 })
      expect(fs.readFileSync(asset.filePath)).toEqual(content)
      assets.push(asset)
    }
    library.close()
    library = new AssetLibrary(root)
    expect(assets.map(asset => library.get(asset.assetId).mimeType)).toEqual([detected, detected, detected])
  })

  it.each([
    ['text that is not an image', async () => Buffer.from('not an image'), 'image/png', DECODE_MESSAGE],
    ['a GIF declared as JPEG', async () => await imageBytes('gif'), 'image/jpeg', UNSUPPORTED_CONTENT_MESSAGE],
    // `sharp` cannot read BMP, so this reports the decode message; Pillow reads BMP and reports unsupported content.
    ['a BMP declared as PNG', async () => fs.readFileSync(fixturePath('still.bmp')), 'image/png', DECODE_MESSAGE],
    ['a truncated JPEG', async () => (await imageBytes('jpeg')).subarray(0, -2), 'image/webp', DECODE_MESSAGE],
    ['an image declared as text', async () => await imageBytes('png'), 'text/plain',
      'Unsupported media type. Select an image, video, or audio format listed in Assets.'],
    ['an empty file', async () => Buffer.alloc(0), 'image/png', 'The uploaded file is empty.'],
    ['an animated PNG declared as JPEG', async () => fs.readFileSync(fixturePath('animated.png')), 'image/jpeg',
      STILL_IMAGE_MESSAGE],
    ['an animated WebP declared as PNG', async () => await animatedImageBytes('webp'), 'image/png', STILL_IMAGE_MESSAGE],
    ['an animated GIF declared as WebP', async () => await animatedImageBytes('gif'), 'image/webp',
      UNSUPPORTED_CONTENT_MESSAGE],
    ['a JPEG over the pixel limit declared as PNG', async () => await imageBytes('jpeg', 4097, 4096), 'image/png',
      'Images must contain at most 16777216 pixels.'],
  ])('rejects %s without publishing a file', async (_case, content, mimeType, message) => {
    const rejection = library.add(await content(), 'portrait', mimeType)
    await expect(rejection).rejects.toThrow(new MediaValidationError(message))
    await expect(rejection).rejects.toBeInstanceOf(MediaValidationError)
    expect(library.list()).toEqual([])
    expect(storedFiles()).toEqual([])
  })

  it('rejects an oversized upload before decoding it', async () => {
    const rejection = library.add(Buffer.alloc(15 * 1024 * 1024 + 1, 'x'), 'large.png', 'image/png')
    await expect(rejection).rejects.toThrow(new UploadTooLargeError('The image exceeds the 15728640 byte upload limit.'))
    await expect(rejection).rejects.toBeInstanceOf(UploadTooLargeError)
    const atLimit = library.add(Buffer.alloc(15 * 1024 * 1024, 'x'), 'large.png', 'image/png')
    await expect(atLimit).rejects.toThrow(DECODE_MESSAGE)
    expect(library.list()).toEqual([])
    expect(storedFiles()).toEqual([])
  })

  it('removes the copied file when publishing fails after validation', async () => {
    library.close()
    await expect(library.add(await imageBytes('png'), 'portrait.png', 'image/png')).rejects.toThrow()
    expect(storedFiles()).toEqual([])
  })

  it.each([
    [' 　 a/b\\c\td\x7fe \x85', 'a_b_c_d_e'],
    ['﻿name', '﻿name'],
    ['', 'Untitled asset'],
    ['   ', 'Untitled asset'],
    ['\n', '_'],
    [`${'a'.repeat(199)} b`, `${'a'.repeat(199)} `],
    ['😀'.repeat(250), '😀'.repeat(200)],
  ])('stores the reference display name for %j', async (name, displayName) => {
    const asset = await library.add(await imageBytes('png'), name, 'image/png')
    expect(asset.name).toBe(displayName)
  })
})
