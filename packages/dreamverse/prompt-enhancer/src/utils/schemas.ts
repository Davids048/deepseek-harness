/**
 * Decode generated JSON and validate string fields shared by prompt features.
 *
 * @module @dreamverse/prompt-enhancer/utils/schemas
 */
import { PromptValueError } from './errors.ts'
import { PYTHON_SPACE_CLASS, dictGet, isJsonObject, stripWhitespace, type JsonObject, type JsonValue } from './python-text.ts'

/** Fenced blocks like ```` ```json ... ``` ```` with optional prose around them. */
const FENCE_PATTERN = new RegExp(`\`\`\`(?:json)?${PYTHON_SPACE_CLASS}*([\\s\\S]*?)\`\`\``, 'giu')

/**
 * Decode complete JSON text like Python `json.loads`.
 * @param text - the candidate JSON text.
 * @returns the decoded value, or `undefined` when the text is not JSON.
 */
function tryParseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue
  } catch (error) {
    // A SyntaxError means this candidate is not JSON; the caller tries its next extraction strategy.
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

/**
 * Decode the JSON value that begins with the `{` at `start` and ignore the text after it, like Python
 * `JSONDecoder.raw_decode`. The scan finds the matching close bracket outside strings, then decodes that span.
 * @param text - the reply text.
 * @param start - the index of a `{`.
 * @returns the decoded value, or `undefined` when no complete JSON value starts there.
 */
function decodeJsonPrefix(text: string, start: number): JsonValue | undefined {
  const closers: string[] = []
  let inString = false
  for (let index = start; index < text.length; index++) {
    const character = text.charAt(index)
    if (inString) {
      if (character === '\\') index++
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') closers.push('}')
    else if (character === '[') closers.push(']')
    else if (character === '}' || character === ']') {
      if (closers.pop() !== character) return undefined
      if (closers.length === 0) return tryParseJson(text.slice(start, index + 1))
    }
  }
  return undefined
}

/**
 * Find a JSON object in plain text, a fenced block, or surrounding prose.
 * @param content - the assistant reply text.
 * @returns the first JSON object found by the reference search order.
 * @throws PromptValueError when the reply is blank or contains no JSON object.
 */
export function parseJsonObject(content: string): JsonObject {
  const text = stripWhitespace(content)
  if (!text) throw new PromptValueError('Assistant response is empty.')

  const whole = tryParseJson(text)
  if (isJsonObject(whole)) return whole

  for (const match of text.matchAll(FENCE_PATTERN)) {
    const block = stripWhitespace(match[1] ?? '')
    if (!block) continue
    const parsed = tryParseJson(block)
    if (isJsonObject(parsed)) return parsed
  }

  // Fall back to scanning for the first decodable JSON object in free-form text.
  for (let index = text.indexOf('{'); index >= 0; index = text.indexOf('{', index + 1)) {
    const parsed = decodeJsonPrefix(text, index)
    if (isJsonObject(parsed)) return parsed
  }

  throw new PromptValueError('No JSON object found in assistant response.')
}

/**
 * Read a required nonblank string field.
 * @param parsed - the decoded reply object.
 * @param fieldName - the field to read.
 * @returns the stripped field value.
 * @throws PromptValueError when the field is missing, not a string, or blank.
 */
export function requirePromptField(parsed: JsonObject, fieldName: string): string {
  const value = dictGet(parsed, fieldName)
  if (typeof value !== 'string') throw new PromptValueError(`Missing ${fieldName} string.`)
  const prompt = stripWhitespace(value)
  if (!prompt) throw new PromptValueError(`${fieldName} is empty.`)
  return prompt
}
