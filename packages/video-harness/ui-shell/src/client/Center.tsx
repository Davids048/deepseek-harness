/**
 * The center of the DreamVerse shell, shadowing DSH's `main.conversation`. Without an open project it is the entry
 * page: a DreamVerse headline, the DSH composer, and recent project cards, and the chat itself once it starts. With a
 * project open it is the workspace: a top bar (breadcrumb, 画布 | 剪辑 toggle, panel control, draft bar) above
 * the canvas or the cuts editor.
 *
 * The center also keeps the shell's open project and the DSH main session together: once the client lists are ready
 * it restores the location the URL names, and afterwards it adopts the project of a main session that moves to
 * another project by itself (for example when the agent binds the entry chat to a project it created).
 *
 * @module @video-harness/ui-shell/Center
 */
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { VhClient } from '@video-harness/ui-kit/api.ts'
import { getEpisodeOf, publishCurrentEpisode, VH_CURRENT_EPISODE_EVENT } from '@video-harness/ui-kit/current-episode.ts'
import { pickText, useText } from '@video-harness/ui-kit/locale.ts'
import { sessionDraft } from '@video-harness/ui-kit/state.ts'
import { useProjectState } from '@video-harness/ui-kit/useProject.ts'
import type { VhWorkspaceEventMap } from '@video-harness/ui-kit/workspace-events.ts'
import type { ShellActions } from './actions.ts'
import { InlineRename } from './InlineRename.tsx'
import type { Links, ShellLocation } from './store.ts'
import {
  applyingLocation, formatLocation, getShell, NO_PROJECTS, parseLocation, postJson, projectOfSession, refreshLinks, setShell,
  startUrlMirror, useShell,
} from './store.ts'
import { CanvasView, CutsView } from './views.ts'
import css from './shell.module.css'

/** What the shell's slot registrations inject. */
export interface ShellInjected {
  shell: ShellActions
}

/** Props of the center entry. */
export type CenterProps = PropsRuntime<'main.conversation'> & PropsRenderFactories & ShellInjected

/** The one client the shell's own reads share. */
const client = new VhClient()

/** Milliseconds the URL restore waits for DSH's startup session before it proceeds without one. */
const DSH_RESTORE_WAIT_MS = 4000

/** Whether the URL location was restored; the center adopts the main session's project only afterwards. */
let restored = false

/**
 * Run an action and log its failure; navigation failures leave the page as it was.
 * @param work - the action.
 */
function run(work: () => Promise<void>): void {
  work().catch((error: unknown) => { console.warn('ui-shell: navigation failed', error) })
}

/** The Chat view alone, for a Conversation occurrence that must not switch views. */
export function ChatOnlyView(props: ConversationViewsProps): ReactNode {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

/** No width handles for the shell's Conversation occurrences. */
function NoWidthControls(): ReactNode {
  return null
}

/**
 * Move the page to a location the URL names, without adding browser history entries: open its project (and its
 * session), or the entry page, then its center view and cuts episode.
 * @param shell - the shell actions.
 * @param links - the project links.
 * @param target - the location.
 * @param restore - whether this is the page-load restore, which opens the project's session even though the shell
 *   state already names the URL's project.
 */
function applyLocation(shell: ShellActions, links: Links, target: ShellLocation, restore: boolean): void {
  applyingLocation(() => {
    const projectId = target.projectId !== null && links.projects.some(p => p.projectId === target.projectId) ? target.projectId : null
    if (projectId === null) {
      run(() => shell.goHome(target.sessionId))
      return
    }
    const current = getShell()
    if (restore || projectId !== current.projectId || (target.sessionId !== undefined && target.sessionId !== current.sessionId)) {
      run(() => shell.openProject(projectId, target.sessionId))
    }
    if (target.episode !== null) publishCurrentEpisode(projectId, target.episode)
    setShell({ view: target.view, episode: target.episode ?? getEpisodeOf(projectId) })
  })
}

/**
 * Choose the center by the shell's open project, restore the URL location once, and keep the open project and the
 * main session together.
 * @param props - the slot props.
 * @returns the entry page or the workspace.
 */
export function CenterPanel(props: CenterProps): ReactNode {
  const { sessionId, useWorkspaces, useSessions, shell } = props
  const links = useShell(s => s.links)
  const projectId = useShell(s => s.projectId)
  const workspace = useWorkspaces(s => sessionId === undefined ? undefined : s.items.find(item => item.sessionIds.includes(sessionId)))
  const workspacesReady = useWorkspaces(s => s.phase === 'ready')
  const sessionsReady = useSessions(s => s.phase === 'ready')
  const { projectId: sessionProject, needsBind } = projectOfSession(links, sessionId, workspace)
  const binding = useRef<string | null>(null)
  const previousProject = useRef<string | null>(null)
  const [restoreTimedOut, setRestoreTimedOut] = useState(false)
  useEffect(() => {
    setShell({ sessionId })
  }, [sessionId])
  useEffect(() => {
    if (!needsBind || sessionId === undefined || sessionProject === null) return
    const key = `${sessionId}:${sessionProject}`
    if (binding.current === key) return
    binding.current = key
    postJson('/api/vh/workspaces/bind', { session: sessionId, project: sessionProject })
      .then(() => refreshLinks())
      .catch((error: unknown) => { console.warn('ui-shell: bind failed', error) })
  }, [needsBind, sessionId, sessionProject])
  useEffect(() => {
    // Restore the URL location once: the URL's project wins over the session DSH restored, and the main session
    // follows it. The entry page keeps a restored entry chat and otherwise opens the blank entry session.
    // DSH restores its own main session on startup without yielding to later navigation, so the shell waits for that
    // session (or a timeout) before it opens the URL's location; otherwise DSH's late restore replaces it.
    if (restored || links === null || !workspacesReady || !sessionsReady || (sessionId === undefined && !restoreTimedOut)) return
    restored = true
    previousProject.current = sessionProject
    startUrlMirror()
    applyLocation(shell, links, parseLocation(window.location.hash), true)
  }, [links, workspacesReady, sessionsReady, sessionId, sessionProject, shell, restoreTimedOut])
  useEffect(() => {
    const timer = setTimeout(() => { setRestoreTimedOut(true) }, DSH_RESTORE_WAIT_MS)
    return () => { clearTimeout(timer) }
  }, [])
  useEffect(() => {
    // Back, Forward, and an edited hash move the page to the location the URL names.
    const follow = (): void => {
      const current = getShell()
      if (!restored || current.links === null || window.location.hash === formatLocation(current)) return
      applyLocation(shell, current.links, parseLocation(window.location.hash), false)
    }
    window.addEventListener('popstate', follow)
    window.addEventListener('hashchange', follow)
    return () => {
      window.removeEventListener('popstate', follow)
      window.removeEventListener('hashchange', follow)
    }
  }, [shell])
  useEffect(() => {
    // The episode the cuts editor selects goes into the URL.
    const follow = (): void => {
      const open = getShell().projectId
      if (open !== null) setShell({ episode: getEpisodeOf(open) })
    }
    window.addEventListener(VH_CURRENT_EPISODE_EVENT, follow)
    return () => { window.removeEventListener(VH_CURRENT_EPISODE_EVENT, follow) }
  }, [])
  useEffect(() => {
    // After the restore, a main session that moves into another project by itself takes the center with it: the
    // entry chat bound to a project the agent created, or a chat of the open project rebound to another project. A
    // session whose project only resolves late (DSH restored a session elsewhere while the shell opened the URL's
    // project) never takes the center, and the entry page is reached only through 首页.
    if (!restored) return
    const previous = previousProject.current
    previousProject.current = sessionProject
    const open = getShell().projectId
    if (sessionProject === null || sessionProject === previous || sessionProject === open) return
    if (open !== null && open !== previous) return
    setShell({ projectId: sessionProject })
  }, [sessionProject])
  return projectId === null
    ? <EntryPage {...props} />
    : <WorkspacePage key={projectId} {...props} projectId={projectId} sessionInProject={sessionProject === projectId} />
}

/**
 * The entry page: a DreamVerse headline, the DSH composer without its hero chrome, and recent projects while the chat
 * is still blank. The right panel stays collapsed, because nothing in it belongs to a project yet.
 * @param props - the slot props.
 * @returns the page.
 */
function EntryPage(props: CenterProps): ReactNode {
  const { sessionId, useSession, useConversation, useSessions, renderFactorySlot, shell } = props
  const t = useText()
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const summaryBlank = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.blank)
  const mounted = useSyncExternalStore(shell.mountedSeat.subscribe, shell.mountedSeat.getSnapshot)
  const active = session !== undefined && conversation !== undefined && (
    conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running)
  const settling = sessionId !== undefined && !active && session?.openState === 'loading' && summaryBlank !== true
  const blank = !active && !settling
  useEffect(() => {
    if (sessionId === undefined || mounted !== sessionId) return
    try {
      shell.hidePanels()
    } catch (error) {
      // The seat unbound between the mount notice and this effect; the next mount collapses it.
      console.warn('ui-shell: collapse right panel failed', error)
    }
  }, [mounted, sessionId, shell])
  return (
    <div className={css.center} data-vh-entry="" data-blank={blank ? '' : undefined}>
      {blank && <h1 className={css.entryHeadline}>{t('今天想做一个什么视频？', 'What video do you want to make?')}</h1>}
      <div className={css.entryChat}>
        {renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : 'active', hero: false }, {
          slots: { views: ChatOnlyView, widthControls: NoWidthControls },
        })}
      </div>
      {blank && <RecentProjects shell={shell} />}
    </div>
  )
}

/**
 * Recent project cards.
 * @param props - the shell actions.
 * @returns the strip, or nothing without projects.
 */
function RecentProjects({ shell }: ShellInjected): ReactNode {
  const t = useText()
  const projects = useShell(s => s.links?.projects ?? NO_PROJECTS)
  const recent = useMemo(() => [...projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8), [projects])
  if (recent.length === 0) return null
  return (
    <section className={css.recent}>
      <h3 className={css.recentTitle}>{t('最近项目', 'Recent projects')}</h3>
      <div className={css.cards}>
        {recent.map(project => (
          <button key={project.projectId} type="button" className={css.card} onClick={() => { run(() => shell.openProject(project.projectId)) }}>
            <div className={css.cardThumb} />
            <span className={css.cardTitle}>{project.title}</span>
            <span className={css.cardMeta}>{project.createdAt.slice(0, 10)}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

/**
 * The workspace of an open project.
 * @param props - the slot props, the project, and whether the main session belongs to the project.
 * @returns the top bar and the center view.
 */
function WorkspacePage(props: CenterProps & { projectId: string; sessionInProject: boolean }): ReactNode {
  const { sessionId, useSessions, projectId, sessionInProject, shell } = props
  const t = useText()
  const view = useShell(s => s.view)
  const title = useShell(s => s.links?.projects.find(p => p.projectId === projectId)?.title ?? projectId)
  const sessionTitle = useSessions((s) => {
    const row = sessionId === undefined ? undefined : s.byId[sessionId]
    return row?.blank === false ? row.displayTitle : undefined
  })
  const [renaming, setRenaming] = useState(false)
  const state = useProjectState(client, projectId, 'main')
  // The chat session the workspace sits beside: its draft is the one the bar accepts or discards, and the views' edits
  // go to its working branch. Until the main session belongs to this project, edits go to `main`.
  const session = sessionInProject ? sessionId ?? null : null
  const draft = state.value === null ? null : sessionDraft(state.value, session)
  const mounted = useSyncExternalStore(shell.mountedSeat.subscribe, shell.mountedSeat.getSnapshot)
  const opened = useRef(new Set<string>())
  useEffect(() => {
    // Once per session, the chat moves to the right panel when a session of this project mounts. The workspace renders
    // as soon as the project is chosen, while the main session is still the entry chat until openProject moves it;
    // panels opened for that session would keep its chat as a hidden second 对话 tab. The first attempt runs at once,
    // so a tab the user picks right after the project opens stays in front.
    if (sessionId === undefined || !sessionInProject || mounted !== sessionId || opened.current.has(sessionId)) return
    let failure: unknown = null
    const open = (): boolean => {
      try {
        shell.showPanels()
        opened.current.add(sessionId)
        return true
      } catch (error) {
        failure = error
        return false
      }
    }
    if (open()) return
    // A remounting seat drops its binding and binds again in a later effect of the same commit, after this effect ran,
    // so the open is retried when the seat publishes this session again, and on a timer while no surface is mounted.
    let attempts = 1
    const stop = (): void => {
      clearInterval(timer)
      unsubscribe()
    }
    const timer = setInterval(() => {
      attempts += 1
      if (open()) stop()
      else if (attempts >= 20) { stop(); console.warn('ui-shell: open chat tab failed', failure) }
    }, 250)
    const unsubscribe = shell.mountedSeat.subscribe(() => {
      if (shell.mountedSeat.getSnapshot() === sessionId && open()) stop()
    })
    return stop
  }, [mounted, sessionId, sessionInProject, shell])
  useEffect(() => {
    // A `vh:canvas-focus` request asks the center to show the canvas.
    const focus = (): void => { setShell({ view: 'canvas' }) }
    window.addEventListener('vh:canvas-focus', focus)
    return () => { window.removeEventListener('vh:canvas-focus', focus) }
  }, [])
  // 加入剪辑 appends the asset to the timeline selected in the timeline editor, else to the project's first timeline; a
  // project without timelines gets timeline `t1` named 第 1 集 holding the clip.
  const insertToCut = (assetId: string): void => {
    const sequences = state.value?.sequences ?? []
    const timeline = sequences.find(item => item.id === getEpisodeOf(projectId)) ?? sequences[0]
    const at = (timeline?.items.length ?? 0) + 1
    const call = timeline === undefined
      ? { tool: 'timeline.create', params: { timeline: 't1', name: '第 1 集', assets: [assetId] }, intent: pickText('新建时间线', 'Create timeline') }
      : { tool: 'timeline.clip_insert', params: { timeline: timeline.id, at, asset: assetId }, intent: pickText(`插入片段（第 ${String(at)} 段）`, `Insert clip at position ${String(at)}`) }
    if (timeline === undefined) publishCurrentEpisode(projectId, 't1')
    void client.invoke({ project: projectId, ...call, surface: 'timeline', ...session === null ? {} : { session } })
      .then(() => { state.reload() }, (error: unknown) => { console.warn('ui-shell: insert failed', error) })
  }
  const insertRef = useRef(insertToCut)
  insertRef.current = insertToCut
  useEffect(() => {
    // 加入剪辑 from the 素材 panel: insert, then show the cuts so the clip is visible.
    const insert = (event: Event): void => {
      const { assetId } = (event as CustomEvent<VhWorkspaceEventMap['vh:cut-insert']>).detail
      insertRef.current(assetId)
      setShell({ view: 'cuts' })
    }
    window.addEventListener('vh:cut-insert', insert)
    return () => { window.removeEventListener('vh:cut-insert', insert) }
  }, [])
  const decide = (action: 'accept' | 'discard'): void => {
    if (draft === null) return
    const done = action === 'accept'
      ? client.acceptDraft(projectId, { session: draft.session }, 'canvas')
      : client.discardDraft(projectId, { session: draft.session }, 'canvas', draft.counts)
    void done.then(() => { state.reload() }, (error: unknown) => { console.warn(`ui-shell: ${action} draft failed`, error) })
  }
  const showPanels = (): void => {
    // Until the main session belongs to this project, the panels would open for the entry chat; the session's own
    // panels open when it mounts.
    if (!sessionInProject) return
    try {
      shell.showPanels()
    } catch (error) {
      // No session seat is mounted yet; the chat tab opens when the session's seat mounts.
      console.warn('ui-shell: open panels failed', error)
    }
  }
  return (
    <div className={`${css.center} ${css.workspace}`} data-vh-workspace="">
      <header className={css.topbar}>
        <div className={css.crumbs}>
          {renaming
            ? (
              <InlineRename
                value={title}
                onSave={(next) => { run(() => shell.renameProject(projectId, next)) }}
                onClose={() => { setRenaming(false) }}
              />
            )
            : (
              <span className={css.crumbProject} title={t('双击重命名', 'Double-click to rename')} onDoubleClick={() => { setRenaming(true) }}>{title}</span>
            )}
          <span className={css.crumbSep}>/</span>
          <span className={css.crumbSession}>{sessionTitle ?? t('新对话', 'New chat')}</span>
        </div>
        <div className={css.toggle} role="tablist">
          {(['canvas', 'cuts'] as const).map(id => (
            <button
              key={id} type="button" role="tab" className={css.toggleItem}
              data-active={view === id ? '' : undefined}
              onClick={() => { setShell({ view: id }) }}
            >{id === 'canvas' ? t('画布', 'Canvas') : t('剪辑', 'Cuts')}</button>
          ))}
        </div>
        <div className={css.barEnd}>
          <button type="button" className={css.panelsButton} title={t('打开对话、素材和轨迹', 'Open Chat, Assets, and Trajectory')} onClick={showPanels}>
            {t('面板', 'Panels')}
          </button>
        </div>
      </header>
      {/* The canvas draws its own draft bar; the cuts view gets this strip under the top bar. */}
      {draft !== null && view !== 'canvas' && (
        <div className={css.draft}>
          <span>{t('草稿待确认', 'Draft to review')}</span>
          <button type="button" className={`${css.draftButton} ${css.draftAccept}`} onClick={() => { decide('accept') }}>{t('接受', 'Accept')}</button>
          <button type="button" className={css.draftButton} onClick={() => { decide('discard') }}>{t('丢弃', 'Discard')}</button>
        </div>
      )}
      <div className={css.viewArea}>
        {view === 'canvas'
          ? <CanvasView projectId={projectId} branch="main" client={client} session={session} />
          : <CutsView projectId={projectId} branch="main" client={client} session={session} />}
      </div>
    </div>
  )
}
