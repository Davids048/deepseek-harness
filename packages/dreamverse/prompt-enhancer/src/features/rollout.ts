/**
 * Build and accept a rollout from source prompts and system instructions selected by `PromptEnhancer`.
 *
 * @module @dreamverse/prompt-enhancer/features/rollout
 */
import type { ChatRequest, VendorReply } from '../llm/client.ts'
import { PromptValueError, errorText } from '../utils/errors.ts'
import {
  PYTHON_SPACE_CLASS, dictGet, dumpsJson, isJsonObject, splitLines, stripCharacters, stripWhitespace,
  truncateCodePoints, type JsonObject, type JsonValue,
} from '../utils/python-text.ts'
import { parseJsonObject, requirePromptField } from '../utils/schemas.ts'
import { elapsedMs, type FeatureDependencies } from './index.ts'

export const REWRITE_REQUEST_TEXT = 'Rewrite all segment prompts with improved continuity and cinematic detail. '
  + 'Keep count and ordering identical.'
export const REWRITE_MODE_NEW = 'new_rollout'
export const REWRITE_MODE_EDIT_EXISTING = 'edit_existing_rollout'
export const DEFAULT_REWRITE_ROLLOUT_ID = 'current_rollout'
export const DEFAULT_REWRITE_ROLLOUT_LABEL = 'Current rollout'

/** Error text of the lenient extractor, which a JSON parse failure replaces with its own message. */
const NO_SEGMENT_PROMPTS_MESSAGE = 'No rewrite segment prompts found in assistant response.'
/** Longest assistant-reply excerpt, in code points, appended to a diagnostic. */
const RESPONSE_PREVIEW_CODE_POINTS = 240
/** Object keys that may hold the rollout itself. */
const NESTED_ROLLOUT_KEYS = ['rollout', 'current_rollout', 'rewritten_rollout']
/** List keys accepted by the lenient extractor, in priority order. */
const PROMPT_LIST_KEYS = ['segment_prompts', 'rewritten_prompts', 'prompts', 'segments']
/** Segment-object keys that may hold prompt text, in priority order. */
const SEGMENT_TEXT_KEYS = ['prompt', 'text', 'segment_prompt', 'content', 'description']
/** Numbered segment keys such as `segment_1` or `Shot-2`. */
const INDEXED_KEY_PATTERN = /^(?:segment|prompt|scene|shot)[ _-]?(\d+)$/iu
/** A leading list bullet on a prose line. */
const LIST_BULLET_PATTERN = new RegExp(`^${PYTHON_SPACE_CLASS}*[-*]${PYTHON_SPACE_CLASS}*`, 'u')
/** A numbered prose line such as `**Segment 2**: text` or `3) text`. */
const NUMBERED_LINE_PATTERN = new RegExp(
  `^(?:\\*\\*)?(?:segment|scene|shot|prompt)?${PYTHON_SPACE_CLASS}*[_ -]?(\\d+)`
  + `(?:\\*\\*)?${PYTHON_SPACE_CLASS}*[:.)-]${PYTHON_SPACE_CLASS}*(.+)$`,
  'iu',
)

/** Generated prompts and the normalized source retained for project safety diagnostics. */
export interface RolloutResult {
  prompts: string[]
  sourcePrompts: string[]
  fallbackUsed: boolean
  error: string | null
  provider: string
  model: string
  latencyMs: number
  rolloutId: string
  rolloutLabel: string
  rawResponseText: string | null
}

/** Inputs of `rewriteRollout`. */
export interface RewriteRolloutOptions extends FeatureDependencies {
  /** The number of prompts to create when the source is empty. */
  readonly segmentCount: number
  readonly presetId?: string | null | undefined
  readonly presetLabel?: string | null | undefined
  readonly rewriteInstruction?: string | null | undefined
}

/**
 * Describe the requested segment count and duration for rollout creation or editing.
 * @param options.promptsToRewrite - the normalized source prompts; empty requests a new rollout.
 * @param options.segmentCount - the number of prompts the reply must contain.
 * @param options.segmentDurationSec - the segment duration.
 * @param options.presetId - the rollout id hint.
 * @param options.presetLabel - the rollout label hint.
 * @param options.rewriteInstruction - the normalized user instruction.
 * @returns the user payload before the output-format sentence is appended.
 */
function buildRewriteUserPayload(options: {
  promptsToRewrite: readonly string[]
  segmentCount: number
  segmentDurationSec: number
  presetId: string | null | undefined
  presetLabel: string | null | undefined
  rewriteInstruction: string
}): JsonObject & { request: string } {
  const rolloutId = stripWhitespace(options.presetId || '') || DEFAULT_REWRITE_ROLLOUT_ID
  const rolloutLabel = stripWhitespace(options.presetLabel || '') || DEFAULT_REWRITE_ROLLOUT_LABEL
  const instruction = stripWhitespace(options.rewriteInstruction)
  if (options.promptsToRewrite.length === 0) {
    return {
      mode: REWRITE_MODE_NEW,
      request: REWRITE_REQUEST_TEXT,
      user_instruction: instruction,
      desired_segment_count: options.segmentCount,
      segment_duration_sec: options.segmentDurationSec,
      rollout_id_hint: rolloutId,
      rollout_label_hint: rolloutLabel,
    }
  }
  return {
    mode: REWRITE_MODE_EDIT_EXISTING,
    request: REWRITE_REQUEST_TEXT,
    user_instruction: instruction,
    desired_segment_count: options.segmentCount,
    segment_duration_sec: options.segmentDurationSec,
    current_rollout: {
      id: rolloutId,
      label: rolloutLabel,
      segment_prompts: [...options.promptsToRewrite],
    },
  }
}

/**
 * Build a rollout request using normalized source prompts and the selected system text.
 *
 * An empty source requests the selected segment count; a populated source preserves its count. The result returns
 * the source alongside generated prompts for project safety diagnostics.
 * @param prompts - the normalized source prompts.
 * @param options - the selected template, budget, settings, race, and request inputs.
 * @returns the accepted rollout, or the source prompts with the failure.
 */
export async function rewriteRollout(prompts: string[], options: RewriteRolloutOptions): Promise<RolloutResult> {
  const { settings, race } = options
  const model = settings.rewriteDefaultModel
  const instruction = normalizePrompt(options.rewriteInstruction)
  if (prompts.length === 0 && !instruction) {
    return {
      prompts: [],
      sourcePrompts: [],
      fallbackUsed: true,
      error: 'No valid prompts to rewrite or generate.',
      provider: race.providerLabel,
      model,
      latencyMs: 0.0,
      rolloutId: resolveRolloutId(options.presetId),
      rolloutLabel: resolveRolloutLabel(options.presetLabel),
      rawResponseText: null,
    }
  }

  const expectedLen = prompts.length > 0 ? prompts.length : options.segmentCount
  const userPayload = buildRewriteUserPayload({
    promptsToRewrite: prompts,
    segmentCount: expectedLen,
    segmentDurationSec: options.segmentDurationSec,
    presetId: options.presetId,
    presetLabel: options.presetLabel,
    rewriteInstruction: instruction,
  })
  userPayload.request += ' Return JSON as {"id": "...", "label": "...", "segment_prompts": ["..."]}. '
    + `Include exactly ${expectedLen} segment prompts.`
  const referenceLabels = options.referenceLabels ?? []
  if (referenceLabels.length > 0) userPayload['protagonist_reference_labels'] = [...referenceLabels]
  const request: ChatRequest = {
    systemPrompt: options.systemPrompt,
    userContent: dumpsJson(userPayload),
    model,
    defaultModel: settings.rewriteDefaultModel,
    temperature: settings.rewriteDefaultTemperature,
    maxCompletionTokens: options.maxCompletionTokens,
  }

  /** Validate rollout contents and retain raw text for project inspection. */
  const accept = (reply: VendorReply): [string, string, string, string[]] => {
    const content = reply.text || dumpsJson(reply.rawResponse)
    try {
      const [rolloutId, rolloutLabel, rewritten] = extractRewriteRolloutFromContent(
        content, expectedLen, options.presetId, options.presetLabel)
      return [content, rolloutId, rolloutLabel, rewritten]
    } catch (error) {
      if (!(error instanceof PromptValueError) || reply.text) throw error
      // Without assistant text, the serialized response is the available diagnostic.
      const preview = truncateCodePoints(content.replaceAll('\n', '\\n'), RESPONSE_PREVIEW_CODE_POINTS)
      throw new PromptValueError(`${error.message} | assistant_response=${preview}`, { cause: error })
    }
  }

  const started = performance.now()
  try {
    const [provider, [content, rolloutId, rolloutLabel, rewritten]] = await race.firstAccepted(request, accept, {
      operationName: 'rewrite_prompt_sequence',
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    })
    return {
      prompts: rewritten,
      sourcePrompts: prompts,
      fallbackUsed: false,
      error: null,
      provider,
      model,
      latencyMs: elapsedMs(started),
      rolloutId,
      rolloutLabel,
      rawResponseText: content,
    }
  } catch (error) {
    if (options.signal?.aborted) throw error
    return {
      prompts,
      sourcePrompts: prompts,
      fallbackUsed: true,
      error: errorText(error),
      provider: race.providerLabel,
      model,
      latencyMs: elapsedMs(started),
      rolloutId: resolveRolloutId(options.presetId),
      rolloutLabel: resolveRolloutLabel(options.presetLabel),
      rawResponseText: null,
    }
  }
}

/**
 * Strip a string value; other values become empty.
 * @param value - the candidate text.
 * @returns the stripped text, or `''`.
 */
function normalizePrompt(value: unknown): string {
  return typeof value === 'string' ? stripWhitespace(value) : ''
}

/**
 * Resolve the rollout id reported when the reply supplies none.
 * @param value - the preset id.
 * @returns the stripped id, or `current_rollout`.
 */
function resolveRolloutId(value: unknown): string {
  return normalizePrompt(value) || DEFAULT_REWRITE_ROLLOUT_ID
}

/**
 * Resolve the rollout label reported when the reply supplies none.
 * @param value - the preset label.
 * @returns the stripped label, or `Current rollout`.
 */
function resolveRolloutLabel(value: unknown): string {
  return normalizePrompt(value) || DEFAULT_REWRITE_ROLLOUT_LABEL
}

/**
 * Read optional rollout metadata, ignoring blank or non-string values.
 * @param parsed - a candidate rollout object.
 * @param fieldName - the metadata field.
 * @returns the stripped value, or `undefined`.
 */
function optionalPromptField(parsed: JsonObject, fieldName: string): string | undefined {
  const value = dictGet(parsed, fieldName)
  if (typeof value !== 'string') return undefined
  return stripWhitespace(value) || undefined
}

/**
 * Validate a canonical list of segment prompts and its exact length.
 * @param parsed - a candidate rollout object.
 * @param fieldName - the list field.
 * @param expectedLen - the required prompt count.
 * @returns the stripped prompts.
 * @throws PromptValueError when the list is missing, malformed, or the wrong length.
 */
function requirePromptListField(parsed: JsonObject, fieldName: string, expectedLen: number): string[] {
  const value = dictGet(parsed, fieldName)
  if (!Array.isArray(value)) throw new PromptValueError(`Missing ${fieldName} list.`)
  const prompts: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new PromptValueError(`${fieldName} contains non-string item.`)
    const normalized = stripWhitespace(item)
    if (!normalized) throw new PromptValueError(`${fieldName} contains empty prompt.`)
    prompts.push(normalized)
  }
  if (prompts.length !== expectedLen) {
    throw new PromptValueError(`${fieldName} length mismatch: expected ${expectedLen}, got ${prompts.length}.`)
  }
  return prompts
}

/**
 * Read a prompt from a string or a supported segment object.
 * @param item - a list item or indexed value.
 * @returns the stripped prompt, or `undefined`.
 */
function normalizeRewritePromptItem(item: JsonValue | undefined): string | undefined {
  if (typeof item === 'string') return stripWhitespace(item) || undefined
  if (!isJsonObject(item)) return undefined
  for (const key of SEGMENT_TEXT_KEYS) {
    const value = dictGet(item, key)
    if (typeof value === 'string' && stripWhitespace(value)) return stripWhitespace(value)
  }
  return undefined
}

/**
 * Accept a supported list only when every segment and its count are valid.
 * @param value - a candidate list.
 * @param expectedLen - the required prompt count.
 * @returns the prompts, or `undefined`.
 */
function maybeExtractRewritePromptList(value: JsonValue | undefined, expectedLen: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const prompts: string[] = []
  for (const item of value) {
    const normalized = normalizeRewritePromptItem(item)
    if (normalized === undefined) return undefined
    prompts.push(normalized)
  }
  return prompts.length === expectedLen ? prompts : undefined
}

/**
 * Collect numbered segment fields in chronological order.
 * @param parsed - a candidate rollout object.
 * @param expectedLen - the required prompt count.
 * @returns the prompts ordered by index, or `undefined` when an index is missing, out of range, or unreadable.
 */
function extractIndexedRewritePrompts(parsed: JsonObject, expectedLen: number): string[] | undefined {
  const indexedPrompts = new Map<number, string>()
  for (const [key, value] of Object.entries(parsed)) {
    const match = INDEXED_KEY_PATTERN.exec(stripWhitespace(key))
    if (match === null) continue
    const segmentIdx = Number.parseInt(match[1] ?? '', 10)
    if (segmentIdx < 1 || segmentIdx > expectedLen) return undefined
    const normalized = normalizeRewritePromptItem(value)
    if (normalized === undefined) return undefined
    indexedPrompts.set(segmentIdx, normalized)
  }
  const prompts: string[] = []
  for (let idx = 1; idx <= expectedLen; idx++) {
    const prompt = indexedPrompts.get(idx)
    if (prompt === undefined) return undefined
    prompts.push(prompt)
  }
  return prompts
}

/**
 * Read numbered prose segments, joining each segment's continuation lines.
 * @param content - the reply text.
 * @param expectedLen - the required prompt count.
 * @returns the prompts ordered by number, or `undefined`.
 */
function extractNumberedRewritePromptsFromText(content: string, expectedLen: number): string[] | undefined {
  const lines = splitLines(content)
  if (lines.length === 0) return undefined

  const numberedSegments = new Map<number, string[]>()
  let currentIdx: number | undefined
  for (const rawLine of lines) {
    const line = stripWhitespace(rawLine)
    if (!line) continue
    const normalizedLine = line.replace(LIST_BULLET_PATTERN, '')
    const match = NUMBERED_LINE_PATTERN.exec(normalizedLine)
    if (match !== null) {
      const segmentIdx = Number.parseInt(match[1] ?? '', 10)
      if (segmentIdx < 1 || segmentIdx > expectedLen) return undefined
      numberedSegments.set(segmentIdx, [stripWhitespace(match[2] ?? '')])
      currentIdx = segmentIdx
      continue
    }
    if (currentIdx !== undefined) numberedSegments.get(currentIdx)?.push(normalizedLine)
  }

  const prompts: string[] = []
  for (let idx = 1; idx <= expectedLen; idx++) {
    const parts = numberedSegments.get(idx)
    if (parts === undefined) return undefined
    let prompt = stripWhitespace(parts.filter(part => part).join(' '))
    prompt = stripWhitespace(stripCharacters(stripCharacters(stripWhitespace(prompt), '"'), '\''))
    if (!prompt) return undefined
    prompts.push(prompt)
  }
  return prompts
}

/**
 * List the reply object and its nested rollout objects in the order the extractors try them.
 * @param parsed - the decoded reply object.
 * @returns the candidate objects.
 */
function candidateRolloutObjects(parsed: JsonObject): JsonObject[] {
  const candidates = [parsed]
  for (const key of NESTED_ROLLOUT_KEYS) {
    const value = dictGet(parsed, key)
    if (isJsonObject(value)) candidates.push(value)
  }
  return candidates
}

/**
 * Accept supported nested, indexed, and prose rollout formats.
 * @param parsed - the decoded reply object, empty when the reply is not JSON.
 * @param expectedLen - the required prompt count.
 * @param rawContent - the reply text for numbered prose.
 * @returns the prompts.
 * @throws PromptValueError when no supported format yields the required count.
 */
function extractRewriteSegmentPromptsLenient(parsed: JsonObject, expectedLen: number, rawContent: string): string[] {
  for (const candidate of candidateRolloutObjects(parsed)) {
    for (const key of PROMPT_LIST_KEYS) {
      const prompts = maybeExtractRewritePromptList(dictGet(candidate, key), expectedLen)
      if (prompts !== undefined) return prompts
    }
    const indexedPrompts = extractIndexedRewritePrompts(candidate, expectedLen)
    if (indexedPrompts !== undefined) return indexedPrompts
  }
  if (stripWhitespace(rawContent)) {
    const numberedPrompts = extractNumberedRewritePromptsFromText(rawContent, expectedLen)
    if (numberedPrompts !== undefined) return numberedPrompts
  }
  throw new PromptValueError(NO_SEGMENT_PROMPTS_MESSAGE)
}

/**
 * Read rollout metadata and segments, defaulting omitted metadata to the request.
 * @param parsed - the decoded reply object.
 * @param expectedLen - the required prompt count.
 * @param rawContent - the reply text.
 * @param presetId - the requested rollout id.
 * @param presetLabel - the requested rollout label.
 * @returns the rollout id, label, and prompts.
 */
function extractRewriteRollout(
  parsed: JsonObject,
  expectedLen: number,
  rawContent: string,
  presetId: string | null | undefined,
  presetLabel: string | null | undefined,
): [string, string, string[]] {
  const candidates = candidateRolloutObjects(parsed)
  for (const candidate of candidates) {
    try {
      return [
        requirePromptField(candidate, 'id'),
        requirePromptField(candidate, 'label'),
        requirePromptListField(candidate, 'segment_prompts', expectedLen),
      ]
    } catch (error) {
      // A candidate without canonical fields falls through to the lenient formats below.
      if (!(error instanceof PromptValueError)) throw error
    }
  }
  const rolloutId = candidates.map(candidate => optionalPromptField(candidate, 'id'))
    .find(value => value !== undefined) ?? resolveRolloutId(presetId)
  const rolloutLabel = candidates.map(candidate => optionalPromptField(candidate, 'label'))
    .find(value => value !== undefined) ?? resolveRolloutLabel(presetLabel)
  const prompts = extractRewriteSegmentPromptsLenient(parsed, expectedLen, rawContent)
  return [rolloutId, rolloutLabel, prompts]
}

/**
 * Parse a rollout from JSON or numbered prose and preserve useful parse errors.
 * @param responseContent - the reply text, or the serialized response when the text is empty.
 * @param expectedLen - the required prompt count.
 * @param presetId - the requested rollout id.
 * @param presetLabel - the requested rollout label.
 * @returns the rollout id, label, and prompts.
 * @throws PromptValueError with the JSON parse failure when no prompts were found in unparseable text.
 */
function extractRewriteRolloutFromContent(
  responseContent: string,
  expectedLen: number,
  presetId: string | null | undefined,
  presetLabel: string | null | undefined,
): [string, string, string[]] {
  let parsed: JsonObject = {}
  let parseError: PromptValueError | undefined
  try {
    parsed = parseJsonObject(responseContent)
  } catch (error) {
    if (!(error instanceof PromptValueError)) throw error
    parseError = error
  }
  try {
    return extractRewriteRollout(parsed, expectedLen, responseContent, presetId, presetLabel)
  } catch (error) {
    if (parseError !== undefined && error instanceof PromptValueError && error.message === NO_SEGMENT_PROMPTS_MESSAGE) {
      throw parseError
    }
    throw error
  }
}
