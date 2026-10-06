/**
 * Expansion of the composer's `vh:` references. The composer serializes a picked project item as
 * `@[<label>](vh:<kind>/<ids>)`; this module finds those references in user text and describes each one with the
 * concrete record and asset IDs the model needs to act on it.
 *
 * Reference forms:
 * - `vh:clip/<sequenceId>/<slot>/<assetId>`: a clip of a video, by its sequence, slot, and asset.
 * - `vh:asset/<assetId>`: a stored asset.
 * - `vh:entity/<id>`: a character, style, or location.
 * - `vh:op/<recordId>`: a record.
 *
 * @module @video-harness/mentions/expand
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId, ProjectId, ProjectRecord, ProjectState, RecordId, RecordInputRef } from '@dv/project'
import type {} from '@video-harness/tools'

/** One `vh:` reference found in user text. */
export interface VhReference {
  label: string
  uri: string
}

/** The composer's serialized reference: `@[label](vh:...)`. */
const REFERENCE = /@\[([^\]]*)\]\((vh:[^)\s]+)\)/g

/**
 * Find every `vh:` reference in a text, in order.
 * @param text - user text.
 * @returns the references.
 */
export function parseVhReferences(text: string): VhReference[] {
  return [...text.matchAll(REFERENCE)].map(match => ({ label: match[1] ?? '', uri: match[2] ?? '' }))
}

/**
 * Format one reference the way the composer serializes it.
 * @param label - the chip label, such as `第1集·第2段`.
 * @param uri - the `vh:` address.
 * @returns the reference text.
 */
export function formatVhReference(label: string, uri: string): string {
  return `@[${label.replaceAll(']', '')}](${uri})`
}

/** What expansion reads from the Project service. */
export interface ExpansionSources {
  /** The `main` state of a project. */
  getState(projectId: ProjectId): ProjectState
  /** A record, or undefined when the project has no such record. */
  getRecord(projectId: ProjectId, record: RecordId): ProjectRecord | undefined
}

/**
 * Describe one reference with concrete IDs.
 * @param reference - the reference.
 * @param projectId - the project the session works on.
 * @param sources - the Project reads.
 * @returns one line for the model.
 */
export function describeReference(reference: VhReference, projectId: ProjectId, sources: ExpansionSources): string {
  const parts = reference.uri.slice('vh:'.length).split('/').map(decodeURIComponent)
  const head = `- ${reference.label} (${reference.uri})`
  const state = sources.getState(projectId)
  switch (parts[0]) {
    case 'clip': {
      const [, sequenceId, slot, assetId] = parts
      const producer = assetId === undefined ? undefined : state.components.proj.created_by[brandString<AssetId>(assetId)]
      return `${head}: video ${String(sequenceId)}, slot ${String(slot)}, asset ${String(assetId)}${producerText(projectId, producer, sources)}`
    }
    case 'asset': {
      const assetId = parts[1] ?? ''
      const producer = state.components.proj.created_by[brandString<AssetId>(assetId)]
      return `${head}: asset ${assetId}${producerText(projectId, producer, sources)}`
    }
    case 'entity': {
      const entityId = parts[1] ?? ''
      const versions = state.components.bible.entities[entityId] ?? []
      const latest = versions[versions.length - 1]
      if (latest === undefined) return `${head}: no entity ${entityId} on main`
      return `${head}: ${latest.kind} ${entityId}@${String(latest.version)} "${latest.name}", reference images [${latest.refs.join(', ')}]; pass it as input ${entityId}@${String(latest.version)}`
    }
    case 'op': {
      const recordId = parts[1] ?? ''
      return `${head}:${producerText(projectId, brandString<RecordId>(recordId), sources)}`
    }
    default:
      return `${head}: unknown reference kind`
  }
}

/**
 * A record input reference as text, as the composer and the agent write it.
 * @param ref - the reference.
 * @returns an asset ID, `<id>@<version>`, or `<record>#<output>`.
 */
export function refText(ref: RecordInputRef): string {
  if ('asset' in ref) return ref.asset
  if ('record' in ref) return `${ref.record}#${ref.output}`
  if ('character' in ref) return `${ref.character}@${ref.version}`
  if ('location' in ref) return `${ref.location}@${ref.version}`
  return `${ref.style}@${ref.version}`
}

/** The producing record of an asset, as ` made by …` text. */
function producerText(projectId: ProjectId, recordId: RecordId | undefined, sources: ExpansionSources): string {
  if (recordId === undefined) return ', uploaded (no producing record)'
  const record = sources.getRecord(projectId, recordId)
  if (record === undefined) return `, record ${recordId} not found`
  const prompt = typeof record.params['prompt'] === 'string' ? `, prompt "${record.params['prompt']}"` : ''
  const duration = record.report?.['duration_sec'] ?? record.params['duration_sec']
  const inputs = record.inputs.map(input => `${input.role}=${input.resolved_asset ?? refText(input.ref)}`).join(', ')
  return ` made by record ${record.id} (${record.operation ?? record.kind}, ${record.status})${prompt}`
    + `${duration === undefined ? '' : `, duration ${String(duration)} s`}`
    + `, inputs [${inputs}], outputs [${record.outputs.join(', ')}]; to change it call the tool again with base_op ${record.id}`
}

/**
 * The context block for the references in one user text, or null when the text has none.
 * @param text - the user text.
 * @param projectId - the session's project, or null when none is bound.
 * @param sources - the Project reads.
 * @returns the block.
 */
export function expansionBlock(text: string, projectId: ProjectId | null, sources: ExpansionSources): string | null {
  const references = parseVhReferences(text)
  if (references.length === 0) return null
  const lines = projectId === null
    ? references.map(reference => `- ${reference.label} (${reference.uri}): no project is bound to this session; call dv_proj_open first`)
    : references.map(reference => describeReference(reference, projectId, sources))
  return `The user referenced these project items:\n${lines.join('\n')}`
}
