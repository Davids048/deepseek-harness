/**
 * Project event logging through one service-owned JSONL writer shared across projects.
 *
 * @module @dreamverse/project/project-logger
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { ProjectId } from './dependencies.ts'

/** Two-digit zero padding for date and time fields. */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Python `datetime.now(timezone.utc).strftime("%y%m%d_%H%M%S_%f")`, with microseconds from millisecond precision.
 * @param now - the instant to format.
 * @returns the log file name stem, for example `260924_085912_123000`.
 */
export function logFileTimestamp(now: Date): string {
  const date = `${pad2(now.getUTCFullYear() % 100)}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`
  const time = `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`
  return `${date}_${time}_${String(now.getUTCMilliseconds() * 1000).padStart(6, '0')}`
}

/**
 * Python `datetime.now(timezone.utc).isoformat()`: the fraction has six digits and is omitted when it is zero.
 * @param now - the instant to format.
 * @returns for example `2026-09-24T08:59:12.123000+00:00`.
 */
export function utcIsoTimestamp(now: Date = new Date()): string {
  const seconds = now.toISOString().slice(0, 19)
  const milliseconds = now.getUTCMilliseconds()
  const fraction = milliseconds === 0 ? '' : `.${String(milliseconds * 1000).padStart(6, '0')}`
  return `${seconds}${fraction}+00:00`
}

/**
 * Records project events in one JSONL file per service start, at `<root>/<hostname>/<yymmdd_HHMMSS_ffffff>.jsonl`.
 * Each entry starts with `ts`, `event`, `hostname`, and `project_id`, followed by the payload keys.
 */
export class ProjectEventLogger {
  readonly hostname: string
  readonly directory: string
  readonly path: string

  /**
   * Create the hostname directory and an empty log file; an existing file with the same name is an error.
   * @param rootDir - the configured project log root.
   * @param now - the service start time that names the file.
   */
  constructor(rootDir: string, now: Date = new Date()) {
    this.hostname = hostname()
    this.directory = join(rootDir, this.hostname)
    this.path = join(this.directory, `${logFileTimestamp(now)}.jsonl`)
    mkdirSync(this.directory, { recursive: true })
    writeFileSync(this.path, '', { flag: 'wx' })
  }

  /**
   * Append one event labeled with its project ID. The synchronous append keeps each entry whole and in call order.
   * @param event - the event name.
   * @param projectId - the project that produced the event.
   * @param payload - fields appended after the entry header; payload keys that repeat a header key replace its value.
   */
  writeEvent(event: string, projectId: ProjectId, payload?: Record<string, unknown>): void {
    const entry = { ts: utcIsoTimestamp(), event, hostname: this.hostname, project_id: projectId, ...payload }
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8')
  }
}
