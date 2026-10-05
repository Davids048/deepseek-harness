/**
 * The operation log as the `vhOpLog` Cordis service. One directory per project under the configured root:
 *
 * ```
 * <root>/<project_id>/project.json   title and creation time
 * <root>/<project_id>/ops.jsonl      one record per line, appended in creation order; patches append a second line
 * <root>/<project_id>/heads.json     branch name → the ID of the branch's latest record
 * ```
 *
 * Records are never rewritten. A patch (status, outputs, resolved inputs) is appended as `{"patch": id, ...}` and
 * applied on replay, so the file stays append-only while a record's lifecycle advances. Branches are named pointers
 * to records; moving a pointer is how undo and fast-forward work, and the records a pointer leaves behind stay in the
 * file so another branch can point at them.
 *
 * @module @video-harness/oplog
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import z from '@deepseek-ai/schemastery'
import type { Op, OpDraft, OpId, OpPatch, OpStatus, ProjectId, TurnId } from './types.ts'

export * from './types.ts'

/** The branch name of a project's accepted history. */
export const MAIN_BRANCH = 'main'

const STATUS_ORDER: Record<OpStatus, number> = { pending: 0, running: 1, done: 2, failed: 2 }

/**
 * Whether a status change moves forward in the lifecycle.
 * @param from - the stored status.
 * @param to - the requested status.
 * @returns true for pending → running → done or failed, and for repeating the same status.
 */
export function statusAdvances(from: OpStatus, to: OpStatus): boolean {
  if (from === to) return true
  if (from === 'done' || from === 'failed') return false
  return STATUS_ORDER[to] > STATUS_ORDER[from]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The append-only operation log of every video harness project. */
    vhOpLog: VhOpLog
  }
}

/** The `project.json` record. */
export interface ProjectInfo {
  readonly projectId: ProjectId
  readonly title: string
  readonly createdAt: string
}

/** What a subscriber learns about a change. */
export type OpLogEvent =
  | { kind: 'append'; op: Op }
  | { kind: 'patch'; op: Op }
  | { kind: 'head'; branch: string; to: OpId }

/** A caller passed an unknown project, record, or branch, or broke an append rule. */
export class OpLogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpLogError'
  }
}

/** `vhOpLog` plugin configuration. */
export interface Config {
  /** The directory holding one `<project_id>/` per project; created when missing. */
  root: string
}

/** Loader validation; `root` is required. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
})

/** One project's records and heads, kept in memory and mirrored to its files. */
interface ProjectLog {
  info: ProjectInfo
  ops: Map<OpId, Op>
  order: OpId[]
  heads: Record<string, OpId>
  listeners: Set<(event: OpLogEvent) => void>
}


/**
 * Copy the defined fields of a patch onto a record; an absent field leaves the record's value in place.
 * @param op - the stored record.
 * @param patch - the changes.
 * @returns the record after the change.
 */
function applyPatch(op: Op, patch: OpPatch): Op {
  const next: Op = { ...op }
  if (patch.status !== undefined) next.status = patch.status
  if (patch.outputs !== undefined) next.outputs = patch.outputs
  if (patch.inputs !== undefined) next.inputs = patch.inputs
  if (patch.finished_at !== undefined) next.finished_at = patch.finished_at
  if (patch.error !== undefined) next.error = patch.error
  if (patch.cost !== undefined) next.cost = patch.cost
  if (patch.report !== undefined) next.report = patch.report
  return next
}

/** A line of `ops.jsonl`: a record, or a patch to an earlier record. */
type LogLine = Op | ({ patch: OpId } & OpPatch)

/** Append-only operation log with named branch heads, one directory per project. */
export default class VhOpLog extends Service {
  static Config = Config

  private readonly root: string
  private readonly projects = new Map<ProjectId, ProjectLog>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'vhOpLog')
    this.root = config.root
    mkdirSync(this.root, { recursive: true })
    for (const name of readdirSync(this.root)) this.load(brandString<ProjectId>(name))
  }

  /**
   * Create a project with an empty log and a `main` head that points nowhere yet.
   * @param init - the title.
   * @returns the project ID.
   */
  createProject(init: { title: string }): ProjectId {
    const projectId = brandString<ProjectId>(randomUUID())
    const dir = join(this.root, projectId)
    mkdirSync(dir, { recursive: true })
    const info: ProjectInfo = { projectId, title: init.title, createdAt: new Date().toISOString() }
    writeFileSync(join(dir, 'project.json'), `${JSON.stringify(info)}\n`)
    writeFileSync(join(dir, 'ops.jsonl'), '')
    this.projects.set(projectId, { info, ops: new Map(), order: [], heads: {}, listeners: new Set() })
    this.writeHeads(projectId)
    return projectId
  }

  /** @returns every project, in load order. */
  listProjects(): ProjectInfo[] {
    return [...this.projects.values()].map(log => log.info)
  }

  /**
   * @param projectId - a project.
   * @returns its `project.json` record.
   */
  project(projectId: ProjectId): ProjectInfo {
    return this.log(projectId).info
  }

  /**
   * Append a record to its branch. The parent must be the branch's current head, so two writers cannot both extend
   * the same head; a `branch` record may name any existing record as its parent and creates the branch at it.
   * @param projectId - the project.
   * @param draft - the record without ID and creation time.
   * @param parent - the record this one follows, or null for the first record of the project.
   * @returns the stored record.
   */
  append(projectId: ProjectId, draft: OpDraft, parent: OpId | null): Op {
    const log = this.log(projectId)
    const head = log.heads[draft.branch]
    if (draft.kind === 'branch') {
      if (head !== undefined) throw new OpLogError(`Branch '${draft.branch}' already exists.`)
      if (parent !== null && !log.ops.has(parent)) throw new OpLogError(`Unknown parent record '${parent}'.`)
    } else if ((head ?? null) !== parent) {
      throw new OpLogError(`Record parent '${String(parent)}' is not the head of branch '${draft.branch}'.`)
    }
    const op: Op = {
      ...draft, id: brandString<OpId>(randomUUID()), created_at: new Date().toISOString(), parents: parent === null ? [] : [parent],
    }
    this.appendLine(projectId, op)
    log.ops.set(op.id, op)
    log.order.push(op.id)
    log.heads[draft.branch] = op.id
    this.writeHeads(projectId)
    this.emit(log, { kind: 'append', op })
    return op
  }

  /**
   * Advance a record: status forward only, outputs and resolved inputs filled in, cost and error recorded. Any other
   * field is immutable.
   * @param projectId - the project.
   * @param opId - the record.
   * @param patch - the changes.
   * @returns the record after the change.
   */
  update(projectId: ProjectId, opId: OpId, patch: OpPatch): Op {
    const log = this.log(projectId)
    const op = this.get(projectId, opId)
    if (patch.status !== undefined && !statusAdvances(op.status, patch.status)) {
      throw new OpLogError(`Record '${opId}' cannot move from '${op.status}' to '${patch.status}'.`)
    }
    const next = applyPatch(op, patch)
    this.appendLine(projectId, { patch: opId, ...patch })
    log.ops.set(opId, next)
    this.emit(log, { kind: 'patch', op: next })
    return next
  }

  /**
   * @param projectId - the project.
   * @param opId - a record ID.
   * @returns the record.
   */
  get(projectId: ProjectId, opId: OpId): Op {
    const op = this.log(projectId).ops.get(opId)
    if (op === undefined) throw new OpLogError(`Unknown record '${opId}'.`)
    return op
  }

  /**
   * @param projectId - the project.
   * @returns every record in creation order.
   */
  all(projectId: ProjectId): Op[] {
    const log = this.log(projectId)
    return log.order.map(id => log.ops.get(id)).filter((op): op is Op => op !== undefined)
  }

  /**
   * @param projectId - the project.
   * @returns branch name → head record ID.
   */
  heads(projectId: ProjectId): Record<string, OpId> {
    return { ...this.log(projectId).heads }
  }

  /**
   * Create a branch pointing at an existing record, by appending a `branch` record whose parent is that record.
   * @param projectId - the project.
   * @param name - the branch name; must not exist.
   * @param at - the record the branch starts from.
   * @param turn - the turn that opens the branch; defaults to the turn of `at`.
   * @returns the branch record.
   */
  createBranch(projectId: ProjectId, name: string, at: OpId, turn?: TurnId): Op {
    const from = this.get(projectId, at)
    return this.append(projectId, {
      parents: [], turn: turn ?? from.turn, branch: name, actor: 'system', surface: 'api', intent: `branch ${name} at ${at}`,
      kind: 'branch', inputs: [], params: { at }, outputs: [], status: 'done', deterministic: true,
    }, at)
  }

  /**
   * Point a branch at another record: undo moves `main` back, accepting a draft moves `main` forward.
   * @param projectId - the project.
   * @param branch - an existing branch.
   * @param to - an existing record.
   */
  moveHead(projectId: ProjectId, branch: string, to: OpId): void {
    const log = this.log(projectId)
    if (!(branch in log.heads)) throw new OpLogError(`Unknown branch '${branch}'.`)
    this.get(projectId, to)
    log.heads[branch] = to
    this.writeHeads(projectId)
    this.emit(log, { kind: 'head', branch, to })
  }

  /**
   * Walk parents from a record to the project's first record.
   * @param projectId - the project.
   * @param opId - the record to start from.
   * @returns the records from the root to `opId`, inclusive.
   */
  ancestors(projectId: ProjectId, opId: OpId): Op[] {
    const chain: Op[] = []
    let current: OpId | undefined = opId
    while (current !== undefined) {
      const op = this.get(projectId, current)
      chain.push(op)
      current = op.parents[0]
    }
    return chain.reverse()
  }

  /**
   * Receive every append, patch, and head move of a project.
   * @param projectId - the project.
   * @param listener - called synchronously after each change.
   * @returns a function that removes the listener.
   */
  subscribe(projectId: ProjectId, listener: (event: OpLogEvent) => void): () => void {
    const log = this.log(projectId)
    log.listeners.add(listener)
    return () => { log.listeners.delete(listener) }
  }

  /** The branch an undo or fast-forward targets by default. */
  get mainBranch(): string {
    return MAIN_BRANCH
  }

  private log(projectId: ProjectId): ProjectLog {
    const log = this.projects.get(projectId)
    if (log === undefined) throw new OpLogError(`Unknown project '${projectId}'.`)
    return log
  }

  private emit(log: ProjectLog, event: OpLogEvent): void {
    for (const listener of log.listeners) listener(event)
  }

  private appendLine(projectId: ProjectId, line: LogLine): void {
    appendFileSync(join(this.root, projectId, 'ops.jsonl'), `${JSON.stringify(line)}\n`)
  }

  /** Write `heads.json` atomically so a crash leaves either the previous or the current heads. */
  private writeHeads(projectId: ProjectId): void {
    const path = join(this.root, projectId, 'heads.json')
    writeFileSync(`${path}.tmp`, `${JSON.stringify(this.log(projectId).heads)}\n`)
    renameSync(`${path}.tmp`, path)
  }

  /** Replay one project directory: records first, then patches, then heads. */
  private load(projectId: ProjectId): void {
    const dir = join(this.root, projectId)
    const infoPath = join(dir, 'project.json')
    if (!existsSync(infoPath)) return
    const info = JSON.parse(readFileSync(infoPath, 'utf8')) as ProjectInfo
    const log: ProjectLog = { info, ops: new Map(), order: [], heads: {}, listeners: new Set() }
    const opsPath = join(dir, 'ops.jsonl')
    const text = existsSync(opsPath) ? readFileSync(opsPath, 'utf8') : ''
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const parsed = JSON.parse(line) as LogLine
      if ('patch' in parsed) {
        const { patch, ...changes } = parsed
        const op = log.ops.get(patch)
        if (op !== undefined) log.ops.set(patch, applyPatch(op, changes))
      } else {
        log.ops.set(parsed.id, parsed)
        log.order.push(parsed.id)
      }
    }
    const headsPath = join(dir, 'heads.json')
    if (existsSync(headsPath)) log.heads = JSON.parse(readFileSync(headsPath, 'utf8')) as Record<string, OpId>
    this.projects.set(projectId, log)
  }
}
