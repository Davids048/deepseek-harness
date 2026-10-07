/**
 * The images a user sends in a chat message join the open project's canvas list. `@dv/chat-references` imports each
 * sent image into the project's asset pool, and an asset ID is the SHA-256 hex of the asset's bytes, so the browser
 * computes the same ID from the image it sends and places it with `DvClient.placeAssets` before the import finishes;
 * the canvas draws the node once the import record exists.
 *
 * @module @dv/ui-composer/attachments
 */
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import type { DvClient } from '@dv/ui-kit/api.ts'

/**
 * The asset ID of an image: the SHA-256 hex of its bytes.
 * @param url - a browser URL of the image, such as the preview URL of a chat attachment.
 * @returns the asset ID.
 */
export async function assetIdOfImage(url: string): Promise<string> {
  const bytes = await (await fetch(url)).arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Place the images of each chat submission not handled yet on a project's canvas list. A submission echo exists only
 * while the browser sends a message, so a reload never places the images of earlier messages again.
 * @param submissions - the session's local submission echoes.
 * @param handled - request IDs of submissions already placed; updated in place.
 * @param project - the open project, or null on the entry page.
 * @param client - the API client.
 * @returns settles when every placement was sent; a failed placement leaves the canvas as it was.
 */
export async function placeSubmittedImages(
  submissions: readonly PendingSubmission[], handled: Set<string>, project: string | null, client: DvClient,
): Promise<void> {
  const fresh = submissions.filter(submission => !handled.has(submission.requestId))
  for (const submission of fresh) handled.add(submission.requestId)
  if (project === null) return
  const urls = fresh.flatMap(submission => submission.attachments.flatMap(attachment => attachment.type === 'image' ? [attachment.value.previewUrl] : []))
  if (urls.length === 0) return
  try {
    await client.placeAssets(project, await Promise.all(urls.map(assetIdOfImage)))
  } catch (error) {
    // The message is sent either way; the image stays off the canvas and the user can drag it there from the asset pool.
    void error
  }
}
