/**
 * The DreamVerse workload data that `dreamverseProjectStore` keeps for a `dreamverse` project, and the schema-1 record
 * that `@dreamverse/project` wrote before the shared project store, which `legacy-migration.ts` converts.
 *
 * Workload data schema version 1 holds the creation config, the prompt enhancement flag, the prompt sequence, every
 * segment with the file store IDs of its video, last frame, and project-owned reference images, the completed
 * sequences, and the map from each library image to its copy in the project.
 *
 * @module @dreamverse/project/project-data
 */
import type { CreationConfig } from '@dreamverse/segment-generation'

/** The `kind` of every DreamVerse project in the project store. */
export const DREAMVERSE_PROJECT_KIND = 'dreamverse'

/** The version of `DreamverseProjectData`. */
export const DREAMVERSE_DATA_SCHEMA_VERSION = 1

/** One segment of a DreamVerse project. */
export interface StoredSegment {
  segment_id: string
  prompt: string
  /** `preset`, `user`, or `automatic`. */
  source: string
  instruction: { request_id: string; text: string } | null
  enhanced: boolean
  sequence_index: number | null
  reference_segment_id: string | null
  /** The project-owned copies of the segment's reference images, in selection order. */
  reference_asset_ids: string[]
  /** The file store ID of the segment's fragmented MP4; null until the segment completes. */
  video_asset_id: string | null
  /** The file store ID of the segment's last frame PNG; null until the segment completes. */
  last_frame_asset_id: string | null
  /** `pending`, `generating`, `completed`, `failed`, or `cancelled`. */
  status: string
  error: string | null
  /** The MIME type of the segment's video, with its codecs; null before the video starts. */
  mime: string | null
  /** ISO-8601 UTC time when the segment record was created. */
  created_at: string
}

/** The workload data of one DreamVerse project. */
export interface DreamverseProjectData {
  creation_config: CreationConfig
  prompt_enhancement_enabled: boolean
  /** The browser's `preset_id` value, any JSON value. */
  prompt_sequence_id: unknown
  prompt_sequence_label: string
  segments: StoredSegment[]
  /** Each completed round's display sequence of segment IDs, oldest first. */
  completed_sequences: string[][]
  /** Library asset ID to the ID of its copy owned by this project. */
  reference_copies: Record<string, string>
}

/** The schema-1 segment record of the record format before the shared project store. */
export type LegacySegment = Omit<StoredSegment, 'video_asset_id' | 'last_frame_asset_id'>

/** The schema-1 `project.json` that `@dreamverse/project` wrote before the shared project store. */
export interface LegacyProject {
  project_id: string
  title: string
  created_at: string
  creation_config: CreationConfig
  prompt_enhancement_enabled: boolean
  prompt_sequence_id: unknown
  prompt_sequence_label: string
  segments: LegacySegment[]
  completed_sequences: string[][]
}

/** Segment IDs and project IDs name files; this pattern admits only names without separators or dots. */
const STORED_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Read a JSON value that must be a list of strings.
 * @param value - the JSON value.
 * @param path - the value's path, named in error messages.
 * @returns the strings.
 */
function stringItems(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be a list.`)
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${path}[${index}] must be a string.`)
    return item
  })
}

/** One untyped JSON object, with the path of its fields for error messages. */
class JsonFields {
  constructor(private readonly fields: Record<string, unknown>, private readonly path: string) {}

  /**
   * Wrap a JSON value that must be an object.
   * @param value - the JSON value.
   * @param path - the value's path.
   * @returns the object's fields.
   */
  static of(value: unknown, path: string): JsonFields {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be an object.`)
    return new JsonFields(Object.fromEntries(Object.entries(value)), path)
  }

  raw(name: string): unknown {
    return this.fields[name]
  }

  string(name: string): string {
    const value = this.fields[name]
    if (typeof value !== 'string') throw new Error(`${this.name(name)} must be a string.`)
    return value
  }

  nullableString(name: string): string | null {
    return this.fields[name] === null ? null : this.string(name)
  }

  boolean(name: string): boolean {
    const value = this.fields[name]
    if (typeof value !== 'boolean') throw new Error(`${this.name(name)} must be a boolean.`)
    return value
  }

  integer(name: string): number {
    const value = this.fields[name]
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${this.name(name)} must be an integer.`)
    return value
  }

  nullableInteger(name: string): number | null {
    return this.fields[name] === null ? null : this.integer(name)
  }

  storedId(name: string): string {
    const value = this.string(name)
    if (!STORED_ID.test(value)) throw new Error(`${this.name(name)} is not a valid ID.`)
    return value
  }

  list(name: string): unknown[] {
    const value = this.fields[name]
    if (!Array.isArray(value)) throw new Error(`${this.name(name)} must be a list.`)
    return value
  }

  stringList(name: string): string[] {
    return stringItems(this.fields[name], this.name(name))
  }

  /** @returns every field, each of which must be a string. */
  stringValues(): Record<string, string> {
    return Object.fromEntries(Object.keys(this.fields).map(name => [name, this.string(name)]))
  }

  name(field: string): string {
    return `${this.path}.${field}`
  }
}

/**
 * Read the fields that schema-1 records and workload data share for one segment.
 * @param fields - the segment object.
 * @returns the segment without its file IDs.
 */
function parseLegacySegmentFields(fields: JsonFields): LegacySegment {
  const instructionValue = fields.raw('instruction')
  let instruction: LegacySegment['instruction'] = null
  if (instructionValue !== null) {
    const instructionFields = JsonFields.of(instructionValue, fields.name('instruction'))
    instruction = { request_id: instructionFields.string('request_id'), text: instructionFields.string('text') }
  }
  return {
    segment_id: fields.storedId('segment_id'),
    prompt: fields.string('prompt'),
    source: fields.string('source'),
    instruction,
    enhanced: fields.boolean('enhanced'),
    sequence_index: fields.nullableInteger('sequence_index'),
    reference_segment_id: fields.nullableString('reference_segment_id'),
    reference_asset_ids: fields.stringList('reference_asset_ids'),
    status: fields.string('status'),
    error: fields.nullableString('error'),
    mime: fields.nullableString('mime'),
    created_at: fields.string('created_at'),
  }
}

/**
 * Read a creation config object.
 * @param value - the JSON value.
 * @param path - its path.
 * @returns the creation config.
 */
function parseCreationConfig(value: unknown, path: string): CreationConfig {
  const config = JsonFields.of(value, path)
  return {
    model_id: config.string('model_id'),
    generation_mode: config.string('generation_mode'),
    aspect_ratio: config.string('aspect_ratio'),
    resolution: config.string('resolution'),
    segment_count: config.integer('segment_count'),
    segment_duration_sec: config.integer('segment_duration_sec'),
    frame_width: config.integer('frame_width'),
    frame_height: config.integer('frame_height'),
    num_frames: config.integer('num_frames'),
  }
}

/**
 * Read the completed sequences list.
 * @param fields - the object that holds `completed_sequences`.
 * @returns the sequences.
 */
function parseCompletedSequences(fields: JsonFields): string[][] {
  return fields.list('completed_sequences').map((sequence, index) =>
    stringItems(sequence, `${fields.name('completed_sequences')}[${index}]`))
}

/**
 * Read the workload data of a `dreamverse` project.
 * @param value - the stored `workload.data`.
 * @returns the typed data.
 * @throws Error naming the first invalid field.
 */
export function parseProjectData(value: unknown): DreamverseProjectData {
  const fields = JsonFields.of(value, 'workload.data')
  return {
    creation_config: parseCreationConfig(fields.raw('creation_config'), fields.name('creation_config')),
    prompt_enhancement_enabled: fields.boolean('prompt_enhancement_enabled'),
    prompt_sequence_id: fields.raw('prompt_sequence_id') ?? null,
    prompt_sequence_label: fields.string('prompt_sequence_label'),
    segments: fields.list('segments').map((segment, index) => {
      const segmentFields = JsonFields.of(segment, `${fields.name('segments')}[${index}]`)
      return {
        ...parseLegacySegmentFields(segmentFields),
        video_asset_id: segmentFields.nullableString('video_asset_id'),
        last_frame_asset_id: segmentFields.nullableString('last_frame_asset_id'),
      }
    }),
    completed_sequences: parseCompletedSequences(fields),
    reference_copies: JsonFields.of(fields.raw('reference_copies'), fields.name('reference_copies')).stringValues(),
  }
}

/**
 * Read a schema-1 `project.json` that `@dreamverse/project` wrote before the shared project store.
 * @param value - the parsed JSON.
 * @param projectId - the directory name, which must equal `project_id`.
 * @returns the typed record.
 * @throws Error naming the first invalid field, or when the record is not schema 1.
 */
export function parseLegacyProject(value: unknown, projectId: string): LegacyProject {
  const fields = JsonFields.of(value, 'project.json')
  if (fields.raw('schema_version') !== 1) throw new Error(`project.json schema_version ${String(fields.raw('schema_version'))} is not 1.`)
  if (fields.string('project_id') !== projectId) throw new Error(`project.json project_id does not match directory ${projectId}.`)
  return {
    project_id: projectId,
    title: fields.string('title'),
    created_at: fields.string('created_at'),
    creation_config: parseCreationConfig(fields.raw('creation_config'), fields.name('creation_config')),
    prompt_enhancement_enabled: fields.boolean('prompt_enhancement_enabled'),
    prompt_sequence_id: fields.raw('prompt_sequence_id') ?? null,
    prompt_sequence_label: fields.string('prompt_sequence_label'),
    segments: fields.list('segments').map((segment, index) =>
      parseLegacySegmentFields(JsonFields.of(segment, `${fields.name('segments')}[${index}]`))),
    completed_sequences: parseCompletedSequences(fields),
  }
}
