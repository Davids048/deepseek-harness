/**
 * Failure kinds that mirror the Python exception classes raised by the reference prompt enhancer.
 *
 * The prompt configuration route answers HTTP 400 for a Python `ValueError` and HTTP 500 with the message for a
 * Python `RuntimeError`; projects treat `ValueError` as a recoverable validation failure. Callers distinguish the
 * two kinds with `instanceof`.
 *
 * @module @dreamverse/prompt-enhancer/utils/errors
 */

/** A failure the reference raises as Python `ValueError`, such as a rejected setting or an unsupported mode. */
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
