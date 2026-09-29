/**
 * Port of the reference `curated_presets_router` (`dreamverse/routes/presets.py`): `GET /curated-presets` merges the
 * fallback catalog with the overlay catalog, and `POST /curated-presets/append` appends one preset to the overlay
 * file. The browser server serves these routes only when developer tools are enabled.
 *
 * @module @dreamverse/browser-server/curated-presets-routes
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { bodyObject, decodeJsonBody, sendJson, type ValidationIssue } from './http.ts'

/** The curated preset catalog files of the reference `ApplicationSettings`. */
export interface CuratedPresetsFiles {
  /** The catalog that appends write. */
  filePath: string
  /** The catalog whose presets the overlay catalog replaces by ID, or `null`. */
  fallbackFilePath: string | null
}

/** One catalog entry: any JSON object; entries that are not objects are kept in the file and skipped by merges. */
type CuratedPreset = Record<string, unknown>

/** The validated `AppendCuratedPresetRequest` body. */
interface AppendCuratedPresetRequest {
  id: string
  label: string
  segmentPrompts: string[]
}

/** A reference `RuntimeError` of the catalog helpers; the routes answer 500 with its message as `detail`. */
class CatalogError extends Error {}

/** The characters for which Python `str.isspace()` is true. */
const PYTHON_WHITESPACE = '[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'

/** The `stat` error codes that Python 3.12 `Path.is_file()` reports as a missing file. */
const STAT_MISSING_CODES = new Set(['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP'])

/** Python `str.strip()` without arguments. */
const PYTHON_STRIP_PATTERN = new RegExp(`^${PYTHON_WHITESPACE}+|${PYTHON_WHITESPACE}+$`, 'gu')

/** Python `str.strip()`. */
function pythonStrip(text: string): string {
  return text.replace(PYTHON_STRIP_PATTERN, '')
}

/** Python `str()` of a JSON value, which the reference applies to each preset's `id`. */
function pythonStr(value: unknown): string {
  if (value === null) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'string') return value
  return typeof value === 'number' ? String(value) : JSON.stringify(value)
}

/** Whether a parsed JSON value is a Python `dict`. */
function isJsonObject(value: unknown): value is CuratedPreset {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The reference `_sanitize_preset_id`. */
function sanitizePresetId(raw: string): string {
  const normalized = pythonStrip(raw).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return normalized || 'custom_editable'
}

/**
 * The reference `_load_curated_presets_file`: an absent path or a path that is not a regular file reads as empty.
 * Undecodable UTF-8 throws a plain `TypeError`, like the reference's uncaught `UnicodeDecodeError`.
 * @throws CatalogError for unreadable files, invalid JSON, and JSON other than an array.
 */
function loadCuratedPresetsFile(path: string): unknown[] {
  let isFile: boolean
  try {
    isFile = statSync(path).isFile()
  } catch (error) {
    // Python 3.12 `Path.is_file()` answers false for these `stat` failures and raises for the others.
    if (!STAT_MISSING_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error
    isFile = false
  }
  if (!isFile) return []
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    throw new CatalogError(`Failed to read curated presets file: ${path}`)
  }
  // `ignoreBOM` keeps a leading BOM in the text, where the reference's `json.load` rejects it as invalid JSON.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new CatalogError(`Invalid JSON in curated presets file: ${path}`)
  }
  if (Array.isArray(payload)) return payload
  throw new CatalogError(`Curated presets file must contain a JSON array: ${path}`)
}

/**
 * The reference `_write_curated_presets_file`: `json.dump(..., ensure_ascii=False, indent=2)` plus a newline. A
 * failure to create the parent directory propagates as a plain error, like the reference's uncaught `OSError`.
 * @throws CatalogError when writing the file fails.
 */
function writeCuratedPresetsFile(path: string, presets: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, `${JSON.stringify(presets, null, 2)}\n`)
  } catch {
    throw new CatalogError(`Failed to write curated presets file: ${path}`)
  }
}

/**
 * The reference `_merge_curated_presets`: copies of the object entries with a non-blank `id`, where a later entry
 * replaces an earlier entry with the same case-insensitive ID in place.
 */
function mergeCuratedPresets(...presetGroups: unknown[][]): CuratedPreset[] {
  const merged: CuratedPreset[] = []
  const indexById = new Map<string, number>()
  for (const item of presetGroups.flat()) {
    if (!isJsonObject(item)) continue
    const presetId = pythonStrip(pythonStr(Object.hasOwn(item, 'id') ? item.id : ''))
    if (!presetId) continue
    const normalizedId = presetId.toLowerCase()
    const index = indexById.get(normalizedId)
    if (index === undefined) {
      indexById.set(normalizedId, merged.length)
      merged.push({ ...item })
    } else {
      merged[index] = { ...item }
    }
  }
  return merged
}

/** Load both catalogs in the reference order: the overlay catalog, then the fallback catalog. */
function loadCatalogs(files: CuratedPresetsFiles): { overlayPresets: unknown[]; fallbackPresets: unknown[] } {
  const overlayPresets = loadCuratedPresetsFile(files.filePath)
  const fallbackPresets = files.fallbackFilePath === null ? [] : loadCuratedPresetsFile(files.fallbackFilePath)
  return { overlayPresets, fallbackPresets }
}

/**
 * Validate a JSON object body against `AppendCuratedPresetRequest` with pydantic's rules, reporting fields in
 * declaration order.
 * @returns the request, or every validation issue in field order.
 */
function validateAppendRequest(body: Record<string, unknown>): { request: AppendCuratedPresetRequest } | { issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = []
  for (const field of ['id', 'label'] as const) {
    const input = body[field]
    if (!Object.hasOwn(body, field)) issues.push({ type: 'missing', loc: ['body', field], msg: 'Field required', input: body })
    else if (typeof input !== 'string') issues.push({ type: 'string_type', loc: ['body', field], msg: 'Input should be a valid string', input })
  }
  const prompts = body.segment_prompts
  if (!Object.hasOwn(body, 'segment_prompts')) {
    issues.push({ type: 'missing', loc: ['body', 'segment_prompts'], msg: 'Field required', input: body })
  } else if (!Array.isArray(prompts)) {
    issues.push({ type: 'list_type', loc: ['body', 'segment_prompts'], msg: 'Input should be a valid list', input: prompts })
  } else {
    prompts.forEach((input: unknown, index) => {
      if (typeof input !== 'string') issues.push({ type: 'string_type', loc: ['body', 'segment_prompts', index], msg: 'Input should be a valid string', input })
    })
  }
  if (issues.length > 0) return { issues }
  return { request: { id: body.id as string, label: body.label as string, segmentPrompts: prompts as string[] } }
}

/**
 * Serve `GET /curated-presets`: the merged catalogs and both file paths; a catalog error answers 500 with `detail`.
 * @param response - the browser response.
 * @param files - the catalog paths.
 */
export function getCuratedPresets(response: ServerResponse, files: CuratedPresetsFiles): void {
  let presets: CuratedPreset[]
  try {
    const { overlayPresets, fallbackPresets } = loadCatalogs(files)
    presets = mergeCuratedPresets(fallbackPresets, overlayPresets)
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error
    sendJson(response, 500, { detail: error.message })
    return
  }
  sendJson(response, 200, { presets, count: presets.length, file_path: files.filePath, fallback_file_path: files.fallbackFilePath })
}

/**
 * Serve `POST /curated-presets/append` with the reference checks in order: 422 for an invalid body, 400 for a blank
 * label or fewer than two non-blank prompts, 500 for a catalog error, 409 for an existing ID, and 400 for text that
 * is not valid UTF-8; then append the preset to the overlay catalog.
 * @param request - the browser request.
 * @param response - the browser response.
 * @param files - the catalog paths.
 */
export async function appendCuratedPreset(request: IncomingMessage, response: ServerResponse, files: CuratedPresetsFiles): Promise<void> {
  const decoded = await decodeJsonBody(request)
  const object = 'issue' in decoded ? decoded : bodyObject(decoded.value)
  if ('issue' in object) {
    sendJson(response, 422, { detail: [object.issue] })
    return
  }
  const validated = validateAppendRequest(object.body)
  if ('issues' in validated) {
    sendJson(response, 422, { detail: validated.issues })
    return
  }
  const presetId = sanitizePresetId(validated.request.id)
  const label = pythonStrip(validated.request.label)
  if (!label) {
    sendJson(response, 400, { detail: 'label must be non-empty.' })
    return
  }
  const prompts = validated.request.segmentPrompts.map(pythonStrip).filter(prompt => prompt)
  if (prompts.length < 2) {
    sendJson(response, 400, { detail: 'segment_prompts must contain at least 2 non-empty prompts.' })
    return
  }
  try {
    const { overlayPresets, fallbackPresets } = loadCatalogs(files)
    const existingIds = new Set(mergeCuratedPresets(fallbackPresets, overlayPresets)
      .map(item => pythonStrip(pythonStr(Object.hasOwn(item, 'id') ? item.id : '')).toLowerCase()))
    if (existingIds.has(presetId.toLowerCase())) {
      sendJson(response, 409, { detail: `Preset id already exists in curated presets file: ${presetId}` })
      return
    }
    // A lone surrogate fails Python's UTF-8 encoding before the writer truncates the stored catalog.
    if (![label, ...prompts].every(text => text.isWellFormed())) {
      sendJson(response, 400, { detail: 'label and segment_prompts must contain valid UTF-8 text.' })
      return
    }
    const nextEntry = { id: presetId, label, segment_prompts: prompts }
    overlayPresets.push(nextEntry)
    writeCuratedPresetsFile(files.filePath, overlayPresets)
    sendJson(response, 200, {
      type: 'curated_preset_appended',
      preset: nextEntry,
      count: mergeCuratedPresets(fallbackPresets, overlayPresets).length,
      file_path: files.filePath,
      fallback_file_path: files.fallbackFilePath,
    })
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error
    sendJson(response, 500, { detail: error.message })
  }
}
