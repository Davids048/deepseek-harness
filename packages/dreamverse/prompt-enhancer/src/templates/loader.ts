/**
 * Load prompt templates and retain the files that supplied them.
 *
 * @module @dreamverse/prompt-enhancer/templates/loader
 */
import { fileURLToPath } from 'node:url'

import { PromptRuntimeError } from '../utils/errors.ts'
import { isFile, isOsError, joinPath, normalizePath, pathSuffix, readTextFile, withSuffix } from '../utils/python-paths.ts'
import { PYTHON_SPACE_CLASS, stripWhitespace } from '../utils/python-text.ts'

/** Directory of the bundled templates, byte-identical copies of the reference `templates/resources/`. */
export const PACKAGED_TEMPLATE_DIRECTORY = normalizePath(fileURLToPath(new URL('../../resources/', import.meta.url)))

/** A template file wrapped as a Python triple-quoted `SYSTEM_PROMPT` assignment. */
const SYSTEM_PROMPT_WRAPPER = new RegExp(
  `^SYSTEM_PROMPT${PYTHON_SPACE_CLASS}*=${PYTHON_SPACE_CLASS}*('''|""")([\\s\\S]*?)\\1${PYTHON_SPACE_CLASS}*$`, 'u')

/** Template path overrides captured when one enhancer is constructed. */
export interface PromptTemplateOptions {
  /** `FASTVIDEO_PROMPT_ENHANCE_SYSTEM_PROMPT_PATH`; blank selects the packaged file. */
  readonly enhanceSystemPromptPath?: string | undefined
  /** `FASTVIDEO_PROMPT_AUTO_SYSTEM_PROMPT_PATH`. */
  readonly autoSystemPromptPath?: string | undefined
  /** `FASTVIDEO_PROMPT_REWRITE_ALL_SYSTEM_PROMPT_PATH`. */
  readonly rewriteAllSystemPromptPath?: string | undefined
  /** `FASTVIDEO_PROMPT_REWRITE_USER_SYSTEM_PROMPT_PATH`. */
  readonly rewriteUserSystemPromptPath?: string | undefined
}

/**
 * Select an explicit template path, or the packaged file.
 * @param filename - the packaged template file name.
 * @param override - the configured path override.
 * @returns the stripped override when it is nonblank, otherwise the packaged file.
 */
function resolveTemplatePath(filename: string, override: string | undefined): string {
  return stripWhitespace(override ?? '') || joinPath(PACKAGED_TEMPLATE_DIRECTORY, filename)
}

/**
 * Try the configured extension before its supported Markdown or text alternate.
 * @param path - the configured template path.
 * @returns the normalized candidate paths.
 */
export function promptFileCandidates(path: string): string[] {
  const candidatePaths = [normalizePath(path)]
  const suffix = pathSuffix(path)
  if (suffix === '.txt') candidatePaths.push(withSuffix(path, '.md'))
  else if (suffix === '.md') candidatePaths.push(withSuffix(path, '.txt'))
  return candidatePaths
}

/**
 * Read and normalize one candidate template file.
 * @param candidate - the file path.
 * @param promptName - the template name used in failure messages.
 * @returns the normalized template text.
 * @throws PromptRuntimeError when the file cannot be read.
 */
function readTemplate(candidate: string, promptName: string): string {
  try {
    return normalizePromptFileText(readTextFile(candidate))
  } catch (error) {
    if (isOsError(error)) throw new PromptRuntimeError(`Failed to read ${promptName} system prompt: ${candidate}`, { cause: error })
    throw error
  }
}

/**
 * Load a required template and record the path that supplied it.
 * @param path - the configured template path.
 * @param promptName - the template name used in failure messages.
 * @returns the template text and its source path.
 * @throws PromptRuntimeError when no candidate exists, or the first existing candidate is unreadable or empty.
 */
function loadPromptRequiredWithPath(path: string, promptName: string): [string, string] {
  const candidatePaths = promptFileCandidates(path)
  for (const candidate of candidatePaths) {
    if (!isFile(candidate)) continue
    const text = readTemplate(candidate, promptName)
    if (!text) throw new PromptRuntimeError(`${promptName} system prompt file is empty: ${candidate}`)
    return [text, candidate]
  }
  throw new PromptRuntimeError(`${promptName} system prompt file not found. Tried: ${candidatePaths.join(', ')}`)
}

/**
 * Use a template file when populated; otherwise reuse the supplied template.
 * @param path - the configured template path.
 * @param promptName - the template name used in failure messages.
 * @param fallbackPromptText - the text used when no candidate is populated.
 * @param fallbackPromptSourcePath - the source path reported with the fallback text.
 * @returns the template text and its source path.
 */
function loadPromptWithPromptFallback(
  path: string,
  promptName: string,
  fallbackPromptText: string,
  fallbackPromptSourcePath: string,
): [string, string] {
  for (const candidate of promptFileCandidates(path)) {
    if (!isFile(candidate)) continue
    const text = readTemplate(candidate, promptName)
    if (text) return [text, candidate]
  }
  return [fallbackPromptText, fallbackPromptSourcePath]
}

/**
 * Read plain template text or a triple-quoted `SYSTEM_PROMPT` assignment.
 * @param text - the file text.
 * @returns the stripped template body, or `''` for a blank file.
 */
export function normalizePromptFileText(text: string): string {
  const normalized = stripWhitespace(text)
  if (!normalized) return ''
  const wrapperMatch = SYSTEM_PROMPT_WRAPPER.exec(normalized)
  if (wrapperMatch !== null) return stripWhitespace(wrapperMatch[2] ?? '')
  return normalized
}

/** Loaded template text and the files that supplied it; the files are read once, at construction. */
export class PromptTemplates {
  ref2vaSystemPrompt: string
  ref2vaSystemPromptSourcePath: string
  enhanceSystemPrompt: string
  enhanceSystemPromptSourcePath: string
  autoSystemPrompt: string
  autoSystemPromptSourcePath: string
  rewriteAllSystemPrompt: string
  rewriteAllSystemPromptSourcePath: string
  rewriteUserSystemPrompt: string
  rewriteUserSystemPromptSourcePath: string

  /**
   * Select this enhancer's template files, then load their text. The Ref2VA template has no path override.
   * @param options - the path overrides.
   * @throws PromptRuntimeError when a required template is missing, unreadable, or empty.
   */
  constructor(options: PromptTemplateOptions) {
    [this.ref2vaSystemPrompt, this.ref2vaSystemPromptSourcePath] = loadPromptRequiredWithPath(
      joinPath(PACKAGED_TEMPLATE_DIRECTORY, 'ref2va_system_prompt.md'), 'reference video')
    ;[this.enhanceSystemPrompt, this.enhanceSystemPromptSourcePath] = loadPromptRequiredWithPath(
      resolveTemplatePath('next_segment_system_prompt.md', options.enhanceSystemPromptPath), 'next-segment')
    ;[this.autoSystemPrompt, this.autoSystemPromptSourcePath] = loadPromptRequiredWithPath(
      resolveTemplatePath('auto_extension_system_prompt.md', options.autoSystemPromptPath), 'auto-extension')
    ;[this.rewriteAllSystemPrompt, this.rewriteAllSystemPromptSourcePath] = loadPromptRequiredWithPath(
      resolveTemplatePath('rewrite_window_system_prompt.md', options.rewriteAllSystemPromptPath), 'rewrite-window')
    ;[this.rewriteUserSystemPrompt, this.rewriteUserSystemPromptSourcePath] = loadPromptWithPromptFallback(
      resolveTemplatePath('rewrite_user_system_prompt.md', options.rewriteUserSystemPromptPath),
      'rewrite-user',
      this.rewriteAllSystemPrompt,
      this.rewriteAllSystemPromptSourcePath,
    )
  }
}
