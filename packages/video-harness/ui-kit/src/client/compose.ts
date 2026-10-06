/**
 * The `vh:compose` browser event: a view asks the chat composer to prefill a message that references project items.
 * Every producer (the canvas "让 agent 改", the asset "让 agent 使用") calls `dispatchCompose`;
 * the composer listens, fills its draft with `text`, and turns each entry of `refs` into a structured `@` reference.
 * Nothing is sent until the user submits. Example for an asset: `{ kind: 'asset', id: asset.id, label: asset.name }`.
 *
 * @module @video-harness/ui-kit/compose
 */

/** The event name. */
export const VH_COMPOSE_EVENT = 'vh:compose'

/** One project item the composer inserts as an `@` reference. */
export interface VhComposeRef {
  /** What `id` names: an operation record, an entity name, or an asset ID. */
  kind: 'op' | 'entity' | 'asset'
  id: string
  /** The chip label the user sees, such as `镜头 2` or `Hero`. */
  label: string
  /** An image or video asset that shows the item, for the chip thumbnail. */
  assetId?: string
}

/** The event's `detail`. */
export interface VhComposeDetail {
  /** The draft text to put in the composer, without the references. */
  text: string
  refs: VhComposeRef[]
}

/**
 * Dispatch `vh:compose` on `window`.
 * @param detail - the draft text and references.
 */
export function dispatchCompose(detail: VhComposeDetail): void {
  window.dispatchEvent(new CustomEvent<VhComposeDetail>(VH_COMPOSE_EVENT, { detail }))
}
