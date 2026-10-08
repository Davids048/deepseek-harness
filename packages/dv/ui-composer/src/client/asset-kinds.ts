/**
 * The media kind of each asset of the open DreamVerse project, followed outside React and read by the chat Markdown
 * cards through a selector hook. The index holds the assets that the `main` branch and every open draft
 * branch mention, and it is fetched again after the project's change events.
 *
 * @module @dv/ui-composer/asset-kinds
 */
import type { DvClient } from '@dv/ui-kit/api.ts'
import { DV_CURRENT_PROJECT_EVENT, getCurrentProject } from '@dv/ui-kit/current-project.ts'

/** The media kinds that the chat cards draw. */
export type AssetKind = 'video' | 'image'

/** Asset ID → media kind; assets of other kinds, such as audio, are absent. */
export type AssetKinds = ReadonlyMap<string, AssetKind>

/** The index while no project is open or before the first fetch settles. */
export const NO_ASSET_KINDS: AssetKinds = new Map()

/** The pause after a project event before the fetch, so a burst of events causes one fetch. */
const REFETCH_DELAY_MS = 150

/**
 * @param mime - an asset's MIME type.
 * @returns the media kind, or undefined for other files.
 */
export function kindOf(mime: string): AssetKind | undefined {
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('image/')) return 'image'
  return undefined
}

/**
 * @param a - an index.
 * @param b - another index.
 * @returns whether both map the same assets to the same kinds.
 */
function sameKinds(a: AssetKinds, b: AssetKinds): boolean {
  if (a.size !== b.size) return false
  for (const [id, kind] of a) if (b.get(id) !== kind) return false
  return true
}

/**
 * Fetch the assets of `main` and of every open draft branch.
 * @param client - the API client.
 * @param project - the project.
 * @param signal - cancels the requests.
 * @returns the index.
 */
async function fetchKinds(client: DvClient, project: string, signal: AbortSignal): Promise<AssetKinds> {
  const main = await client.getState(project, 'main', signal)
  const drafts = main.branches.filter(branch => branch.name !== 'main' && branch.counts !== null)
  const states = [main, ...await Promise.all(drafts.map(branch => client.getState(project, branch.name, signal)))]
  const kinds = new Map<string, AssetKind>()
  for (const state of states) {
    for (const asset of state.assets) {
      const kind = kindOf(asset.mime)
      if (kind !== undefined) kinds.set(asset.id, kind)
    }
  }
  return kinds
}

/**
 * Follow the asset kinds of the project that the DreamVerse shell has open.
 * @param client - the API client.
 * @param onChange - receives each index that differs from the last one; a project change first resets the index to
 *   {@link NO_ASSET_KINDS}, and a failed fetch keeps the last index until the next project event.
 * @returns a function that stops following.
 */
export function followAssetKinds(client: DvClient, onChange: (kinds: AssetKinds) => void): () => void {
  let project: string | null = null
  let kinds = NO_ASSET_KINDS
  let request: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopEvents = (): void => {}

  const publish = (next: AssetKinds): void => {
    if (sameKinds(kinds, next)) return
    kinds = next
    onChange(next)
  }
  const cancel = (): void => {
    request?.abort()
    request = null
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const load = (open: string): void => {
    cancel()
    const current = new AbortController()
    request = current
    fetchKinds(client, open, current.signal).then((next) => {
      if (!current.signal.aborted) publish(next)
    }, (_error: unknown) => {
      // A failed or cancelled fetch keeps the last index; the next project event fetches again.
    })
  }
  const follow = (): void => {
    const next = getCurrentProject()
    if (next === project) return
    project = next
    stopEvents()
    cancel()
    publish(NO_ASSET_KINDS)
    if (next === null) {
      stopEvents = () => {}
      return
    }
    stopEvents = client.subscribe(next, () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { load(next) }, REFETCH_DELAY_MS)
    })
    load(next)
  }

  window.addEventListener(DV_CURRENT_PROJECT_EVENT, follow)
  follow()
  return () => {
    window.removeEventListener(DV_CURRENT_PROJECT_EVENT, follow)
    stopEvents()
    cancel()
  }
}
