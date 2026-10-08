/**
 * The DreamVerse left navigator, shadowing the DSH sidebar's Workspace browser: 新建项目, the 首页 / 项目 entries, and the
 * project → session tree. Each project lists the chat sessions of its Workspace and the sessions bound to it, with a
 * row menu to rename or delete the project or a session.
 *
 * @module @dv/ui-shell/Navigator
 */
import type { ReactNode } from 'react'
import { useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { pickText, useText } from '@dv/ui-kit/locale.ts'
import type { ShellInjected } from './Center.tsx'
import { ChevronDownIcon, ChevronRightIcon, HomeIcon, PlusIcon } from './icons.tsx'
import { InlineRename, RowMenu } from './InlineRename.tsx'
import type { WireProjectLink } from '@dv/ui-kit/types.ts'
import { useProjectSessions } from './sessions.ts'
import { NO_PROJECTS, useShell } from './store.ts'
import css from './shell.module.css'

/** Props of the navigator entry. */
export type NavigatorProps = PropsRuntime<'sidebar.workspaces'> & ShellInjected

/** How many projects the tree lists before 项目 expands it to all. */
const SHOWN_PROJECTS = 12

/**
 * Run an action and log its failure; navigation failures leave the page as it was.
 * @param work - the action.
 */
function run(work: () => Promise<void>): void {
  work().catch((error: unknown) => { console.warn('ui-shell: navigation failed', error) })
}

/**
 * The navigator.
 * @param props - the DSH UI slot props.
 * @returns the navigator, or nothing in the collapsed rail.
 */
export function Navigator(props: NavigatorProps): ReactNode {
  const { wide, shell } = props
  const t = useText()
  const projectId = useShell(s => s.projectId)
  const projects = useShell(s => s.links?.projects ?? NO_PROJECTS)
  const [showAll, setShowAll] = useState(false)
  const loaded = useShell(s => s.links !== null)
  if (!wide) return null
  const sorted = [...projects].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const shown = showAll ? sorted : sorted.slice(0, SHOWN_PROJECTS)
  // The open project always has a row, also when more than SHOWN_PROJECTS newer projects push it out of the list.
  const openRow = sorted.find(p => p.id === projectId)
  if (openRow !== undefined && !shown.includes(openRow)) shown.push(openRow)
  const nav = (label: string, active: boolean, onClick: () => void, icon?: ReactNode): ReactNode => (
    <button
      type="button" className={css.navItem} data-active={active ? '' : undefined} aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >{icon}{label}</button>
  )
  return (
    <div className={css.nav} data-dv-navigator="">
      <button type="button" className={css.navSecondary} onClick={() => { run(() => shell.newProject()) }}>
        <PlusIcon />{t('新建项目', 'Create project')}
      </button>
      {nav(t('首页', 'Home'), projectId === null, () => { run(() => shell.goHome()) }, <HomeIcon />)}
      {sorted.length > SHOWN_PROJECTS && nav(showAll ? t('收起项目', 'Fewer projects') : t('全部项目', 'All projects'), false, () => { setShowAll(value => !value) })}
      <div className={css.section}>{t('项目', 'Projects')}</div>
      {loaded && sorted.length === 0 && (
        <div className={css.navHint}>{t('还没有项目。点击「新建项目」，或在首页描述你想做的视频。', 'No projects yet. Click Create project, or describe the video you want on Home.')}</div>
      )}
      {shown.map(project => (
        <ProjectTree
          key={project.id}
          {...props}
          project={project}
          open={project.id === projectId}
        />
      ))}
    </div>
  )
}

/**
 * One project with a row menu to rename or delete it, its chat sessions, and a ＋ that starts a chat session in it.
 * @param props - the DSH UI slot props, the project, and whether it is the open one.
 * @returns the rows.
 */
function ProjectTree(props: NavigatorProps & { project: WireProjectLink; open: boolean }): ReactNode {
  const { project, open, shell } = props
  const t = useText()
  const [expanded, setExpanded] = useState(open)
  const [renaming, setRenaming] = useState<string | null>(null)
  const current = useShell(s => s.sessionId)
  const sessions = useProjectSessions(props, project)
  const isOpen = expanded || open
  const toggle = (): void => {
    setExpanded(!isOpen)
  }
  const deleteProject = (): void => {
    if (!window.confirm(pickText(`删除项目“${project.title}”？项目会移到回收目录，可由管理员恢复。`, `Delete project "${project.title}"? It moves to the trash directory, where an administrator can restore it.`))) return
    run(() => shell.deleteProject(project.id))
  }
  return (
    <>
      <div className={css.treeRow} data-active={open ? '' : undefined}>
        <span
          role="button" tabIndex={0} className={css.treeCaret} aria-expanded={isOpen}
          aria-label={isOpen ? t('收起会话', 'Hide chats') : t('展开会话', 'Show chats')}
          onClick={toggle} onKeyDown={() => {}}
        >{isOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}</span>
        {renaming === project.id
          ? (
            <InlineRename
              value={project.title} onClose={() => { setRenaming(null) }}
              onSave={(title) => { run(() => shell.renameProject(project.id, title)) }}
            />
          )
          : (
            <span
              className={css.treeLabel} role="button" tabIndex={0} title={project.title}
              onClick={() => { run(() => shell.openProject(project.id)) }} onKeyDown={() => {}}
            >{project.title}</span>
          )}
        <RowMenu
          label={t('项目菜单', 'Project menu')}
          items={[
            { label: t('重命名', 'Rename'), run: () => { setRenaming(project.id) } },
            { label: t('删除项目', 'Delete project'), danger: true, run: deleteProject },
          ]}
        />
        <button
          type="button" className={css.treeAdd} title={t('新对话', 'New chat')} aria-label={t('新对话', 'New chat')}
          onClick={() => { run(() => shell.newSession(project.id)) }}
        >
          <PlusIcon />
        </button>
      </div>
      {isOpen && sessions.map(summary => (
        <div
          key={summary.id} role="button" tabIndex={0} className={`${css.treeRow} ${css.treeChild}`}
          data-active={summary.id === current ? '' : undefined}
          onClick={() => { shell.openSession(summary.id) }} onKeyDown={() => {}}
        >
          {renaming === summary.id
            ? (
              <InlineRename
                value={summary.displayTitle} onClose={() => { setRenaming(null) }}
                onSave={(title) => { run(() => shell.renameSession(summary.id, title)) }}
              />
            )
            : <span className={css.treeLabel} title={summary.displayTitle}>{summary.blank ? t('新对话', 'New chat') : summary.displayTitle}</span>}
          <RowMenu
            label={t('对话菜单', 'Conversation menu')}
            items={[
              { label: t('重命名', 'Rename'), run: () => { setRenaming(summary.id) } },
              {
                label: t('删除对话', 'Delete chat'), danger: true,
                run: () => {
                  if (!window.confirm(pickText(`删除对话“${summary.displayTitle}”？`, `Delete chat "${summary.displayTitle}"?`))) return
                  run(() => shell.deleteSession(summary.id))
                },
              },
            ]}
          />
        </div>
      ))}
    </>
  )
}

/** The brand in the sidebar header: the DreamVerse mark (a play glyph on the accent square) and the name. */
export function BrandName(): ReactNode {
  return (
    <span className={css.brand}>
      <span className={css.brandMark} aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L8.5 4.6A1 1 0 0 0 7 5.5z" /></svg>
      </span>
      DreamVerse
    </span>
  )
}
