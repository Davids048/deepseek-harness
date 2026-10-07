/**
 * Chat sessions as Project's agent tools see them: the project each session is bound to (saved to one file per
 * session, so a restart continues the session), and the work a session's tool calls wait for (chat images still being
 * imported).
 *
 * Calls nothing else in Project. Called by the service (`bindSession`, `sessionProject`, `holdToolCalls`) and by the
 * agent tools module.
 *
 * @module @dv/project/sessions
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectId, SessionId } from './types.ts'

/**
 * The project of a session file, or null for a file without a binding. The file is `{"project": <ProjectId>}`; the
 * API's workspace listing reads the same field.
 * @param path - the session file.
 * @returns the bound project, or null.
 * @throws Error when the file is not a JSON object whose `project` is a string or null.
 */
function boundProject(path: string): ProjectId | null {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const value = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['project'] : undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`Session file ${path} is not a session binding.`)
  return brandString<ProjectId>(value)
}

/** Session bindings and held tool calls. */
export class Sessions {
  private readonly projects = new Map<SessionId, ProjectId | null>()
  private readonly holds = new Map<SessionId, Promise<unknown>>()

  /**
   * @param root - the directory holding one `<encoded session>.json` per bound session; created on the first binding.
   */
  constructor(private readonly root: string) {}

  /**
   * Bind a session to a project and save the binding.
   * @param session - the chat session.
   * @param project - the project.
   */
  bind(session: SessionId, project: ProjectId): void {
    this.projects.set(session, project)
    mkdirSync(this.root, { recursive: true })
    writeFileSync(this.pathOf(session), JSON.stringify({ project }))
  }

  /**
   * @param session - the chat session.
   * @returns the project it is bound to, read from its file on first use; null while it has none.
   */
  project(session: SessionId): ProjectId | null {
    if (!this.projects.has(session)) {
      const path = this.pathOf(session)
      this.projects.set(session, existsSync(path) ? boundProject(path) : null)
    }
    return this.projects.get(session) ?? null
  }

  /**
   * Make the session's next tool calls wait until `work` settles, after any work held before it.
   * @param session - the chat session.
   * @param work - the work, such as importing the chat images of a message; its failure does not fail the calls.
   */
  hold(session: SessionId, work: Promise<unknown>): void {
    const settled = (): void => { if (this.holds.get(session) === held) this.holds.delete(session) }
    const previous = this.holds.get(session) ?? Promise.resolve()
    const held = Promise.allSettled([previous, work])
    this.holds.set(session, held)
    held.then(settled, settled)
  }

  /**
   * @param session - the chat session.
   * @returns a promise that settles when the work held for the session settled.
   */
  async ready(session: SessionId): Promise<void> {
    await this.holds.get(session)
  }

  /** The file a session's binding is kept in. */
  private pathOf(session: SessionId): string {
    return join(this.root, `${encodeURIComponent(session)}.json`)
  }
}
