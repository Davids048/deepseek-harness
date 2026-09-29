/**
 * Load prompt templates and retain their configured and source paths.
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

/** Template path choices captured when one enhancer is constructed. */
export interface PromptTemplateOptions {
  /** Developer mode reads each template from `devtoolsPromptDirectory` and falls back to the packaged file. */
  readonly devtoolsEnabled: boolean
  /** The developer overlay directory; the reference uses `apps/dreamverse/dreamverse/prompts.local`. */
  readonly devtoolsPromptDirectory: string
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
 * Select an explicit template path, or the packaged file with its developer overlay.
 * @param filename - the packaged template file name.
 * @param override - the configured path override.
 * @param options - the developer-mode choice and overlay directory.
 * @returns the configured path and its fallback path.
 */
function resolveTemplatePaths(
  filename: string,
  override: string | undefined,
  options: PromptTemplateOptions,
): [string, string | null] {
  const explicitPath = stripWhitespace(override ?? '')
  if (explicitPath) return [explicitPath, null]
  const packagedPath = joinPath(PACKAGED_TEMPLATE_DIRECTORY, filename)
  if (options.devtoolsEnabled) return [joinPath(options.devtoolsPromptDirectory, filename), packagedPath]
  return [packagedPath, null]
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
 * List the configured path's candidates followed by the fallback path's candidates, without duplicates.
 * @param path - the configured template path.
 * @param fallbackPath - the packaged fallback path.
 * @returns the candidate paths in load order.
 */
function templateCandidates(path: string, fallbackPath: string | null): string[] {
  const candidatePaths: string[] = []
  for (const currentPath of [path, fallbackPath]) {
    if (!currentPath) continue
    for (const candidate of promptFileCandidates(currentPath)) {
      if (!candidatePaths.includes(candidate)) candidatePaths.push(candidate)
    }
  }
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
 * @param fallbackPath - the packaged fallback path.
 * @returns the template text and its source path.
 * @throws PromptRuntimeError when no candidate exists, or the first existing candidate is unreadable or empty.
 */
function loadPromptRequiredWithPath(path: string, promptName: string, fallbackPath: string | null): [string, string] {
  const candidatePaths = templateCandidates(path, fallbackPath)
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
 * @param fallbackPath - the packaged fallback path.
 * @returns the template text and its source path.
 */
function loadPromptWithPromptFallback(
  path: string,
  promptName: string,
  fallbackPromptText: string,
  fallbackPromptSourcePath: string,
  fallbackPath: string | null,
): [string, string] {
  for (const candidate of templateCandidates(path, fallbackPath)) {
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

/**
 * Own configured template paths, loaded text, and the files that supplied the text.
 *
 * Paths are selected once at construction; `reload` and the editor use the retained paths. Fields are mutable so
 * the editor and tests can redirect them like the reference's attributes.
 */
export class PromptTemplates {
  enhanceSystemPromptPath: string
  enhanceSystemPromptFallbackPath: string | null
  autoSystemPromptPath: string
  autoSystemPromptFallbackPath: string | null
  rewriteAllSystemPromptPath: string
  rewriteAllSystemPromptFallbackPath: string | null
  rewriteUserSystemPromptPath: string
  rewriteUserSystemPromptFallbackPath: string | null
  ref2vaSystemPromptPath: string
  ref2vaSystemPromptFallbackPath: string | null

  ref2vaSystemPrompt!: string
  ref2vaSystemPromptSourcePath!: string
  enhanceSystemPrompt!: string
  enhanceSystemPromptSourcePath!: string
  autoSystemPrompt!: string
  autoSystemPromptSourcePath!: string
  rewriteAllSystemPrompt!: string
  rewriteAllSystemPromptSourcePath!: string
  rewriteUserSystemPrompt!: string
  rewriteUserSystemPromptSourcePath!: string

  /**
   * Select this enhancer's template files, then load their text.
   * @param options - the developer-mode choice, overlay directory, and path overrides.
   * @throws PromptRuntimeError when a required template is missing, unreadable, or empty.
   */
  constructor(options: PromptTemplateOptions) {
    [this.enhanceSystemPromptPath, this.enhanceSystemPromptFallbackPath] = resolveTemplatePaths(
      'next_segment_system_prompt.md', options.enhanceSystemPromptPath, options)
    ;[this.autoSystemPromptPath, this.autoSystemPromptFallbackPath] = resolveTemplatePaths(
      'auto_extension_system_prompt.md', options.autoSystemPromptPath, options)
    ;[this.rewriteAllSystemPromptPath, this.rewriteAllSystemPromptFallbackPath] = resolveTemplatePaths(
      'rewrite_window_system_prompt.md', options.rewriteAllSystemPromptPath, options)
    ;[this.rewriteUserSystemPromptPath, this.rewriteUserSystemPromptFallbackPath] = resolveTemplatePaths(
      'rewrite_user_system_prompt.md', options.rewriteUserSystemPromptPath, options)
    // The reference template has no path override; developer mode still overlays it.
    this.ref2vaSystemPromptPath = joinPath(PACKAGED_TEMPLATE_DIRECTORY, 'ref2va_system_prompt.md')
    this.ref2vaSystemPromptFallbackPath = null
    if (options.devtoolsEnabled) {
      this.ref2vaSystemPromptFallbackPath = this.ref2vaSystemPromptPath
      this.ref2vaSystemPromptPath = joinPath(options.devtoolsPromptDirectory, 'ref2va_system_prompt.md')
    }
    this.reload()
  }

  /**
   * Load template text and retain each resolved source path.
   * @throws PromptRuntimeError when a required template is missing, unreadable, or empty.
   */
  reload(): void {
    ;[this.ref2vaSystemPrompt, this.ref2vaSystemPromptSourcePath] = loadPromptRequiredWithPath(
      this.ref2vaSystemPromptPath, 'reference video', this.ref2vaSystemPromptFallbackPath)
    ;[this.enhanceSystemPrompt, this.enhanceSystemPromptSourcePath] = loadPromptRequiredWithPath(
      this.enhanceSystemPromptPath, 'next-segment', this.enhanceSystemPromptFallbackPath)
    ;[this.autoSystemPrompt, this.autoSystemPromptSourcePath] = loadPromptRequiredWithPath(
      this.autoSystemPromptPath, 'auto-extension', this.autoSystemPromptFallbackPath)
    ;[this.rewriteAllSystemPrompt, this.rewriteAllSystemPromptSourcePath] = loadPromptRequiredWithPath(
      this.rewriteAllSystemPromptPath, 'rewrite-window', this.rewriteAllSystemPromptFallbackPath)
    ;[this.rewriteUserSystemPrompt, this.rewriteUserSystemPromptSourcePath] = loadPromptWithPromptFallback(
      this.rewriteUserSystemPromptPath,
      'rewrite-user',
      this.rewriteAllSystemPrompt,
      this.rewriteAllSystemPromptSourcePath,
      this.rewriteUserSystemPromptFallbackPath,
    )
  }
}
