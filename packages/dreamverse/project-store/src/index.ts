/**
 * The shared project layer as the `dreamverseProjectStore` Cordis service.
 *
 * Every workload, such as DreamVerse, keeps its projects here. A project is one directory under the
 * configured root:
 *
 * ```
 * <root>/<project_id>/project.json          the schema-2 record (`ProjectRecord`)
 * <root>/<project_id>/project.legacy.json   the record that `migrate` replaced, when the project was migrated
 * ```
 *
 * The record holds the fields every workload shares and the workload's own data, which this service stores but does
 * not interpret. The project's files live in the `dreamverseAssetsManager` file store, owned by
 * `projectOwner(projectId)`; deleting a project deletes them. One holder at a time may write a project: writes take the
 * holder's lease, and a later `acquire` revokes the current holder before it grants the project.
 *
 * @module @dreamverse/project-store
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { projectOwner } from '@dreamverse/assets-manager'
import type { ProjectFiles } from './dependencies.ts'
import {
  PROJECT_RECORD_SCHEMA_VERSION, isProjectId, parseProjectRecord, projectRecordJson, type ProjectRecord, type WorkloadData,
} from './records.ts'

export { PROJECT_RECORD_SCHEMA_VERSION, isProjectId, type ProjectRecord, type WorkloadData } from './records.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Stored projects of every workload: records, workload data, and the write lease of each project. */
    dreamverseProjectStore: DreamverseProjectStore
  }
}

/** A party that holds the write right of a project. */
export interface ProjectHolder {
  /** Another party acquires the project: stop writing, and resolve after the last write. */
  revoke(): Promise<void>
}

/** The write right of one project, from `acquire` until `release` or a later `acquire` revokes it. */
export interface ProjectLease {
  readonly projectId: string
}

/** A directory under the root whose record is not schema 2, for a workload to migrate. */
export interface UnrecognizedProject {
  projectId: string
  directory: string
  /** The parsed `project.json` (or `project.legacy.json` when `project.json` is missing); null for invalid JSON. */
  record: unknown
}

/** The project is not stored, or its record is not schema 2. */
export class ProjectNotFoundError extends Error {
  /** @param projectId - the requested project. */
  constructor(projectId: string) {
    super(`Project '${projectId}' not found.`)
    this.name = 'ProjectNotFoundError'
  }
}

/** The project has a holder, so it cannot be deleted. */
export class ProjectInUseError extends Error {
  /** @param projectId - the held project. */
  constructor(projectId: string) {
    super(`Project '${projectId}' is in use.`)
    this.name = 'ProjectInUseError'
  }
}

/** A write used a lease that was released or revoked. */
export class StaleLeaseError extends Error {
  /** @param projectId - the project of the stale lease. */
  constructor(projectId: string) {
    super(`The lease of project '${projectId}' is no longer current.`)
    this.name = 'StaleLeaseError'
  }
}

/** `dreamverseProjectStore` plugin configuration. */
export interface Config {
  /** The `projects` directory holding one `<project_id>/` directory per project; created when missing. */
  root: string
}

/** The current holder of one project and the lease it received. */
interface Holding {
  lease: ProjectLease
  holder: ProjectHolder
}

const RECORD_FILE = 'project.json'
const LEGACY_FILE = 'project.legacy.json'

/** Stores projects as records under one root and grants one writer per project at a time. */
export default class DreamverseProjectStore extends Service {
  static inject = ['dreamverseAssetsManager']

  static Config: z<Config> = z.object({
    root: z.string().required(),
  })

  private readonly root: string
  private readonly holdings = new Map<string, Holding>()
  /** The last pending `acquire` of each project; the next one waits for it, so grants follow call order. */
  private readonly acquireQueue = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'dreamverseProjectStore')
    this.root = config.root
    mkdirSync(this.root, { recursive: true })
  }

  private get files(): ProjectFiles {
    return this.ctx.dreamverseAssetsManager
  }

  /**
   * Create a project with a new ID.
   * @param init - the workload kind (fixed for the project's life), the title, and the initial workload data.
   * @returns the stored record.
   */
  create(init: { kind: string; title: string; workload: WorkloadData }): ProjectRecord {
    const now = new Date().toISOString()
    const record: ProjectRecord = {
      projectId: randomUUID(), kind: init.kind, title: init.title, createdAt: now, updatedAt: now, thumbnailAssetId: null,
      workload: init.workload,
    }
    this.write(record)
    return record
  }

  /**
   * Read one project record from disk.
   * @param projectId - the project ID.
   * @returns the record, or undefined when the project is not stored or its record is not schema 2.
   */
  get(projectId: string): ProjectRecord | undefined {
    if (!isProjectId(projectId)) return undefined
    const raw = this.readJson(join(this.root, projectId, RECORD_FILE))
    return raw.found ? parseProjectRecord(raw.value, projectId) : undefined
  }

  /**
   * List the stored projects, optionally of one workload kind.
   * @param filter - an optional workload kind.
   * @returns the schema-2 records, most recently updated first; records of other schemas are skipped.
   */
  list(filter: { kind?: string } = {}): ProjectRecord[] {
    const records: ProjectRecord[] = []
    for (const projectId of this.projectIds()) {
      const record = this.get(projectId)
      if (record !== undefined && (filter.kind === undefined || record.kind === filter.kind)) records.push(record)
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * Report whether the project is open for writing.
   * @param projectId - the project ID.
   * @returns whether a holder holds the project's write right.
   */
  isHeld(projectId: string): boolean {
    return this.holdings.has(projectId)
  }

  /**
   * Grant the write right of a project. A current holder is revoked first: the store awaits its `revoke()`, and its
   * lease is stale before the new lease is granted. Concurrent acquisitions of one project are granted in call order.
   * @param projectId - the project ID.
   * @param holder - the party that receives the right and is told when another party takes it.
   * @returns the lease that the holder's writes take.
   * @throws {ProjectNotFoundError} when the project is not stored.
   */
  async acquire(projectId: string, holder: ProjectHolder): Promise<ProjectLease> {
    if (this.get(projectId) === undefined) throw new ProjectNotFoundError(projectId)
    const previous = this.acquireQueue.get(projectId) ?? Promise.resolve()
    const granted = previous.then(async () => {
      const current = this.holdings.get(projectId)
      if (current !== undefined) {
        try {
          await current.holder.revoke()
        } finally {
          if (this.holdings.get(projectId) === current) this.holdings.delete(projectId)
        }
      }
      if (this.get(projectId) === undefined) throw new ProjectNotFoundError(projectId)
      const lease: ProjectLease = Object.freeze({ projectId })
      this.holdings.set(projectId, { lease, holder })
      return lease
    })
    const settled = granted.then(() => undefined, () => undefined)
    this.acquireQueue.set(projectId, settled)
    void settled.then(() => {
      if (this.acquireQueue.get(projectId) === settled) this.acquireQueue.delete(projectId)
    })
    return await granted
  }

  /**
   * Give up a lease; releasing a lease that is no longer current does nothing.
   * @param lease - the lease to release.
   */
  release(lease: ProjectLease): void {
    if (this.holdings.get(lease.projectId)?.lease === lease) this.holdings.delete(lease.projectId)
  }

  /**
   * Replace the workload data.
   * @param lease - the current lease of the project.
   * @param workload - the workload's data and its format version.
   * @returns the stored record.
   * @throws {StaleLeaseError} when the lease is not current.
   */
  updateWorkload(lease: ProjectLease, workload: WorkloadData): ProjectRecord {
    return this.update(lease, { workload })
  }

  /**
   * Rename the project.
   * @param lease - the current lease of the project.
   * @param title - the new title.
   * @returns the stored record.
   * @throws {StaleLeaseError} when the lease is not current.
   */
  setTitle(lease: ProjectLease, title: string): ProjectRecord {
    return this.update(lease, { title })
  }

  /**
   * Set the image that the project list shows for the project.
   * @param lease - the current lease of the project.
   * @param assetId - the file store asset to show as the thumbnail, or null for none.
   * @returns the stored record.
   * @throws {StaleLeaseError} when the lease is not current.
   */
  setThumbnail(lease: ProjectLease, assetId: string | null): ProjectRecord {
    return this.update(lease, { thumbnailAssetId: assetId })
  }

  /**
   * Delete a project: its files in the file store, then its directory.
   * @param projectId - the project ID.
   * @throws {ProjectNotFoundError} when the project is not stored.
   * @throws {ProjectInUseError} when a holder holds the project.
   */
  delete(projectId: string): void {
    if (this.get(projectId) === undefined) throw new ProjectNotFoundError(projectId)
    if (this.isHeld(projectId)) throw new ProjectInUseError(projectId)
    this.files.deleteOwnedBy(projectOwner(projectId))
    rmSync(join(this.root, projectId), { recursive: true, force: true })
  }

  /**
   * List the directories whose record is not schema 2: an older or foreign `project.json`, or a migration that stopped
   * after keeping `project.legacy.json` and before writing the new record.
   * @returns one entry per such directory.
   */
  listUnrecognized(): UnrecognizedProject[] {
    const unrecognized: UnrecognizedProject[] = []
    for (const projectId of this.projectIds()) {
      const directory = join(this.root, projectId)
      const current = this.readJson(join(directory, RECORD_FILE))
      if (current.found) {
        if (parseProjectRecord(current.value, projectId) === undefined) unrecognized.push({ projectId, directory, record: current.value })
        continue
      }
      const legacy = this.readJson(join(directory, LEGACY_FILE))
      if (legacy.found) unrecognized.push({ projectId, directory, record: legacy.value })
    }
    return unrecognized
  }

  /**
   * Replace a directory's unrecognized record with a project record, keeping the old file as `project.legacy.json`.
   * @param projectId - an ID that `listUnrecognized` reported.
   * @param init - the workload kind, the title, the original creation time, and the converted workload data.
   * @returns the stored record.
   * @throws Error when the directory is missing or already holds a schema-2 record.
   */
  migrate(projectId: string, init: { kind: string; title: string; createdAt: string; workload: WorkloadData }): ProjectRecord {
    const directory = join(this.root, projectId)
    if (!isProjectId(projectId) || !existsSync(directory)) throw new Error(`Project directory '${projectId}' does not exist.`)
    if (this.get(projectId) !== undefined) throw new Error(`Project '${projectId}' already has a schema ${PROJECT_RECORD_SCHEMA_VERSION} record.`)
    const recordPath = join(directory, RECORD_FILE)
    if (existsSync(recordPath)) renameSync(recordPath, join(directory, LEGACY_FILE))
    const record: ProjectRecord = {
      projectId, kind: init.kind, title: init.title, createdAt: init.createdAt, updatedAt: new Date().toISOString(),
      thumbnailAssetId: null, workload: init.workload,
    }
    this.write(record)
    return record
  }

  /**
   * Apply field changes to the record of a lease's project and store it with a new update time.
   * @param lease - the current lease.
   * @param changes - the changed fields.
   * @returns the stored record.
   * @throws {StaleLeaseError} when the lease is not current.
   * @throws {ProjectNotFoundError} when the record is gone.
   */
  private update(lease: ProjectLease, changes: Partial<Pick<ProjectRecord, 'title' | 'thumbnailAssetId' | 'workload'>>): ProjectRecord {
    if (this.holdings.get(lease.projectId)?.lease !== lease) throw new StaleLeaseError(lease.projectId)
    const current = this.get(lease.projectId)
    if (current === undefined) throw new ProjectNotFoundError(lease.projectId)
    const record: ProjectRecord = { ...current, ...changes, updatedAt: new Date().toISOString() }
    this.write(record)
    return record
  }

  /** Replace a project's `project.json` through a temporary file and a rename, creating the directory when missing. */
  private write(record: ProjectRecord): void {
    const directory = join(this.root, record.projectId)
    mkdirSync(directory, { recursive: true })
    const path = join(directory, RECORD_FILE)
    const temporaryPath = `${path}.tmp`
    writeFileSync(temporaryPath, projectRecordJson(record), 'utf8')
    renameSync(temporaryPath, path)
  }

  /** @returns the root's subdirectories whose names are valid project IDs. */
  private projectIds(): string[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && isProjectId(entry.name))
      .map(entry => entry.name)
  }

  /**
   * Read a JSON file that may be absent.
   * @param path - the file.
   * @returns whether the file exists, and its parsed value (null when the file is not valid JSON).
   */
  private readJson(path: string): { found: false } | { found: true; value: unknown } {
    if (!existsSync(path)) return { found: false }
    try {
      return { found: true, value: JSON.parse(readFileSync(path, 'utf8')) }
    } catch (error) {
      // An unreadable or invalid file is reported as a record that is not schema 2; callers skip or migrate it.
      if (error instanceof SyntaxError) return { found: true, value: null }
      throw error
    }
  }
}
