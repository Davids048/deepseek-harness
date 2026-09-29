/** Verify the `dreamverseAssetsManager` Config, plugin lifecycle, and delegation to the asset library. */
import path from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DreamverseAssetsManager, { AssetNotFoundError, Config } from '../src/index.ts'
import { AssetLibrary } from '../src/library.ts'
import { uploadPolicy } from '../src/media.ts'
import { imageBytes, temporaryDirectory, type TemporaryDirectory } from './support.ts'

let temporary: TemporaryDirectory

beforeEach(() => {
  temporary = temporaryDirectory()
})

afterEach(() => {
  vi.restoreAllMocks()
  temporary.cleanup()
})

describe('Config', () => {
  it('requires the library root', () => {
    expect(Config({ root: '/state/assets' })).toEqual({ root: '/state/assets' })
    expect(() => Config({})).toThrow()
  })
})

describe('DreamverseAssetsManager', () => {
  it('opens the library while mounted and closes it on dispose', async () => {
    const close = vi.spyOn(AssetLibrary.prototype, 'close')
    const root = path.join(temporary.directory, 'assets')
    const ctx = new Context()
    const fiber = await ctx.plugin(DreamverseAssetsManager, Config({ root }))
    const assets = ctx.dreamverseAssetsManager
    const asset = await assets.add(await imageBytes('png'), 'portrait.png', 'image/png')
    expect(assets.list()).toEqual([asset])
    expect(assets.get(asset.assetId)).toEqual(asset)
    expect(assets.retain([asset.assetId])).toEqual([asset])
    assets.delete(asset.assetId)
    expect(() => assets.get(asset.assetId)).toThrow(AssetNotFoundError)
    assets.release([asset.assetId])
    expect(assets.uploadPolicy()).toEqual(uploadPolicy())
    expect(close).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(close).toHaveBeenCalledTimes(1)
    expect(ctx.get('dreamverseAssetsManager')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps published assets for the next plugin instance on the same root', async () => {
    const root = path.join(temporary.directory, 'assets')
    const ctx = new Context()
    const first = await ctx.plugin(DreamverseAssetsManager, Config({ root }))
    const asset = await ctx.dreamverseAssetsManager.add(await imageBytes('webp'), 'portrait.webp', 'image/webp')
    await first.dispose()
    const second = await ctx.plugin(DreamverseAssetsManager, Config({ root }))
    expect(ctx.dreamverseAssetsManager.list()).toEqual([asset])
    await second.dispose()
    await ctx.fiber.dispose()
  })
})
