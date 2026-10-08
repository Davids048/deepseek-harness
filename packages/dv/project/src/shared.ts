/**
 * Values that every module of the Project service uses: the component keys, the error classes and the branch names.
 *
 * @module @dv/project/shared
 */
/**
 * The component keys an operation's `component` may name, in the order the project summary of the `dv_proj_*` tools
 * lists the components' fields.
 */
export const COMPONENT_KEYS: ReadonlySet<string> = new Set(['proj', 'asset', 'bible', 'plan', 'shot', 'timeline', 'deliver', 'inspect'])

/** The name of a project's first branch, which every other branch forks from directly or through another branch. */
export const MAIN_BRANCH = 'main'

/** Why a Project call was refused. The record store, the runner, branches and history throw these codes. */
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
