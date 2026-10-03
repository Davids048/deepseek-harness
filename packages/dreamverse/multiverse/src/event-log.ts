/**
 * The multiverse log: one JSONL file per director start, at `<root>/<hostname>/<yymmdd_HHMMSS_ffffff>.jsonl`, that
 * records every model request the director sends and what the model returned.
 *
 * @module @dreamverse/multiverse/event-log
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { ProjectId } from '@dreamverse/project-store'

/** The events of the multiverse log. */
export type MultiverseLogEvent =
  | 'prompt_enhance_request'
  | 'prompt_enhance_response'
  | 'branch_proposal_request'
  | 'branch_proposal_response'

/**
 * Format a UTC instant as `yymmdd_HHMMSS_ffffff`, with microseconds from millisecond precision.
 * @param now - the instant to format.
 * @returns for example `260924_085912_123000`.
 */
function logFileStem(now: Date): string {
  const digits = now.toISOString().replace(/\D/g, '')
  return `${digits.slice(2, 8)}_${digits.slice(8, 14)}_${digits.slice(14, 17)}000`
}

/** Appends multiverse events to one JSONL file; each synchronous append writes one complete line. */
export class MultiverseEventLog {
  /** The log file. */
  readonly path: string
  private readonly host = hostname()

  /**
   * Create the empty log file.
   * @param root - the log root; the file goes in its `<hostname>` directory.
   * @param now - the start time that names the file.
   * @throws Error when the directory or file cannot be created, or the file already exists.
   */
  constructor(root: string, now: Date = new Date()) {
    const directory = join(root, this.host)
    mkdirSync(directory, { recursive: true })
    this.path = join(directory, `${logFileStem(now)}.jsonl`)
    writeFileSync(this.path, '', { flag: 'wx' })
  }

  /**
   * Append one event as a JSON line of `ts` (ISO-8601 UTC), `event`, `hostname`, `multiverse_id`, and the payload fields.
   * @param event - the event name.
   * @param multiverseId - the multiverse that the event concerns.
   * @param payload - the event fields, including `node_id` when the event concerns a node.
   * @throws Error when the append fails.
   */
  write(event: MultiverseLogEvent, multiverseId: ProjectId, payload: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), event, hostname: this.host, multiverse_id: multiverseId, ...payload }
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8')
  }
}
