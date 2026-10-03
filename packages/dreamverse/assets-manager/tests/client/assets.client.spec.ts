/** @vitest-environment jsdom */
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteAsset, listAssets, resolveReferenceAssetIds, type AssetId, type ReferenceDraft } from '../../src/client/assets.ts'
import { imageAsset } from './assetFixtures.client.ts'

afterEach(() => vi.unstubAllGlobals())

describe('request attachment uploads', () => {
  it('reuses saved IDs and preserves request order across local uploads', async () => {
    const file = new File(['png'], 'side.png', { type: 'image/png' })
    const uploaded = imageAsset('side.png')
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(uploaded)))
    vi.stubGlobal('fetch', fetchMock)
    const draft: ReferenceDraft[] = [{ draftId: 'saved', kind: 'savedAsset', asset: imageAsset('front.png') }, { draftId: 'local', kind: 'localFile', file }]
    const onUploaded = vi.fn()
    expect(await resolveReferenceAssetIds(draft, onUploaded)).toEqual(['asset-front.png', 'asset-side.png'])
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/assets', expect.objectContaining({ method: 'POST' }))
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeInstanceOf(FormData)
    expect(onUploaded).toHaveBeenCalledWith(draft[1], uploaded)
  })

  it('reports each completed upload before a later failure and preserves server errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(imageAsset()))).mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Video exceeds duration limit' }), { status: 422 })))
    const draft: ReferenceDraft[] = ['one', 'two'].map(draftId => ({ draftId, kind: 'localFile', file: new File(['png'], `${draftId}.png`) }))
    const uploaded = vi.fn()
    await expect(resolveReferenceAssetIds(draft, uploaded)).rejects.toThrow('Video exceeds duration limit')
    expect(uploaded).toHaveBeenCalledTimes(1)
  })

  it('reads library records that also carry the server\'s owner and creation time', async () => {
    const record = { ...imageAsset('front.png'), owner: 'library', created_at: '2026-10-02T00:00:00.000Z' }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ assets: [record] }))))
    expect(await listAssets()).toEqual([imageAsset('front.png')])
  })

  it('deletes without reading a body from a 204 response', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await deleteAsset(brandString<AssetId>('picture'))
    expect(fetchMock).toHaveBeenCalledWith('/assets/picture', { method: 'DELETE' })
  })
})
