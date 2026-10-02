/**
 * On-disk project storage. Each project owns one directory under the configured root:
 *
 * ```
 * <root>/<project_id>/project.json                 the project's text content (`PersistedProject`)
 * <root>/<project_id>/segments/<segment_id>.mp4     the segment's fragmented MP4, the bytes the browser received
 * <root>/<project_id>/segments/<segment_id>.png     the segment's last frame
 * ```
 *
 * `@dreamverse/project` is the only writer. `project.json` is replaced through a temporary file and a rename, so a
 * reader sees either the previous or the next complete record.
 *
 * @module @dreamverse/project/project-store
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CreationConfig } from './project-creation.ts'

/** The `project.json` format version that this package reads and writes. */
export const PROJECT_SCHEMA_VERSION = 1

/** One segment record in `project.json`. */
export interface PersistedSegment {
  segment_id: string
  prompt: string
  /** `preset`, `user`, or `automatic`. */
  source: string
  instruction: { request_id: string; text: string } | null
  enhanced: boolean
  sequence_index: number | null
  reference_segment_id: string | null
  reference_asset_ids: string[]
  /** `pending`, `generating`, `completed`, `failed`, or `cancelled`. */
  status: string
  error: string | null
  /** The MIME type of the segment's video, with its codecs; null before the video starts. */
  mime: string | null
  /** ISO-8601 UTC time when the segment record was created. */
  created_at: string
}

/** The content of `project.json`. */
export interface PersistedProject {
  schema_version: number
  project_id: string
  title: string
  /** ISO-8601 UTC. */
  created_at: string
  /** ISO-8601 UTC time of the latest write. */
  updated_at: string
  creation_config: CreationConfig
  prompt_enhancement_enabled: boolean
  /** The browser's `preset_id` value, any JSON value. */
  prompt_sequence_id: unknown
  prompt_sequence_label: string
  segments: PersistedSegment[]
  /** Each completed round's display sequence of segment IDs, oldest first. */
  completed_sequences: string[][]
}

/** The two files that a completed segment can own. */
export type SegmentFileKind = 'video' | 'frame'

/** Project and segment IDs become path names; this pattern admits only names without separators or dots. */
const STORED_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Whether a project or segment ID can name a directory or file under the project root.
 * @param id - the ID from a browser message, an HTTP path, or a stored record.
 * @returns true for 1 to 128 letters, digits, `_`, or `-`.
 */
export function isStoredId(id: string): boolean {
  return STORED_ID.test(id)
}

/**
 * Read a JSON value that must be a list of strings.
 * @param value - the JSON value.
 * @param path - the value's path in `project.json`.
 * @returns the strings.
 */
function stringItems(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`project.json ${path} must be a list.`)
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`project.json ${path}[${index}] must be a string.`)
    return item
  })
}

/** One untyped JSON object read from `project.json`, with the path of its fields for error messages. */
class JsonFields {
  constructor(private readonly fields: Record<string, unknown>, private readonly path: string) {}

  /**
   * Wrap a JSON value that must be an object.
   * @param value - the JSON value.
   * @param path - the value's path in `project.json`.
   * @returns the object's fields.
   */
  static of(value: unknown, path: string): JsonFields {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`project.json ${path} must be an object.`)
    return new JsonFields(Object.fromEntries(Object.entries(value)), path)
  }

  raw(name: string): unknown {
    return this.fields[name]
  }

  string(name: string): string {
    const value = this.fields[name]
    if (typeof value !== 'string') throw new Error(`project.json ${this.name(name)} must be a string.`)
    return value
  }

  nullableString(name: string): string | null {
    const value = this.fields[name]
    if (value === null) return null
    return this.string(name)
  }

  boolean(name: string): boolean {
    const value = this.fields[name]
    if (typeof value !== 'boolean') throw new Error(`project.json ${this.name(name)} must be a boolean.`)
    return value
  }

  integer(name: string): number {
    const value = this.fields[name]
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`project.json ${this.name(name)} must be an integer.`)
    return value
  }

  nullableInteger(name: string): number | null {
    return this.fields[name] === null ? null : this.integer(name)
  }

  storedId(name: string): string {
    const value = this.string(name)
    if (!isStoredId(value)) throw new Error(`project.json ${this.name(name)} is not a valid ID.`)
    return value
  }

  list(name: string): unknown[] {
    const value = this.fields[name]
    if (!Array.isArray(value)) throw new Error(`project.json ${this.name(name)} must be a list.`)
    return value
  }

  stringList(name: string): string[] {
    return stringItems(this.fields[name], this.name(name))
  }

  name(field: string): string {
    return this.path ? `${this.path}.${field}` : field
  }
}

/**
 * Read one segment record from disk.
 * @param value - one element of `segments`.
 * @param index - its position, named in error messages.
 * @returns the typed segment record.
 */
function parseSegment(value: unknown, index: number): PersistedSegment {
  const fields = JsonFields.of(value, `segments[${index}]`)
  const instructionValue = fields.raw('instruction')
  let instruction: PersistedSegment['instruction'] = null
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
 * Read the content of one `project.json` file.
 * @param value - the parsed JSON.
 * @param projectId - the directory name, which must equal `project_id`.
 * @returns the typed record.
 * @throws Error naming the first invalid field.
 */
export function parsePersistedProject(value: unknown, projectId: string): PersistedProject {
  const fields = JsonFields.of(value, '')
  if (fields.raw('schema_version') !== PROJECT_SCHEMA_VERSION) {
    throw new Error(`project.json schema_version ${String(fields.raw('schema_version'))} is not ${PROJECT_SCHEMA_VERSION}.`)
  }
  if (fields.string('project_id') !== projectId) throw new Error(`project.json project_id does not match directory ${projectId}.`)
  const config = JsonFields.of(fields.raw('creation_config'), 'creation_config')
  return {
    schema_version: PROJECT_SCHEMA_VERSION,
    project_id: projectId,
    title: fields.string('title'),
    created_at: fields.string('created_at'),
    updated_at: fields.string('updated_at'),
    creation_config: {
      model_id: config.string('model_id'),
      generation_mode: config.string('generation_mode'),
      aspect_ratio: config.string('aspect_ratio'),
      resolution: config.string('resolution'),
      segment_count: config.integer('segment_count'),
      segment_duration_sec: config.integer('segment_duration_sec'),
      frame_width: config.integer('frame_width'),
      frame_height: config.integer('frame_height'),
      num_frames: config.integer('num_frames'),
    },
    prompt_enhancement_enabled: fields.boolean('prompt_enhancement_enabled'),
    prompt_sequence_id: fields.raw('prompt_sequence_id') ?? null,
    prompt_sequence_label: fields.string('prompt_sequence_label'),
    segments: fields.list('segments').map(parseSegment),
    completed_sequences: fields.list('completed_sequences').map((sequence, index) =>
      stringItems(sequence, `completed_sequences[${index}]`)),
  }
}

/** Reads and writes project directories under one root. */
export class ProjectStore {
  /**
   * @param root - the directory holding one subdirectory per project; it is created when missing.
   */
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true })
  }

  /**
   * @param projectId - a valid stored ID.
   * @returns the project's directory.
   */
  projectDirectory(projectId: string): string {
    return join(this.root, projectId)
  }

  /**
   * @param projectId - a valid stored ID.
   * @param segmentId - a valid stored ID.
   * @param kind - the video or the last frame.
   * @returns the path of the segment's file, whether or not it exists.
   */
  segmentFilePath(projectId: string, segmentId: string, kind: SegmentFileKind): string {
    return join(this.projectDirectory(projectId), 'segments', `${segmentId}.${kind === 'video' ? 'mp4' : 'png'}`)
  }

  /**
   * Replace `project.json` atomically, creating the project and segment directories when missing.
   * @param record - the complete record.
   */
  write(record: PersistedProject): void {
    const directory = this.projectDirectory(record.project_id)
    mkdirSync(join(directory, 'segments'), { recursive: true })
    const path = join(directory, 'project.json')
    const temporaryPath = `${path}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    renameSync(temporaryPath, path)
  }

  /**
   * Read one project.
   * @param projectId - the project ID; an ID that cannot name a directory reads as absent.
   * @returns the record, or undefined when no `project.json` exists.
   * @throws Error when the file holds invalid JSON or an invalid record.
   */
  read(projectId: string): PersistedProject | undefined {
    if (!isStoredId(projectId)) return undefined
    const path = join(this.projectDirectory(projectId), 'project.json')
    if (!existsSync(path)) return undefined
    return parsePersistedProject(JSON.parse(readFileSync(path, 'utf8')), projectId)
  }

  /** @returns the names of the root's subdirectories that are valid project IDs. */
  projectIds(): string[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && isStoredId(entry.name))
      .map(entry => entry.name)
  }

  /**
   * Remove a project's directory with its files.
   * @param projectId - a valid stored ID.
   */
  delete(projectId: string): void {
    rmSync(this.projectDirectory(projectId), { recursive: true, force: true })
  }
}
