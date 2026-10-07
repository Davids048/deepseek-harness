/**
 * The record store: the only code that reads or writes the files of a project. One directory per project under the
 * configured root:
 *
 * ```
 * <root>/<ProjectId>/project.json    ProjectInfo
 * <root>/<ProjectId>/records.jsonl   record lines and update lines, appended in write order
 * <root>/<ProjectId>/branches.json   BranchesFile: branch pointers
 * ```
 *
 * The store keeps every project in memory and mirrors each change to disk before it returns. It enforces the record
 * format rules (append only to a branch head, status only forward, no update after a record finished) and reports
 * every change to the `onChange` callback after the change is on disk. It does not interpret records, choose branches,
 * or take decisions; the other modules do that and call it while they hold the project lock it provides.
 *
 * @module @dv/project/record-store
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MAIN_BRANCH, ProjectError } from './shared.ts'
import type {
  Branch, ProjectEvent, ProjectId, ProjectInfo, ProjectRecord, RecordId, RecordStatus, RecordUpdate,
} from './types.ts'

/** A branch as `branches.json` stores it: every field of {@link Branch} except the computed `counts`. */
export type StoredBranch = Omit<Branch, 'counts'>

/** The contents of `branches.json`. */
export interface BranchesFile {
  /** Branch name → branch. */
  branches: Record<string, StoredBranch>
}

/** A record line as a caller hands it to {@link RecordStore.append}: the store assigns `id` and `created_at`. */
export type RecordLineInput = Omit<ProjectRecord, 'id' | 'created_at' | 'started_at' | 'finished_at' | 'error' | 'cost' | 'report'>

/** One project in memory: its metadata, its records with every update line applied, and its `branches.json`. */
interface LoadedProject {
  info: ProjectInfo
  /** Record ID → the record line with its update lines applied; `resolved_asset` values are as written on disk. */
  records: Map<RecordId, ProjectRecord>
  /** Record IDs in write order. */
  order: RecordId[]
  branches: BranchesFile
}

/** The order of statuses: an update may only move to a higher rank. */
const STATUS_RANK: Record<RecordStatus, number> = { pending: 0, running: 1, done: 2, failed: 2, cancelled: 2 }

/**
 * @param status - a record status.
 * @returns whether the status is final (`done`, `failed` or `cancelled`).
 */
function isFinished(status: RecordStatus): boolean {
  return STATUS_RANK[status] === 2
}

/**
 * Write a file atomically: write `<file>.tmp`, then rename it over the file.
 * @param file - the file path.
 * @param text - the full contents.
 */
function writeAtomic(file: string, text: string): void {
  const temporary = `${file}.tmp`
  writeFileSync(temporary, text)
  renameSync(temporary, file)
}

/**
 * @param branch - a branch, possibly carrying extra fields such as `counts`.
 * @returns exactly the stored fields of the branch.
 */
function storedBranch(branch: StoredBranch): StoredBranch {
  return { name: branch.name, head: branch.head, base: branch.base, forked_at: branch.forked_at, session: branch.session }
}

/** Append-only storage of every project's records, branch pointers and metadata. */
export class RecordStore {
  private readonly projects = new Map<ProjectId, LoadedProject>()
  /** Project → the settled tail of its lock chain; the next `lock` call starts after it. */
  private readonly locks = new Map<ProjectId, Promise<void>>()

  /**
   * @param root - the directory holding one `<ProjectId>/` per project; created when missing.
   * @param onChange - called after each change is on disk; the subscriptions module fans it out.
   */
  constructor(readonly root: string, private readonly onChange: (project: ProjectId, event: ProjectEvent) => void) {}

  /**
   * Read every project directory under the root into memory; the service calls it once at start. Directories without
   * `project.json`, and the `.trash` directory, are skipped. `records.jsonl` is replayed in file order: a record line
   * adds a record, an update line applies to the record it names.
   */
  load(): void {
    mkdirSync(this.root, { recursive: true })
    this.projects.clear()
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.trash') continue
      const dir = join(this.root, entry.name)
      if (!existsSync(join(dir, 'project.json'))) continue
      const info = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as ProjectInfo
      const loaded: LoadedProject = {
        info,
        records: new Map(),
        order: [],
        branches: JSON.parse(readFileSync(join(dir, 'branches.json'), 'utf8')) as BranchesFile,
      }
      for (const line of readFileSync(join(dir, 'records.jsonl'), 'utf8').split('\n')) {
        if (line === '') continue
        const parsed = JSON.parse(line) as ProjectRecord | RecordUpdate
        if ('update' in parsed) {
          const record = loaded.records.get(parsed.update)
          if (record === undefined) throw new Error(`${join(dir, 'records.jsonl')}: update line for unknown record ${parsed.update}`)
          applyUpdate(record, parsed)
        } else {
          loaded.records.set(parsed.id, parsed)
          loaded.order.push(parsed.id)
        }
      }
      this.projects.set(info.id, loaded)
    }
  }

  /**
   * Run a function while holding the project's lock. Calls for the same project run one at a time in call order;
   * calls for different projects do not wait for each other. The lock is not reentrant.
   * @param project - the project.
   * @param fn - the work to do under the lock.
   * @returns what `fn` returns.
   */
  lock<T>(project: ProjectId, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.locks.get(project) ?? Promise.resolve()
    const result = previous.then(fn)
    // The chain continues after `fn` settles either way; the stored tail never rejects.
    const tail = result.then(() => undefined, () => undefined)
    this.locks.set(project, tail)
    void tail.then(() => {
      if (this.locks.get(project) === tail) this.locks.delete(project)
    })
    return result
  }

  /**
   * Create a project directory with `project.json`, an empty `records.jsonl`, and a `branches.json` with no branches.
   * The first appended record creates `main`.
   * @param info - the project's metadata; `info.id` must be new.
   */
  createProject(info: ProjectInfo): void {
    const dir = join(this.root, info.id)
    if (this.projects.has(info.id) || existsSync(dir)) {
      throw new ProjectError('invalid_params', `A project with ID ${info.id} already exists.`)
    }
    const stored: ProjectInfo = { id: info.id, title: info.title, created_at: info.created_at }
    const branches: BranchesFile = { branches: {} }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'project.json'), `${JSON.stringify(stored, null, 2)}\n`)
    writeFileSync(join(dir, 'records.jsonl'), '')
    writeFileSync(join(dir, 'branches.json'), `${JSON.stringify(branches)}\n`)
    this.projects.set(info.id, { info: stored, records: new Map(), order: [], branches })
  }

  /** @returns every project's metadata, oldest first. */
  listProjects(): ProjectInfo[] {
    return [...this.projects.values()].map(loaded => ({ ...loaded.info })).sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  }

  /**
   * @param project - a project.
   * @returns its metadata; throws `unknown_project`.
   */
  getProject(project: ProjectId): ProjectInfo {
    return { ...this.loaded(project).info }
  }

  /**
   * Rewrite `project.json` with a new title; the write is atomic (temporary file, then rename).
   * @param project - a project.
   * @param title - the new title.
   * @returns the metadata after the change.
   */
  renameProject(project: ProjectId, title: string): ProjectInfo {
    const loaded = this.loaded(project)
    const info: ProjectInfo = { ...loaded.info, title }
    writeAtomic(join(this.root, project, 'project.json'), `${JSON.stringify(info, null, 2)}\n`)
    loaded.info = info
    return { ...info }
  }

  /**
   * Remove a project: move its directory to `<root>/.trash/<ProjectId>-<timestamp>` and forget it in memory.
   * @param project - a project.
   */
  deleteProject(project: ProjectId): void {
    this.loaded(project)
    const trash = join(this.root, '.trash')
    mkdirSync(trash, { recursive: true })
    renameSync(join(this.root, project), join(trash, `${project}-${String(Date.now())}`))
    this.projects.delete(project)
  }

  /**
   * Append a record line. Rules: `parents` must be `[head of record.branch]`, else `parent_not_head` (or
   * `unknown_branch` when the branch does not exist); the one exception is the first record of a project, which has
   * `parents: []`, must be on `main`, and creates the `main` branch pointing at itself. After the append the branch
   * points at the new record.
   * @param project - the project.
   * @param line - the record without `id` and `created_at`.
   * @returns the stored record.
   */
  append(project: ProjectId, line: RecordLineInput): ProjectRecord {
    const loaded = this.loaded(project)
    const existing = loaded.branches.branches[line.branch]
    const first = loaded.order.length === 0
    // Check the parent rule before anything is written.
    if (existing === undefined) {
      if (!first || line.branch !== MAIN_BRANCH) {
        throw new ProjectError('unknown_branch', `Project ${project} has no branch ${line.branch}.`)
      }
      if (line.parents.length !== 0) {
        throw new ProjectError('parent_not_head', `The first record of project ${project} must have no parent.`)
      }
    } else if (line.parents.length !== 1 || line.parents[0] !== existing.head) {
      throw new ProjectError('parent_not_head',
        `Cannot append to ${line.branch} of project ${project}: the record's parent is not the branch head ${existing.head}.`)
    }
    // Exactly the record-line fields, in record-format order.
    const record: ProjectRecord = {
      id: brandString<RecordId>(randomUUID()), parents: [...line.parents], branch: line.branch, kind: line.kind,
      component: line.component, operation: line.operation, operation_version: line.operation_version, actor: line.actor,
      surface: line.surface, turn: line.turn, session: line.session, tool_call: line.tool_call, intent: line.intent,
      params: line.params, inputs: line.inputs, outputs: line.outputs, based_on: line.based_on, supersedes: line.supersedes,
      deterministic: line.deterministic, status: line.status, created_at: new Date().toISOString(),
    }
    const stored = structuredClone(record)
    const branch: StoredBranch = existing === undefined
      ? { name: MAIN_BRANCH, head: stored.id, base: null, forked_at: null, session: null }
      : { ...existing, head: stored.id }
    appendFileSync(join(this.root, project, 'records.jsonl'), `${JSON.stringify(stored)}\n`)
    loaded.records.set(stored.id, stored)
    loaded.order.push(stored.id)
    loaded.branches.branches[branch.name] = branch
    this.writeBranches(project, loaded)
    this.onChange(project, { kind: 'record', record: this.currentForm(loaded, stored) })
    this.onChange(project, { kind: 'branch', name: branch.name, branch: { ...branch, counts: null } })
    return this.currentForm(loaded, stored)
  }

  /**
   * Append an update line. Rules: the record must exist (`unknown_record`) and must not be finished
   * (`record_finished`); `status`, when given, must move forward (`status_backwards`).
   * @param project - the project.
   * @param update - the update line.
   * @returns the record's current form after the update.
   */
  update(project: ProjectId, update: RecordUpdate): ProjectRecord {
    const loaded = this.loaded(project)
    const record = loaded.records.get(update.update)
    if (record === undefined) throw new ProjectError('unknown_record', `Project ${project} has no record ${update.update}.`)
    if (isFinished(record.status)) {
      throw new ProjectError('record_finished', `Record ${record.id} of project ${project} already ended ${record.status}.`)
    }
    if (update.status !== undefined && STATUS_RANK[update.status] <= STATUS_RANK[record.status]) {
      throw new ProjectError('status_backwards',
        `Record ${record.id} of project ${project} cannot move from ${record.status} to ${update.status}.`)
    }
    // Exactly the fields the caller set, in update-line order.
    const line: RecordUpdate = { update: update.update }
    if (update.status !== undefined) line.status = update.status
    if (update.started_at !== undefined) line.started_at = update.started_at
    if (update.finished_at !== undefined) line.finished_at = update.finished_at
    if (update.outputs !== undefined) line.outputs = update.outputs
    if (update.error !== undefined) line.error = update.error
    if (update.cost !== undefined) line.cost = update.cost
    if (update.report !== undefined) line.report = update.report
    const stored = structuredClone(line)
    appendFileSync(join(this.root, project, 'records.jsonl'), `${JSON.stringify(stored)}\n`)
    applyUpdate(record, stored)
    const current = this.currentForm(loaded, record)
    this.onChange(project, { kind: 'update', record: current })
    return this.currentForm(loaded, record)
  }

  /**
   * @param project - the project.
   * @param record - a record ID.
   * @returns the record's current form; throws `unknown_record`.
   */
  getRecord(project: ProjectId, record: RecordId): ProjectRecord {
    const loaded = this.loaded(project)
    return this.currentForm(loaded, this.storedRecord(project, loaded, record))
  }

  /**
   * @param project - the project.
   * @returns every record's current form, in write order.
   */
  listRecords(project: ProjectId): ProjectRecord[] {
    const loaded = this.loaded(project)
    return loaded.order.map(id => this.currentForm(loaded, this.storedRecord(project, loaded, id)))
  }

  /**
   * Walk `parents[0]` from a record to the project's first record.
   * @param project - the project.
   * @param record - the record to start from.
   * @returns the records from the first record to `record`, inclusive, oldest first.
   */
  ancestors(project: ProjectId, record: RecordId): ProjectRecord[] {
    const loaded = this.loaded(project)
    const chain: ProjectRecord[] = []
    let next: RecordId | undefined = record
    while (next !== undefined) {
      const stored = this.storedRecord(project, loaded, next)
      chain.push(this.currentForm(loaded, stored))
      next = stored.parents[0]
    }
    return chain.reverse()
  }

  /**
   * @param project - the project.
   * @param name - a branch name.
   * @returns the branch, or undefined when it does not exist.
   */
  getBranch(project: ProjectId, name: string): StoredBranch | undefined {
    const branch = this.loaded(project).branches.branches[name]
    return branch === undefined ? undefined : { ...branch }
  }

  /**
   * @param project - the project.
   * @returns every branch, `main` first, then by name.
   */
  listBranches(project: ProjectId): StoredBranch[] {
    return Object.values(this.loaded(project).branches.branches).map(branch => ({ ...branch })).sort((a, b) => {
      if (a.name === MAIN_BRANCH) return -1
      if (b.name === MAIN_BRANCH) return 1
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
  }

  /**
   * Create a branch or move its pointer, and rewrite `branches.json` atomically. `branch.head` must be an existing
   * record (`unknown_record`).
   * @param project - the project.
   * @param branch - the branch after the change.
   */
  setBranch(project: ProjectId, branch: StoredBranch): void {
    const loaded = this.loaded(project)
    this.storedRecord(project, loaded, branch.head)
    const stored = storedBranch(branch)
    loaded.branches.branches[stored.name] = stored
    this.writeBranches(project, loaded)
    this.onChange(project, { kind: 'branch', name: stored.name, branch: { ...stored, counts: null } })
  }

  /**
   * Remove a branch pointer (a closed draft); its records stay in `records.jsonl`. Removing `main` is refused.
   * @param project - the project.
   * @param name - the branch name.
   */
  removeBranch(project: ProjectId, name: string): void {
    const loaded = this.loaded(project)
    if (name === MAIN_BRANCH) throw new ProjectError('invalid_params', `The ${MAIN_BRANCH} branch of project ${project} cannot be removed.`)
    if (loaded.branches.branches[name] === undefined) throw new ProjectError('unknown_branch', `Project ${project} has no branch ${name}.`)
    const { [name]: removed, ...rest } = loaded.branches.branches
    void removed
    loaded.branches.branches = rest
    this.writeBranches(project, loaded)
    this.onChange(project, { kind: 'branch', name, branch: null })
  }

  /**
   * @param project - a project ID.
   * @returns the project in memory; throws `unknown_project`.
   */
  private loaded(project: ProjectId): LoadedProject {
    const loaded = this.projects.get(project)
    if (loaded === undefined) throw new ProjectError('unknown_project', `There is no project ${project}.`)
    return loaded
  }

  /**
   * @param project - the project ID, for the error message.
   * @param loaded - the project in memory.
   * @param record - a record ID.
   * @returns the stored record (not a copy); throws `unknown_record`.
   */
  private storedRecord(project: ProjectId, loaded: LoadedProject, record: RecordId): ProjectRecord {
    const stored = loaded.records.get(record)
    if (stored === undefined) throw new ProjectError('unknown_record', `Project ${project} has no record ${record}.`)
    return stored
  }

  /**
   * The current form of a stored record: a copy whose `{record, output}` inputs carry the producer's
   * `outputs[output]` as `resolved_asset` once the producer is `done`.
   * @param loaded - the project in memory.
   * @param stored - the stored record.
   * @returns a copy the caller may change.
   */
  private currentForm(loaded: LoadedProject, stored: ProjectRecord): ProjectRecord {
    const current = structuredClone(stored)
    for (const input of current.inputs) {
      if (input.resolved_asset !== null || !('record' in input.ref)) continue
      const producer = loaded.records.get(input.ref.record)
      if (producer?.status === 'done') input.resolved_asset = producer.outputs[input.ref.output] ?? null
    }
    return current
  }

  /**
   * Rewrite a project's `branches.json` atomically from memory.
   * @param project - the project.
   * @param loaded - the project in memory.
   */
  private writeBranches(project: ProjectId, loaded: LoadedProject): void {
    writeAtomic(join(this.root, project, 'branches.json'), `${JSON.stringify(loaded.branches)}\n`)
  }
}

/**
 * Apply an update line to a stored record in place.
 * @param record - the stored record.
 * @param update - the update line.
 */
function applyUpdate(record: ProjectRecord, update: RecordUpdate): void {
  const { update: id, ...fields } = update
  void id
  Object.assign(record, fields)
}
