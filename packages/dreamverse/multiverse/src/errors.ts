/**
 * Errors that the multiverse services raise; the controller maps them to HTTP statuses.
 *
 * @module @dreamverse/multiverse/errors
 */

/** A multiverse or node ID that the tree does not hold; the controller answers 404. */
export class MultiverseNotFoundError extends Error {
  override name = 'MultiverseNotFoundError'
}

/** A request that the multiverse cannot accept in its current state or with its inputs; the controller answers 400. */
export class MultiverseRequestError extends Error {
  override name = 'MultiverseRequestError'
}
