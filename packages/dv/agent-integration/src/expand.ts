/**
 * Expansion of the composer's `dv:` mentions. The composer serializes a picked project item as
 * `@[<label>](dv:<kind>/<id>)`; this module finds those mentions in user text and describes each one with the
 * concrete record and asset IDs the model needs to act on it.
 *
 * Mention URIs:
 * - `dv:asset/<AssetId>`: a stored asset.
 * - `dv:record/<RecordId>`: a record.
 * - `dv:character/<CharacterId>`, `dv:location/<LocationId>`, `dv:style/<StyleId>`: a character, location or style.
 * - `dv:clip/<ClipId>`: a clip of a timeline; a clip ID is unique in the project.
 *
 * @module @dv/agent-integration/expand
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import { formatInputRef, toolNameOf, type AssetId, type ProjectId, type ProjectRecord, type ProjectState, type RecordId } from '@dv/project'
import type { Character, Location, Style } from '@dv/story-bible'
import type {} from '@dv/timeline'

/** One `dv:` mention found in user text. */
export interface Mention {
  label: string
  uri: string
}

/** The composer's serialized mention: `@[label](dv:...)`. */
const MENTION = /@\[([^\]]*)\]\((dv:[^)\s]+)\)/g

/**
 * Find every `dv:` mention in a text, in order.
 * @param text - user text.
 * @returns the mentions.
 */
export function parseMentions(text: string): Mention[] {
  return [...text.matchAll(MENTION)].map(match => ({ label: match[1] ?? '', uri: match[2] ?? '' }))
}

/**
 * Format one mention the way the composer serializes it.
 * @param label - the chip label, such as `时间线 1·片段 2`.
 * @param uri - the `dv:` URI.
 * @returns the mention text.
 */
export function formatMention(label: string, uri: string): string {
  return `@[${label.replaceAll(']', '')}](${uri})`
}

/** What expansion reads from the Project service. */
export interface ExpansionSources {
  /** The state of the session's working branch of a project. */
  getState(projectId: ProjectId): ProjectState
  /** A record, or undefined when the project has no such record. */
  getRecord(projectId: ProjectId, record: RecordId): ProjectRecord | undefined
}

/**
 * Describe one mention with concrete IDs.
 * @param mention - the mention.
 * @param projectId - the project the session works on.
 * @param sources - the Project reads.
 * @returns one line for the model.
 */
export function describeMention(mention: Mention, projectId: ProjectId, sources: ExpansionSources): string {
  const [kind = '', ...rest] = mention.uri.slice('dv:'.length).split('/').map(decodeURIComponent)
  const id = rest.join('/')
  const head = `- ${mention.label} (${mention.uri})`
  const state = sources.getState(projectId)
  switch (kind) {
    case 'clip':
      return `${head}: ${clipText(state, id, projectId, sources)}`
    case 'asset': {
      const producer = state.components.proj.created_by[brandString<AssetId>(id)]
      return `${head}: asset ${id}${producerText(projectId, producer, sources)}`
    }
    case 'character':
    case 'location':
    case 'style': {
      const { characters, locations, styles } = state.components.bible
      const byId: Record<string, ReadonlyArray<Character | Location | Style>> =
        kind === 'character' ? characters : kind === 'location' ? locations : styles
      const latest = byId[id]?.at(-1)
      if (latest === undefined) return `${head}: no ${kind} ${id} on ${state.branch}`
      const version = `${id}@${String(latest.version)}`
      return `${head}: ${kind} ${version} "${latest.name}", reference images [${latest.references.join(', ')}]; pass it as input ${version}`
    }
    case 'record':
      return `${head}:${producerText(projectId, brandString<RecordId>(id), sources)}`
    default:
      return `${head}: unknown mention kind`
  }
}

/**
 * A clip of a timeline on the working branch: its timeline (with its name when it has one), its 1-based position, its
 * asset, and the record that produced the asset.
 */
function clipText(state: ProjectState, clipId: string, projectId: ProjectId, sources: ExpansionSources): string {
  for (const timeline of state.components.timeline.timelines) {
    const index = timeline.clips.findIndex(clip => clip.id === clipId)
    const clip = timeline.clips[index]
    if (clip === undefined) continue
    const producer = state.components.proj.created_by[clip.asset]
    const name = timeline.name === '' ? '' : ` "${timeline.name}"`
    return `clip ${clipId}, clip ${String(index + 1)} of timeline ${timeline.id}${name}, asset ${clip.asset}`
      + producerText(projectId, producer, sources)
  }
  return `no clip ${clipId} on ${state.branch}`
}

/** The producing record of an asset, as ` made by …` text. */
function producerText(projectId: ProjectId, recordId: RecordId | undefined, sources: ExpansionSources): string {
  if (recordId === undefined) return ', imported (no producing record)'
  const record = sources.getRecord(projectId, recordId)
  if (record === undefined) return `, record ${recordId} not found`
  const prompt = typeof record.params['prompt'] === 'string' ? `, prompt "${record.params['prompt']}"` : ''
  const duration = record.report?.['duration_sec'] ?? record.params['duration_sec']
  const inputs = record.inputs.map(input => `${input.role}=${input.resolved_asset ?? formatInputRef(input.ref)}`).join(', ')
  const maker = record.operation === null ? record.kind : toolNameOf({ name: record.operation })
  return ` made by record ${record.id} (${maker}, ${record.status})${prompt}`
    + `${duration === undefined ? '' : `, duration ${String(duration)} s`}`
    + `, inputs [${inputs}], outputs [${record.outputs.join(', ')}]; to change it call the tool again with based_on ${record.id}`
}

/**
 * The context block for the mentions in one user text, or null when the text has none.
 * @param text - the user text.
 * @param projectId - the session's project, or null when none is bound.
 * @param sources - the Project reads.
 * @returns the block.
 */
export function expansionBlock(text: string, projectId: ProjectId | null, sources: ExpansionSources): string | null {
  const mentions = parseMentions(text)
  if (mentions.length === 0) return null
  const lines = projectId === null
    ? mentions.map(mention => `- ${mention.label} (${mention.uri}): no project is bound to this conversation; call dv_proj_open first`)
    : mentions.map(mention => describeMention(mention, projectId, sources))
  return `The user referenced these project items:\n${lines.join('\n')}`
}
