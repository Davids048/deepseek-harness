import { useEffect, useState } from 'react'
import type { AssetRecord, MediaType } from '@dreamverse/assets-manager/client/assets.ts'
import { cn } from '../../utils.ts'

/** Localized copy of {@link AssetPreview}, supplied by the package that renders the preview. */
export interface AssetPreviewLabels {
  /** Alert shown when the browser cannot play or decode the media; receives the file name. */
  unsupported: (name: string) => string
}

/** Display stored or local media and release the preview URL when its file leaves the UI. */
export default function AssetPreview({ source, className, labels }: {
  source: File | AssetRecord
  className?: string
  labels: AssetPreviewLabels
}) {
  const [localUrl, setLocalUrl] = useState('')
  const [failed, setFailed] = useState(false)
  const local = source instanceof File
  const mediaType = local ? source.type.split('/')[0] as MediaType : source.media_type
  const url = local ? localUrl : source.content_url
  useEffect(() => {
    setFailed(false)
    if (!(source instanceof File)) return
    const objectUrl = URL.createObjectURL(source)
    setLocalUrl(objectUrl)
    return () => { URL.revokeObjectURL(objectUrl) }
  }, [source])
  if (failed) return <p role="alert">{labels.unsupported(source.name)}</p>
  if (!url) return null
  if (mediaType === 'image') return <img src={url} alt={source.name} onError={() => { setFailed(true) }} className={cn('h-32 w-full rounded-lg object-contain', className)} />
  if (mediaType === 'video') return <video src={url} aria-label={source.name} controls preload="metadata" onError={() => { setFailed(true) }} className={cn('h-40 w-full rounded-lg', className)} />
  return <audio src={url} aria-label={source.name} controls preload="metadata" onError={() => { setFailed(true) }} className={cn('w-full', className)} />
}
