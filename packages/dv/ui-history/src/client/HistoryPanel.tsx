/**
 * The History panel: every record of a project, newest first and grouped by agent turn, read through
 * `POST /api/dv/history`. Each row shows time, actor, surface, intent, the operation's tool label, status, input and
 * output thumbnails, and the record's mark (草稿, 已接受, 已撤销, 已丢弃, 已重放, or an exploration branch). Filters narrow by
 * actor, branch, operation kind, and timeline. Selecting a row plays its output under the row and focuses the record on
 * the canvas or its clip on the timeline. The panel writes nothing except accept, discard, undo, and redo of the chat
 * session's working branch in its header.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DvClient, assetUrl } from '@dv/ui-kit/api.ts'
import { useCurrentProject } from '@dv/ui-kit/current-project.ts'
import { useDiscardDraft } from '@dv/ui-kit/DiscardDraftDialog.tsx'
import { useText } from '@dv/ui-kit/locale.ts'
import type { PickText } from '@dv/ui-kit/locale.ts'
import { openDrafts, sessionDraft } from '@dv/ui-kit/state.ts'
import { timelineName } from '@dv/ui-kit/timeline.ts'
import type { Actor, Asset, HistoryEntry, HistoryQuery, ProjectRecord, RecordStatus, Surface, WireHistory } from '@dv/ui-kit/types.ts'
import { useProjectState } from '@dv/ui-kit/useProject.ts'
import {
  DV_HISTORY_FOCUS_EVENT, DV_TRAJECTORY_FOCUS_EVENT, dispatchWorkspaceEvent, type DvWorkspaceEventMap,
} from '@dv/ui-kit/workspace-events.ts'
import {
  branchQuery, centerFocus, clipTimelines, groupByTurn, markBadge, markStyle, operationLabel, timelineRecords, turnToolCall,
} from './rows.ts'

/** Props of {@link HistoryPanel}. */
export interface HistoryPanelProps {
  projectId: string
  /** The chat session the panel sits beside; the header's actions act on that session's working branch. */
  session: string | null
  /** The API client; defaults to one over the page's fetch. */
  client?: DvClient
}

/** The four filters of the header; an empty value means all. */
interface Filters {
  actor: '' | Actor
  branch: string
  component: string
  timeline: string
}

const NO_FILTERS: Filters = { actor: '', branch: '', component: '', timeline: '' }

/** Entries per page. */
const PAGE = 50
/** The most entries one request reloads. */
const MAX_PAGE = 200

/** The loaded window of history: entries newest first, the request records of their turns, and their assets. */
interface Loaded {
  entries: HistoryEntry[]
  requests: Record<string, ProjectRecord>
  assets: Map<string, Asset>
  /** True while the last page was full, so 加载更多 may find more. */
  more: boolean
}

const ACTORS: Record<Actor, [string, string]> = { user: ['用户', 'User'], agent: ['智能体', 'Agent'], system: ['系统', 'System'] }
const SURFACES: Record<Surface, [string, string]> = {
  chat: ['对话', 'Chat'], canvas: ['画布', 'Canvas'], timeline: ['时间线', 'Timeline'], asset_pool: ['素材库', 'Asset pool'],
  api: ['接口', 'API'], history: ['历史', 'History'],
}
const STATUSES: Record<RecordStatus, [string, string]> = {
  pending: ['等待中', 'Pending'], running: ['运行中', 'Running'], done: ['完成', 'Done'], failed: ['失败', 'Failed'],
  cancelled: ['已取消', 'Cancelled'],
}
const COMPONENTS: Array<[string, string, string]> = [
  ['proj', '项目', 'Project'], ['asset', '素材库', 'Asset pool'], ['bible', '设定库', 'Story bible'], ['plan', '分镜', 'Shot plan'],
  ['shot', '镜头渲染', 'Shot render'], ['timeline', '时间线', 'Timeline'], ['deliver', '交付', 'Deliver'], ['inspect', '检查器', 'Inspector'],
]

const line = 'var(--dv-line, rgba(127, 127, 127, 0.25))'
const muted = 'var(--dv-muted, rgba(127, 127, 127, 0.95))'
const accent = 'var(--dv-accent, #7c5cff)'
const danger = 'var(--dv-danger, #e5484d)'
const button: CSSProperties = {
  border: `1px solid ${line}`, background: 'transparent', color: 'inherit', borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer',
}
const select: CSSProperties = { border: `1px solid ${line}`, background: 'transparent', color: 'inherit', borderRadius: 6, fontSize: 12, padding: '2px 4px' }
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
 * Format a record time: `HH:MM` today, else the date and `HH:MM`.
 * @param iso - an ISO time.
 * @returns the text.
 */
function shortTime(iso: string): string {
  const time = new Date(iso)
  const clock = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  return time.toDateString() === new Date().toDateString() ? clock : `${time.toLocaleDateString()} ${clock}`
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
    requests: { ...loaded?.requests, ...page.requests },
    assets,
    more: page.entries.length >= limit,
  }
}

/**
 * The loaded history window for a query: the first page on a query change, more pages on request, a refetch of the
 * loaded window on every `record`, `branch`, or unreadable event, and an in-place record update on every `update` event.
 * @param client - the API client.
 * @param query - the query without paging fields, or null when no record can match.
 * @returns the window, the last error, and the paging gesture.
 */
function useHistory(client: DvClient, query: HistoryQuery | null): {
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
    if (query === null) { store({ entries: [], requests: {}, assets: new Map(), more: false }, key); return }
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
    if (query === null) return
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
    if (query === null || shown === null || last === undefined) return shown
    const page = await client.listHistory({ ...query, before: last.record.id, limit: PAGE })
    const next = mergePage(shown, page, PAGE)
    store(next, key)
    return next
  }, [client, key, store])
  return { loaded, error, loadMore }
}

/**
 * The History panel of one project.
 * @param props - the project, the chat session beside the panel, and an optional client.
 * @returns the panel.
 */
export function HistoryPanel(props: HistoryPanelProps): ReactNode {
  const { projectId, session } = props
  const client = useMemo(() => props.client ?? new DvClient(), [props.client])
  const t = useText()
  const main = useProjectState(client, projectId, 'main')
  const draft = main.value === null ? null : sessionDraft(main.value, session)
  const working = useProjectState(client, projectId, draft?.branch ?? 'main')
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [selected, setSelected] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [focusRecord, setFocusRecord] = useState<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLElement>())

  const records = working.value?.components.proj.records
  const owner = useMemo(() => clipTimelines(records ?? []), [records])
  const timelines = working.value?.components.timeline.timelines ?? []
  const timelineSet = useMemo(() => {
    const timeline = timelines.find(item => item.id === filters.timeline)
    if (filters.timeline === '' || working.value === null) return null
    if (timeline === undefined) return []
    const { records: branchRecords, created_by: createdBy } = working.value.components.proj
    return timelineRecords(branchRecords, createdBy, timeline.id, timeline.clips.map(clip => clip.asset))
  }, [filters.timeline, timelines, working.value])
  const query = useMemo((): HistoryQuery | null => {
    if (timelineSet !== null && timelineSet.length === 0) return null
    return {
      project: projectId, ...branchQuery(filters.branch),
      ...filters.actor === '' ? {} : { actor: filters.actor },
      ...filters.component === '' ? {} : { component: filters.component },
      ...timelineSet === null ? {} : { records: timelineSet },
    }
  }, [projectId, filters.branch, filters.actor, filters.component, timelineSet])
  const { loaded, error, loadMore } = useHistory(client, query)

  // A `dv:history-focus` request: clear the filters, find the record the tool call wrote, then select it once loaded.
  const takeFocus = useCallback((focus: DvWorkspaceEventMap['dv:history-focus']) => {
    pendingFocus = null
    setFilters(NO_FILTERS)
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
    if (focusRecord === null || loaded === null || query === null || JSON.stringify(filters) !== JSON.stringify(NO_FILTERS)) return
    if (loaded.entries.some(entry => entry.record.id === focusRecord)) {
      setSelected(focusRecord)
      setFocusRecord(null)
      requestAnimationFrame(() => { rowRefs.current.get(focusRecord)?.scrollIntoView({ block: 'nearest' }) })
    } else if (loaded.more) void loadMore()
    else setFocusRecord(null)
  }, [focusRecord, loaded, query, filters, loadMore])

  const choose = (entry: HistoryEntry): void => {
    setSelected(entry.record.id)
    const target = centerFocus(entry, owner)
    // The focus names its own event and detail, so it is dispatched as is.
    if (target !== null) window.dispatchEvent(new CustomEvent(target.event, { detail: target.detail }))
  }

  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS)
  let body: ReactNode
  if (error !== null) body = <p style={{ color: danger, fontSize: 12 }}>{t(`读取失败：${error}`, `Failed to load: ${error}`)}</p>
  else if (loaded === null) body = <p style={{ color: muted, fontSize: 12 }}>{t('正在读取…', 'Loading…')}</p>
  else {
    // Every project starts with its `proj.create` record, so a project without other operation records counts as empty;
    // its creation row stays listed below the notice.
    const changes = loaded.entries.filter(entry => entry.record.kind === 'operation' && entry.record.operation !== 'proj.create')
    const empty = filtered ? loaded.entries.every(entry => entry.record.kind === 'request') : changes.length === 0
    const groups = groupByTurn(loaded.entries).map((group) => {
      const rows = group.entries.map(entry => (
        <Row
          key={entry.record.id} entry={entry} assets={loaded.assets} selected={selected === entry.record.id}
          onChoose={choose}
          rowRef={(element) => {
            if (element === null) rowRefs.current.delete(entry.record.id)
            else rowRefs.current.set(entry.record.id, element)
          }}
        />
      ))
      if (group.turn === null) return rows
      return (
        <TurnSection
          key={`${group.turn}:${group.entries[0]?.record.id ?? ''}`} turn={group.turn} entries={group.entries} request={loaded.requests[group.turn]}
        >
          {rows}
        </TurnSection>
      )
    })
    body = (
      <>
        {empty
          ? (
            <p data-testid="dv-history-empty" style={{ color: muted, fontSize: 12 }}>
              {filtered
                ? t('没有符合筛选条件的记录', 'No records match the filters')
                : t('还没有记录。在画布、时间线或对话里做的每一步都会出现在这里。', 'No records yet. Every change made in the canvas, the timeline, or the chat appears here.')}
            </p>
          )
          : null}
        {groups}
      </>
    )
  }
  return (
    <div data-testid="dv-history-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: 12, gap: 8 }}>
      <Actions client={client} projectId={projectId} session={session} draftOpen={draft !== null} />
      <FilterBar filters={filters} onChange={setFilters} state={main.value} timelines={timelines} t={t} />
      {notice === null ? null : <p style={{ color: muted, fontSize: 12, margin: 0 }}>{notice}</p>}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {body}
        {loaded?.more === true
          ? (
            <button type="button" data-testid="dv-history-more" style={{ ...button, marginTop: 8 }} onClick={() => { void loadMore() }}>
              {t('加载更多', 'Load more')}
            </button>
          )
          : null}
      </div>
    </div>
  )
}

/**
 * The header actions on the chat session's working branch: accept and discard while its draft is open, undo and redo.
 * @param props - the client, the project, the chat session, and whether the session has an open draft.
 * @returns the action bar.
 */
function Actions(props: { client: DvClient; projectId: string; session: string | null; draftOpen: boolean }): ReactNode {
  const { client, projectId, session } = props
  const t = useText()
  const [failure, setFailure] = useState<string | null>(null)
  const discard = useDiscardDraft(client, projectId, 'history')
  const run = (work: () => Promise<unknown>): void => {
    setFailure(null)
    work().catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) })
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {props.draftOpen && session !== null
        ? (
          <>
            <button type="button" style={button} onClick={() => { run(() => client.acceptDraft(projectId, { session }, 'history')) }}>{t('接受草稿', 'Accept the draft')}</button>
            <button type="button" style={button} onClick={() => { discard.request({ session }) }}>{t('丢弃', 'Discard')}</button>
          </>
        )
        : null}
      <button type="button" style={button} onClick={() => { run(() => client.undo(projectId, 'history', session)) }}>{t('撤销', 'Undo')}</button>
      <button type="button" style={button} onClick={() => { run(() => client.redo(projectId, 'history', session)) }}>{t('重做', 'Redo')}</button>
      {failure === null ? null : <span style={{ color: danger, fontSize: 12 }}>{failure}</span>}
      {discard.dialog}
    </div>
  )
}

/**
 * The four filter selects.
 * @param props - the filters, the change callback, the state of `main` (for branches), the working branch's timelines,
 *   and the string picker.
 * @returns the filter bar.
 */
function FilterBar(props: {
  filters: Filters
  onChange: (filters: Filters) => void
  state: Parameters<typeof openDrafts>[0] | null
  timelines: Array<{ id: string; name: string }>
  t: PickText
}): ReactNode {
  const { filters, onChange, state, t } = props
  const explorations = state === null ? [] : Object.keys(state.heads).filter(name => name !== 'main' && !name.startsWith('draft/')).sort()
  const drafts = state === null ? [] : openDrafts(state)
  const labelled = (zh: string, en: string, control: ReactNode): ReactNode => (
    <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, color: muted }}>{t(zh, en)}{control}</label>
  )
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {labelled('发起者', 'Actor', (
        <select data-testid="dv-history-filter-actor" style={select} value={filters.actor} onChange={(event) => { onChange({ ...filters, actor: event.currentTarget.value as Filters['actor'] }) }}>
          <option value="">{t('全部', 'All')}</option>
          {(Object.keys(ACTORS) as Actor[]).map(actor => <option key={actor} value={actor}>{t(...ACTORS[actor])}</option>)}
        </select>
      ))}
      {labelled('分支', 'Branch', (
        <select data-testid="dv-history-filter-branch" style={select} value={filters.branch} onChange={(event) => { onChange({ ...filters, branch: event.currentTarget.value }) }}>
          <option value="">{t('全部', 'All')}</option>
          <option value="main">main</option>
          {drafts.map(draft => <option key={draft.branch} value={draft.branch}>{t(`草稿 · ${draft.session}`, `Draft · ${draft.session}`)}</option>)}
          {explorations.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      ))}
      {labelled('操作类型', 'Operation kind', (
        <select data-testid="dv-history-filter-component" style={select} value={filters.component} onChange={(event) => { onChange({ ...filters, component: event.currentTarget.value }) }}>
          <option value="">{t('全部', 'All')}</option>
          {COMPONENTS.map(([key, zh, en]) => <option key={key} value={key}>{t(zh, en)}</option>)}
        </select>
      ))}
      {labelled('时间线', 'Timeline', (
        <select data-testid="dv-history-filter-timeline" style={select} value={filters.timeline} onChange={(event) => { onChange({ ...filters, timeline: event.currentTarget.value }) }}>
          <option value="">{t('全部', 'All')}</option>
          {props.timelines.map(timeline => (
            <option key={timeline.id} value={timeline.id}>{timelineName(timeline, n => t(`时间线 ${String(n)}`, `Timeline ${String(n)}`))}</option>
          ))}
        </select>
      ))}
    </div>
  )
}

/**
 * One turn group: the human's request as the heading, its time, the link into the trajectory, and the turn's rows.
 * @param props - the turn, its entries, its request record when known, and the rendered rows.
 * @returns the group.
 */
function TurnSection(props: { turn: string; entries: HistoryEntry[]; request: ProjectRecord | undefined; children: ReactNode }): ReactNode {
  const t = useText()
  const call = turnToolCall(props.entries)
  const time = props.request?.created_at ?? props.entries.at(-1)?.record.created_at ?? ''
  const text = props.request?.intent ?? ''
  return (
    <section data-testid="dv-history-turn" data-turn={props.turn} style={{ borderLeft: `2px solid ${line}`, paddingLeft: 8, margin: '0 0 10px' }}>
      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, margin: '0 0 4px' }}>
        <span title={text} style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {text === '' ? t('智能体轮次', 'Agent turn') : text}
        </span>
        <span title={time} style={{ color: muted }}>{time === '' ? '' : shortTime(time)}</span>
        {call === null ? null : <TrajectoryLink session={call.session} toolCall={call.toolCall} />}
      </header>
      {props.children}
    </section>
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

/**
 * One record row, with its output preview while selected.
 * @param props - the entry, the known assets, whether it is selected, the selection callback, and the row element ref.
 * @returns the row.
 */
function Row(props: {
  entry: HistoryEntry
  assets: ReadonlyMap<string, Asset>
  selected: boolean
  onChoose: (entry: HistoryEntry) => void
  rowRef: (element: HTMLElement | null) => void
}): ReactNode {
  const { entry, assets } = props
  const { record } = entry
  const t = useText()
  const badge = markBadge(entry)
  const style = markStyle(entry.mark)
  const label = operationLabel(record.operation)
  const status = t(...STATUSES[record.status])
  const inputs = record.inputs.map(input => input.resolved_asset).filter((id): id is string => id !== null).slice(0, 3)
  const outputs = record.outputs.slice(0, 3)
  return (
    <div
      ref={props.rowRef} role="option" tabIndex={0} aria-selected={props.selected}
      data-testid="dv-history-row" data-record={record.id} data-mark={entry.mark} data-status={record.status} data-actor={record.actor}
      onClick={() => { props.onChoose(entry) }}
      onKeyDown={(event) => { if (event.key === 'Enter') props.onChoose(entry) }}
      style={{
        padding: '6px 6px', borderRadius: 6, cursor: 'pointer', fontSize: 12, marginBottom: 2,
        background: props.selected ? 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))' : 'transparent',
        opacity: style === 'normal' ? 1 : 0.55,
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span title={record.created_at} style={{ color: muted }}>{shortTime(record.created_at)}</span>
        <span>{t(...ACTORS[record.actor])}</span>
        <span style={{ color: muted }}>· {t(...SURFACES[record.surface])}</span>
        <span style={{ fontWeight: 600, textDecoration: style === 'struck' ? 'line-through' : 'none' }}>{t(...label)}</span>
        <span title={record.error?.message ?? status} style={{ color: record.status === 'failed' ? danger : muted }}>{status}</span>
        {badge === null
          ? null
          : <span style={{ fontSize: 10, border: `1px solid ${accent}`, color: accent, borderRadius: 3, padding: '0 4px' }}>{'branch' in badge ? badge.branch : t(badge.zh, badge.en)}</span>}
        {record.session !== null && record.tool_call !== null
          ? <TrajectoryLink session={record.session} toolCall={record.tool_call} />
          : null}
      </div>
      {record.intent === ''
        ? null
        : <div title={record.intent} style={{ color: muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{record.intent}</div>}
      {inputs.length + outputs.length === 0
        ? null
        : (
          <div style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'center' }}>
            {inputs.map(id => <Thumb key={`in:${id}`} id={id} asset={assets.get(id)} />)}
            {inputs.length > 0 && outputs.length > 0 ? <span style={{ color: muted }}>→</span> : null}
            {outputs.map(id => <Thumb key={`out:${id}`} id={id} asset={assets.get(id)} />)}
          </div>
        )}
      {props.selected ? <Preview record={record} assets={assets} /> : null}
    </div>
  )
}

/** One input or output thumbnail. */
function Thumb(props: { id: string; asset: Asset | undefined }): ReactNode {
  const media: CSSProperties = { width: 40, height: 40, objectFit: 'cover', borderRadius: 4, border: `1px solid ${line}`, display: 'block' }
  return props.asset?.mime.startsWith('video/') === true
    ? <video src={`${assetUrl(props.id)}#t=0.1`} preload="metadata" muted style={media} />
    : <img src={assetUrl(props.id)} alt={props.asset?.name ?? props.id} loading="lazy" style={media} />
}

/** The inline player of a selected row: its first video output, else its first image output; nothing without outputs. */
function Preview(props: { record: ProjectRecord; assets: ReadonlyMap<string, Asset> }): ReactNode {
  const outputs = props.record.outputs.map(id => ({ id, mime: props.assets.get(id)?.mime ?? '' }))
  const video = outputs.find(output => output.mime.startsWith('video/'))
  const image = outputs.find(output => output.mime.startsWith('image/'))
  if (video === undefined && image === undefined) return null
  const style: CSSProperties = { maxWidth: '100%', maxHeight: 220, borderRadius: 6, marginTop: 6, display: 'block' }
  return (
    <div data-testid="dv-history-preview" onClick={(event) => { event.stopPropagation() }}>
      {video === undefined
        ? <img src={assetUrl(image?.id ?? '')} alt="" style={style} />
        : <video src={assetUrl(video.id)} autoPlay muted controls style={style} />}
    </div>
  )
}

/**
 * The tab body: the History panel of the project that the DreamVerse shell has open, beside the chat session whose
 * right panel holds the tab.
 * @param props - the tab's chat session and the injected client.
 * @returns the panel, or a notice while no project is open.
 */
export function HistoryTabBody(props: PropsRuntime<'sidebar.right.pane.tab'> & { client: DvClient }): ReactNode {
  const project = useCurrentProject()
  const t = useText()
  if (project === null) return <p data-testid="dv-history-empty" style={{ padding: 12, fontSize: 12, color: muted }}>{t('先打开一个项目', 'Open a project first')}</p>
  // Keyed by project so a switch starts from an empty panel instead of showing the previous project's records.
  return <HistoryPanel key={project} projectId={project} session={props.sessionId} client={props.client} />
}
