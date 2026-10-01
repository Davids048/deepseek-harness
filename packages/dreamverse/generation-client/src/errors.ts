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

/**
 * A segment failure that the generation backend reported, with HTTP 400 before its event stream or with an `error`
 * event in it. The backend's `invalid_request` code is the `ValueError` kind; `generation_failed` is not.
 */
export class GenerationSegmentError extends Error {
  override name = 'GenerationSegmentError'

  /**
   * @param message - the backend's failure message.
   * @param errorType - the backend's error code: `invalid_request` or `generation_failed`.
   * @param isValueError - whether the failure is the `ValueError` kind, a problem with the request itself.
   */
  constructor(message: string, readonly errorType: string, readonly isValueError: boolean) {
    super(message)
  }
}
