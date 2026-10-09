/**
 * The History panel: the edit history of a project, read through `POST /api/dv/history`, like the History panel of an
 * image editor. It lists the steps of the history list, newest first. Each row shows the action with its subject
 * (修改分镜计划 p1 → v2, 参考图生成镜头 7), who did it (你, 智能体, 自动), how long ago, its status, one thumbnail, and for an
 * agent action the intent the agent gave for the call. The renders a plan approval scheduled fold under the approval's
 * row. The step at the current position carries 当前; the steps after it, which redo brings back, are greyed. Every other
 * row's ⋮ menu offers 回到这一步, which moves the current position to that step. Selecting a row plays its output under
 * the row and, for a step at or before the current position, focuses it on the canvas or its clip on the timeline. The
 * header holds undo and redo; moves write no record, and a new step after a move discards the greyed steps.
 *
 * @module @dv/ui-history/HistoryPanel
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DvClient, assetUrl } from '@dv/ui-kit/api.ts'
import { useCurrentProject } from '@dv/ui-kit/current-project.ts'
import { useText } from '@dv/ui-kit/locale.ts'
import type { Actor, Asset, HistoryEntry, HistoryQuery, ProjectRecord, RecordStatus, WireHistory } from '@dv/ui-kit/types.ts'
import { useProjectState } from '@dv/ui-kit/useProject.ts'
import {
  DV_HISTORY_FOCUS_EVENT, DV_TRAJECTORY_FOCUS_EVENT, dispatchWorkspaceEvent, type DvWorkspaceEventMap,
} from '@dv/ui-kit/workspace-events.ts'
import {
  actionLabel, actionRows, centerFocus, clipTimelines, relativeTime, thumbnailOf, type ActionRow, type Thumbnail,
} from './rows.ts'

/** Props of {@link HistoryPanel}. */
export interface HistoryPanelProps {
  projectId: string
  /** The API client; defaults to one over the page's fetch. */
  client?: DvClient
}

/** Entries per page. */
const PAGE = 50
/** The most entries one request reloads. */
const MAX_PAGE = 200

/** The loaded window of history: entries newest first and their assets. */
interface Loaded {
  entries: HistoryEntry[]
  assets: Map<string, Asset>
  /** True while the last page was full, so 加载更多 may find more. */
  more: boolean
}

/** Who did an action: the creator at the screen, the agent, or the project on its own (renders an approval scheduled). */
const ACTORS: Record<Actor, [string, string]> = { user: ['你', 'You'], agent: ['智能体', 'Agent'], system: ['自动', 'Automatic'] }
const STATUSES: Record<RecordStatus, [string, string]> = {
  pending: ['等待中', 'Pending'], running: ['运行中', 'Running'], done: ['完成', 'Done'], failed: ['失败', 'Failed'],
  cancelled: ['已取消', 'Cancelled'],
}

const line = 'var(--dv-line, rgba(127, 127, 127, 0.25))'
const muted = 'var(--dv-muted, rgba(127, 127, 127, 0.95))'
const accent = 'var(--dv-accent, #7c5cff)'
const danger = 'var(--dv-danger, #e5484d)'
const success = 'var(--dv-success, #30a46c)'
/** The relative time's gray: opaque, so the small text draws as one plain glyph run. */
const timeColor = 'var(--dv-muted, #8b8b8b)'
/** The dot color of each status. */
const STATUS_COLORS: Record<RecordStatus, string> = { pending: muted, running: accent, done: success, failed: danger, cancelled: muted }
const button: CSSProperties = {
  border: `1px solid ${line}`, background: 'transparent', color: 'inherit', borderRadius: 6, padding: '2px 8px', fontSize: 12, cursor: 'pointer',
}
/** A 28px icon-only button of the header. */
const icon: CSSProperties = {
  width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: 6,
  padding: 0, background: 'transparent', color: 'inherit', cursor: 'pointer',
}
const link: CSSProperties = { border: 'none', background: 'transparent', color: accent, fontSize: 11, padding: 0, cursor: 'pointer' }

/**
 * A `dv:history-focus` request that no mounted panel has taken yet. The request usually arrives while the tab is
 * closed (the plugin opens the tab in response), so the panel that mounts next takes it.
 */
let pendingFocus: DvWorkspaceEventMap['dv:history-focus'] | null = null
const focusListeners = new Set<(focus: DvWorkspaceEventMap['dv:history-focus']) => void>()
if (typeof window !== 'undefined') {
  window.addEventListener(DV_HISTORY_FOCUS_EVENT, (event) => {
    const focus = (event as CustomEvent<DvWorkspaceEventMap['dv:history-focus']>).detail
    pendingFocus = focus
    for (const listener of focusListeners) listener(focus)
  })
}

/**
 * Merge a page into the loaded window.
 * @param loaded - the window so far, or null for a fresh one.
 * @param page - the route's answer.
 * @param limit - the page size asked for.
 * @returns the merged window.
 */
function mergePage(loaded: Loaded | null, page: WireHistory, limit: number): Loaded {
  const assets = new Map(loaded?.assets ?? [])
  for (const asset of page.assets) assets.set(asset.id, asset)
  return {
    entries: [...loaded?.entries ?? [], ...page.entries],
    assets,
    more: page.entries.length >= limit,
  }
}

/**
 * The loaded history window for a query: the first page on a query change, more pages on request, a refetch of the
 * loaded window on every `record` or unreadable event, and an in-place record update on every `update` event.
 * @param client - the API client.
 * @param query - the query without paging fields.
 * @returns the window, the last error, and the paging gesture.
 */
function useHistory(client: DvClient, query: HistoryQuery): {
  loaded: Loaded | null
  error: string | null
  loadMore: () => Promise<Loaded | null>
} {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = useRef<Loaded | null>(null)
  const key = JSON.stringify(query)
  const keyRef = useRef(key)
  keyRef.current = key
  const store = useCallback((next: Loaded | null, forKey: string) => {
    if (keyRef.current !== forKey) return
    current.current = next
    setLoaded(next)
  }, [])
  // The first page of every query.
  useEffect(() => {
    const controller = new AbortController()
    current.current = null
    setLoaded(null)
    client.listHistory({ ...query, limit: PAGE }, controller.signal).then((page) => {
      setError(null)
      store(mergePage(null, page, PAGE), key)
    }, (failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { controller.abort() }
    // `key` stands for `query`.
  }, [client, key, store])
  // Live update of the loaded window.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const refetch = (): void => {
      const limit = Math.min(Math.max(current.current?.entries.length ?? 0, PAGE), MAX_PAGE)
      client.listHistory({ ...query, limit }).then((page) => { store(mergePage(null, page, limit), key) }, () => undefined)
    }
    const unsubscribe = client.subscribe(query.project, (event) => {
      if (event?.kind === 'update') {
        const shown = current.current
        if (shown === null) return
        const entries = shown.entries.map(entry => entry.record.id === event.record.id ? { ...entry, record: event.record } : entry)
        store({ ...shown, entries }, key)
        return
      }
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; refetch() }, 200)
    })
    return () => {
      if (timer !== null) clearTimeout(timer)
      unsubscribe()
    }
  }, [client, key, store])
  const loadMore = useCallback(async (): Promise<Loaded | null> => {
    const shown = current.current
    const last = shown?.entries.at(-1)
    if (shown === null || last === undefined) return shown
    const page = await client.listHistory({ ...query, before: last.record.id, limit: PAGE })
    const next = mergePage(shown, page, PAGE)
    store(next, key)
    return next
  }, [client, key, store])
  return { loaded, error, loadMore }
}

/**
 * The History panel of one project.
 * @param props - the project and an optional client.
 * @returns the panel.
 */
export function HistoryPanel(props: HistoryPanelProps): ReactNode {
  const { projectId } = props
  const client = useMemo(() => props.client ?? new DvClient(), [props.client])
  const t = useText()
  const current = useProjectState(client, projectId)
  const [selected, setSelected] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [focusRecord, setFocusRecord] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const rowRefs = useRef(new Map<string, HTMLElement>())
  // The relative times refresh every half minute.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { clearInterval(timer) }
  }, [])

  // The records of the current state: what the canvas and the timeline show.
  const records = current.value?.components.proj.records
  const owner = useMemo(() => clipTimelines(records ?? []), [records])
  // The steps of the history list, newest first.
  const query = useMemo((): HistoryQuery => ({ project: projectId }), [projectId])
  const { loaded, error, loadMore } = useHistory(client, query)
  const rows = useMemo(() => actionRows(loaded?.entries ?? []), [loaded])
  const recordsById = useMemo(() => new Map((loaded?.entries ?? []).map(entry => [entry.record.id, entry.record])), [loaded])

  // A `dv:history-focus` request: find the record the tool call wrote, then select it once loaded.
  const takeFocus = useCallback((focus: DvWorkspaceEventMap['dv:history-focus']) => {
    pendingFocus = null
    setNotice(null)
    client.listHistory({ project: projectId, session: focus.session, tool_call: focus.toolCall, limit: 1 }).then((page) => {
      const found = page.entries[0]
      if (found === undefined) { setNotice(t('这次调用没有写记录', 'This call wrote no record')); return }
      setFocusRecord(found.record.id)
    }, (failure: unknown) => { setNotice(String(failure)) })
  }, [client, projectId, t])
  useEffect(() => {
    if (pendingFocus !== null) takeFocus(pendingFocus)
    focusListeners.add(takeFocus)
    return () => { focusListeners.delete(takeFocus) }
  }, [takeFocus])
  useEffect(() => {
    if (focusRecord === null || loaded === null) return
    if (loaded.entries.some(entry => entry.record.id === focusRecord)) {
      // A record folded under an approval shows once its approval's row is expanded.
      const parent = rows.find(row => row.children.some(child => child.record.id === focusRecord))
      if (parent !== undefined) setExpanded(shown => new Set([...shown, parent.entry.record.id]))
      setSelected(focusRecord)
      setFocusRecord(null)
      requestAnimationFrame(() => { rowRefs.current.get(focusRecord)?.scrollIntoView({ block: 'nearest' }) })
    } else if (loaded.more) void loadMore()
    else setFocusRecord(null)
  }, [focusRecord, loaded, rows, loadMore])

  const choose = (entry: HistoryEntry): void => {
    setSelected(entry.record.id)
    const target = centerFocus(entry, owner)
    // The focus names its own event and detail, so it is dispatched as is.
    if (target !== null) window.dispatchEvent(new CustomEvent(target.event, { detail: target.detail }))
  }
  const toggle = (record: string): void => {
    setExpanded((shown) => {
      const next = new Set(shown)
      if (!next.delete(record)) next.add(record)
      return next
    })
  }
  const report = (failure: unknown): void => { setNotice(failure instanceof Error ? failure.message : String(failure)) }
  // 回到这一步: move the current position to the step.
  const jump = (record: string): void => {
    setNotice(null)
    client.moveTo(projectId, record).catch(report)
  }
  const rowRef = (record: string) => (element: HTMLElement | null): void => {
    if (element === null) rowRefs.current.delete(record)
    else rowRefs.current.set(record, element)
  }

  let body: ReactNode
  if (error !== null) body = <p style={{ color: danger, fontSize: 12 }}>{t(`读取失败：${error}`, `Failed to load: ${error}`)}</p>
  else if (loaded === null) body = <p style={{ color: muted, fontSize: 12 }}>{t('正在读取…', 'Loading…')}</p>
  else {
    // Every project starts with its `proj.create` record, so a project without other records counts as empty; its
    // creation row stays listed below the notice.
    const changes = loaded.entries.filter(entry => entry.record.operation !== 'proj.create')
    const shared = {
      assets: loaded.assets, records: recordsById, now, selected, onChoose: choose, rowRef, onJump: jump,
    }
    body = (
      <>
        {changes.length === 0
          ? (
            <p data-testid="dv-history-empty" style={{ color: muted, fontSize: 12 }}>
              {t('还没有记录。在画布、时间线或对话里做的每一步都会出现在这里。', 'No records yet. Every change made in the canvas, the timeline, or the chat appears here.')}
            </p>
          )
          : null}
        {rows.map(row => (
          <Row
            key={row.entry.record.id} {...shared} row={row}
            expanded={expanded.has(row.entry.record.id)} onToggle={() => { toggle(row.entry.record.id) }}
          />
        ))}
      </>
    )
  }
  return (
    <div data-testid="dv-history-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '8px 8px 0', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Actions client={client} projectId={projectId} canRedo={current.value !== null && current.value.head !== current.value.tip} />
      </div>
      {notice === null ? null : <p style={{ color: muted, fontSize: 12, margin: 0 }}>{notice}</p>}
      <div role="listbox" style={{ flex: 1, minHeight: 0, overflowY: 'auto', borderTop: `1px solid ${line}` }}>
        {body}
        {loaded?.more === true
          ? (
            <button type="button" data-testid="dv-history-more" style={{ ...button, margin: '8px 0' }} onClick={() => { void loadMore() }}>
              {t('加载更多', 'Load more')}
            </button>
          )
          : null}
      </div>
    </div>
  )
}

/** The undo and redo buttons of the header: test ID suffix, label, tooltip, and icon paths. */
const MOVES = [
  { key: 'undo', label: ['撤销', 'Undo'], title: ['撤销（Ctrl+Z / ⌘Z）', 'Undo (Ctrl+Z / ⌘Z)'], paths: ['M9 14 4 9l5-5', 'M4 9h11a5 5 0 0 1 0 10h-3'] },
  {
    key: 'redo', label: ['重做', 'Redo'], title: ['重做（Shift+Ctrl+Z / ⇧⌘Z）', 'Redo (Shift+Ctrl+Z / ⇧⌘Z)'],
    paths: ['m15 14 5-5-5-5', 'M20 9H9a5 5 0 0 0 0 10h3'],
  },
] as const

/**
 * Undo and redo at the end of the header: they move the current position one step; redo is enabled while a step after
 * the current position exists.
 * @param props - the client, the project, and whether redo has a step to bring back.
 * @returns the buttons and the last failure.
 */
function Actions(props: { client: DvClient; projectId: string; canRedo: boolean }): ReactNode {
  const { client, projectId } = props
  const t = useText()
  const [failure, setFailure] = useState<string | null>(null)
  const run = (work: () => Promise<unknown>): void => {
    setFailure(null)
    work().catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) })
  }
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', marginLeft: 'auto' }}>
      {MOVES.map((move) => {
        const enabled = move.key === 'undo' || props.canRedo
        return (
          <button
            key={move.key} type="button" data-testid={`dv-history-${move.key}`} disabled={!enabled}
            aria-label={t(move.label[0], move.label[1])} title={t(move.title[0], move.title[1])}
            style={{ ...icon, ...enabled ? {} : { opacity: 0.35, cursor: 'default' } }}
            onClick={() => { run(() => move.key === 'undo' ? client.undo(projectId) : client.redo(projectId)) }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {move.paths.map(path => <path key={path} d={path} />)}
            </svg>
          </button>
        )
      })}
      {failure === null ? null : <span style={{ color: danger, fontSize: 12 }}>{failure}</span>}
    </div>
  )
}

/**
 * The ⋮ button at the end of a row and its menu with 回到这一步. Escape or a click outside closes the menu; its clicks and
 * keys never reach the row. The row of the current position has no button.
 * @param props - the 回到这一步 gesture, or null when it does not apply.
 * @returns the button and, while open, the menu; null without a gesture.
 */
function StepActions(props: { onBack: (() => void) | null }): ReactNode {
  const t = useText()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('pointerdown', outside) }
  }, [open])
  const { onBack } = props
  if (onBack === null) return null
  return (
    <span
      ref={root} style={{ position: 'relative', flex: 'none', display: 'inline-flex' }}
      onClick={(event) => { event.stopPropagation() }}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') setOpen(false) }}
    >
      <button
        type="button" data-testid="dv-history-step-actions" aria-label={t('更多操作', 'More actions')} aria-haspopup="menu" aria-expanded={open}
        style={{ ...icon, width: 24, height: 24, color: muted }} onClick={() => { setOpen(value => !value) }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" />
        </svg>
      </button>
      {open
        ? (
          <div
            role="menu"
            style={{
              position: 'absolute', right: 0, top: '100%', marginTop: 2, zIndex: 20, minWidth: 140, padding: 4, display: 'flex',
              flexDirection: 'column', border: '0.5px solid var(--dsw-alias-border-l3, #d0d3da)', borderRadius: 8,
              background: 'var(--dsw-alias-bg-base, #ffffff)', boxShadow: '0 6px 24px rgba(0, 0, 0, 0.18)',
            }}
          >
            <button
              type="button" role="menuitem" data-testid="dv-history-step-back"
              style={{ ...button, border: 'none', textAlign: 'left', padding: '6px 10px', whiteSpace: 'nowrap' }}
              onClick={() => { setOpen(false); onBack() }}
            >
              {t('回到这一步', 'Go back to this step')}
            </button>
          </div>
        )
        : null}
    </span>
  )
}

/** The 在轨迹中查看 link: asks the shell to open 轨迹 on the chat session and show the tool call. */
function TrajectoryLink(props: { session: string; toolCall: string }): ReactNode {
  const t = useText()
  return (
    <button
      type="button" data-testid="dv-history-open-trajectory" style={link}
      onClick={(event) => {
        event.stopPropagation()
        dispatchWorkspaceEvent(DV_TRAJECTORY_FOCUS_EVENT, { session: props.session, toolCall: props.toolCall })
      }}
    >
      {t('在轨迹中查看', 'Show in trajectory')}
    </button>
  )
}

/** What every row reads besides its own entry. */
interface RowContext {
  assets: ReadonlyMap<string, Asset>
  records: ReadonlyMap<string, ProjectRecord>
  now: number
  selected: string | null
  onChoose: (entry: HistoryEntry) => void
  rowRef: (record: string) => (element: HTMLElement | null) => void
  /** 回到这一步 on a row. */
  onJump: (record: string) => void
}

/**
 * One action row: the thumbnail, the action label and the time on the first line; who, the status, 当前 on the step at
 * the current position and the agent's intent on the second; a step after the current position is greyed. A plan
 * approval adds the toggle that shows the renders it scheduled, nested below it.
 * @param props - the row, the shared row context, and the approval's expanded state and toggle.
 * @returns the row and, while expanded, its nested rows.
 */
function Row(props: RowContext & { row: ActionRow; expanded: boolean; onToggle: () => void }): ReactNode {
  const { row, expanded } = props
  const t = useText()
  const children = row.children
  const renders = children.filter(child => child.record.operation === 'shot.render_ref2va' || child.record.operation === 'shot.render_t2va')
  const doneRenders = renders.filter(child => child.record.status === 'done').length
  const foldText = renders.length === 0
    ? t(...actionLabel(children[0]?.record ?? row.entry.record))
    : t(`渲染 ${String(renders.length)} 个镜头`, `Render ${String(renders.length)} shots`)
  return (
    <div style={{ borderBottom: `1px solid ${line}` }}>
      <EntryRow {...props} entry={row.entry} nested={false} folded={children} />
      {children.length === 0
        ? null
        : (
          <button
            type="button" data-testid="dv-history-fold" aria-expanded={expanded} onClick={props.onToggle}
            style={{ ...link, color: muted, display: 'block', padding: '0 0 6px 56px', fontSize: 11 }}
          >
            {expanded ? '▾' : '▸'} {foldText}
            {doneRenders < renders.length ? ` (${String(doneRenders)}/${String(renders.length)})` : ''}
          </button>
        )}
      {expanded ? children.map(child => <EntryRow key={child.record.id} {...props} entry={child} nested />) : null}
    </div>
  )
}

/**
 * One record's line pair, with its output preview, full words and trajectory link while selected.
 * @param props - the entry, the shared row context, whether it is nested under an approval, and the records folded under it (`folded`).
 * @returns the row.
 */
function EntryRow(props: RowContext & { entry: HistoryEntry; nested: boolean; folded?: HistoryEntry[] }): ReactNode {
  const { entry, assets, nested } = props
  const { record } = entry
  const t = useText()
  const selected = props.selected === record.id
  const status = t(...STATUSES[record.status])
  const thumbnail = thumbnailOf(record, assets, props.records, (props.folded ?? []).map(child => child.record))
  // The intent the agent gave for its call; a call without one records the operation name, which the label already shows.
  // A human action's intent repeats its label, so it stays in the tooltip.
  const words = record.actor === 'agent' && record.intent !== record.operation ? record.intent : ''
  const size = nested ? 28 : 40
  const dim = entry.place === 'after' ? 0.55 : 1
  return (
    <div
      ref={props.rowRef(record.id)} role="option" tabIndex={0} aria-selected={selected} title={record.intent}
      data-testid="dv-history-row" data-record={record.id} data-status={record.status} data-actor={record.actor}
      data-surface={record.surface} data-place={entry.place}
      onClick={() => { props.onChoose(entry) }}
      onKeyDown={(event) => { if (event.key === 'Enter') props.onChoose(entry) }}
      style={{
        padding: nested ? '4px 8px 4px 56px' : '6px 8px', cursor: 'pointer', fontSize: 12,
        background: selected ? 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))' : 'transparent',
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: `${String(size)}px minmax(0, 1fr) auto`, columnGap: 8, alignItems: 'center' }}>
        {/* A step after the current one is greyed; the ⋮ menu is not, so it is not trapped under the next row. */}
        <div style={{ opacity: dim }}><Thumb thumbnail={thumbnail} size={size} /></div>
        <div style={{ minWidth: 0, opacity: dim }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
            <span
              style={{
                flex: 1, minWidth: 0, fontWeight: nested ? 400 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {t(...actionLabel(record))}
            </span>
            <span
              data-testid="dv-history-time" title={new Date(record.created_at).toLocaleString()}
              style={{ flex: 'none', color: timeColor, fontSize: 12, fontWeight: 400, whiteSpace: 'nowrap', textAlign: 'right' }}
            >
              {t(...relativeTime(record.created_at, props.now))}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: muted, fontSize: 11, minWidth: 0, whiteSpace: 'nowrap' }}>
            <span>{t(...ACTORS[record.actor])}</span>
            <span title={record.error?.message ?? status} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span style={{ width: 6, height: 6, borderRadius: 3, background: STATUS_COLORS[record.status], display: 'inline-block' }} />
              {record.status === 'done' ? null : <span style={{ color: record.status === 'failed' ? danger : muted }}>{status}</span>}
            </span>
            {entry.place === 'current'
              ? (
                <span data-testid="dv-history-current" style={{ background: accent, color: '#fff', borderRadius: 3, padding: '0 4px', lineHeight: '14px' }}>
                  {t('当前', 'Current')}
                </span>
              )
              : null}
            {words === '' ? null : <span title={words} style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>“{words}”</span>}
          </div>
        </div>
        <StepActions onBack={entry.place === 'current' ? null : () => { props.onJump(record.id) }} />
      </div>
      {selected ? <Details record={record} assets={assets} words={words} /> : null}
    </div>
  )
}

/**
 * A row's one thumbnail: an image, a video's first frame, or an empty square that keeps the rows aligned. An image that
 * fails to load falls back to the empty square instead of the browser's broken-image icon.
 * @param props - the thumbnail, or null, and its edge in pixels.
 * @returns the thumbnail.
 */
function Thumb(props: { thumbnail: Thumbnail | null; size: number }): ReactNode {
  const [failed, setFailed] = useState<string | null>(null)
  const media: CSSProperties = {
    width: props.size, height: props.size, objectFit: 'cover', borderRadius: 4, display: 'block',
    background: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))',
  }
  const { thumbnail } = props
  if (thumbnail === null || failed === thumbnail.asset) return <span style={media} />
  const shared = { 'data-testid': 'dv-history-thumb', 'data-asset': thumbnail.asset, style: media }
  return thumbnail.kind === 'video'
    ? <video {...shared} src={assetUrl(thumbnail.asset)} preload="metadata" muted playsInline onError={() => { setFailed(thumbnail.asset) }} />
    : <img {...shared} src={assetUrl(thumbnail.asset)} alt="" loading="lazy" onError={() => { setFailed(thumbnail.asset) }} />
}

/**
 * What a selected row adds below it: the inline player of its first video output (else its first image output), the
 * agent's intent in full, and the link into the trajectory for an agent action.
 * @param props - the record, the known assets, and the agent's intent.
 * @returns the details, or null when there is nothing to add.
 */
function Details(props: { record: ProjectRecord; assets: ReadonlyMap<string, Asset>; words: string }): ReactNode {
  const { record } = props
  const outputs = record.outputs.map(id => ({ id, mime: props.assets.get(id)?.mime ?? '' }))
  const video = outputs.find(output => output.mime.startsWith('video/'))
  const image = outputs.find(output => output.mime.startsWith('image/'))
  const call = record.session !== null && record.tool_call !== null ? { session: record.session, toolCall: record.tool_call } : null
  if (video === undefined && image === undefined && call === null && props.words === '') return null
  const style: CSSProperties = { maxWidth: '100%', maxHeight: 220, borderRadius: 6, display: 'block' }
  return (
    <div onClick={(event) => { event.stopPropagation() }} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
      {video === undefined && image === undefined
        ? null
        : (
          <div data-testid="dv-history-preview">
            {video === undefined
              ? <img src={assetUrl(image?.id ?? '')} alt="" style={style} />
              : <video src={assetUrl(video.id)} autoPlay muted controls style={style} />}
          </div>
        )}
      {props.words === '' ? null : <div style={{ color: muted, fontSize: 11, whiteSpace: 'pre-wrap' }}>“{props.words}”</div>}
      {call === null ? null : <div><TrajectoryLink session={call.session} toolCall={call.toolCall} /></div>}
    </div>
  )
}

/**
 * The tab body: the History panel of the project that the DreamVerse shell has open, beside the chat session whose
 * right panel holds the tab.
 * @param props - the tab's props and the injected client.
 * @returns the panel, or a notice while no project is open.
 */
export function HistoryTabBody(props: PropsRuntime<'sidebar.right.pane.tab'> & { client: DvClient }): ReactNode {
  const project = useCurrentProject()
  const t = useText()
  if (project === null) return <p data-testid="dv-history-empty" style={{ padding: 12, fontSize: 12, color: muted }}>{t('先打开一个项目', 'Open a project first')}</p>
  // Keyed by project so a switch starts from an empty panel instead of showing the previous project's records.
  return <HistoryPanel key={project} projectId={project} client={props.client} />
}
