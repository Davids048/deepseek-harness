/**
 * Values that every module of the Project service uses: the component keys and the error classes.
 *
 * @module @dv/project/shared
 */
/**
 * The component keys an operation's `component` may name, in the order the project summary of the `dv_proj_*` tools
 * lists the components' fields.
 */
export const COMPONENT_KEYS: ReadonlySet<string> = new Set(['proj', 'asset', 'bible', 'plan', 'shot', 'timeline', 'deliver', 'inspect'])

/** Why a Project call was refused. The record store, the runner and history throw these codes. */
export type ProjectErrorCode =
  | 'unknown_project'
  | 'unknown_record'
  | 'unknown_operation'
  | 'unknown_asset'
  | 'invalid_params'
  | 'invalid_inputs'
  | 'input_not_ready'
  | 'operation_exists'
  | 'reducer_exists'
  | 'parent_not_head'
  | 'status_backwards'
  | 'record_finished'
  | 'nothing_to_undo'

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
