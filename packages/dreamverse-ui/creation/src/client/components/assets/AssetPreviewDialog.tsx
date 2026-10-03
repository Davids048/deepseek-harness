import { useRef } from 'react'
import { Dialog } from 'radix-ui'
import { X } from 'lucide-react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import AssetPreview from '@dreamverse/ui-kit/components/assets/AssetPreview.tsx'
import type { AssetRecord } from '@dreamverse/assets-manager/client/assets.ts'

/** Show local or saved media in a dismissible, full-size preview with keyboard focus contained inside. */
export default function AssetPreviewDialog({ source, onClose, t }: {
  source: File | AssetRecord
  onClose: () => void
  t: TranslateNS<'dreamverse.creation'>
}) {
  const returnFocus = useRef<HTMLElement | null>(null)
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/75 backdrop-blur-sm" />
        <Dialog.Content aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[80] w-[calc(100%-2rem)] max-w-5xl -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl outline-none"
          onOpenAutoFocus={() => {
            // The picker opens this dialog without a Dialog.Trigger; remember its focused thumbnail.
            returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          }}
          onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus.current?.focus() }}>
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Dialog.Title className="min-w-0 flex-1 truncate text-sm font-medium">{source.name}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label={t('preview.close')} className="flex size-9 shrink-0 items-center justify-center rounded-lg hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <X className="size-5" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <div className="p-4">
            <AssetPreview source={source} className="h-auto max-h-[calc(100dvh-10rem)] object-contain"
              labels={{ unsupported: name => t('preview.unsupported', { name }) }} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
