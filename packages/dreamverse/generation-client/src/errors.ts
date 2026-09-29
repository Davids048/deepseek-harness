/**
 * Error kinds shared by the DreamVerse harness packages.
 *
 * The Python reference distinguishes `ValueError` failures, which a project reports to the browser and survives,
 * from other exceptions, which end the project connection. These classes carry that distinction across the
 * generation backend API and through the TypeScript port.
 *
 * @module @dreamverse/generation-client/errors
 */

/** A failure the reference raises as Python `ValueError`. */
export class DreamverseValueError extends Error {
  override name = 'DreamverseValueError'
}

/** Rejected project input with a short category that becomes the WebSocket close reason. */
export class ProjectValidationError extends DreamverseValueError {
  override name = 'ProjectValidationError'

  /**
   * @param message - the browser-visible error message.
   * @param reason - the short category sent as the WebSocket close reason.
   */
  constructor(message: string, readonly reason: string) {
    super(message)
  }
}

/** A worker failure that the generation backend reported with `segment_error` while it generated one segment. */
export class GenerationSegmentError extends Error {
  override name = 'GenerationSegmentError'

  /**
   * @param message - the worker exception text.
   * @param errorType - the Python exception class name.
   * @param isValueError - whether the Python exception is a `ValueError`.
   */
  constructor(message: string, readonly errorType: string, readonly isValueError: boolean) {
    super(message)
  }
}
