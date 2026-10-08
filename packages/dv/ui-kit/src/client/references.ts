/**
 * The reference images a shot sends to the video model, in the order its prompt names them (`Picture 1`, `Picture 2`,
 * …), and the split of a prompt at those names, so a view can show each named image instead of the bare label.
 *
 * The order matches `shot.render_ref2va`: the resolved `reference` inputs in input order, where a character, location or
 * style version stands for all of its reference images in the version's order. The `first_frame` input of a shot that
 * continues the previous shot (the previous take's last still) is not a reference: the model names it after the
 * references (`Picture N+1`). A `t2va` shot renders from text and has no reference images.
 *
 * @module @dv/ui-kit/references
 */
import type { PlanVersion, Shot, WireState } from './types.ts'

/** One run of a prompt: plain text, or a `Picture N` or `<Picture N>` token that names the N-th (1-based) reference image. */
export type PicturePart = { text: string } | { picture: number; text: string }

/**
 * The reference texts a plan shot renders from, as `plan.approve` passes them to `shot.render_ref2va`: the shot's own
 * references, else the plan version's. A `t2va` shot has none.
 * @param version - the plan version.
 * @param shot - one shot of the version.
 * @returns the reference texts (`<asset>`, `<record>#<output>`, or `<id>@<version>`).
 */
export function shotReferences(version: Pick<PlanVersion, 'references'>, shot: Pick<Shot, 'references' | 'mode'>): string[] {
  return shot.mode === 't2va' ? [] : shot.references ?? version.references ?? []
}

/**
 * The image assets that reference texts stand for, in the order the video model numbers them: `<id>@<version>` expands
 * to that character, location or style version's reference images (characters tried first, then locations, then
 * styles), `<record>#<output>` names that output of a record, and any other text is an asset ID. A text the state cannot
 * resolve, and an asset that is not an image, adds nothing.
 * @param state - the branch state the references are read against.
 * @param references - the reference texts, in input order.
 * @returns the image asset IDs; position N - 1 is `Picture N`.
 */
export function referenceImages(state: WireState, references: readonly string[]): string[] {
  const bible = state.components.bible
  const records = new Map(state.components.proj.records.map(record => [record.id, record]))
  const images = new Set(state.assets.filter(asset => asset.mime.startsWith('image/')).map(asset => asset.id))
  return references.flatMap((ref) => {
    const hash = ref.lastIndexOf('#')
    const output = hash > 0 ? Number(ref.slice(hash + 1)) : Number.NaN
    if (Number.isInteger(output) && output >= 0) {
      const asset = records.get(ref.slice(0, hash))?.outputs[output]
      return asset !== undefined && images.has(asset) ? [asset] : []
    }
    const at = ref.lastIndexOf('@')
    const version = at > 0 ? Number(ref.slice(at + 1)) : Number.NaN
    if (!Number.isInteger(version)) return images.has(ref) ? [ref] : []
    const id = ref.slice(0, at)
    const versions = bible.characters[id] ?? bible.locations[id] ?? bible.styles[id] ?? []
    return (versions.find(entry => entry.version === version)?.references ?? []).filter(asset => images.has(asset))
  })
}

/**
 * Split a prompt at its `Picture N` and `picture N` tokens (N a whole number from 1). A token in angle brackets, as in
 * `<Picture 1>`, includes the brackets, so a view that draws the image drops them too.
 * @param prompt - the shot prompt.
 * @returns the text runs and tokens in prompt order; a token keeps its original text for alt text and screen readers.
 */
export function pictureParts(prompt: string): PicturePart[] {
  const parts: PicturePart[] = []
  let last = 0
  for (const match of prompt.matchAll(/<[Pp]icture (\d+)>|\b[Pp]icture (\d+)\b/g)) {
    const picture = Number(match[1] ?? match[2])
    if (picture < 1) continue
    if (match.index > last) parts.push({ text: prompt.slice(last, match.index) })
    parts.push({ picture, text: match[0] })
    last = match.index + match[0].length
  }
  if (last < prompt.length) parts.push({ text: prompt.slice(last) })
  return parts
}
