/**
 * The `dv:compose` browser event: a view asks the chat composer to prefill a message that references project items.
 * Every producer (the canvas "让智能体改", the asset "让智能体使用") calls `dispatchCompose`;
 * the composer listens, fills its draft with `text`, and turns each entry of `refs` into a structured `@` reference.
 * Nothing is sent until the user submits. Example for an asset: `{ kind: 'asset', id: asset.id, label: asset.name }`.
 *
 * @module @dv/ui-kit/compose
 */

/** The event name. */
export const DV_COMPOSE_EVENT = 'dv:compose'

/** One project item the composer inserts as an `@` reference. */
export interface DvComposeRef {
  /** What `id` names: a record, a character, a location, a style, or an asset. */
  kind: 'record' | 'character' | 'location' | 'style' | 'asset'
  id: string
  /** The chip label the user sees, such as `镜头 2` or `Hero`. */
  label: string
  /** An image or video asset that shows the item, for the chip thumbnail. */
  assetId?: string
}

/** The event's `detail`. */
export interface DvComposeDetail {
  /** The draft text to put in the composer, without the references. */
  text: string
  refs: DvComposeRef[]
}

/**
 * Dispatch `dv:compose` on `window`.
 * @param detail - the draft text and references.
 */
export function dispatchCompose(detail: DvComposeDetail): void {
  window.dispatchEvent(new CustomEvent<DvComposeDetail>(DV_COMPOSE_EVENT, { detail }))
}
