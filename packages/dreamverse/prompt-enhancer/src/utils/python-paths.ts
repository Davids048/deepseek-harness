/**
 * Python `pathlib` semantics for prompt template paths.
 *
 * The reference reports template source paths as `str(Path(...))`, tries `.md`/`.txt` alternates with
 * `Path.with_suffix`, and reads files as UTF-8 text with universal newlines.
 * These helpers reproduce those strings and reads so reported paths and loaded text match the reference.
 *
 * @module @dreamverse/prompt-enhancer/utils/python-paths
 */
import fs from 'node:fs'

import { PromptValueError, errorText } from './errors.ts'

/** `errno` codes for which Python `Path.is_file()` returns false instead of raising. */
const IGNORED_STAT_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP'])

/**
 * Normalize a POSIX path like Python `str(PurePosixPath(path))`: collapse repeated separators, drop `.` components
 * and trailing separators, and keep `..` components.
 * @param path - the path text.
 * @returns the normalized path, or `.` for an empty path.
 */
export function normalizePath(path: string): string {
  if (path === '') return '.'
  const root = path.startsWith('//') && !path.startsWith('///') ? '//' : path.startsWith('/') ? '/' : ''
  const parts = path.split('/').filter(part => part !== '' && part !== '.')
  return root + parts.join('/') || '.'
}

/**
 * Join a directory and a file name like Python `Path(directory) / name`.
 * @param directory - the directory path.
 * @param name - a relative file name.
 * @returns the normalized joined path.
 */
export function joinPath(directory: string, name: string): string {
  return normalizePath(directory === '' ? name : `${directory}/${name}`)
}

/**
 * Split a path into its parent prefix and final component.
 * @param path - the path text.
 * @returns the normalized prefix including its trailing separator, and the final component.
 */
function splitName(path: string): { prefix: string; name: string } {
  const normalized = normalizePath(path)
  const index = normalized.lastIndexOf('/')
  return { prefix: normalized.slice(0, index + 1), name: normalized.slice(index + 1) }
}

/**
 * Read the final suffix like Python `PurePath.suffix`.
 * @param path - the path text.
 * @returns the suffix including its dot, or `''`.
 */
export function pathSuffix(path: string): string {
  const { name } = splitName(path)
  const index = name.lastIndexOf('.')
  return index > 0 && index < name.length - 1 ? name.slice(index) : ''
}

/**
 * Replace the final suffix like Python `PurePath.with_suffix`.
 * @param path - the path text.
 * @param suffix - the replacement suffix including its dot.
 * @returns the normalized path with the replaced or appended suffix.
 */
export function withSuffix(path: string, suffix: string): string {
  const { prefix, name } = splitName(path)
  const oldSuffix = pathSuffix(path)
  return `${prefix}${oldSuffix ? name.slice(0, -oldSuffix.length) : name}${suffix}`
}

/**
 * Report whether a Node failure is an operating-system error, which Python raises as `OSError`.
 * @param error - the caught value.
 * @returns true for a Node system error carrying a `syscall`.
 */
export function isOsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).syscall === 'string'
}

/**
 * Report whether a path is a regular file like Python `Path.is_file()`, which follows symbolic links.
 * @param path - the path to check.
 * @returns true for a regular file; false for a missing path or a non-file.
 * @throws the stat failure for errors other than missing, not-a-directory, bad descriptor, or symlink loop.
 */
export function isFile(path: string): boolean {
  try {
    return fs.statSync(path).isFile()
  } catch (error) {
    if (isOsError(error) && IGNORED_STAT_ERRORS.has(error.code ?? '')) return false
    throw error
  }
}

/**
 * Read a file like Python `Path.read_text(encoding="utf-8")`: strict UTF-8 decoding, then `\r\n` and `\r`
 * become `\n`.
 * @param path - the file to read.
 * @returns the decoded text.
 * @throws the read failure as an OS error, or PromptValueError for invalid UTF-8 as Python raises `ValueError`.
 */
export function readTextFile(path: string): string {
  const bytes = fs.readFileSync(path)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (error) {
    throw new PromptValueError(`'utf-8' codec can't decode ${path}: ${errorText(error)}`, { cause: error })
  }
  return text.replace(/\r\n?/g, '\n')
}
