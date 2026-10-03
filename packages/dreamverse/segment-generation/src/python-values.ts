/**
 * Python value semantics that the reference applies to browser JSON: `dict.get`, truthiness, `str()`, and `repr()`.
 * Creation validation uses these helpers where the reference reads an untyped payload field.
 *
 * @module @dreamverse/segment-generation/python-values
 */

/** A browser command or queued action: one JSON object whose `type` names the action. */
export type ActionPayload = Record<string, unknown>

/**
 * Python `payload.get(key, fallback)`: the fallback applies only when the key is absent.
 * @param payload - the JSON object.
 * @param key - the field name.
 * @param fallback - the value for an absent key; `null` stands for `None`.
 * @returns the field value, or the fallback.
 */
export function payloadGet(payload: ActionPayload, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(payload, key) ? payload[key] : fallback
}

/**
 * Python truthiness of a JSON value.
 * @param value - the JSON value.
 * @returns false for null, false, 0, the empty string, an empty array, and an empty object.
 */
export function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0
  return Boolean(value)
}

/**
 * Python `str()` of a JSON scalar, as it appears in reference f-string messages.
 * @param value - the JSON value.
 * @returns `None`, `True`, or `False` for those values, the text of a string or number, and JSON for other values.
 */
export function pythonStr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'string') return value
  return typeof value === 'number' ? String(value) : JSON.stringify(value)
}

/**
 * Python `repr()` of a string, as reference `!r` f-string fields print it.
 * @param text - the string.
 * @returns the text in single quotes, or in double quotes when it contains only single quotes, with Python's
 *   escapes for the quote, backslashes, tabs, line breaks, and other non-printable characters.
 */
export function pythonRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'"
  let escaped = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (character === quote || character === '\\') escaped += `\\${character}`
    else if (character === '\t') escaped += '\\t'
    else if (character === '\n') escaped += '\\n'
    else if (character === '\r') escaped += '\\r'
    // Python treats Unicode "Other" and "Separator" characters, except the ASCII space, as non-printable.
    else if (character !== ' ' && /[\p{C}\p{Z}]/u.test(character)) {
      const [prefix, digits]: [string, number] = code < 0x100 ? ['x', 2] : code < 0x10000 ? ['u', 4] : ['U', 8]
      escaped += `\\${prefix}${code.toString(16).padStart(digits, '0')}`
    } else escaped += character
  }
  return `${quote}${escaped}${quote}`
}

/**
 * Python `str(value or fallback)`.
 * @param value - the JSON value.
 * @param fallback - the text used when the value is falsy.
 * @returns the string form of a truthy value, or the fallback.
 */
export function textOr(value: unknown, fallback: string): string {
  return isTruthy(value) ? pythonStr(value) : fallback
}
