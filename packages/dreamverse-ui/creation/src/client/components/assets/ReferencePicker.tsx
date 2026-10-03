import { useRef, useState } from 'react'
import { ImagePlus, Library } from 'lucide-react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import ReferenceImageGrid from './ReferenceImageGrid.tsx'
import AssetPreviewDialog from './AssetPreviewDialog.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@dreamverse/ui-kit/components/ui/popover.tsx'
import type { ReferencePickerProps } from '@dreamverse/ui-kit/contracts.ts'

export type { ReferencePickerProps }

/** Why the last file selection was refused; the alert translates it when it renders. */
type SelectionError = 'tooMany' | 'unsupported' | null

/** Show selected reference thumbnails in the composer and choose image sources from the add button. */
export default function ReferencePicker({
  references, onReferencesChange, onOpenAssets, accept, maxCount, maxBytes, t,
}: ReferencePickerProps & { t: TranslateNS<'dreamverse.creation'> }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<SelectionError>(null)
  const [previewReferenceId, setPreviewReferenceId] = useState<string | null>(null)
  const previewReference = references.find(reference => reference.draftId === previewReferenceId)
  /** Stage files for this request without uploading or changing persisted library records. */
  function selectFiles(files: File[]) {
    if (files.length === 0) return
    if (references.length + files.length > maxCount) {
      setError('tooMany')
      setOpen(true)
      return
    }
    if (files.some(file => !accept.split(',').includes(file.type) || file.size > maxBytes)) {
      setError('unsupported')
      setOpen(true)
      return
    }
    setError(null)
    setOpen(false)
    onReferencesChange([...references, ...files.map(file => ({ draftId: randomUUID(), kind: 'localFile' as const, file }))])
  }
  return (
    <div aria-label={t('references.label')} className={references.length > 0 ? 'flex w-full items-start gap-2 pb-2' : 'shrink-0'}
      onDragOver={(event) => { event.preventDefault() }}
      onDrop={(event) => { event.preventDefault(); selectFiles(Array.from(event.dataTransfer.files)) }}>
      <input ref={inputRef} type="file" multiple accept={accept} aria-label={t('references.add')} className="sr-only"
        onChange={(event) => { selectFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
      {references.length > 0 && (
        <ReferenceImageGrid references={references} onReferencesChange={onReferencesChange} onPreview={setPreviewReferenceId} t={t} />
      )}
      {previewReference && <AssetPreviewDialog source={previewReference.kind === 'localFile' ? previewReference.file : previewReference.asset}
        onClose={() => { setPreviewReferenceId(null) }} t={t} />}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={t('references.addButton')} title={t('references.add')}
            className={`flex w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${references.length > 0 ? 'h-16' : 'h-12'}`}>
            <ImagePlus className="size-4" aria-hidden="true" />
            <span className="text-[10px] leading-none">{references.length > 0 ? t('references.addShort') : t('references.reference')}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" aria-label={t('references.options')} className="max-h-[min(28rem,var(--radix-popover-content-available-height))] overflow-y-auto"
          onInteractOutside={(event) => {
            // The native file chooser returns focus to the input outside this popup.
            if (event.target === inputRef.current) event.preventDefault()
          }}>
          <div className="space-y-1">
            <button type="button" onClick={() => inputRef.current?.click()} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-muted focus-visible:bg-muted">
              <ImagePlus className="size-4" aria-hidden="true" /> {t('references.addImage')}
            </button>
            <button type="button" onClick={() => { setOpen(false); onOpenAssets() }} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-muted focus-visible:bg-muted">
              <Library className="size-4" aria-hidden="true" /> {t('references.fromAssets')}
            </button>
          </div>
          {error !== null && <p role="alert" className="mt-2 text-sm text-destructive">
            {error === 'tooMany'
              ? t('references.error.tooMany', { count: maxCount })
              : t('references.error.unsupported', { size: Math.round(maxBytes / 1024 / 1024) })}
          </p>}
        </PopoverContent>
      </Popover>
    </div>
  )
}
