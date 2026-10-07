/** The images of a sent chat message join the open project's canvas list under their SHA-256 asset IDs. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import { DvClient } from '@dv/ui-kit/api.ts'
import { placeSubmittedImages } from '../src/client/attachments.ts'

afterEach(() => { vi.unstubAllGlobals() })

/**
 * A submission echo with the given preview URLs.
 * @param requestId - the prompt RPC identity.
 * @param urls - image preview URLs, in prompt order.
 * @returns the echo.
 */
function submission(requestId: string, urls: string[]): PendingSubmission {
  return {
    requestId: requestId as PendingSubmission['requestId'], placement: 'transcript', time: 0, text: '',
    attachments: urls.map(previewUrl => ({ type: 'image' as const, value: { previewUrl } })),
  }
}

describe('placeSubmittedImages', () => {
  it('places each sent image once under the SHA-256 hex of its bytes', async () => {
    const images: Record<string, string> = { 'blob:a': 'image-a', 'blob:b': 'image-b' }
    const placed: unknown[] = []
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      const image = images[input]
      if (image !== undefined) return Promise.resolve(new Response(image))
      placed.push(JSON.parse(String(init?.body)))
      return Promise.resolve(new Response('{}'))
    })
    const handled = new Set<string>()
    const client = new DvClient()
    const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
    await placeSubmittedImages([submission('r1', ['blob:a', 'blob:b'])], handled, 'p1', client)
    // A later snapshot that still holds r1 places only the new submission; one without images places nothing.
    await placeSubmittedImages([submission('r1', ['blob:a', 'blob:b']), submission('r2', []), submission('r3', ['blob:b'])], handled, 'p1', client)
    expect(placed).toEqual([{ project: 'p1', placed: [hash('image-a'), hash('image-b')] }, { project: 'p1', placed: [hash('image-b')] }])
  })
})
