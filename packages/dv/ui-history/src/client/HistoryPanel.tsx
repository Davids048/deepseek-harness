/**
 * The History panel: the edit history of a project, read through `POST /api/dv/history`, in two views that a toggle in
 * the header switches.
 *
 * The list view (列表) shows the steps of the project's current branch from its start to its head, newest first, one
 * row per action, and the steps after the head that redo brings back, greyed. Each row shows the action with its
 * subject (修改分镜计划 p1 → v2, 参考图生成镜头 7), who did it (你, 智能体, 自动), how long ago, its status, one thumbnail,
 * and for an agent action the intent the agent gave for the call. The renders a plan approval scheduled fold under the
 * approval's row. The current step carries 当前; every step before it offers 回到这一步, which jumps the branch back to
 * just after that step. Selecting a row plays its output under the row and focuses the record on the canvas or its clip
 * on the timeline. The header holds the filters (actor, operation kind, timeline), undo, and redo.
 *
 * The tree view (分支树) shows every step of every branch as a lane graph (`branchTree`): one lane per branch, one row
 * per step with only its label and a small thumbnail. Clicking a step makes its branch current and moves the branch's
 * head there.
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
import type { PickText } from '@dv/ui-kit/locale.ts'
import { branchLabel } from '@dv/ui-kit/state.ts'
import { timelineName } from '@dv/ui-kit/timeline.ts'
import type { Actor, Asset, Branch, HistoryEntry, HistoryQuery, ProjectRecord, RecordStatus, WireHistory } from '@dv/ui-kit/types.ts'
import { useProjectState } from '@dv/ui-kit/useProject.ts'
import {
  DV_HISTORY_FOCUS_EVENT, DV_TRAJECTORY_FOCUS_EVENT, dispatchWorkspaceEvent, type DvWorkspaceEventMap,
} from '@dv/ui-kit/workspace-events.ts'
import {
  actionLabel, actionRows, branchTree, centerFocus, clipTimelines, ownerBranch, relativeTime, stepPlace, thumbnailOf,
  timelineRecords, branchSteps, type ActionRow, type BranchTree, type Thumbnail, type TreeRow, type BranchSteps,
} from './rows.ts'

/** Props of {@link HistoryPanel}. */
export interface HistoryPanelProps {
  projectId: string
  /** The chat session the panel sits beside, recorded as the `session` of the undo and redo it writes. */
  session: string | null
  /** The API client; defaults to one over the page's fetch. */
  client?: DvClient
}

/** The three filters of the list view; an empty value means all. */
interface Filters {
  actor: '' | Actor
  component: string
  timeline: string
}

const NO_FILTERS: Filters = { actor: '', component: '', timeline: '' }

/** The two views of the panel: the current branch's steps, or every branch as a lane graph. */
type HistoryView = 'list' | 'tree'

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
const COMPONENTS: Array<[string, string, string]> = [
  ['proj', '项目', 'Project'], ['asset', '素材库', 'Asset pool'], ['bible', '设定库', 'Story bible'], ['plan', '分镜', 'Shot plan'],
  ['shot', '镜头渲染', 'Shot render'], ['timeline', '时间线', 'Timeline'], ['deliver', '交付', 'Deliver'], ['inspect', '检查器', 'Inspector'],
]

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
const select: CSSProperties = { border: `1px solid ${line}`, background: 'transparent', color: 'inherit', borderRadius: 6, fontSize: 12, padding: '2px 4px' }
const link: CSSProperties = { border: 'none', background: 'transparent', color: accent, fontSize: 11, padding: 0, cursor: 'pointer' }
/** The color of each lane of the branch tree, by lane index modulo the list. */
const LANE_COLORS = [accent, success, '#f5a524', '#0090ff', danger, '#8e4ec6']
/** The width of one lane and the height of one row of the branch tree, in pixels. */
const LANE = 14
const TREE_ROW = 34

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
    if (query === null) { store({ entries: [], assets: new Map(), more: false }, key); return }
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
  const current = useProjectState(client, projectId, null)
  const [view, setView] = useState<HistoryView>('list')
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
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

  const records = current.value?.components.proj.records
  const owner = useMemo(() => clipTimelines(records ?? []), [records])
  const redoSteps = current.value?.redo_steps
  const steps = useMemo(() => branchSteps(records ?? [], redoSteps ?? []), [records, redoSteps])
  const timelines = current.value?.components.timeline.timelines ?? []
  const timelineSet = useMemo(() => {
    const timeline = timelines.find(item => item.id === filters.timeline)
    if (filters.timeline === '' || current.value === null) return null
    if (timeline === undefined) return []
    const { records: branchRecords, created_by: createdBy } = current.value.components.proj
    return timelineRecords(branchRecords, createdBy, timeline.id, timeline.clips.flatMap(clip => clip.asset === null ? [] : [clip.asset]))
  }, [filters.timeline, timelines, current.value])
  // A timeline filter that the branch shown after a switch does not have is cleared, so no hidden filter stays active.
  const filteredTimelineGone = filters.timeline !== '' && current.value !== null && !timelines.some(item => item.id === filters.timeline)
  useEffect(() => {
    if (filteredTimelineGone) setFilters(previous => ({ ...previous, timeline: '' }))
  }, [filteredTimelineGone])
  // The list view reads the current branch's line with the filters; the tree view reads every branch line.
  const query = useMemo((): HistoryQuery | null => {
    if (view === 'tree') return { project: projectId, marks: ['current', 'redo', 'branch'] }
    if (timelineSet !== null && timelineSet.length === 0) return null
    return {
      project: projectId, marks: ['current', 'redo'],
      ...filters.actor === '' ? {} : { actor: filters.actor },
      ...filters.component === '' ? {} : { component: filters.component },
      ...timelineSet === null ? {} : { records: timelineSet },
    }
  }, [projectId, view, filters.actor, filters.component, timelineSet])
  const { loaded, error, loadMore } = useHistory(client, query)
  const rows = useMemo(() => actionRows(loaded?.entries ?? []), [loaded])
  const branches = current.value?.branches
  const tree = useMemo(() => branchTree(loaded?.entries ?? [], branches ?? []), [loaded, branches])
  const recordsById = useMemo(() => new Map((loaded?.entries ?? []).map(entry => [entry.record.id, entry.record])), [loaded])

  // A `dv:history-focus` request: show the list without filters, find the record the tool call wrote, then select it once loaded.
  const takeFocus = useCallback((focus: DvWorkspaceEventMap['dv:history-focus']) => {
    pendingFocus = null
    setView('list')
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
    if (focusRecord === null || loaded === null || query === null || view !== 'list' || JSON.stringify(filters) !== JSON.stringify(NO_FILTERS)) return
    if (loaded.entries.some(entry => entry.record.id === focusRecord)) {
      // A record folded under an approval shows once its approval's row is expanded.
      const parent = rows.find(row => row.children.some(child => child.record.id === focusRecord))
      if (parent !== undefined) setExpanded(shown => new Set([...shown, parent.entry.record.id]))
      setSelected(focusRecord)
      setFocusRecord(null)
      requestAnimationFrame(() => { rowRefs.current.get(focusRecord)?.scrollIntoView({ block: 'nearest' }) })
    } else if (loaded.more) void loadMore()
    else setFocusRecord(null)
  }, [focusRecord, loaded, rows, query, view, filters, loadMore])

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
  // 回到这一步: move the current branch back to just after the record.
  const jump = (record: string): void => {
    setNotice(null)
    client.undo(projectId, 'history', session, record).catch(report)
  }
  // A step of the tree: stay on the current branch when its line holds the step, else switch to the step's owner.
  const moveTo = (entry: HistoryEntry): void => {
    const shown = current.value?.current ?? null
    const lane = shown !== null && entry.branches.includes(shown) ? shown : ownerBranch(entry)
    if (lane === null) return
    setNotice(null)
    client.switchBranch(projectId, lane, 'history', entry.record.id, session).catch(report)
  }
  const rowRef = (record: string) => (element: HTMLElement | null): void => {
    if (element === null) rowRefs.current.delete(record)
    else rowRefs.current.set(record, element)
  }

  const filtered = view === 'list' && JSON.stringify(filters) !== JSON.stringify(NO_FILTERS)
  let body: ReactNode
  if (error !== null) body = <p style={{ color: danger, fontSize: 12 }}>{t(`读取失败：${error}`, `Failed to load: ${error}`)}</p>
  else if (loaded === null) body = <p style={{ color: muted, fontSize: 12 }}>{t('正在读取…', 'Loading…')}</p>
  else {
    // Every project starts with its `proj.create` record, so a project without other operation records counts as empty;
    // its creation row stays listed below the notice.
    const changes = loaded.entries.filter(entry => entry.record.operation !== 'proj.create')
    const empty = filtered ? rows.length === 0 : changes.length === 0
    const shared = {
      assets: loaded.assets, records: recordsById, now, selected, onChoose: choose, rowRef, steps, onJump: jump,
    }
    const tail = view === 'tree'
      ? (
        <TreeView
          tree={tree} assets={loaded.assets} records={recordsById} current={current.value?.current ?? null} head={steps.current}
          onMove={moveTo}
        />
      )
      : rows.map(row => (
        <Row
          key={row.entry.record.id} {...shared} row={row}
          expanded={expanded.has(row.entry.record.id)} onToggle={() => { toggle(row.entry.record.id) }}
        />
      ))
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
        {tail}
      </>
    )
  }
  return (
    <div data-testid="dv-history-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '8px 8px 0', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <ViewToggle view={view} onChange={setView} t={t} />
        {view === 'list' ? <FilterBar filters={filters} onChange={setFilters} timelines={timelines} t={t} /> : null}
        <Actions client={client} projectId={projectId} session={session} canRedo={steps.after.size > 0} />
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

/**
 * The toggle between the list view and the branch tree.
 * @param props - the shown view, the change callback, and the string picker.
 * @returns the two buttons.
 */
function ViewToggle(props: { view: HistoryView; onChange: (view: HistoryView) => void; t: PickText }): ReactNode {
  const { view, t } = props
  const choices: Array<[HistoryView, string]> = [['list', t('列表', 'List')], ['tree', t('分支树', 'Branch tree')]]
  return (
    <div data-testid="dv-history-view-toggle" role="group" aria-label={t('视图', 'View')} style={{ display: 'inline-flex', gap: 2 }}>
      {choices.map(([value, label]) => (
        <button
          key={value} type="button" data-view={value} aria-pressed={view === value}
          style={{ ...button, ...view === value ? { background: accent, borderColor: accent, color: '#fff' } : {} }}
          onClick={() => { props.onChange(value) }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/**
 * Undo and redo on the project's current branch, at the end of the header; redo is enabled while a step can be redone.
 * @param props - the client, the project, the chat session, and whether redo has a step to bring back.
 * @returns the buttons.
 */
function Actions(props: { client: DvClient; projectId: string; session: string | null; canRedo: boolean }): ReactNode {
  const { client, projectId, session } = props
  const t = useText()
  const [failure, setFailure] = useState<string | null>(null)
  const run = (work: () => Promise<unknown>): void => {
    setFailure(null)
    work().catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) })
  }
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', marginLeft: 'auto' }}>
      <button type="button" data-testid="dv-history-undo" style={button} onClick={() => { run(() => client.undo(projectId, 'history', session)) }}>
        {t('撤销', 'Undo')}
      </button>
      <button
        type="button" data-testid="dv-history-redo" disabled={!props.canRedo}
        style={{ ...button, ...props.canRedo ? {} : { opacity: 0.4, cursor: 'default' } }}
        onClick={() => { run(() => client.redo(projectId, 'history', session)) }}
      >
        {t('重做', 'Redo')}
      </button>
      {failure === null ? null : <span style={{ color: danger, fontSize: 12 }}>{failure}</span>}
    </div>
  )
}

/**
 * The three filter selects of the list view. Each names its filter in its empty option, so the bar needs no separate
 * labels.
 * @param props - the filters, the change callback, the current branch's timelines, and the string picker.
 * @returns the selects.
 */
function FilterBar(props: {
  filters: Filters
  onChange: (filters: Filters) => void
  timelines: Array<{ id: string; name: string }>
  t: PickText
}): ReactNode {
  const { filters, onChange, t } = props
  const styled = (value: string): CSSProperties => ({ ...select, color: value === '' ? muted : 'inherit', maxWidth: 110 })
  return (
    <>
      <select
        data-testid="dv-history-filter-actor" aria-label={t('发起者', 'Actor')} style={styled(filters.actor)} value={filters.actor}
        onChange={(event) => { onChange({ ...filters, actor: event.currentTarget.value as Filters['actor'] }) }}
      >
        <option value="">{t('发起者', 'Actor')}</option>
        {(Object.keys(ACTORS) as Actor[]).map(actor => <option key={actor} value={actor}>{t(...ACTORS[actor])}</option>)}
      </select>
      <select
        data-testid="dv-history-filter-component" aria-label={t('操作类型', 'Operation kind')} style={styled(filters.component)}
        value={filters.component} onChange={(event) => { onChange({ ...filters, component: event.currentTarget.value }) }}
      >
        <option value="">{t('操作类型', 'Operation kind')}</option>
        {COMPONENTS.map(([key, zh, en]) => <option key={key} value={key}>{t(zh, en)}</option>)}
      </select>
      <select
        data-testid="dv-history-filter-timeline" aria-label={t('时间线', 'Timeline')} style={styled(filters.timeline)}
        value={filters.timeline} onChange={(event) => { onChange({ ...filters, timeline: event.currentTarget.value }) }}
      >
        <option value="">{t('时间线', 'Timeline')}</option>
        {props.timelines.map(timeline => (
          <option key={timeline.id} value={timeline.id}>{timelineName(timeline, n => t(`时间线 ${String(n)}`, `Timeline ${String(n)}`))}</option>
        ))}
      </select>
    </>
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
  /** The steps of the current branch. */
  steps: BranchSteps
  /** 回到这一步 on a step before the current one. */
  onJump: (record: string) => void
}

/**
 * One action row: the thumbnail, the action label and the time on the first line; who, the status, 当前 on the current
 * step and the agent's intent on the second. A plan approval adds the toggle that shows the renders it scheduled, nested below it.
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
  const step = stepPlace(record.id, props.steps)
  // A step redo brings back is greyed.
  const dimmed = step === 'after' || entry.mark === 'redo'
  const selected = props.selected === record.id
  const status = t(...STATUSES[record.status])
  const thumbnail = thumbnailOf(record, assets, props.records, (props.folded ?? []).map(child => child.record))
  // The intent the agent gave for its call; a call without one records the operation name, which the label already shows.
  // A human action's intent repeats its label, so it stays in the tooltip.
  const words = record.actor === 'agent' && record.intent !== record.operation ? record.intent : ''
  const size = nested ? 28 : 40
  return (
    <div
      ref={props.rowRef(record.id)} role="option" tabIndex={0} aria-selected={selected} title={record.intent}
      data-testid="dv-history-row" data-record={record.id} data-mark={entry.mark} data-status={record.status} data-actor={record.actor}
      data-surface={record.surface} data-step={step ?? undefined}
      onClick={() => { props.onChoose(entry) }}
      onKeyDown={(event) => { if (event.key === 'Enter') props.onChoose(entry) }}
      style={{
        padding: nested ? '4px 8px 4px 56px' : '6px 8px', cursor: 'pointer', fontSize: 12,
        background: selected ? 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))' : 'transparent',
        opacity: dimmed ? 0.55 : 1,
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: `${String(size)}px minmax(0, 1fr)`, columnGap: 8, alignItems: 'center' }}>
        <Thumb thumbnail={thumbnail} size={size} />
        <div style={{ minWidth: 0 }}>
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
            {step === 'current'
              ? (
                <span data-testid="dv-history-current" style={{ background: accent, color: '#fff', borderRadius: 3, padding: '0 4px', lineHeight: '14px' }}>
                  {t('当前', 'Current')}
                </span>
              )
              : null}
            {words === '' ? null : <span title={words} style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>“{words}”</span>}
            {step === 'before'
              ? (
                <button
                  type="button" data-testid="dv-history-jump" style={{ ...link, marginLeft: 'auto', flex: 'none' }}
                  onClick={(event) => { event.stopPropagation(); props.onJump(record.id) }}
                >
                  {t('回到这一步', 'Go back to this step')}
                </button>
              )
              : null}
          </div>
        </div>
      </div>
      {selected ? <Details record={record} assets={assets} words={words} /> : null}
    </div>
  )
}

/**
 * The branch tree: a legend of the lanes (each branch's label, the current branch marked), then one row per step with
 * the lane graph on the left and the step's label and small thumbnail on the right.
 * @param props - the laid-out tree, the known assets and records, the current branch, the current branch's head step,
 *   and the gesture that moves the head to a step.
 * @returns the tree.
 */
function TreeView(props: {
  tree: BranchTree
  assets: ReadonlyMap<string, Asset>
  records: ReadonlyMap<string, ProjectRecord>
  current: string | null
  head: string | null
  onMove: (entry: HistoryEntry) => void
}): ReactNode {
  const t = useText()
  const { lanes, rows } = props.tree
  return (
    <div data-testid="dv-history-tree" style={{ fontSize: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '6px 8px', borderBottom: `1px solid ${line}` }}>
        {lanes.map((branch, lane) => (
          <TreeLane key={branch.name} branch={branch} color={laneColor(lane)} current={branch.name === props.current} t={t} />
        ))}
      </div>
      {rows.map(row => (
        <TreeNode
          key={row.entry.record.id} row={row} lanes={lanes.length} assets={props.assets} records={props.records}
          head={row.entry.record.id === props.head} onMove={props.onMove}
        />
      ))}
    </div>
  )
}

/** @returns the color of a lane of the branch tree. */
function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length] ?? accent
}

/** One entry of the lane legend: the lane's color, the branch label, and 当前 on the current branch. */
function TreeLane(props: { branch: Branch; color: string; current: boolean; t: PickText }): ReactNode {
  const { branch, t } = props
  return (
    <span
      data-testid="dv-history-tree-lane" data-branch={branch.name} data-current={props.current}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: props.current ? 600 : 400 }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 4, background: props.color, display: 'inline-block' }} />
      {branchLabel(branch, t)}
      {props.current ? <span style={{ color: muted, fontWeight: 400 }}>{t('（当前）', ' (current)')}</span> : null}
    </span>
  )
}

/**
 * One step of the branch tree: the lane lines through the row, the forks that bend into it, the step's dot (ringed on
 * the current branch's head step), the step's small thumbnail and its label. Clicking it moves the head there.
 * @param props - the laid-out row, the lane count, the known assets and records, whether the step is the head, and the
 *   move gesture.
 * @returns the row.
 */
function TreeNode(props: {
  row: TreeRow
  lanes: number
  assets: ReadonlyMap<string, Asset>
  records: ReadonlyMap<string, ProjectRecord>
  head: boolean
  onMove: (entry: HistoryEntry) => void
}): ReactNode {
  const { row } = props
  const { record } = row.entry
  const t = useText()
  const x = (lane: number): number => lane * LANE + LANE / 2 + 2
  const middle = TREE_ROW / 2
  const width = Math.max(props.lanes, 1) * LANE + 4
  const dot = x(row.lane)
  return (
    <div
      role="option" tabIndex={0} aria-selected={props.head} title={record.intent}
      data-testid="dv-history-tree-node" data-record={record.id} data-lane={row.lane} data-mark={row.entry.mark} data-head={props.head}
      onClick={() => { props.onMove(row.entry) }}
      onKeyDown={(event) => { if (event.key === 'Enter') props.onMove(row.entry) }}
      style={{ display: 'flex', alignItems: 'center', gap: 6, height: TREE_ROW, padding: '0 8px 0 4px', cursor: 'pointer', opacity: row.entry.mark === 'redo' ? 0.55 : 1 }}
    >
      <svg width={width} height={TREE_ROW} style={{ flex: 'none', overflow: 'visible' }} aria-hidden="true">
        {row.lines.map(lane => (
          <g key={`l${String(lane.lane)}`} style={{ stroke: laneColor(lane.lane) }} strokeWidth={2}>
            {lane.up ? <line x1={x(lane.lane)} y1={0} x2={x(lane.lane)} y2={middle} /> : null}
            {lane.down ? <line x1={x(lane.lane)} y1={middle} x2={x(lane.lane)} y2={TREE_ROW} /> : null}
          </g>
        ))}
        {row.forks.map(fork => fork.empty
          ? (
            <g key={`f${String(fork.lane)}`} style={{ stroke: laneColor(fork.lane) }} strokeWidth={2}>
              <line x1={dot} y1={middle} x2={x(fork.lane)} y2={middle} />
              <circle cx={x(fork.lane)} cy={middle} r={3.5} style={{ fill: 'var(--dsw-alias-bg-primary, #fff)' }} />
            </g>
          )
          : (
            <path
              key={`f${String(fork.lane)}`} d={`M ${String(x(fork.lane))} 0 Q ${String(x(fork.lane))} ${String(middle)} ${String(dot)} ${String(middle)}`}
              style={{ stroke: laneColor(fork.lane), fill: 'none' }} strokeWidth={2}
            />
          ))}
        {props.head ? <circle cx={dot} cy={middle} r={7} style={{ fill: 'none', stroke: laneColor(row.lane) }} strokeWidth={2} /> : null}
        <circle cx={dot} cy={middle} r={4} style={{ fill: laneColor(row.lane) }} />
      </svg>
      <Thumb thumbnail={thumbnailOf(record, props.assets, props.records)} size={24} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: props.head ? 600 : 400 }}>
        {t(...actionLabel(record))}
      </span>
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
