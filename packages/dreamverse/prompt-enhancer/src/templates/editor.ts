/**
 * Expose editable prompt fields and persist template text with backups.
 *
 * @module @dreamverse/prompt-enhancer/templates/editor
 */
import fs from 'node:fs'

import { PromptRuntimeError, PromptValueError } from '../utils/errors.ts'
import { isFile, isOsError, normalizePath, pathParent, pathSuffixes, readTextFile, withName } from '../utils/python-paths.ts'
import { stripWhitespace } from '../utils/python-text.ts'
import { normalizePromptFileText, promptFileCandidates, type PromptTemplates } from './loader.ts'

/** Template text and editor save paths, keyed by the reference prompt configuration fields. */
export interface TemplateConfig {
  ref2va_system_prompt: string
  ref2va_system_prompt_path: string
  next_segment_system_prompt_path: string
  auto_extension_system_prompt_path: string
  rewrite_window_system_prompt_path: string
  rewrite_user_system_prompt_path: string
  next_segment_system_prompt: string
  auto_extension_system_prompt: string
  rewrite_window_system_prompt: string
  rewrite_user_system_prompt: string
}

/** Template edits keyed by the reference prompt configuration fields; `null` or omission keeps a template. */
export interface TemplateUpdate {
  readonly next_segment_system_prompt?: string | null | undefined
  readonly auto_extension_system_prompt?: string | null | undefined
  readonly rewrite_window_system_prompt?: string | null | undefined
  readonly rewrite_user_system_prompt?: string | null | undefined
  readonly ref2va_system_prompt?: string | null | undefined
}

/**
 * Expose template text and the paths displayed by the prompt editor.
 * @param templates - the loaded templates.
 * @returns the reference snake_case template fields in reference order.
 */
export function getTemplateConfig(templates: PromptTemplates): TemplateConfig {
  return {
    ref2va_system_prompt: templates.ref2vaSystemPrompt,
    ref2va_system_prompt_path: templates.ref2vaSystemPromptSourcePath,
    next_segment_system_prompt_path: templates.enhanceSystemPromptSourcePath,
    auto_extension_system_prompt_path: templates.autoSystemPromptSourcePath,
    rewrite_window_system_prompt_path: templates.rewriteAllSystemPromptSourcePath,
    rewrite_user_system_prompt_path: resolvePromptSavePath(
      templates.rewriteUserSystemPromptPath, templates.rewriteUserSystemPromptFallbackPath),
    next_segment_system_prompt: templates.enhanceSystemPrompt,
    auto_extension_system_prompt: templates.autoSystemPrompt,
    rewrite_window_system_prompt: templates.rewriteAllSystemPrompt,
    rewrite_user_system_prompt: templates.rewriteUserSystemPrompt,
  }
}

/**
 * Raise Python's `UnicodeEncodeError` text when text contains a lone surrogate, which UTF-8 cannot encode.
 * @param text - the template text to save.
 * @throws PromptValueError naming the first run of lone surrogates by code point position.
 */
function checkUtf8Encodable(text: string): void {
  let position = 0
  let runStart = -1
  let firstCode = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    const surrogate = code >= 0xd800 && code <= 0xdfff
    if (surrogate && runStart < 0) {
      runStart = position
      firstCode = code
    } else if (!surrogate && runStart >= 0) break
    position++
  }
  if (runStart < 0) return
  const runEnd = position
  if (runEnd - runStart === 1) {
    throw new PromptValueError(`'utf-8' codec can't encode character '\\u${firstCode.toString(16)}' `
      + `in position ${runStart}: surrogates not allowed`)
  }
  throw new PromptValueError(`'utf-8' codec can't encode characters in position ${runStart}-${runEnd - 1}: `
    + 'surrogates not allowed')
}

/**
 * Validate every supplied template before writing; the caller reloads shared text.
 *
 * A file failure can leave earlier saves applied. Each changed file keeps its normal backup; this operation does not
 * roll back completed writes.
 * @param templates - the loaded templates whose retained paths receive the edits.
 * @param update - the template edits.
 * @throws PromptValueError for blank text or text that UTF-8 cannot encode; PromptRuntimeError for a write failure.
 */
export function saveTemplates(templates: PromptTemplates, update: TemplateUpdate): void {
  const templateUpdates = [
    ['ref2va_system_prompt', update.ref2va_system_prompt, templates.ref2vaSystemPromptPath,
      templates.ref2vaSystemPromptFallbackPath, 'reference video', false],
    ['next_segment_system_prompt', update.next_segment_system_prompt, templates.enhanceSystemPromptPath,
      templates.enhanceSystemPromptFallbackPath, 'next-segment', false],
    ['auto_extension_system_prompt', update.auto_extension_system_prompt, templates.autoSystemPromptPath,
      templates.autoSystemPromptFallbackPath, 'auto-extension', false],
    ['rewrite_window_system_prompt', update.rewrite_window_system_prompt, templates.rewriteAllSystemPromptPath,
      templates.rewriteAllSystemPromptFallbackPath, 'rewrite-window', false],
    ['rewrite_user_system_prompt', update.rewrite_user_system_prompt, templates.rewriteUserSystemPromptPath,
      templates.rewriteUserSystemPromptFallbackPath, 'rewrite-user', true],
  ] as const
  const validatedSaves: [string, string | null, string, string][] = []
  for (const [field, promptText, path, fallbackPath, promptName, allowTemplateFallback] of templateUpdates) {
    if (promptText === null || promptText === undefined) continue
    const normalized = stripWhitespace(promptText)
    if (!normalized || (!allowTemplateFallback && !normalizePromptFileText(normalized))) {
      throw new PromptValueError(`${field} cannot be empty.`)
    }
    // Check encoding before a write can truncate a template file.
    checkUtf8Encodable(normalized)
    validatedSaves.push([path, fallbackPath, normalized, promptName])
  }
  for (const [path, fallbackPath, promptText, promptName] of validatedSaves) {
    savePrompt(resolvePromptSavePath(path, fallbackPath), promptText, promptName)
  }
}

/**
 * Save template text, backing up a differing file before replacement.
 * @param path - the destination file.
 * @param promptText - the validated template text.
 * @param promptName - the template name used in failure messages.
 * @throws PromptRuntimeError when reading, backing up, or writing the file fails.
 */
function savePrompt(path: string, promptText: string, promptName: string): void {
  const promptPath = normalizePath(path)
  fs.mkdirSync(pathParent(promptPath), { recursive: true })
  const normalizedPromptText = `${stripWhitespace(promptText)}\n`
  try {
    if (isFile(promptPath)) {
      const currentText = readTextFile(promptPath)
      if (currentText !== normalizedPromptText) {
        fs.cpSync(promptPath, buildPromptBackupPath(promptPath), { preserveTimestamps: true })
      }
    }
    fs.writeFileSync(promptPath, normalizedPromptText, 'utf8')
  } catch (error) {
    if (isOsError(error)) {
      throw new PromptRuntimeError(`Failed to save ${promptName} system prompt: ${promptPath}`, { cause: error })
    }
    throw error
  }
}

/**
 * Name a backup `<stem>.<YYYYmmdd_HHMMSS>.bak<suffixes>` beside the template, using local time.
 * @param promptPath - the template file.
 * @returns the backup path.
 */
function buildPromptBackupPath(promptPath: string): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const suffix = pathSuffixes(promptPath).join('')
  const name = normalizePath(promptPath).split('/').at(-1) ?? ''
  const stem = suffix ? name.slice(0, -suffix.length) : name
  return withName(promptPath, `${stem}.${timestamp}.bak${suffix}`)
}

/**
 * Choose the existing fallback file when the configured path is absent.
 * @param path - the configured template path.
 * @param fallbackPath - the packaged fallback path.
 * @returns the normalized save destination.
 */
function resolvePromptSavePath(path: string, fallbackPath: string | null): string {
  const candidate = normalizePath(path)
  if (isFile(candidate) || fallbackPath === null) return candidate
  for (const fallbackCandidate of promptFileCandidates(fallbackPath)) {
    if (isFile(fallbackCandidate)) return fallbackCandidate
  }
  return candidate
}
