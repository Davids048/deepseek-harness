/** @vitest-environment jsdom */
import '../../kit/tests/support/setup.client.ts'
import { useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import AssetLibrary from '../src/client/components/assets/AssetLibrary.tsx'
import { en } from '../src/client/locales.ts'
import type { AssetRecord } from '@dreamverse/assets-manager/client/assets.ts'
import { assetUploadPolicy, imageAsset } from '../../kit/tests/support/assetFixtures.client.ts'

const t = makeTranslate(en)

function Library({ onSelect, onDeleted }: { onSelect: (asset: AssetRecord) => void; onDeleted: (id: string) => void }) {
  const [assets, setAssets] = useState<AssetRecord[]>([])
  return (
    <AssetLibrary
      open
      assets={assets}
      onAssetsChange={setAssets}
      uploadPolicy={assetUploadPolicy}
      onClose={() => {}}
      onSelect={onSelect}
      onDeleted={onDeleted}
      canSelect
      t={t}
    />
  )
}

afterEach(() => vi.unstubAllGlobals())

it.each(['Escape', 'backdrop', 'Close'])('dismisses the asset library with %s and returns focus to its opener', async (dismissal) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ assets: [] }))))
  const user = userEvent.setup()
  /** Keep the library mounted while opening and closing its dialog. */
  function DismissibleLibrary() {
    const [open, setOpen] = useState(false)
    const [assets, setAssets] = useState<AssetRecord[]>([])
    return <>
      <button type="button" onClick={() => { setOpen(true) }}>Open assets</button>
      <AssetLibrary open={open} assets={assets} onAssetsChange={setAssets} uploadPolicy={assetUploadPolicy}
        onClose={() => { setOpen(false) }} onSelect={() => {}} onDeleted={() => {}} canSelect t={t} />
    </>
  }
  render(<DismissibleLibrary />)
  const opener = screen.getByRole('button', { name: 'Open assets' })
  await user.click(opener)
  const dialog = screen.getByRole('dialog', { name: 'Asset library' })
  await user.click(screen.getByText('No saved assets.'))
  expect(dialog).toBeVisible()
  if (dismissal === 'Escape') await user.keyboard('{Escape}')
  else if (dismissal === 'backdrop') {
    const backdrop = dialog.parentElement
    if (!backdrop) throw new Error('Expected the asset library dialog to have a backdrop')
    await user.click(backdrop)
  } else await user.click(screen.getByRole('button', { name: 'Close asset library' }))
  expect(screen.queryByRole('dialog', { name: 'Asset library' })).not.toBeInTheDocument()
  await waitFor(() => expect(opener).toHaveFocus())
  await user.click(opener)
  expect(screen.getByRole('dialog', { name: 'Asset library' })).toBeVisible()
})

it('uploads library media immediately and separates image selection from deletion', async () => {
  const asset = imageAsset()
  let uploadedOnServer = false
  let deletedOnServer = false
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { uploadedOnServer = true; return new Response(JSON.stringify(asset)) }
    if (init?.method === 'DELETE') { deletedOnServer = true; return new Response(null, { status: 204 }) }
    return new Response(JSON.stringify({ assets: deletedOnServer ? [{ ...imageAsset('music'), media_type: 'audio' }] : uploadedOnServer ? [asset, { ...imageAsset('music'), media_type: 'audio' }] : [{ ...imageAsset('music'), media_type: 'audio' }] }))
  })
  vi.stubGlobal('fetch', fetchMock)
  const select = vi.fn()
  const deleted = vi.fn()
  const user = userEvent.setup()
  render(<Library onSelect={select} onDeleted={deleted} />)
  expect(await screen.findByLabelText('Use music')).toBeDisabled()
  await user.upload(screen.getByLabelText('Upload assets'), new File(['png'], 'subject.png', { type: 'image/png' }))
  await user.click(await screen.findByLabelText('Use subject.png'))
  expect(select).toHaveBeenCalledWith(asset)
  expect(deleted).not.toHaveBeenCalled()
  await user.click(screen.getByLabelText('Delete subject.png'))
  await waitFor(() => { expect(deleted).toHaveBeenCalledWith(asset.asset_id) })
  expect(screen.queryByText('subject.png')).not.toBeInTheDocument()
})

it('retains an uploaded asset when an earlier library refresh finishes afterward', async () => {
  const { promise: listing, resolve: finishList } = Promise.withResolvers<Response>()
  let listingCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response(JSON.stringify(imageAsset()))
    return listingCalls++ === 0 ? listing : new Response(JSON.stringify({ assets: [imageAsset(), imageAsset('saved.png')] }))
  }))
  const user = userEvent.setup()
  render(<Library onSelect={vi.fn()} onDeleted={vi.fn()} />)
  await user.upload(screen.getByLabelText('Upload assets'), new File(['png'], 'subject.png', { type: 'image/png' }))
  await screen.findByLabelText('Use subject.png')
  await act(async () => { finishList(new Response(JSON.stringify({ assets: [] }))) })
  expect(screen.getByLabelText('Use subject.png')).toBeEnabled()
  expect(await screen.findByLabelText('Use saved.png')).toBeEnabled()
})

it('keeps a deleted asset hidden when a refresh contains its earlier record', async () => {
  const { promise: listing, resolve: finishList } = Promise.withResolvers<Response>()
  let listingCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    return listingCalls++ === 0 ? listing : new Response(JSON.stringify({ assets: [] }))
  }))
  /** Hold a cached record while the server refresh and a user deletion race. */
  function CachedLibrary() {
    const [assets, setAssets] = useState([imageAsset()])
    return (
      <AssetLibrary
        open
        assets={assets}
        onAssetsChange={setAssets}
        uploadPolicy={assetUploadPolicy}
        onClose={() => {}}
        onSelect={() => {}}
        onDeleted={() => {}}
        canSelect
        t={t}
      />
    )
  }
  const user = userEvent.setup()
  render(<CachedLibrary />)
  await user.click(screen.getByLabelText('Delete subject.png'))
  await waitFor(() => expect(screen.queryByLabelText('Use subject.png')).not.toBeInTheDocument())
  await act(async () => { finishList(new Response(JSON.stringify({ assets: [imageAsset()] }))) })
  expect(screen.queryByLabelText('Use subject.png')).not.toBeInTheDocument()
})
