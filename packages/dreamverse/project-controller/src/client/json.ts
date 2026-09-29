/** A decoded JSON object whose fields the reader checks before use. */
export type JsonObject = Readonly<Record<string, unknown>>

/**
 * Whether a decoded JSON value is an object (not an array or `null`).
 * @param value - the decoded value.
 * @returns true when the value's fields can be read by name.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
