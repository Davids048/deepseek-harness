/**
 * Error kinds that project and user-action code raises and classifies.
 *
 * `DreamverseValueError` stands for Python `ValueError`: a round that fails with it reports the message to the
 * browser and keeps the project open. Any other `Error` ends the project. `ProjectClosedError` stands for
 * `asyncio.CancelledError` raised inside a project's generation work after the project closes.
 *
 * @module @dreamverse/project/errors
 */

export { DreamverseValueError, GenerationSegmentError, ProjectValidationError } from '@dreamverse/generation-client'

/**
 * Raised inside a project's queued generation work after `closeAndWaitForGeneration()` aborts it. Round failure
 * handling and preset-metadata rollback let it pass, as the reference lets `asyncio.CancelledError` pass
 * `except Exception`.
 */
export class ProjectClosedError extends Error {
  override name = 'ProjectClosedError'

  constructor() {
    super('Project disconnected.')
  }
}

/**
 * Python `str(exc)` for a caught value.
 * @param error - the caught value.
 * @returns the error message, or the string form of a non-Error value.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
