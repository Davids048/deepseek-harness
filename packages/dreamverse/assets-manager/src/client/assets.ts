/** Persistent media records and ordered, request-local attachment drafts. */
export type MediaType = 'image' | 'video' | 'audio'

export interface AssetRecord {
  asset_id: string
  name: string
  media_type: MediaType
  mime_type: string
  size_bytes: number
  width: number | null
  height: number | null
  duration_sec: number | null
  content_url: string
}

export interface MediaUploadPolicy {
  mime_types: string[]
  extensions: string[]
  max_bytes: number
  max_pixels?: number
  max_duration_sec?: number
  max_channels?: number
}

export type AssetUploadPolicy = Record<MediaType, MediaUploadPolicy>
export type ReferenceDraft =
	| { draftId: string; kind: 'localFile'; file: File }
	| { draftId: string; kind: 'savedAsset'; asset: AssetRecord }

/** Whether a decoded JSON value is an object whose fields can be read by name. */
function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is one of the asset media types. */
function isMediaType(value: unknown): value is MediaType {
  return value === 'image' || value === 'video' || value === 'audio'
}

/** Whether a value is a number or `null`. */
function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === 'number'
}

/** Decode one asset record from the `/assets` API; a missing or mistyped field rejects the record. */
function parseAssetRecord(value: unknown): AssetRecord | null {
  if (!isJsonObject(value)) return null
  const mediaType = value.media_type
  if (typeof value.asset_id !== 'string' || typeof value.name !== 'string' || !isMediaType(mediaType)
    || typeof value.mime_type !== 'string' || typeof value.size_bytes !== 'number'
    || !isNumberOrNull(value.width) || !isNumberOrNull(value.height) || !isNumberOrNull(value.duration_sec)
    || typeof value.content_url !== 'string') return null
  return {
    asset_id: value.asset_id,
    name: value.name,
    media_type: mediaType,
    mime_type: value.mime_type,
    size_bytes: value.size_bytes,
    width: value.width,
    height: value.height,
    duration_sec: value.duration_sec,
    content_url: value.content_url,
  }
}

/** Read server validation errors without discarding their useful explanation. */
async function requireSuccess(response: Response): Promise<void> {
  if (response.ok) return
  const payload: unknown = await response.json().catch(() => null)
  throw new Error(isJsonObject(payload) && typeof payload.detail === 'string'
    ? payload.detail
    : `Asset request failed (${response.status}).`)
}

/**
 * List the asset library.
 * @returns the library's records in the server's order.
 * @throws when the request fails or the response is not an asset list.
 */
export async function listAssets(): Promise<AssetRecord[]> {
  const response = await fetch('/assets')
  await requireSuccess(response)
  const body: unknown = await response.json()
  if (!isJsonObject(body) || !Array.isArray(body.assets)) throw new Error('The asset list response is invalid.')
  return body.assets.map((entry: unknown) => {
    const record = parseAssetRecord(entry)
    if (!record) throw new Error('The asset list response contains an invalid asset record.')
    return record
  })
}

/**
 * Upload one file to the asset library.
 * @param file - the file to upload.
 * @returns the stored asset's record.
 * @throws when the server rejects the file or the response is not an asset record.
 */
export async function uploadAsset(file: File): Promise<AssetRecord> {
  const body = new FormData()
  body.append('file', file)
  const response = await fetch('/assets', { method: 'POST', body })
  await requireSuccess(response)
  const record = parseAssetRecord(await response.json())
  if (!record) throw new Error('The asset upload response is not an asset record.')
  return record
}

/**
 * Delete one asset from the library.
 * @param assetId - the asset to delete.
 * @throws when the server rejects the deletion.
 */
export async function deleteAsset(assetId: string): Promise<void> {
  const response = await fetch(`/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' })
  await requireSuccess(response)
}

/** Upload a fixed ordered selection; successful files remain reusable if a later upload fails. */
export async function resolveReferenceAssetIds(
  draft: readonly ReferenceDraft[],
  onUploaded: (reference: Extract<ReferenceDraft, { kind: 'localFile' }>, asset: AssetRecord) => void,
): Promise<string[]> {
  const ids: string[] = []
  for (const reference of draft) {
    if (reference.kind === 'savedAsset') {
      ids.push(reference.asset.asset_id)
      continue
    }
    const asset = await uploadAsset(reference.file)
    onUploaded(reference, asset)
    ids.push(asset.asset_id)
  }
  return ids
}
