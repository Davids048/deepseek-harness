/**
 * The Tool session list of one project, for the workspace's left navigation: the sessions newest first, each with rename
 * (double-click) and delete, a row that creates a session, and a disabled row for creating new tools.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useText } from '@video-harness/ui-kit/locale.ts'
import { ToolApi, VH_TOOL_SESSIONS_CHANGED_EVENT, notifyToolSessionsChanged, toolSessionTitle } from '@video-harness/ui-kit/tool-api.ts'
import type { WireToolSession } from '@video-harness/ui-kit/tool-api.ts'
import { button, color } from './style.ts'

/** Props of {@link ToolSessionsNav}. */
export interface ToolSessionsNavProps {
  projectId: string
  /** The session the center shows, highlighted in the list. */
  activeSessionId?: string | null
  /**
   * Called when the user picks a session, with the opened session after "新建 Tool 会话" (an empty one is reused), and
   * with null after the user deletes the active session.
   */
  onOpen: (toolSessionId: string | null) => void
  /** The API client; defaults to one over the page's fetch. */
  api?: ToolApi
}

/**
 * List a project's Tool sessions with create, rename (double-click a row), and delete.
 * @param props - the project, the active session, and the open callback.
 * @returns the list.
 */
export function ToolSessionsNav(props: ToolSessionsNavProps): ReactNode {
  const api = useMemo(() => props.api ?? new ToolApi(), [props.api])
  const t = useText()
  const [sessions, setSessions] = useState<WireToolSession[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const reload = useCallback(() => {
    api.sessions(props.projectId).then((rows) => { setSessions(rows); setError(null) }, (failure: unknown) => { setError(String(failure)) })
  }, [api, props.projectId])
  useEffect(reload, [reload])
  // Refetch when another view changes this project's sessions.
  useEffect(() => {
    const onChanged = (event: Event): void => { if ((event as CustomEvent<string>).detail === props.projectId) reload() }
    window.addEventListener(VH_TOOL_SESSIONS_CHANGED_EVENT, onChanged)
    return () => { window.removeEventListener(VH_TOOL_SESSIONS_CHANGED_EVENT, onChanged) }
  }, [reload, props.projectId])

  const fail = (failure: unknown): void => { setError(String(failure)) }
  const create = (): void => {
    api.createSession(props.projectId).then((session) => { notifyToolSessionsChanged(props.projectId); props.onOpen(session.id) }, fail)
  }
  const rename = (id: string, title: string): void => {
    setEditing(null)
    if (title.trim().length === 0) return
    api.renameSession(props.projectId, id, title.trim()).then(() => { notifyToolSessionsChanged(props.projectId) }, fail)
  }
  const remove = (session: WireToolSession): void => {
    const title = toolSessionTitle(session.title)
    if (!window.confirm(t(`删除 Tool 会话「${title}」？它生成的视频仍保留在画布和素材里。`, `Delete the Tool session "${title}"? Its generated videos stay on the canvas and in Assets.`))) return
    api.deleteSession(props.projectId, session.id).then(() => {
      notifyToolSessionsChanged(props.projectId)
      if (session.id === props.activeSessionId) props.onOpen(null)
    }, fail)
  }
  const row = (active: boolean): CSSProperties => ({
    display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', borderRadius: 6, border: 'none', fontSize: 13,
    background: active ? color.panel : 'transparent', color: 'inherit', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  })
  return (
    <div data-testid="vh-tool-sessions" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {sessions.map(session => editing === session.id
        ? (
          <input
            key={session.id} autoFocus defaultValue={toolSessionTitle(session.title)} aria-label={t('Tool 会话名称', 'Tool session name')}
            style={{ ...button, width: '100%', fontSize: 13 }}
            onBlur={(event) => { rename(session.id, event.currentTarget.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') rename(session.id, event.currentTarget.value)
              if (event.key === 'Escape') setEditing(null)
            }}
          />
        )
        : (
          <div key={session.id} style={{ display: 'flex', alignItems: 'center' }} onMouseEnter={() => { setHovered(session.id) }} onMouseLeave={() => { setHovered(null) }}>
            <button
              type="button" title={`${toolSessionTitle(session.title)}${t('（双击重命名）', ' (double-click to rename)')}`} style={{ ...row(session.id === props.activeSessionId), flex: 1, minWidth: 0 }}
              onClick={() => { props.onOpen(session.id) }} onDoubleClick={() => { setEditing(session.id) }}
            >
              {toolSessionTitle(session.title)}
            </button>
            <RowMenu
              visible={hovered === session.id || session.id === props.activeSessionId} label={t('Tool 会话操作', 'Tool session actions')}
              items={[
                { label: t('重命名', 'Rename'), run: () => { setEditing(session.id) } },
                { label: t('删除 Tool 会话', 'Delete Tool session'), danger: true, run: () => { remove(session) } },
              ]}
            />
          </div>
        ))}
      <button type="button" style={{ ...row(false), color: color.accent }} onClick={create}>{t('＋ 新建 Tool 会话', '+ New Tool session')}</button>
      <button type="button" disabled style={{ ...row(false), color: color.muted, cursor: 'not-allowed', opacity: 0.6 }} title={t('即将推出：让 agent 按你的描述搭建新工具', 'Coming soon: the agent builds a new tool from your description')}>
        {t('＋ 创建新工具 · 即将推出', '+ Create a new tool · coming soon')}
      </button>
      {error === null ? null : <p style={{ color: color.danger, fontSize: 12, margin: '4px 10px' }}>{error}</p>}
    </div>
  )
}

/** One entry of a {@link RowMenu}. */
interface RowMenuItem {
  label: string
  danger?: boolean
  run: () => void
}

/**
 * A ⋯ button that opens a small menu of row actions, matching the chat-session rows of the navigator; a click outside
 * the menu closes it.
 * @param props - the entries, the button's accessible label, and whether the button shows while the menu is closed.
 * @returns the button and, while open, the menu.
 */
function RowMenu(props: { items: RowMenuItem[]; label: string; visible: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return undefined
    const close = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || root.current?.contains(event.target) !== true) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => { document.removeEventListener('mousedown', close) }
  }, [open])
  return (
    <span ref={root} style={{ position: 'relative', flex: 'none', visibility: props.visible || open ? 'visible' : 'hidden' }}>
      <button
        type="button" aria-label={props.label} title={props.label} aria-haspopup="menu" aria-expanded={open}
        style={{ padding: '0 6px', border: 'none', borderRadius: 6, background: 'transparent', color: color.muted, cursor: 'pointer', fontSize: 14 }}
        onClick={(event) => { event.stopPropagation(); setOpen(value => !value) }}
      >⋯</button>
      {open && (
        <span role="menu" style={{ position: 'absolute', zIndex: 20, top: '100%', right: 0, display: 'flex', flexDirection: 'column', minWidth: 140, padding: 4, borderRadius: 8, border: `1px solid ${color.line}`, background: 'var(--dsw-alias-bg-base, Canvas)', boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)' }}>
          {props.items.map(item => (
            <button
              key={item.label} type="button" role="menuitem"
              style={{ padding: '6px 10px', border: 'none', borderRadius: 6, background: 'transparent', color: item.danger === true ? color.danger : 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap' }}
              onClick={(event) => { event.stopPropagation(); setOpen(false); item.run() }}
            >{item.label}</button>
          ))}
        </span>
      )}
    </span>
  )
}
