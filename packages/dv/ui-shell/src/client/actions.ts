/**
 * Navigation the DreamVerse shell performs through DSH services. The shell's open project decides the center, and the
 * DSH main session follows it: opening a project moves the main session to that project's latest chat session, or to a
 * blank session in the project's Workspace when it has none, so the right panel (对话 / 素材库 / 轨迹) always belongs to
 * the project in the center. The actions also create, rename, and delete projects and chat sessions.
 *
 * @module @dv/ui-shell/actions
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { pickText } from '@dv/ui-kit/locale.ts'
import type { WireSession } from '@dv/ui-kit/types.ts'
import { getShell, markSessionChoice, refreshLinks, setShell, shellClient } from './store.ts'

/** The right-panel kind of the asset pool tab that `@dv/ui-asset-pool` registers. */
export const ASSET_POOL_KIND = 'dv-asset-pool'

/** The right-panel kind of the History tab that `@dv/ui-history` registers. */
export const HISTORY_KIND = 'dv-history'

/** Milliseconds to wait for the DSH session and Workspace lists before choosing a session from them anyway. */
const LIST_READY_TIMEOUT_MS = 5000

/** The `sessionStorage` key prefix of the blank session this tab created in a Workspace. */
const TAB_BLANK_KEY = 'dv-shell.tab-blank'

/** A session log smaller than this many bytes holds no turn; used for sessions the client list has not loaded. */
const BLANK_LOG_BYTES = 1024

/** The actions the shell components receive through their DSH UI slot registrations. */
export interface ShellActions {
  /** Create a project and its Workspace, then open a chat session in it. */
  newProject(): Promise<void>
  /**
   * Open a project and move the main session into it: `sessionId` when it belongs to the project, else the main session
   * when it is a non-blank session of the project, else the project's latest non-blank chat session, else a blank one.
   */
  openProject(projectId: string, sessionId?: string): Promise<void>
  /** Open one chat session of the open project. */
  openSession(sessionId: string): void
  /** Start a chat session in the project's Workspace. */
  newSession(projectId: string): Promise<void>
  /**
   * Show the entry page: `sessionId` when it is a started, unbound chat of the entry Workspace (a URL restore), else
   * this browser tab's blank chat session in the entry Workspace.
   */
  goHome(sessionId?: string): Promise<void>
  /** Store a unique project title and rename the project's Workspace to match. */
  renameProject(projectId: string, title: string): Promise<void>
  /** Move a project to the trash, drop its Workspace registration, and leave it when it is open. */
  deleteProject(projectId: string): Promise<void>
  /** Rename a chat session. */
  renameSession(sessionId: string, title: string): Promise<void>
  /** Archive a chat session and, when it was open, move to the project's latest other session. */
  deleteSession(sessionId: string): Promise<void>
  /**
   * The entry Workspace (the directory that holds chats started before a project exists), created and titled
   * DreamVerse when missing. DSH's first-use default Workspace is replaced by it.
   */
  entryWorkspace(): Promise<WorkspaceView>
  /** Expand the right panel and open 轨迹, 素材库, and 对话, with 对话 in front. Throws while no session seat is mounted. */
  showPanels(): void
  /** Collapse the right panel of the mounted session. */
  hidePanels(): void
  /** The session whose right-panel seat is mounted, observed by the center. */
  mountedSeat: { getSnapshot(): SessionId | undefined; subscribe(fn: () => void): () => void }
  /** Whether the right panel is expanded, observed by the center to show its open button only while it is hidden. */
  panelExpanded: { getSnapshot(): boolean; subscribe(fn: () => void): () => void }
}

/**
 * Wait until a DSH list has loaded once, or until the timeout passes.
 * @param source - the list store.
 * @returns a promise that settles when the list is ready or the wait timed out.
 */
function whenReady(source: { getSnapshot(): { phase: string }; subscribe(listener: () => void): () => void }): Promise<void> {
  return new Promise((resolve) => {
    if (source.getSnapshot().phase === 'ready') { resolve(); return }
    let stop = (): void => {}
    const done = (): void => { clearTimeout(timer); stop(); resolve() }
    const timer = setTimeout(done, LIST_READY_TIMEOUT_MS)
    stop = source.subscribe(() => { if (source.getSnapshot().phase === 'ready') done() })
  })
}

/**
 * Build the shell actions over the client services.
 * @param ctx - the client root context with `workspaces`, `sessions`, `uiWorkspace`, and `sidebarRight`.
 * @returns the actions.
 */
export function createActions(ctx: ClientContext): ShellActions {
  /**
   * Rename a Workspace to `title`, or to `title N` when another Workspace already has the name.
   * @param workspaceId - the Workspace.
   * @param title - the wanted title.
   */
  const renameWorkspace = async (workspaceId: WorkspaceId, title: string): Promise<void> => {
    const taken = new Set(ctx.workspaces.list.getSnapshot().items.filter(item => item.workspaceId !== workspaceId).map(item => item.title))
    let failure: unknown = null
    for (let n = 1; n <= 20; n += 1) {
      const candidate = n === 1 ? title : `${title} ${String(n)}`
      if (taken.has(candidate)) continue
      try {
        await ctx.workspaces.rename(workspaceId, candidate)
        return
      } catch (error) {
        // `workspace/name-conflict` from a Workspace the list has not shown yet: try the next suffix.
        failure = error
      }
    }
    console.warn('ui-shell: Workspace rename failed', failure)
  }

  /**
   * The Workspace whose directory is `path`, created and titled when missing.
   * @param path - the directory.
   * @param title - the title of a created Workspace.
   * @returns the Workspace ID.
   */
  const workspaceAt = async (path: string, title: string): Promise<WorkspaceId> => {
    const existing = ctx.workspaces.list.getSnapshot().items.find(item => item.path === path)
    if (existing !== undefined) return existing.workspaceId
    const created = await ctx.workspaces.create({ path })
    await renameWorkspace(created.workspaceId, title)
    return created.workspaceId
  }

  /**
   * The project's Workspace, created and recorded when missing.
   * @param projectId - the project.
   * @returns the Workspace ID.
   */
  const projectWorkspace = async (projectId: string): Promise<WorkspaceId> => {
    await whenReady(ctx.workspaces.list)
    const links = getShell().links ?? await refreshLinks()
    let project = links.projects.find(p => p.id === projectId)
    if (project === undefined) project = (await refreshLinks()).projects.find(p => p.id === projectId)
    if (project === undefined) throw new Error(`ui-shell: unknown project ${projectId}`)
    const known = ctx.workspaces.list.getSnapshot().items
    if (project.workspace_id !== null && known.some(item => item.workspaceId === project.workspace_id)) {
      return project.workspace_id as WorkspaceId
    }
    const workspaceId = await workspaceAt(project.path, project.title)
    await shellClient.linkWorkspace(projectId, workspaceId)
    await refreshLinks()
    return workspaceId
  }

  /**
   * The project's chat sessions that are not archived, newest first: the sessions of its Workspace, the sessions bound
   * to it, and the sessions the server stores under its directory, which covers sessions the client list lacks.
   * @param projectId - the project.
   * @param workspaceId - the project's Workspace.
   * @returns each session with whether it is blank.
   */
  const projectSessions = async (
    projectId: string,
    workspaceId: WorkspaceId,
  ): Promise<Array<{ id: string; updatedAt: number; blank: boolean }>> => {
    await Promise.all([whenReady(ctx.sessions.list), whenReady(ctx.workspaces.list)])
    const stored = await shellClient.listSessions(projectId).catch((error: unknown): WireSession[] => {
      console.warn('ui-shell: stored sessions read failed', error)
      return []
    })
    const workspace = ctx.workspaces.list.getSnapshot()
    const sessions = ctx.sessions.list.getSnapshot()
    const archived = new Set<string>(workspace.archivedSessionIds)
    const rows = new Map<string, { id: string; updatedAt: number; blank: boolean }>()
    const ids = [
      ...workspace.items.find(item => item.workspaceId === workspaceId)?.sessionIds ?? [],
      ...Object.entries(getShell().links?.bindings ?? {}).filter(([, project]) => project === projectId).map(([id]) => id),
    ]
    for (const id of ids) {
      const summary = sessions.byId[id as SessionId]
      if (summary !== undefined) rows.set(id, { id, updatedAt: summary.updatedAt, blank: summary.blank })
    }
    for (const row of stored) {
      if (rows.has(row.session)) continue
      const summary = sessions.byId[row.session as SessionId]
      rows.set(row.session, summary === undefined
        ? { id: row.session, updatedAt: Date.parse(row.updated_at), blank: row.bytes < BLANK_LOG_BYTES }
        : { id: row.session, updatedAt: summary.updatedAt, blank: summary.blank })
    }
    // A session bound to another project belongs to that project, even when this project's Workspace holds it.
    const bindings = getShell().links?.bindings ?? {}
    return [...rows.values()]
      .filter(row => !archived.has(row.id) && (bindings[row.id] ?? projectId) === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Blank sessions this browser tab created, by Workspace, kept in `sessionStorage` so a reload reuses them. */
  const tabBlanks = {
    get(workspaceId: WorkspaceId): SessionId | undefined {
      try {
        return (window.sessionStorage.getItem(`${TAB_BLANK_KEY}:${workspaceId}`) ?? undefined) as SessionId | undefined
      } catch (_error: unknown) {
        // Storage is blocked; the tab creates another blank session.
        return undefined
      }
    },
    set(workspaceId: WorkspaceId, sessionId: SessionId): void {
      try {
        window.sessionStorage.setItem(`${TAB_BLANK_KEY}:${workspaceId}`, sessionId)
      } catch (_error: unknown) {
        // Storage is blocked; the blank session stays usable for this page load only.
      }
    },
  }

  /**
   * Open a blank chat session in a Workspace that belongs to this browser tab: the blank session this tab created
   * there earlier while it is still blank, else a new one. DSH's own
   * `openWorkspace` reuses any blank session of the Workspace, so two tabs would share one and see each other's chat.
   * @param workspaceId - the Workspace.
   * @param stillWanted - whether the navigation that asked for the session is still current.
   */
  const openBlank = async (workspaceId: WorkspaceId, stillWanted: () => boolean): Promise<void> => {
    const sessions = ctx.sessions.list.getSnapshot()
    const sessionIds = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)?.sessionIds ?? []
    const blankHere = (id: string | undefined): id is SessionId =>
      id !== undefined && sessions.byId[id as SessionId]?.blank === true && sessionIds.includes(id as SessionId)
    const reused = tabBlanks.get(workspaceId)
    const sessionId = blankHere(reused) ? reused : await ctx.sessions.create({ workspaceId })
    tabBlanks.set(workspaceId, sessionId)
    if (!stillWanted() || getShell().sessionId === sessionId) return
    showSession(sessionId)
  }

  /**
   * Move the DSH main session. DSH's startup restore of its last session runs as a pending layout navigation and
   * would replace a session the shell opened before it finished; starting a navigation first cancels it.
   * @param sessionId - the session.
   */
  const showSession = (sessionId: SessionId): void => {
    ctx.get('layout')?.beginNavigation()
    ctx.uiWorkspace.openSession(sessionId)
  }

  const openSession = (sessionId: string): void => {
    markSessionChoice()
    showSession(sessionId as SessionId)
  }

  const goHome = async (sessionId?: string): Promise<void> => {
    setShell({ projectId: null })
    const links = getShell().links ?? await refreshLinks()
    await Promise.all([whenReady(ctx.sessions.list), whenReady(ctx.workspaces.list)])
    const workspaceId = await workspaceAt(links.entry_path, 'DreamVerse')
    if (getShell().projectId !== null) return
    const entry = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
    const summary = sessionId === undefined ? undefined : ctx.sessions.list.getSnapshot().byId[sessionId as SessionId]
    if (
      summary !== undefined && !summary.blank && entry?.sessionIds.includes(summary.id) === true
      && links.bindings[summary.id] === undefined
    ) {
      if (summary.id !== getShell().sessionId) showSession(summary.id)
      return
    }
    await openBlank(workspaceId, () => getShell().projectId === null)
  }

  const openProject = async (projectId: string, sessionId?: string): Promise<void> => {
    setShell({ projectId })
    const workspaceId = await projectWorkspace(projectId)
    const sessions = await projectSessions(projectId, workspaceId)
    // A later navigation superseded this one while the lists loaded.
    if (getShell().projectId !== projectId) return
    const current = getShell().sessionId
    const currentRow = sessions.find(row => row.id === current)
    const wanted = sessionId === undefined ? undefined : sessions.find(row => row.id === sessionId)
    const latest = wanted ?? (currentRow?.blank === false ? currentRow : undefined) ?? sessions.find(row => !row.blank) ?? currentRow
    if (latest !== undefined) {
      if (latest.id !== current) showSession(latest.id as SessionId)
      return
    }
    await openBlank(workspaceId, () => getShell().projectId === projectId)
  }

  return {
    async newProject() {
      const links = getShell().links ?? await refreshLinks()
      const base = pickText('未命名项目', 'Untitled project')
      const titles = new Set(links.projects.map(p => p.title))
      let title = base
      for (let n = 2; titles.has(title); n += 1) title = `${base} ${String(n)}`
      const created = await shellClient.createProject(title, 'canvas')
      await refreshLinks()
      setShell({ projectId: created.id, view: 'canvas' })
      const workspaceId = await projectWorkspace(created.id)
      if (getShell().projectId !== created.id) return
      await openBlank(workspaceId, () => getShell().projectId === created.id)
    },
    openProject,
    openSession,
    async newSession(projectId) {
      setShell({ projectId })
      const workspaceId = await projectWorkspace(projectId)
      if (getShell().projectId !== projectId) return
      markSessionChoice()
      await openBlank(workspaceId, () => getShell().projectId === projectId)
    },
    goHome,
    async renameProject(projectId, title) {
      const renamed = await shellClient.renameProject(projectId, title)
      const links = await refreshLinks()
      const workspaceId = links.projects.find(p => p.id === projectId)?.workspace_id ?? null
      if (workspaceId !== null && ctx.workspaces.list.getSnapshot().items.some(item => item.workspaceId === workspaceId)) {
        await renameWorkspace(workspaceId as WorkspaceId, renamed.title)
      }
    },
    async deleteProject(projectId) {
      const removed = await shellClient.deleteProject(projectId)
      const linked = removed.workspace_id
      if (linked !== null && ctx.workspaces.list.getSnapshot().items.some(item => item.workspaceId === linked)) {
        await ctx.workspaces.delete(linked as WorkspaceId).catch((error: unknown) => { console.warn('ui-shell: Workspace delete failed', error) })
      }
      await refreshLinks()
      if (getShell().projectId === projectId) await goHome()
    },
    async renameSession(sessionId, title) {
      const result = await ctx.sessions.using(
        sessionId as SessionId,
        { source: 'workspaceOperation' },
        reference => reference.binding.session.rename(title),
      )
      if (!result.ok) throw new Error(result.error.message)
    },
    async deleteSession(sessionId) {
      const projectId = getShell().projectId
      const open = getShell().sessionId === sessionId
      await ctx.uiWorkspace.archiveSession(sessionId as SessionId, { stopActivity: true })
      if (open && projectId !== null) await openProject(projectId)
    },
    async entryWorkspace() {
      const links = getShell().links ?? await refreshLinks()
      const existing = ctx.workspaces.list.getSnapshot().items.find(item => item.path === links.entry_path)
      if (existing !== undefined) return existing
      const created = await ctx.workspaces.create({ path: links.entry_path })
      await renameWorkspace(created.workspaceId, 'DreamVerse')
      return created
    },
    showPanels() {
      // 对话 opens first so it leads the tab strip, then 素材库, 历史 and 轨迹; reopening 对话 brings it to the front.
      ctx.sidebarRight.openTab('dv-chat')
      ctx.sidebarRight.openTab(ASSET_POOL_KIND)
      ctx.sidebarRight.openTab(HISTORY_KIND)
      ctx.sidebarRight.openTab('dv-trajectory')
      ctx.sidebarRight.openTab('dv-chat')
    },
    hidePanels() {
      if (ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded()
    },
    mountedSeat: ctx.sidebarRight.mounted,
    panelExpanded: ctx.sidebarRight.expanded,
  }
}
