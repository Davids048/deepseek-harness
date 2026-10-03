/**
 * The `project.json` record of the shared project layer (schema 2): the fields every workload shares, plus the
 * workload's own data, which this package stores but does not interpret.
 *
 * @module @dreamverse/project-store/records
 */

/** The `project.json` schema that this package reads and writes; schema 1 is the DreamVerse-only record. */
export const PROJECT_RECORD_SCHEMA_VERSION = 2

/** A workload's own data and the version of its format; `data` is a JSON value. */
export interface WorkloadData {
  schemaVersion: number
  data: unknown
}

/** One stored project. */
export interface ProjectRecord {
  readonly projectId: string
  /** The workload that owns the project, fixed at creation. */
  readonly kind: string
  readonly title: string
  /** ISO-8601 UTC. */
  readonly createdAt: string
  /** ISO-8601 UTC time of the last write. */
  readonly updatedAt: string
  /** The file store asset shown as the project's thumbnail, or null. */
  readonly thumbnailAssetId: string | null
  readonly workload: WorkloadData
}

/** Project IDs name directories; this pattern admits only names without separators or dots. */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Whether a project ID can name a directory under the store root.
 * @param projectId - an ID from a caller, an HTTP path, or a directory name.
 * @returns true for 1 to 128 letters, digits, `_`, or `-`.
 */
export function isProjectId(projectId: string): boolean {
  return PROJECT_ID.test(projectId)
}

/**
 * Serialize a record as the `project.json` text.
 * @param record - the record.
 * @returns the JSON text with a trailing newline.
 */
export function projectRecordJson(record: ProjectRecord): string {
  return `${JSON.stringify({
    schema_version: PROJECT_RECORD_SCHEMA_VERSION,
    project_id: record.projectId,
    kind: record.kind,
    title: record.title,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    thumbnail_asset_id: record.thumbnailAssetId,
    workload: { schema_version: record.workload.schemaVersion, data: record.workload.data },
  }, null, 2)}\n`
}

/** Whether a JSON value is an object whose fields can be read by name. */
function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a `project.json` value as a schema-2 record of the project in its directory.
 * @param value - the parsed JSON value of `project.json`.
 * @param projectId - the name of the record's directory.
 * @returns the record, or undefined when the value is not a valid schema-2 record of that project.
 */
export function parseProjectRecord(value: unknown, projectId: string): ProjectRecord | undefined {
  if (!isJsonObject(value) || value['schema_version'] !== PROJECT_RECORD_SCHEMA_VERSION) return undefined
  const { project_id: id, kind, title, created_at: createdAt, updated_at: updatedAt } = value
  const thumbnail = value['thumbnail_asset_id']
  const workload = value['workload']
  if (id !== projectId || typeof kind !== 'string' || typeof title !== 'string') return undefined
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') return undefined
  if (thumbnail !== null && typeof thumbnail !== 'string') return undefined
  if (!isJsonObject(workload) || !Number.isInteger(workload['schema_version']) || !('data' in workload)) return undefined
  return {
    projectId,
    kind,
    title,
    createdAt,
    updatedAt,
    thumbnailAssetId: thumbnail,
    workload: { schemaVersion: Number(workload['schema_version']), data: workload['data'] },
  }
}
