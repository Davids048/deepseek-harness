/**
 * Python text semantics that reach provider requests, prompt results, and error messages.
 *
 * The reference strips, splits, measures, and serializes text with Python rules. JavaScript `trim`, `\s`, `split`,
 * `length`, and `JSON.stringify` differ for some characters, separators, and non-BMP text, so the port uses these
 * helpers wherever the resulting text must match the reference.
 *
 * @module @dreamverse/prompt-enhancer/utils/python-text
 */

/**
 * A JSON number that Python decodes as `float`. Keeping it distinct from `int` lets serialization print Python float
 * text such as `1.0` and `1e-05`.
 */
export class PythonFloat {
  /** @param value - the decoded number. */
  constructor(readonly value: number) {}
}

/**
 * A JSON value as decoded from a provider reply or built for a provider request. A plain `number` from
 * `parsePythonJson` is a Python `int`; a float literal decodes to `PythonFloat`.
 */
export type JsonValue = string | number | boolean | null | PythonFloat | JsonValue[] | JsonObject

/** A decoded JSON object; the reference calls it a `dict`. */
export interface JsonObject {
  [key: string]: JsonValue
}

/**
 * Report whether a decoded JSON value is an object, which Python decodes as `dict`.
 * @param value - a decoded JSON value.
 * @returns true for a non-array, non-null object.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof PythonFloat)
}

/**
 * Decode JSON like Python `json.loads`: a number literal with a fraction or exponent decodes to `PythonFloat`.
 * @param text - the JSON text.
 * @returns the decoded value.
 * @throws SyntaxError when the text is not JSON.
 */
export function parsePythonJson(text: string): JsonValue {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && /[.eE]/.test(context?.source ?? '') ? new PythonFloat(value) : value) as JsonValue
}

/**
 * Read a key like Python `dict.get`, ignoring properties inherited from `Object.prototype`.
 * @param object - a decoded JSON object.
 * @param key - the key to read.
 * @returns the value, or `undefined` when the key is absent.
 */
export function dictGet(object: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined
}

/**
 * Regular-expression character class for Python `str.isspace()`, which Python `re` also uses for `\s`.
 * JavaScript `\s` omits U+001C–U+001F and U+0085 and adds U+FEFF.
 */
export const PYTHON_SPACE_CLASS = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'

/**
 * Report whether a UTF-16 code unit is Python whitespace; every Python whitespace character is in the BMP.
 * @param code - a UTF-16 code unit.
 * @returns true when Python `str.isspace()` is true for the character.
 */
export function isPythonWhitespace(code: number): boolean {
  return (code >= 0x09 && code <= 0x0d) || (code >= 0x1c && code <= 0x20) || code === 0x85 || code === 0xa0
    || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
    || code === 0x202f || code === 0x205f || code === 0x3000
}

/** Python decimal `float()` text: digits with single underscores between them, optional fraction and exponent. */
const PYTHON_DECIMAL = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/
/** Python special `float()` spellings. */
const PYTHON_SPECIAL_FLOAT = /^([+-]?)(inf|infinity|nan)$/i

/**
 * Report whether Python `float()` ignores a character around a number: ASCII whitespace and non-ASCII Unicode
 * whitespace, which excludes U+001C–U+001F.
 * @param code - a UTF-16 code unit.
 * @returns true for an ignored character.
 */
function isFloatWhitespace(code: number): boolean {
  return (code < 0x1c || code > 0x1f) && isPythonWhitespace(code)
}

/**
 * Convert a value like Python `float(value)`.
 * @param value - a decoded JSON value or header text.
 * @returns the number, or `undefined` where Python raises `TypeError` or `ValueError`.
 */
export function toPythonFloat(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return Number(value)
  if (typeof value !== 'string') return undefined
  let start = 0
  let end = value.length
  while (start < end && isFloatWhitespace(value.charCodeAt(start))) start++
  while (end > start && isFloatWhitespace(value.charCodeAt(end - 1))) end--
  const text = value.slice(start, end)
  if (PYTHON_DECIMAL.test(text)) return Number(text.replaceAll('_', ''))
  const special = PYTHON_SPECIAL_FLOAT.exec(text)
  if (special === null) return undefined
  if (special[2]?.toLowerCase() === 'nan') return Number.NaN
  return special[1] === '-' ? -Infinity : Infinity
}

/**
 * Remove leading and trailing whitespace like Python `str.strip()`.
 * @param text - the text to strip.
 * @returns the text without surrounding Python whitespace.
 */
export function stripWhitespace(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && isPythonWhitespace(text.charCodeAt(start))) start++
  while (end > start && isPythonWhitespace(text.charCodeAt(end - 1))) end--
  return text.slice(start, end)
}

/**
 * Remove leading and trailing characters from a set like Python `str.strip(chars)`.
 * @param text - the text to strip.
 * @param characters - the BMP characters to remove.
 * @returns the text without surrounding characters from the set.
 */
export function stripCharacters(text: string, characters: string): string {
  let start = 0
  let end = text.length
  while (start < end && characters.includes(text.charAt(start))) start++
  while (end > start && characters.includes(text.charAt(end - 1))) end--
  return text.slice(start, end)
}

/** Line boundaries recognized by Python `str.splitlines()`. */
const PYTHON_LINE_BREAK = /\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/

/**
 * Split text into lines like Python `str.splitlines()`, without a trailing empty line.
 * @param text - the text to split.
 * @returns the lines without their terminators.
 */
export function splitLines(text: string): string[] {
  const lines = text.split(PYTHON_LINE_BREAK)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Keep at most `limit` code points and mark truncation, like Python `text[:limit] + "..."` after a `len` check.
 * @param text - the text to shorten.
 * @param limit - the maximum number of code points kept.
 * @returns the unchanged text, or its first `limit` code points followed by `...`.
 */
export function truncateCodePoints(text: string, limit: number): string {
  let count = 0
  let index = 0
  for (const character of text) {
    if (count === limit) return `${text.slice(0, index)}...`
    count++
    index += character.length
  }
  return text
}

/**
 * Serialize JSON like Python `json.dumps(value, ensure_ascii=False)`, which separates items with `", "` and keys
 * with `": "`.
 * @param value - the JSON value to serialize.
 * @returns the serialized text.
 */
export function dumpsJson(value: JsonValue): string {
  if (value instanceof PythonFloat) {
    if (Number.isFinite(value.value)) return pythonFloatRepr(value.value)
    return Number.isNaN(value.value) ? 'NaN' : value.value > 0 ? 'Infinity' : '-Infinity'
  }
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${value.map(dumpsJson).join(', ')}]`
  if (isJsonObject(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return '{}'
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}: ${dumpsJson(item)}`).join(', ')}}`
  }
  return JSON.stringify(value)
}

/**
 * Format a finite number like Python `repr(float)`, which the SDKs' JSON encoder writes: the shortest round-trip
 * digits, a `.0` on integral values, and exponent form with a two-digit exponent below 1e-4 or from 1e16.
 * @param value - a finite number.
 * @returns the Python float text.
 */
export function pythonFloatRepr(value: number): string {
  const [mantissa = '0', exponentText = '0'] = value.toExponential().split('e')
  const exponent = Number(exponentText)
  const digits = mantissa.replace('-', '').replace('.', '')
  const sign = value < 0 || Object.is(value, -0) ? '-' : ''
  if (exponent >= 16 || exponent < -4) {
    const fraction = digits.slice(1)
    const exponentDigits = String(Math.abs(exponent)).padStart(2, '0')
    return `${sign}${digits.charAt(0)}${fraction ? `.${fraction}` : ''}e${exponent < 0 ? '-' : '+'}${exponentDigits}`
  }
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`
  const integer = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0')
  return `${sign}${integer}.${digits.slice(exponent + 1) || '0'}`
}

/** Characters that Python `repr` escapes: every non-printable category except the ASCII space. */
const PYTHON_NON_PRINTABLE = /[\p{C}\p{Z}]/u

/**
 * Format a string like Python `repr(str)`, including its quote choice and escapes.
 * @param text - the string to format.
 * @returns the quoted representation.
 */
function reprString(text: string): string {
  const quote = text.includes('\'') && !text.includes('"') ? '"' : '\''
  let body = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (character === quote || character === '\\') body += `\\${character}`
    else if (character === '\t') body += '\\t'
    else if (character === '\n') body += '\\n'
    else if (character === '\r') body += '\\r'
    else if (character !== ' ' && PYTHON_NON_PRINTABLE.test(character)) {
      if (code < 0x100) body += `\\x${code.toString(16).padStart(2, '0')}`
      else if (code < 0x10000) body += `\\u${code.toString(16).padStart(4, '0')}`
      else body += `\\U${code.toString(16).padStart(8, '0')}`
    } else body += character
  }
  return `${quote}${body}${quote}`
}

/**
 * Format a decoded JSON value like Python `repr`; a plain number prints as a Python `int`.
 * @param value - a decoded JSON value, or `undefined` for a missing key that Python reads as `None`.
 * @returns the Python representation.
 */
export function reprPython(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'string') return reprString(value)
  if (value instanceof PythonFloat) {
    if (Number.isFinite(value.value)) return pythonFloatRepr(value.value)
    return Number.isNaN(value.value) ? 'nan' : value.value > 0 ? 'inf' : '-inf'
  }
  if (Array.isArray(value)) return `[${value.map(reprPython).join(', ')}]`
  if (isJsonObject(value)) {
    return `{${Object.entries(value).map(([key, item]) => `${reprString(key)}: ${reprPython(item)}`).join(', ')}}`
  }
  return String(value)
}

/**
 * Name the Python type of a decoded JSON value, as used in `AttributeError` messages.
 * @param value - a decoded JSON value.
 * @returns the Python type name.
 */
export function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float'
  if (value instanceof PythonFloat) return 'float'
  if (typeof value === 'string') return 'str'
  if (Array.isArray(value)) return 'list'
  return 'dict'
}
