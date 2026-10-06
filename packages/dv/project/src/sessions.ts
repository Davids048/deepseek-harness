/**
 * Chat sessions as Project's agent tools see them: the project each session is bound to (saved to one file per
 * session, so a restart continues the session), the agent turn each session is in with the human's words that started
 * it, and the work a session's tool calls wait for (chat images still being imported).
 *
 * Calls nothing else in Project. Called by the service (`bindSession`, `sessionProject`, `noteTurn`, `sessionTurn`,
 * `holdToolCalls`) and by the agent tools module.
 *
 * @module @dv/project/sessions
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectId, SessionId, TurnId } from './types.ts'

/** The agent turn a session is in: the DSH turn number, the turn ID, and the human's words that started it. */
export interface SessionTurn {
  number: number
  turn: TurnId
  requestText: string
}

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

/** Session bindings, turns, and held tool calls. */
export class Sessions {
  private readonly projects = new Map<SessionId, ProjectId | null>()
  private readonly turns = new Map<SessionId, SessionTurn>()
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
   * Note the agent turn a session is in. A new turn number starts a new turn ID; the same number with words sets the
   * words of the turn.
   * @param session - the chat session.
   * @param turn - the agent loop's turn number.
   * @param requestText - the human's words; empty when they are not known yet.
   */
  noteTurn(session: SessionId, turn: number, requestText: string): void {
    const current = this.turns.get(session)
    if (current !== undefined && current.number === turn) {
      if (requestText !== '') current.requestText = requestText
      return
    }
    this.turns.set(session, { number: turn, turn: brandString<TurnId>(randomUUID()), requestText })
  }

  /**
   * @param session - the chat session.
   * @returns the turn it is in, or undefined before its first noted turn.
   */
  turn(session: SessionId): SessionTurn | undefined {
    return this.turns.get(session)
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
