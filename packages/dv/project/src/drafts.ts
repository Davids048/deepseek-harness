/**
 * Drafts and branches: the working branch of each chat session, opening drafts, accept (with replay), discard,
 * exploration branches, and switching a session's branch.
 *
 * Working branch of a session S (`workingBranch`):
 * 1. `draft/<S>` when S has an open draft;
 * 2. else the exploration branch S switched to with `proj.branch_switch`;
 * 3. else `main`. A null session always works on `main`.
 *
 * Branch for a write (`branchForWrite`): the working branch, except that an `agent` write with a session and no open
 * draft first opens `draft/<S>`, forked from the session's working branch at its head. Human (`user`) and `system`
 * writes never open a draft. A draft stays open across turns until the human accepts or discards it; Project never
 * accepts or discards a draft by itself.
 *
 * Calls: the record store (branches, records) and the reducer registry (the base state and conflicts during accept
 * replay; the registry computes states from the history module's `effectiveChain`). The service calls `accept`,
 * `discard`, `createBranch` and `switchBranch` while it holds the project lock; the runner calls `branchForWrite`
 * while it holds the lock.
 *
 * @module @dv/project/drafts
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import { effectiveChain } from './history.ts'
import type { ReducerRegistry } from './reducers.ts'
import type { RecordLineInput, RecordStore, StoredBranch } from './record-store.ts'
import { DraftConflictError, draftBranch, MAIN_BRANCH, ProjectError } from './shared.ts'
import type {
  Branch, DraftCounts, ProjectId, ProjectRecord, RecordId, RecordOrigin, RecordUpdate, SessionId,
} from './types.ts'

/** The prefix of every exploration branch name. */
const EXPLORE_PREFIX = 'explore/'

/**
 * The record line of a `proj.*` record (template in CONTRACTS.md section 3): written `done`, with no update lines.
 * @param branch - the branch to append to.
 * @param parent - the head of that branch.
 * @param operation - the `proj.*` operation name.
 * @param origin - the call's origin.
 * @param params - the record's parameters.
 * @returns the record line.
 */
function projLine(
  branch: string, parent: RecordId, operation: string, origin: RecordOrigin, params: Record<string, unknown>,
): RecordLineInput {
  return {
    parents: [parent], branch, kind: 'operation', component: 'proj', operation, operation_version: '1', ...origin, params,
    inputs: [], outputs: [], based_on: null, supersedes: [], deterministic: true, status: 'done',
  }
}

/** Working branches, drafts and exploration branches of every project. */
export class Drafts {
  /**
   * @param store - the record store.
   * @param reducers - the reducer registry, for accept replay.
   */
  constructor(private readonly store: RecordStore, private readonly reducers: ReducerRegistry) {}

  /**
   * The working branch of a session (rules in the module comment). Takes no lock and writes nothing.
   * @param project - the project.
   * @param session - a chat session, or null.
   * @returns the branch, with `counts` set when it is a draft.
   */
  workingBranch(project: ProjectId, session: SessionId | null): Branch {
    if (session !== null) {
      const draft = this.store.getBranch(project, draftBranch(session))
      if (draft !== undefined) return { ...draft, counts: this.counts(project, draft) }
    }
    return { ...this.requireBranch(project, this.sessionLine(project, session)), counts: null }
  }

  /**
   * The branch a record of this origin goes to, opening the session's draft first for an agent write without one.
   * Opening writes `{name: draft/<S>, head: H, base: B, forked_at: H, session: S}` to `branches.json`, where B is the
   * session's working branch and H its head; it appends no record. The caller holds the project lock.
   * @param project - the project.
   * @param origin - the write's actor and session.
   * @returns the branch name.
   */
  branchForWrite(project: ProjectId, origin: Pick<RecordOrigin, 'actor' | 'session'>): string {
    const working = this.workingBranch(project, origin.session)
    if (origin.session === null || working.counts !== null || origin.actor !== 'agent') return working.name
    const name = draftBranch(origin.session)
    this.store.setBranch(project, { name, head: working.head, base: working.name, forked_at: working.head, session: origin.session })
    return name
  }

  /**
   * Count a draft's records: the operation records of `draftRecords` (undone ones left out), excluding `proj.*` records.
   * `agent_changes` counts actor `agent` and `system`; `human_edits` counts actor `user`.
   * @param project - the project.
   * @param branch - a draft branch.
   * @returns the counts.
   */
  counts(project: ProjectId, branch: StoredBranch): DraftCounts {
    const counts: DraftCounts = { agent_changes: 0, human_edits: 0 }
    for (const record of this.draftRecords(project, branch)) {
      if (record.kind !== 'operation' || record.component === 'proj') continue
      if (record.actor === 'user') counts.human_edits += 1
      else counts.agent_changes += 1
    }
    return counts
  }

  /**
   * Every branch with its counts; `main` first, then by name.
   * @param project - the project.
   * @returns the branches.
   */
  listBranches(project: ProjectId): Branch[] {
    return this.store.listBranches(project).map(branch => ({
      ...branch, counts: branch.session === null ? null : this.counts(project, branch),
    }))
  }

  /**
   * Accept the session's draft into its `base` branch. The caller holds the project lock.
   *
   * 1. No open draft for `origin.session` → `no_open_draft`. A record on the draft is `pending` or `running` →
   *    `draft_busy`; a record undone inside the draft may still run (it finishes into an undone record).
   * 2. Fast-forward, when the base head still equals `forked_at`: append `proj.draft_accept` on the draft with
   *    `params {draft, base: forked_at, replayed: []}`, point the base branch at it, remove the draft branch.
   * 3. Replay, when the base moved: a draft whose effective chain no longer holds `forked_at` (it jumped back to a
   *    step before the fork) throws `DraftConflictError`. Otherwise let D be the draft's records (see `draftRecords`)
   *    without its `proj.undo` and `proj.redo` records, oldest first, and S the state of the base branch. For each
   *    record r of D, in order: r conflicts when it supersedes a record that S already marks superseded, or when
   *    `reducers.conflict(S, r)` returns a reason; on the first conflict throw
   *    `DraftConflictError` and write nothing. Otherwise `S = reducers.apply(S, r)`. When every record passed:
   *    move the draft pointer to the base head (`forked_at` too); append a copy of each r on the draft (the record line
   *    of r with status `pending`, followed by one update line carrying r's status, `started_at`, `finished_at`,
   *    `outputs`, `error`, `cost` and `report`); append `proj.draft_accept` with
   *    `params {draft, base: <base head>, replayed: [[r.id, copy.id], …]}`; point the base branch at it; remove the
   *    draft branch.
   * @param project - the project.
   * @param origin - who accepts; `session` names the draft.
   * @returns the `proj.draft_accept` record.
   */
  accept(project: ProjectId, origin: RecordOrigin): ProjectRecord {
    const draft = this.openDraft(project, origin.session)
    const records = this.idleDraftRecords(project, draft)
    const base = this.requireBranch(project, draft.base ?? MAIN_BRANCH)
    if (base.head === draft.forked_at) {
      const accepted = this.store.append(project, projLine(draft.name, draft.head, 'proj.draft_accept', origin, {
        draft: draft.name, base: draft.forked_at, replayed: [],
      }))
      return this.closeInto(project, draft, base, accepted)
    }
    // Replay copies the draft's steps; its undo and redo records are already folded into its effective chain.
    const steps = records.filter(record => record.operation !== 'proj.undo' && record.operation !== 'proj.redo')
    // A draft that jumped back to a step before its fork has no steps to replay on a moved base.
    if (!effectiveChain(this.store, project, draft.head).some(record => record.id === draft.forked_at)) {
      throw new DraftConflictError(draft.name, draft.head, `The draft returns to a step before it opened, and ${base.name} changed since.`)
    }
    this.checkReplay(project, draft, base, steps)
    // Every record applies on the moved base: re-fork the draft at the base head and copy the records after it.
    this.store.setBranch(project, { ...draft, head: base.head, forked_at: base.head })
    let head = base.head
    const replayed: Array<[RecordId, RecordId]> = []
    for (const record of steps) {
      const copy = this.appendCopy(project, draft.name, head, record)
      replayed.push([record.id, copy.id])
      head = copy.id
    }
    const accepted = this.store.append(project, projLine(draft.name, head, 'proj.draft_accept', origin, {
      draft: draft.name, base: base.head, replayed,
    }))
    return this.closeInto(project, draft, base, accepted)
  }

  /**
   * Discard the session's draft. The caller holds the project lock. No open draft → `no_open_draft`; a `pending` or
   * `running` record → `draft_busy`; `expected` differs from the current counts → `draft_changed` (the dialog showed
   * stale numbers). Otherwise append `proj.draft_discard` on the draft with
   * `params {draft, base: forked_at, agent_changes, human_edits}` and remove the draft branch. The records stay in
   * `records.jsonl`; the base branch does not move.
   * @param project - the project.
   * @param origin - who discards; `session` names the draft.
   * @param expected - the counts the confirmation dialog showed.
   * @returns the counts of the discarded records.
   */
  discard(project: ProjectId, origin: RecordOrigin, expected: DraftCounts): DraftCounts {
    const draft = this.openDraft(project, origin.session)
    this.idleDraftRecords(project, draft)
    const counts = this.counts(project, draft)
    if (counts.agent_changes !== expected.agent_changes || counts.human_edits !== expected.human_edits) {
      throw new ProjectError('draft_changed', `The draft ${draft.name} of project ${project} changed: it holds `
        + `${String(counts.agent_changes)} agent changes and ${String(counts.human_edits)} human edits, not `
        + `${String(expected.agent_changes)} and ${String(expected.human_edits)}.`)
    }
    this.store.append(project, projLine(draft.name, draft.head, 'proj.draft_discard', origin, {
      draft: draft.name, base: draft.forked_at, ...counts,
    }))
    this.store.removeBranch(project, draft.name)
    return counts
  }

  /**
   * Create an exploration branch. The caller holds the project lock. `name` must start with `explore/`
   * (`invalid_params`) and must not exist (`branch_exists`); `at` is a record ID or a branch name (`unknown_record`,
   * `unknown_branch`). Writes `{name, head: at, base: null, forked_at: null, session: null}`, then appends
   * `proj.branch_create` with `params {name, at}` on the branch.
   * @param project - the project.
   * @param name - the branch name.
   * @param at - the record or branch to start from.
   * @param origin - who creates it.
   * @returns the branch after the `proj.branch_create` record.
   */
  createBranch(project: ProjectId, name: string, at: RecordId | string, origin: RecordOrigin): Branch {
    if (!name.startsWith(EXPLORE_PREFIX)) {
      throw new ProjectError('invalid_params', `The branch name ${name} must start with ${EXPLORE_PREFIX}.`)
    }
    if (this.store.getBranch(project, name) !== undefined) {
      throw new ProjectError('branch_exists', `Project ${project} already has a branch ${name}.`)
    }
    const head = this.resolveAt(project, at)
    this.store.setBranch(project, { name, head, base: null, forked_at: null, session: null })
    this.store.append(project, projLine(name, head, 'proj.branch_create', origin, { name, at: head }))
    return { ...this.requireBranch(project, name), counts: null }
  }

  /**
   * Switch the working branch of `origin.session` (required, else `invalid_params`) to `main` or an exploration branch
   * (`unknown_branch`; a draft name → `invalid_params`). The caller holds the project lock. Appends `proj.branch_switch`
   * with `params {from, to}` on the target branch and stores the session's branch (`main` clears it). While the
   * session has an open draft, the draft stays its working branch; the switch takes effect when the draft closes.
   * @param project - the project.
   * @param branch - the target branch name.
   * @param origin - who switches; `session` is the session whose branch changes.
   * @returns the target branch after the record.
   */
  switchBranch(project: ProjectId, branch: string, origin: RecordOrigin): Branch {
    const session = origin.session
    if (session === null) throw new ProjectError('invalid_params', 'Switching a branch needs a chat session.')
    if (branch !== MAIN_BRANCH && !branch.startsWith(EXPLORE_PREFIX)) {
      throw new ProjectError('invalid_params', `A session can switch only to ${MAIN_BRANCH} or an exploration branch, not ${branch}.`)
    }
    const target = this.requireBranch(project, branch)
    const from = this.sessionLine(project, session)
    this.store.append(project, projLine(branch, target.head, 'proj.branch_switch', origin, { from, to: branch }))
    this.store.setSessionBranch(project, session, branch === MAIN_BRANCH ? null : branch)
    return { ...this.requireBranch(project, branch), counts: null }
  }

  /**
   * The branch a session works on when it has no open draft: the exploration branch it switched to, else `main`.
   * @param project - the project.
   * @param session - a chat session, or null (always `main`).
   * @returns the branch name.
   */
  private sessionLine(project: ProjectId, session: SessionId | null): string {
    return (session === null ? undefined : this.store.getSessionBranch(project, session)) ?? MAIN_BRANCH
  }

  /**
   * @param project - the project.
   * @param name - a branch name.
   * @returns the stored branch; throws `unknown_branch`.
   */
  private requireBranch(project: ProjectId, name: string): StoredBranch {
    const branch = this.store.getBranch(project, name)
    if (branch === undefined) throw new ProjectError('unknown_branch', `Project ${project} has no branch ${name}.`)
    return branch
  }

  /**
   * @param project - the project.
   * @param session - the session that names the draft.
   * @returns the session's open draft; throws `no_open_draft`.
   */
  private openDraft(project: ProjectId, session: SessionId | null): StoredBranch {
    const draft = session === null ? undefined : this.store.getBranch(project, draftBranch(session))
    if (draft === undefined) {
      throw new ProjectError('no_open_draft', session === null
        ? `An action without a chat session has no draft in project ${project}.`
        : `Session ${session} has no open draft in project ${project}.`)
    }
    return draft
  }

  /**
   * The records of a draft: the records on its effective chain that are not on the effective chain of its `forked_at`,
   * oldest first. Records undone inside the draft are left out; `proj.undo` and `proj.redo` records are included.
   * @param project - the project.
   * @param draft - a draft branch.
   * @returns the records.
   */
  private draftRecords(project: ProjectId, draft: StoredBranch): ProjectRecord[] {
    const before = new Set(draft.forked_at === null ? [] : effectiveChain(this.store, project, draft.forked_at).map(record => record.id))
    return effectiveChain(this.store, project, draft.head).filter(record => !before.has(record.id))
  }

  /**
   * @param project - the project.
   * @param draft - a draft branch.
   * @returns the draft's records; throws `draft_busy` when one of them is `pending` or `running`.
   */
  private idleDraftRecords(project: ProjectId, draft: StoredBranch): ProjectRecord[] {
    const records = this.draftRecords(project, draft)
    const busy = records.find(record => record.status === 'pending' || record.status === 'running')
    if (busy !== undefined) {
      throw new ProjectError('draft_busy', `The draft ${draft.name} of project ${project} is busy: record ${busy.id} has not finished.`)
    }
    return records
  }

  /**
   * Check that every draft record applies on the base's state, in order; throws `DraftConflictError` at the first
   * record that conflicts. A record conflicts when it supersedes a record that a record outside the draft already
   * superseded on the base, or when a reducer reports a conflict. Writes nothing.
   * @param project - the project.
   * @param draft - the draft.
   * @param base - the branch the draft merges into.
   * @param records - the draft's records, oldest first.
   */
  private checkReplay(project: ProjectId, draft: StoredBranch, base: StoredBranch, records: ProjectRecord[]): void {
    const draftIds = new Set<RecordId>(records.map(record => record.id))
    let state = this.reducers.stateAt(project, base.name, base.head)
    for (const record of records) {
      for (const superseded of record.supersedes) {
        const by = state.components.proj.superseded[superseded]
        if (by !== undefined && !draftIds.has(by)) {
          throw new DraftConflictError(draft.name, record.id, `Record ${superseded} was already replaced by record ${by}.`)
        }
      }
      const reason = this.reducers.conflict(state, record)
      if (reason !== null) throw new DraftConflictError(draft.name, record.id, reason)
      state = this.reducers.apply(state, record)
    }
  }

  /**
   * Append a replay copy of a draft record after `parent` on the draft: the record line with status `pending`, then
   * one update line with the original's final fields.
   * @param project - the project.
   * @param draft - the draft name.
   * @param parent - the head of the draft.
   * @param record - the original record, in its current form.
   * @returns the copy in its current form.
   */
  private appendCopy(project: ProjectId, draft: string, parent: RecordId, record: ProjectRecord): ProjectRecord {
    // The copy gets its own ID, time, parent and branch; status, timing and results come back as one update line.
    const {
      id: _id, created_at: _createdAt, started_at, finished_at, error, cost, report, parents: _parents, branch: _branch,
      status, ...line
    } = record
    const copy = this.store.append(project, { ...line, parents: [parent], branch: draft, status: 'pending', outputs: [] })
    const update: RecordUpdate = {
      update: copy.id, status,
      ...started_at === undefined ? {} : { started_at },
      ...finished_at === undefined ? {} : { finished_at },
      outputs: record.outputs,
      ...error === undefined ? {} : { error },
      ...cost === undefined ? {} : { cost },
      ...report === undefined ? {} : { report },
    }
    return this.store.update(project, update)
  }

  /**
   * Point the base branch at the `proj.draft_accept` record and remove the draft branch.
   * @param project - the project.
   * @param draft - the draft.
   * @param base - the base branch before the accept.
   * @param accepted - the `proj.draft_accept` record.
   * @returns the `proj.draft_accept` record.
   */
  private closeInto(project: ProjectId, draft: StoredBranch, base: StoredBranch, accepted: ProjectRecord): ProjectRecord {
    this.store.setBranch(project, { ...base, head: accepted.id })
    this.store.removeBranch(project, draft.name)
    return accepted
  }

  /**
   * Resolve the start of an exploration branch.
   * @param project - the project.
   * @param at - a branch name or a record ID.
   * @returns the record ID; throws `unknown_branch` for a missing branch name and `unknown_record` for a missing record.
   */
  private resolveAt(project: ProjectId, at: string): RecordId {
    const branch = this.store.getBranch(project, at)
    if (branch !== undefined) return branch.head
    if (at === MAIN_BRANCH || at.includes('/')) throw new ProjectError('unknown_branch', `Project ${project} has no branch ${at}.`)
    return this.store.getRecord(project, brandString<RecordId>(at)).id
  }
}
