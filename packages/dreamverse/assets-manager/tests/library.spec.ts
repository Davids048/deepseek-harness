/** Verify persistent media ownership, upload validation, and deferred deletion in `AssetLibrary`. */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AssetInUseError, AssetLibrary, AssetNotFoundError } from '../src/library.ts'
import { MediaValidationError, UploadTooLargeError } from '../src/media.ts'
import {
  animatedImageBytes, fixturePath, imageBytes, temporaryDirectory, type TemporaryDirectory,
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
    expect(asset).toMatchObject({ mediaType: 'image', mimeType: 'image/png', width: 16, height: 12, durationSec: null })
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

  it('creates the reference assets table', () => {
    library.close()
    const index = new DatabaseSync(path.join(root, 'index.sqlite3'))
    const columns = index.prepare('PRAGMA table_info(assets)').all().map(column => [column.name, column.type])
    index.close()
    library = new AssetLibrary(root)
    expect(columns).toEqual([
      ['asset_id', 'TEXT'], ['name', 'TEXT'], ['media_type', 'TEXT'], ['mime_type', 'TEXT'], ['size_bytes', 'INTEGER'],
      ['width', 'INTEGER'], ['height', 'INTEGER'], ['duration_sec', 'REAL'], ['deleted', 'INTEGER'],
    ])
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
    expect(() => library.get('missing')).toThrow(new AssetNotFoundError(unavailable('\'missing\'')))
    expect(() => library.get('it\'s')).toThrow(unavailable('"it\'s"'))
    expect(() => library.get('both \' and "')).toThrow(unavailable('\'both \\\' and "\''))
    expect(() => library.get('tab\there\\ctl\x01\x7f')).toThrow(unavailable('\'tab\\there\\\\ctl\\x01\\x7f\''))
    expect(() => library.get('nbsp\xa0bom﻿é😀\ud800')).toThrow(unavailable('\'nbsp\\xa0bom\\ufeffé😀\\ud800\''))
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
    expect(() => library.retain([first.assetId, 'missing'])).toThrow(AssetNotFoundError)
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

describe('AssetLibrary project references', () => {
  it('refuses to delete an asset while stored projects use it, across a restart', async () => {
    const asset = await library.add(await imageBytes('png'), 'portrait.png', 'image/png')
    library.addProjectReferences('project-a', [asset.assetId])
    library.addProjectReferences('project-b', [asset.assetId])
    library.addProjectReferences('project-a', [asset.assetId])
    expect(() => { library.delete(asset.assetId) }).toThrow(new AssetInUseError(2))
    expect(new AssetInUseError(2).message).toBe('This image is used by 2 project(s). Delete those projects first.')
    library.close()
    library = new AssetLibrary(root)
    library.removeProjectReferences('project-a')
    expect(() => { library.delete(asset.assetId) }).toThrow(new AssetInUseError(1))
    expect(library.list()).toEqual([asset])
    expect(fs.existsSync(asset.filePath)).toBe(true)
    library.removeProjectReferences('project-b')
    library.delete(asset.assetId)
    expect(library.list()).toEqual([])
    expect(fs.existsSync(asset.filePath)).toBe(false)
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
