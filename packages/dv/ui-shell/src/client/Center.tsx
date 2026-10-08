/**
 * The center of the DreamVerse shell, shadowing DSH's `main.conversation`. Without an open project it is the entry
 * page: a DreamVerse headline, the DSH composer, the template chips, and recent project cards, and the chat itself
 * once it starts. With a project open it is the workspace: a top bar (session switcher,
 * 画布 | 时间线 toggle, right panel toggle) above the canvas or the timeline editor, each of which shows the
 * working-branch bar that accepts or discards the session's draft. The left sidebar collapses while a project is open
 * and expands again on the entry page.
 *
 * The center also keeps the shell's open project and the DSH main session together: once the client lists are ready
 * it restores the location the URL names, and afterwards it adopts the project of a main session that moves to
 * another project by itself (for example when the agent binds the entry chat to a project it created).
 *
 * @module @dv/ui-shell/Center
 */
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DV_CURRENT_TIMELINE_EVENT, getTimelineOf, publishCurrentTimeline } from '@dv/ui-kit/current-timeline.ts'
import { pickText, useText } from '@dv/ui-kit/locale.ts'
import { sessionDraft } from '@dv/ui-kit/state.ts'
import { useProjectState } from '@dv/ui-kit/useProject.ts'
import {
  DV_CANVAS_FOCUS_EVENT, DV_TIMELINE_FOCUS_EVENT, DV_TIMELINE_INSERT_EVENT, type DvWorkspaceEventMap,
} from '@dv/ui-kit/workspace-events.ts'
import type { WireProjectSummary, WireWorkspaces } from '@dv/ui-kit/types.ts'
import { clockText } from '@dv/ui-canvas/src/client/NodeCard.tsx'
import type { ShellActions } from './actions.ts'
import { CoverFrame, editedText, useProjectSummaries } from './cover.tsx'
import { SidebarRightIcon } from './icons.tsx'
import { SessionSwitcher } from './SessionSwitcher.tsx'
import type { ShellLocation } from './store.ts'
import {
  applyingLocation, formatLocation, getShell, NO_PROJECTS, parseLocation, projectOfSession, refreshLinks, setShell, shellClient,
  startUrlMirror, useShell,
} from './store.ts'
import { CanvasView, TimelineView } from './views.ts'
import css from './shell.module.css'

/** What the shell's DSH UI slot registrations inject. */
export interface ShellInjected {
  shell: ShellActions
}

/** Props of the center entry. */
export type CenterProps = PropsRuntime<'main.conversation'> & PropsRenderFactories & ShellInjected

/** The one client the shell's own reads share. */
const client = shellClient

/** Milliseconds the URL restore waits for DSH's startup session before it proceeds without one. */
const DSH_RESTORE_WAIT_MS = 4000

/** How many recent projects the entry page shows before 全部项目 expands the grid. */
const RECENT_COUNT = 2

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
 * session), or the entry page, then its center view and timeline.
 * @param shell - the shell actions.
 * @param links - the project links.
 * @param target - the location.
 * @param restore - whether this is the page-load restore, which opens the project's session even though the shell
 *   state already names the URL's project.
 */
function applyLocation(shell: ShellActions, links: WireWorkspaces, target: ShellLocation, restore: boolean): void {
  applyingLocation(() => {
    const projectId = target.projectId !== null && links.projects.some(p => p.id === target.projectId) ? target.projectId : null
    if (projectId === null) {
      run(() => shell.goHome(target.sessionId))
      return
    }
    const current = getShell()
    if (restore || projectId !== current.projectId || (target.sessionId !== undefined && target.sessionId !== current.sessionId)) {
      run(() => shell.openProject(projectId, target.sessionId))
    }
    if (target.timeline !== null) publishCurrentTimeline(projectId, target.timeline)
    setShell({ view: target.view, timeline: target.timeline ?? getTimelineOf(projectId) })
  })
}

/**
 * Choose the center by the shell's open project, restore the URL location once, and keep the open project and the
 * main session together.
 * @param props - the DSH UI slot props.
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
    client.bindSession(sessionId, sessionProject)
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
    // The timeline the timeline editor selects goes into the URL.
    const follow = (): void => {
      const open = getShell().projectId
      if (open !== null) setShell({ timeline: getTimelineOf(open) })
    }
    window.addEventListener(DV_CURRENT_TIMELINE_EVENT, follow)
    return () => { window.removeEventListener(DV_CURRENT_TIMELINE_EVENT, follow) }
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
 * The entry page: a DreamVerse headline, the DSH composer without its hero chrome, and the template chips and recent
 * projects while the chat is still blank. The right panel stays collapsed, because nothing in it belongs to a project
 * yet, and the left sidebar expands again when the workspace collapsed it.
 * @param props - the DSH UI slot props.
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
    shell.restoreSidebar()
  }, [shell])
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
    <div className={css.center} data-dv-entry="" data-blank={blank ? '' : undefined}>
      {blank && (
        <div className={css.entryIntro}>
          <h1 className={css.entryHeadline}>{t('今天想拍点什么？', 'What are we making today?')}</h1>
        </div>
      )}
      <div className={css.entryChat}>
        {renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : 'active', hero: false }, {
          slots: { views: ChatOnlyView, widthControls: NoWidthControls },
        })}
      </div>
      {blank && <TemplateChips />}
      {blank && <RecentProjects shell={shell} />}
    </div>
  )
}

/** The 从模板开始 row: four template chips, disabled until templates exist. */
function TemplateChips(): ReactNode {
  const t = useText()
  const templates = [t('直播高光', 'Stream highlight'), t('产品发布会', 'Product launch'), t('角色短剧', 'Character drama'), t('音乐 MV', 'Music video')]
  const soon = t('即将推出', 'Coming soon')
  return (
    <div className={css.templates}>
      <span className={css.templatesLabel}>{t('从模板开始', 'Start from a template')}</span>
      <span className={css.soonTag}>{soon}</span>
      {templates.map(name => (
        <button key={name} type="button" className={css.templateChip} disabled title={soon}>{name}</button>
      ))}
    </div>
  )
}

/**
 * The recent projects grid: the newest projects as cover cards, and 全部项目 to show all of them.
 * @param props - the shell actions.
 * @returns the section, or nothing without projects.
 */
function RecentProjects({ shell }: ShellInjected): ReactNode {
  const t = useText()
  const projects = useShell(s => s.links?.projects ?? NO_PROJECTS)
  const [showAll, setShowAll] = useState(false)
  const sorted = useMemo(() => [...projects].sort((a, b) => b.created_at.localeCompare(a.created_at)), [projects])
  // One summaries read for every card; a project added to the list reads them again.
  const summaries = useProjectSummaries(null, sorted.map(project => project.id).join(' '))
  if (sorted.length === 0) return null
  const shown = showAll ? sorted : sorted.slice(0, RECENT_COUNT)
  return (
    <section className={css.recent} aria-labelledby="dv-recent-projects">
      <div className={css.recentHeader}>
        <h2 id="dv-recent-projects" className={css.recentTitle}>{t('最近项目', 'Recent projects')}</h2>
        {sorted.length > RECENT_COUNT && (
          <button type="button" className={css.textButton} onClick={() => { setShowAll(value => !value) }}>
            {showAll ? t('收起', 'Show fewer') : t('全部项目', 'All projects')}
          </button>
        )}
      </div>
      <div className={css.cards}>
        {shown.map(project => (
          <ProjectCard
            key={project.id} shell={shell} projectId={project.id} title={project.title} createdAt={project.created_at}
            summary={summaries?.get(project.id) ?? null}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * One recent project: its 16:9 cover with the total duration, its title, and its shot count and last edit time.
 * @param props - the shell actions, the project, and its summary (null while the summaries load).
 * @returns the card.
 */
function ProjectCard(
  { shell, projectId, title, createdAt, summary }:
    ShellInjected & { projectId: string; title: string; createdAt: string; summary: WireProjectSummary | null },
): ReactNode {
  const t = useText()
  const shots = summary?.shots ?? 0
  const meta = [
    shots > 0 ? t(`${String(shots)} 个镜头`, `${String(shots)} ${shots === 1 ? 'shot' : 'shots'}`) : null,
    editedText(summary?.edited_at ?? createdAt, t),
  ].filter(part => part !== null).join(' · ')
  return (
    <button type="button" className={css.card} onClick={() => { run(() => shell.openProject(projectId)) }}>
      <CoverFrame cover={summary?.cover ?? null} className={css.cardCover}>
        {summary !== null && summary.duration_sec > 0 && <span className={css.cardDuration}>{clockText(summary.duration_sec)}</span>}
      </CoverFrame>
      <span className={css.cardText}>
        <span className={css.cardTitle}>{title}</span>
        <span className={css.cardMeta}>{meta}</span>
      </span>
    </button>
  )
}

/**
 * The workspace of an open project.
 * @param props - the DSH UI slot props, the project, and whether the main session belongs to the project.
 * @returns the top bar and the center view.
 */
function WorkspacePage(props: CenterProps & { projectId: string; sessionInProject: boolean }): ReactNode {
  const { sessionId, useSessions, projectId, sessionInProject, shell } = props
  const t = useText()
  const view = useShell(s => s.view)
  const listed = useShell(s => s.links?.projects.find(p => p.id === projectId))
  const project = useMemo(() => listed ?? { id: projectId, title: projectId, created_at: '', path: '', workspace_id: null }, [listed, projectId])
  const sessionTitle = useSessions((s) => {
    const row = sessionId === undefined ? undefined : s.byId[sessionId]
    return row?.blank === false ? row.displayTitle : undefined
  })
  const state = useProjectState(client, projectId, 'main')
  // The chat session the workspace sits beside: its draft is the one the views' working-branch bar accepts or discards,
  // and the views' edits go to its working branch. Until the main session belongs to this project, edits go to `main`.
  const session = sessionInProject ? sessionId ?? null : null
  const draft = state.value === null ? null : sessionDraft(state.value, session)
  // The state of the session's working branch (its open draft, else `main`), where 插入片段 picks and writes the timeline.
  const working = useProjectState(client, projectId, draft?.branch ?? 'main')
  // The switcher's cover, read again whenever the working branch's state is refetched after a project change.
  const cover = useProjectSummaries(projectId, working.value)?.get(projectId)?.cover ?? null
  const mounted = useSyncExternalStore(shell.mountedSeat.subscribe, shell.mountedSeat.getSnapshot)
  const opened = useRef(new Set<string>())
  useEffect(() => {
    // The canvas and the timeline get the width: an open project starts with the left sidebar collapsed.
    shell.collapseSidebar()
  }, [shell])
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
    // A `dv:canvas-focus` request asks the center to show the canvas.
    const focus = (): void => { setShell({ view: 'canvas' }) }
    window.addEventListener(DV_CANVAS_FOCUS_EVENT, focus)
    return () => { window.removeEventListener(DV_CANVAS_FOCUS_EVENT, focus) }
  }, [])
  useEffect(() => {
    // A `dv:timeline-focus` request selects its timeline and asks the center to show the timeline view.
    const focus = (event: Event): void => {
      const { timelineId } = (event as CustomEvent<DvWorkspaceEventMap['dv:timeline-focus']>).detail
      publishCurrentTimeline(projectId, timelineId)
      setShell({ view: 'timeline' })
    }
    window.addEventListener(DV_TIMELINE_FOCUS_EVENT, focus)
    return () => { window.removeEventListener(DV_TIMELINE_FOCUS_EVENT, focus) }
  }, [projectId])
  // 插入片段 appends the asset to the timeline selected in the timeline editor, else to the working branch's first
  // timeline; a working branch without timelines gets timeline `t1` holding the clip.
  const insertClip = (assetId: string): void => {
    const timelines = working.value?.components.timeline.timelines ?? []
    const timeline = timelines.find(item => item.id === getTimelineOf(projectId)) ?? timelines[0]
    const at = (timeline?.clips.length ?? 0) + 1
    const call = timeline === undefined
      ? { operation: 'timeline.create', params: { timeline: 't1', assets: [assetId] }, intent: pickText('新建时间线', 'Create timeline') }
      : {
        operation: 'timeline.clip_insert', params: { timeline: timeline.id, at, asset: assetId },
        intent: pickText(`在位置 ${String(at)} 插入片段`, `Insert clip at position ${String(at)}`),
      }
    if (timeline === undefined) publishCurrentTimeline(projectId, 't1')
    void client.runOperation({ project: projectId, ...call, surface: 'timeline', ...session === null ? {} : { session } })
      .then(() => { working.reload() }, (error: unknown) => { console.warn('ui-shell: insert failed', error) })
  }
  const insertRef = useRef(insertClip)
  insertRef.current = insertClip
  useEffect(() => {
    // 插入片段 from the 素材库 panel: insert, then show the timeline so the clip is visible.
    const insert = (event: Event): void => {
      const { assetId } = (event as CustomEvent<DvWorkspaceEventMap['dv:timeline-insert']>).detail
      insertRef.current(assetId)
      setShell({ view: 'timeline' })
    }
    window.addEventListener(DV_TIMELINE_INSERT_EVENT, insert)
    return () => { window.removeEventListener(DV_TIMELINE_INSERT_EVENT, insert) }
  }, [])
  const togglePanels = (): void => {
    // Until the main session belongs to this project, the panels would open for the entry chat; the session's own
    // panels open when it mounts.
    if (!sessionInProject) return
    try {
      shell.togglePanels()
    } catch (error) {
      // No session seat is mounted yet; the chat tab opens when the session's seat mounts.
      console.warn('ui-shell: toggle panels failed', error)
    }
  }
  const panelLabel = t('显示或隐藏右侧面板', 'Show or hide the right panel')
  return (
    <div className={`${css.center} ${css.workspace}`} data-dv-workspace="">
      <header className={css.topbar}>
        <div className={css.barStart}>
          <SessionSwitcher
            shell={shell} project={project} cover={cover} sessionTitle={sessionTitle ?? null}
            useSessions={useSessions} useWorkspaces={props.useWorkspaces}
          />
        </div>
        <div className={css.toggle} role="tablist" aria-label={t('视图', 'View')}>
          {(['canvas', 'timeline'] as const).map(id => (
            <button
              key={id} type="button" role="tab" className={css.toggleItem} aria-selected={view === id}
              data-active={view === id ? '' : undefined}
              onClick={() => { setShell({ view: id }) }}
            >{id === 'canvas' ? t('画布', 'Canvas') : t('时间线', 'Timeline')}</button>
          ))}
        </div>
        <div className={css.barEnd}>
          <button type="button" className={css.iconButton} aria-label={panelLabel} title={panelLabel} onClick={togglePanels}>
            <SidebarRightIcon />
          </button>
        </div>
      </header>
      <div className={css.viewArea}>
        {view === 'canvas'
          ? <CanvasView projectId={projectId} branch="main" client={client} session={session} />
          : <TimelineView projectId={projectId} branch="main" client={client} session={session} />}
      </div>
    </div>
  )
}
