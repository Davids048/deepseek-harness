import { useEffect, useRef, useState } from 'react'
import { Dialog } from 'radix-ui'
import AssetPreview from '@dreamverse/ui-kit/components/assets/AssetPreview.tsx'
import { assetErrorText } from '@dreamverse/ui-kit/problemText.ts'
import { deleteAsset, listAssets, uploadAsset, type AssetId, type AssetRecord } from '@dreamverse/assets-manager/client/assets.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssetLibraryProps } from '@dreamverse/ui-kit/contracts.ts'
import type {} from '../../locales.ts'

type Props = AssetLibraryProps & { t: TranslateNS<'dreamverse.assets'> }

/** Browse persistent media independently of the ordered attachments selected for generation. */
export default function AssetLibrary({ open, assets, onAssetsChange, uploadPolicy, onClose, onSelect, onDeleted, canSelect, t }: Props) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const refreshedAssets = useRef<AssetRecord[] | null>(null)
  useEffect(() => {
    if (!open) { refreshedAssets.current = null; return }
    if (refreshedAssets.current === assets) return
    let cancelled = false
    setError('')
    void listAssets().then((records) => {
      // A cache mutation cancels this refresh and starts a list request after the mutation.
      if (!cancelled) {
        refreshedAssets.current = records
        onAssetsChange(stored => stored === assets ? records : stored)
      }
    }).catch((failure: unknown) => { if (!cancelled) setError(assetErrorText(failure, '', t)) })
    return () => { cancelled = true }
  }, [open, assets, onAssetsChange])
  /** Save library uploads immediately, retaining earlier successes after a later validation failure. */
  async function upload(files: File[]) {
    setBusy(true)
    setError('')
    try {
      for (const file of files) {
        const asset = await uploadAsset(file)
        onAssetsChange(stored => [asset, ...stored.filter(entry => entry.asset_id !== asset.asset_id)])
      }
    } catch (failure) {
      setError(assetErrorText(failure, t('upload.failed'), t))
    } finally {
      setBusy(false)
    }
  }
  /** Remove future access to a saved asset while accepted generation requests retain their inputs. */
  async function remove(assetId: AssetId) {
    setError('')
    try {
      await deleteAsset(assetId)
      onAssetsChange(stored => stored.filter(asset => asset.asset_id !== assetId))
      onDeleted(assetId)
    } catch (failure) {
      setError(assetErrorText(failure, t('delete.failed'), t))
    }
  }
  if (!open) return null
  return (
    <Dialog.Root open onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/50 p-3 sm:p-8">
          <Dialog.Content aria-label={t('dialog.label')} aria-labelledby={undefined} aria-describedby={undefined}
            className="mx-auto flex max-h-full max-w-4xl flex-col gap-4 overflow-y-auto rounded-2xl bg-card p-4 outline-none sm:p-6"
            onOpenAutoFocus={() => {
              // The library opens from several controls rather than a single Dialog.Trigger.
              returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
            }}
            onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus.current?.focus() }}>
            <div className="flex items-center justify-between"><Dialog.Title className="text-lg font-semibold">{t('title')}</Dialog.Title><Dialog.Close asChild><button type="button" aria-label={t('close.label')}>{t('close')}</button></Dialog.Close></div>
            <p className="text-sm text-muted-foreground">{t('description')}</p>
            <input ref={inputRef} type="file" multiple aria-label={t('upload.label')} className="sr-only"
              accept={uploadPolicy ? Object.values(uploadPolicy).flatMap(policy => [...policy.mime_types, ...policy.extensions]).join(',') : ''}
              onChange={(event) => { void upload(Array.from(event.target.files ?? [])); event.target.value = '' }} />
            <button type="button" disabled={busy || !uploadPolicy} onClick={() => inputRef.current?.click()} className="self-start rounded-lg border border-border px-3 py-2">{busy ? t('uploading') : t('upload')}</button>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {assets.length === 0 && <p>{t('empty')}</p>}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {assets.map(asset => <article key={asset.asset_id} className="min-w-0 space-y-2 rounded-xl border border-border p-3">
                <AssetPreview source={asset} labels={{ unsupported: name => t('preview.unsupported', { name }) }} />
                <p className="truncate text-sm" title={asset.name}>{asset.name}</p>
                <div className="flex justify-between gap-2 text-sm">
                  <button type="button" className="disabled:opacity-40" disabled={!canSelect || asset.media_type !== 'image'} onClick={() => { onSelect(asset) }} aria-label={t('use.label', { name: asset.name })}>{t('use')}</button>
                  <button type="button" onClick={() => void remove(asset.asset_id)} aria-label={t('delete.label', { name: asset.name })}>{t('delete')}</button>
                </div>
              </article>)}
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
