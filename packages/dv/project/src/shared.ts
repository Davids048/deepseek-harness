/**
 * Values that every module of the Project service uses: the component keys, the error classes and the branch names.
 *
 * @module @dv/project/shared
 */
import type { RecordId, SessionId } from './types.ts'

/**
 * The component keys an operation's `component` may name, in the order the project summary of the `dv_proj_*` tools
 * lists the components' fields.
 */
export const COMPONENT_KEYS: ReadonlySet<string> = new Set(['proj', 'asset', 'bible', 'plan', 'shot', 'timeline', 'deliver', 'inspect'])

/** The branch name of a project's accepted line of records. */
export const MAIN_BRANCH = 'main'

/**
 * The name of a chat session's draft branch.
 * @param session - the chat session.
 * @returns `draft/<session>`.
 */
export function draftBranch(session: SessionId): string {
  return `draft/${session}`
}

/** Why a Project call was refused. The record store, the runner, drafts and history throw these codes. */
export type ProjectErrorCode =
  | 'unknown_project'
  | 'unknown_branch'
  | 'unknown_record'
  | 'unknown_operation'
  | 'unknown_asset'
  | 'invalid_params'
  | 'invalid_inputs'
  | 'input_not_ready'
  | 'operation_exists'
  | 'reducer_exists'
  | 'branch_exists'
  | 'parent_not_head'
  | 'status_backwards'
  | 'record_finished'
  | 'no_open_draft'
  | 'draft_busy'
  | 'draft_changed'
  | 'draft_conflict'
  | 'nothing_to_undo'
  | 'nothing_to_redo'

/** A Project call was refused before it changed anything; `code` says why. */
export class ProjectError extends Error {
  /**
   * @param code - why the call was refused.
   * @param message - the explanation, in words a creator can read.
   */
  constructor(readonly code: ProjectErrorCode, message: string) {
    super(message)
    this.name = 'ProjectError'
  }
}

/**
 * Accepting a draft stopped because one of its records cannot apply on the `main` that moved after the draft was
 * opened. Nothing was written: the draft and `main` are unchanged.
 */
export class DraftConflictError extends ProjectError {
  /**
   * @param draft - the draft branch name.
   * @param record - the draft record that conflicts.
   * @param reason - the reducer's reason, in words a creator can read.
   */
  constructor(readonly draft: string, readonly record: RecordId, readonly reason: string) {
    super('draft_conflict', `Cannot accept ${draft}: record ${record} conflicts with main. ${reason}`)
    this.name = 'DraftConflictError'
  }
}
