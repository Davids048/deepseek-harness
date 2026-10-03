import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId, AssetRecord, AssetUploadPolicy } from '@dreamverse/assets-manager/client/assets.ts'
import { vi } from 'vitest'

export const assetUploadPolicy: AssetUploadPolicy = {
  image: { mime_types: ['image/png', 'image/jpeg', 'image/webp'], extensions: ['.png', '.jpg', '.jpeg', '.webp'], max_bytes: 15 * 1024 * 1024, max_pixels: 16777216 },
  video: { mime_types: ['video/mp4', 'video/quicktime', 'video/webm'], extensions: ['.mp4', '.mov', '.webm'], max_bytes: 100 * 1024 * 1024, max_duration_sec: 30 },
  audio: { mime_types: ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/flac', 'audio/ogg', 'audio/webm'], extensions: ['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.webm'], max_bytes: 100 * 1024 * 1024, max_duration_sec: 30 },
}

export function imageAsset(name = 'subject.png'): AssetRecord {
  return { asset_id: brandString<AssetId>(`asset-${name}`), name, media_type: 'image', mime_type: 'image/png', size_bytes: 3,
    width: 32, height: 32, duration_sec: null, content_url: `/assets/asset-${name}/content` }
}
/** Give sortable thumbnails two-column geometry because jsdom does not calculate layout. */
export function mockReferenceImageLayout() {
  // oxlint-disable-next-line typescript/unbound-method -- The fallback calls the jsdom method with the measured element.
  const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const card = this.closest('li')
    const list = card?.parentElement
    if (!card || list?.getAttribute('aria-label') !== 'Selected reference images') return getBoundingClientRect.call(this)
    const index = Array.from(list.children).indexOf(card)
    return new DOMRect((index % 2) * 140, Math.floor(index / 2) * 200, 130, 190)
  })
}
