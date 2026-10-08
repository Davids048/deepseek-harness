/**
 * The session switcher at the left of the workspace header: a button that shows the open project's cover, title, and
 * chat session title, and a menu that moves to 首页, creates a project, switches among the project's chat sessions or
 * starts one, and opens another project. The menu runs the same shell actions as the navigator.
 *
 * @module @dv/ui-shell/SessionSwitcher
 */
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useText } from '@dv/ui-kit/locale.ts'
import type { WireProjectLink } from '@dv/ui-kit/types.ts'
import type { ShellActions } from './actions.ts'
import { CoverFrame, type ProjectCover } from './cover.tsx'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, HomeIcon, PlusIcon } from './icons.tsx'
import { type SessionListHooks, useProjectSessions } from './sessions.ts'
import { NO_PROJECTS, useShell } from './store.ts'
import css from './shell.module.css'

/** Props of the switcher. */
export interface SessionSwitcherProps extends SessionListHooks {
  shell: ShellActions
  project: WireProjectLink
  /** The cover of the open project, or null without a rendered take. */
  cover: ProjectCover | null
  /** The main session's title, or null for a blank or foreign session. */
  sessionTitle: string | null
}

/**
 * Run an action and log its failure; navigation failures leave the page as it was.
 * @param work - the action.
 */
function run(work: () => Promise<void>): void {
  work().catch((error: unknown) => { console.warn('ui-shell: navigation failed', error) })
}

/**
 * The switcher button and, while open, its menu. A click outside the menu or Escape closes it.
 * @param props - the switcher props.
 * @returns the button and the menu.
 */
export function SessionSwitcher(props: SessionSwitcherProps): ReactNode {
  const { shell, project, cover, sessionTitle } = props
  const t = useText()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const current = useShell(s => s.sessionId)
  const projects = useShell(s => s.links?.projects ?? NO_PROJECTS)
  const sessions = useProjectSessions(props, project)
  const others = [...projects].filter(p => p.id !== project.id).sort((a, b) => b.created_at.localeCompare(a.created_at))
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || root.current?.contains(event.target) !== true) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])
  // Every entry closes the menu before its action runs.
  const choose = (action: () => void) => (): void => {
    setOpen(false)
    action()
  }
  return (
    <div ref={root} className={css.switcherRoot}>
      <button
        ref={button} type="button" className={css.switcher} aria-haspopup="menu" aria-expanded={open}
        title={t('切换会话或项目', 'Switch chat or project')}
        onClick={() => { setOpen(value => !value) }}
      >
        <CoverFrame cover={cover} className={css.switcherCover} />
        <span className={css.switcherProject}>{project.title}</span>
        <span className={css.switcherSep}>/</span>
        <span className={css.switcherSession}>{sessionTitle ?? t('新对话', 'New chat')}</span>
        <span className={css.switcherChevron}><ChevronDownIcon /></span>
      </button>
      {open && (
        <div className={css.menu} role="menu" aria-label={t('切换会话', 'Switch chat')}>
          <button type="button" role="menuitem" className={css.menuItem} onClick={choose(() => { run(() => shell.goHome()) })}>
            <HomeIcon />{t('首页', 'Home')}
          </button>
          <button type="button" role="menuitem" className={css.menuItem} onClick={choose(() => { run(() => shell.newProject()) })}>
            <PlusIcon />{t('新建项目', 'Create project')}
          </button>
          <div className={css.menuDivider} role="separator" />
          <span className={css.menuHeading}>{t(`${project.title} · 会话`, `${project.title} · Chats`)}</span>
          {sessions.map(summary => (
            <button
              key={summary.id} type="button" role="menuitemradio" aria-checked={summary.id === current} className={css.menuItem}
              data-active={summary.id === current ? '' : undefined}
              onClick={choose(() => { if (summary.id !== current) shell.openSession(summary.id) })}
            >
              <span className={css.menuLabel}>{summary.blank ? t('新对话', 'New chat') : summary.displayTitle}</span>
              {summary.id === current && <span className={css.menuCheck}><CheckIcon /></span>}
            </button>
          ))}
          <button
            type="button" role="menuitem" className={`${css.menuItem} ${css.menuItemQuiet}`}
            onClick={choose(() => { run(() => shell.newSession(project.id)) })}
          >
            <PlusIcon />{t('新建会话', 'New chat')}
          </button>
          {others.length > 0 && (
            <>
              <div className={css.menuDivider} role="separator" />
              <span className={css.menuHeading}>{t('其他项目', 'Other projects')}</span>
              <div className={css.menuScroll}>
                {others.map(other => (
                  <button
                    key={other.id} type="button" role="menuitem" className={css.menuItem}
                    onClick={choose(() => { run(() => shell.openProject(other.id)) })}
                  >
                    <span className={css.menuLabel}>{other.title}</span>
                    <span className={css.menuTrail}><ChevronRightIcon /></span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
