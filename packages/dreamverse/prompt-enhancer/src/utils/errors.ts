/**
 * Failure kinds that mirror the Python exception classes raised by the reference prompt enhancer.
 *
 * Projects treat `ValueError` as a recoverable validation failure. Callers distinguish the two kinds with
 * `instanceof`.
 *
 * @module @dreamverse/prompt-enhancer/utils/errors
 */

/** A failure the reference raises as Python `ValueError`, such as an unsupported mode or a rejected reply. */
export class PromptValueError extends Error {
  override name = 'PromptValueError'
}

/** A failure the reference raises as Python `RuntimeError`, such as an unreadable template or a missing key. */
export class PromptRuntimeError extends Error {
  override name = 'PromptRuntimeError'
}

/**
 * Read the text that Python `str(exc)` produces for a caught failure.
 * @param error - the caught value.
 * @returns the error message, or the string form of a non-Error value.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
