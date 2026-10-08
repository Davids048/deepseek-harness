/**
 * Branches: the project's current branch, forking, switching and renaming. A project starts with the branch `main`;
 * every other branch is `b<n>`, forked from another branch. Branches are never merged; they share only the asset pool.
 *
 * Current branch. Each project has one current branch, stored in `branches.json`. Every view and every chat session
 * reads it, and every write of every actor goes to it. No write waits for an acceptance.
 *
 * Fork. A branch is forked in two cases only: the human (or the agent, when the human asks) creates a branch, or a
 * write arrives while the current branch's head stands before its tip, after an undo (`forWrite`). A fork starts the
 * new branch at the `position` of the current branch's head, moves the old branch's head back to its tip so that the
 * steps after the fork point stay on it, and makes the new branch current. Undo, redo, switching and reads never fork.
 *
 * Calls: the record store (branch pointers, the current branch) and the history module (`position`, `tipOf`). The
 * service calls `create`, `switch` and `rename` while it holds the project lock; the runner calls `forWrite` while it
 * holds the lock.
 *
 * @module @dv/project/branches
 */
import type { History } from './history.ts'
import { position, tipOf } from './history.ts'
import type { RecordStore, StoredBranch } from './record-store.ts'
import { ProjectError } from './shared.ts'
import type { Branch, ProjectId, RecordId } from './types.ts'

/** The name pattern of forked branches; the number is one more than the highest one in use, starting at 2. */
const FORKED_BRANCH = /^b(\d+)$/
/** The most characters a branch title holds. */
const TITLE_MAX = 40

/** Branch pointers and the current branch of every project. */
export class Branches {
  /**
   * @param store - the record store.
   * @param history - undo and redo, for the jump when switching to a step of another branch.
   */
  constructor(private readonly store: RecordStore, private readonly history: History) {}

  /**
   * The project's current branch. Takes no lock and writes nothing.
   * @param project - the project.
   * @returns the branch with its tip.
   */
  current(project: ProjectId): Branch {
    return this.withTip(project, this.require(project, this.store.currentBranch(project)))
  }

  /**
   * Every branch with its tip; `main` first, then by name.
   * @param project - the project.
   * @returns the branches.
   */
  list(project: ProjectId): Branch[] {
    return this.store.listBranches(project).map(branch => this.withTip(project, branch))
  }

  /**
   * The branch a write goes to: the current branch, forked first when its head's position stands before its tip (an
   * undo left redo steps). The caller holds the project lock.
   * @param project - the project.
   * @returns the branch name.
   */
  forWrite(project: ProjectId): string {
    const current = this.current(project)
    return position(this.store, project, current.head) === current.tip ? current.name : this.fork(project, current, null).name
  }

  /**
   * Fork a branch from the current branch at its head's position and make it current. The caller holds the project lock.
   * @param project - the project.
   * @param title - the name the human gave it; null or empty for the view's default label.
   * @returns the new branch. Throws `invalid_params` for a title over 40 characters, `branch_exists` for a title another
   *   branch has.
   */
  create(project: ProjectId, title: string | null): Branch {
    return this.fork(project, this.current(project), this.titleFor(project, null, title))
  }

  /**
   * Make a branch current and, with `to`, return it to that step: a `proj.undo` (or `proj.redo` for a redo step) on the
   * branch, unless the branch already stands there. The caller holds the project lock.
   * @param project - the project.
   * @param name - the branch; throws `unknown_branch`.
   * @param origin - who switches, for the jump record.
   * @param to - a step on the branch's line, or undefined to keep the branch's head.
   * @returns the branch after the switch.
   */
  switch(project: ProjectId, name: string, origin: Parameters<History['undo']>[2], to?: RecordId): Branch {
    const branch = this.require(project, name)
    // The jump runs first, so a refused `to` leaves the current branch as it was.
    if (to !== undefined && to !== position(this.store, project, branch.head)) this.history.undo(project, name, origin, to)
    this.store.setCurrent(project, name)
    return this.current(project)
  }

  /**
   * Give a branch the name the human chose. The caller holds the project lock.
   * @param project - the project.
   * @param name - the branch; throws `unknown_branch`.
   * @param title - the title; an empty string returns to the default label.
   * @returns the branch after the change. Throws `invalid_params` for a title over 40 characters, `branch_exists` for a
   *   title another branch has.
   */
  rename(project: ProjectId, name: string, title: string): Branch {
    const branch = this.require(project, name)
    this.store.setBranch(project, { ...branch, title: this.titleFor(project, name, title) })
    return this.withTip(project, this.require(project, name))
  }

  /**
   * Fork `from` at its head's position: move `from` back to its tip, add `b<n>` there, and make it current.
   * @param project - the project.
   * @param from - the branch to fork from.
   * @param title - the new branch's title.
   * @returns the new branch.
   */
  private fork(project: ProjectId, from: Branch, title: string | null): Branch {
    const at = position(this.store, project, from.head)
    const { tip, ...stored } = from
    if (tip !== from.head) this.store.setBranch(project, { ...stored, head: tip })
    const name = `b${String(this.nextNumber(project))}`
    this.store.setBranch(project, { name, title, head: at, base: from.name, forked_at: at })
    this.store.setCurrent(project, name)
    return this.current(project)
  }

  /**
   * @param project - the project.
   * @returns one more than the highest `b<n>` number in use, at least 2 (`main` is the first branch).
   */
  private nextNumber(project: ProjectId): number {
    let highest = 1
    for (const branch of this.store.listBranches(project)) {
      const match = FORKED_BRANCH.exec(branch.name)
      if (match !== null) highest = Math.max(highest, Number(match[1]))
    }
    return highest + 1
  }

  /**
   * @param project - the project.
   * @param name - the branch being named, or null for a new one.
   * @param title - the requested title.
   * @returns the trimmed title, or null for an empty one. Throws `invalid_params` over 40 characters and
   *   `branch_exists` when another branch has the title.
   */
  private titleFor(project: ProjectId, name: string | null, title: string | null): string | null {
    const trimmed = title?.trim() ?? ''
    if (trimmed === '') return null
    if (trimmed.length > TITLE_MAX) throw new ProjectError('invalid_params', `A branch name has at most ${String(TITLE_MAX)} characters.`)
    if (this.store.listBranches(project).some(branch => branch.name !== name && branch.title === trimmed)) {
      throw new ProjectError('branch_exists', `Another branch is already named ${trimmed}.`)
    }
    return trimmed
  }

  /**
   * @param project - the project.
   * @param branch - a stored branch.
   * @returns the branch with its computed tip.
   */
  private withTip(project: ProjectId, branch: StoredBranch): Branch {
    return { ...branch, tip: tipOf(this.store, project, branch.head) }
  }

  /**
   * @param project - the project.
   * @param name - a branch name.
   * @returns the stored branch; throws `unknown_branch`.
   */
  private require(project: ProjectId, name: string): StoredBranch {
    const branch = this.store.getBranch(project, name)
    if (branch === undefined) throw new ProjectError('unknown_branch', `Project ${project} has no branch ${name}.`)
    return branch
  }
}
