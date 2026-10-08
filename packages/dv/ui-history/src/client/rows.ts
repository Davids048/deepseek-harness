/**
 * Pure readings behind the History panel: the action rows of history entries (a plan approval folds the renders it
 * scheduled), the label of an action with its subject, the thumbnail of a record, relative times, the record set of a
 * timeline, where selecting a record focuses the center, the steps of the current branch, and the lane layout of the
 * branch tree. Nothing here touches the DOM or the network, so the unit tests cover it directly.
 *
 * @module @dv/ui-history/rows
 */
import { entryBranch } from '@dv/ui-kit/state.ts'
import { DV_TOOL_LABELS } from '@dv/ui-kit/tool-labels.ts'
import type { Asset, Branch, HistoryEntry, ProjectRecord } from '@dv/ui-kit/types.ts'
import type { DvWorkspaceEventMap } from '@dv/ui-kit/workspace-events.ts'

/** One row of the panel: an operation entry and, for a plan approval, the entries of the records it scheduled. */
export interface ActionRow {
  entry: HistoryEntry
  /** The loaded records the approval scheduled, in `report.scheduled` order; empty for other records. */
  children: HistoryEntry[]
}

/** @returns the IDs a finished `plan.approve` record scheduled (`report.scheduled`). */
function scheduledBy(record: ProjectRecord): string[] {
  const scheduled = record.operation === 'plan.approve' ? record.report?.['scheduled'] : undefined
  return Array.isArray(scheduled) ? scheduled.filter((id): id is string => typeof id === 'string') : []
}

/** Undo and redo records move a branch between steps, so they are not rows. */
const MOVES = new Set(['proj.undo', 'proj.redo'])
/** Records that are not steps: the moves between steps. Undo steps over them. */
const NOT_A_STEP = MOVES

/**
 * Turn history entries into panel rows: one row per operation record, newest first. The undo and redo records are not
 * rows. The records a loaded plan approval scheduled fold under the approval's row instead of
 * standing alone.
 * @param entries - history entries, newest first.
 * @returns the rows, newest first.
 */
export function actionRows(entries: readonly HistoryEntry[]): ActionRow[] {
  const operations = entries.filter(entry => !MOVES.has(entry.record.operation ?? ''))
  const loaded = new Map(operations.map(entry => [entry.record.id, entry]))
  const folded = new Map<string, string>()
  for (const { record } of operations) {
    for (const id of scheduledBy(record)) if (loaded.has(id)) folded.set(id, record.id)
  }
  const rows: ActionRow[] = []
  for (const entry of operations) {
    if (folded.has(entry.record.id)) continue
    const row: ActionRow = { entry, children: [] }
    rows.push(row)
  }
  // Folded records keep the approval's `report.scheduled` order: the shot renders in shot order, then the timeline.
  for (const row of rows) {
    for (const id of scheduledBy(row.entry.record)) {
      const child = folded.get(id) === row.entry.record.id ? loaded.get(id) : undefined
      if (child !== undefined) row.children.push(child)
    }
  }
  return rows
}

/**
 * The agent tool name of an operation: `dv_` and the operation name with `.` replaced by `_`.
 * @param operation - the operation name, such as `timeline.clip_move`.
 * @returns the tool name, such as `dv_timeline_clip_move`.
 */
function toolNameOf(operation: string): string {
  return `dv_${operation.replaceAll('.', '_')}`
}

/**
 * The label a row shows for its operation: the tool label of `DV_TOOL_LABELS`, else the operation name.
 * @param operation - the operation name, or null when the record names none.
 * @returns the Chinese and English label.
 */
export function operationLabel(operation: string | null): readonly [string, string] {
  if (operation === null) return ['', '']
  return DV_TOOL_LABELS[toolNameOf(operation)] ?? [operation, operation]
}

/** @returns the text of a record field, or null. */
function field(fields: Record<string, unknown> | undefined, key: string): string | null {
  const value = fields?.[key]
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * The label a row shows for its action: the tool label followed by its subject. Plans name their title or PlanId and
 * version (`report.plan`, `report.version`), a plan's shot render names its shot number (`params.shot`), and story bible
 * records name the character, location or style.
 * @param record - the operation record.
 * @returns the Chinese and English label.
 */
export function actionLabel(record: ProjectRecord): readonly [string, string] {
  const [zh, en] = operationLabel(record.operation)
  // A PlanId (`p1`); a plan named by its record ID comes from a project made before plans had IDs and is not shown.
  const named = field(record.report, 'plan') ?? field(record.params, 'plan')
  const plan = named !== null && /^p\d+$/.test(named) ? named : null
  const version = field(record.report, 'version') ?? field(record.params, 'version')
  switch (record.operation) {
    case 'plan.create': {
      const title = field(record.params, 'title')
      if (title !== null) return [`${zh}《${title}》`, `${en} “${title}”`]
      return plan === null ? [zh, en] : [`${zh} ${plan}`, `${en} ${plan}`]
    }
    case 'plan.update': {
      if (plan === null) return [zh, en]
      return version === null ? [`${zh} ${plan}`, `${en} ${plan}`] : [`${zh} ${plan} → v${version}`, `${en} ${plan} → v${version}`]
    }
    case 'plan.approve': {
      if (plan === null) return [zh, en]
      return version === null ? [`${zh} ${plan}`, `${en} ${plan}`] : [`${zh} ${plan} v${version}`, `${en} ${plan} v${version}`]
    }
    case 'shot.render_ref2va':
    case 'shot.render_t2va': {
      const shot = field(record.params, 'shot')
      return shot === null ? [zh, en] : [`${zh} ${shot}`, `${en} ${shot}`]
    }
  }
  if (record.component === 'bible') {
    const name = field(record.params, 'name') ?? field(record.params, 'character') ?? field(record.params, 'location')
      ?? field(record.params, 'style')
    if (name !== null) return [`${zh}「${name}」`, `${en} “${name}”`]
  }
  return [zh, en]
}

/** The asset a row's thumbnail shows, and whether it is drawn as an image or as a video frame. */
export interface Thumbnail {
  asset: string
  kind: 'image' | 'video'
}

/**
 * The one thumbnail of a row. An image among the record's outputs, then its inputs, comes first. A video is shown by
 * an image output of the record that made it (a take's still), else as a video frame. Files that are neither images
 * nor videos (a plan's JSON) and assets of unknown type have no thumbnail. A row without media of its own shows the
 * thumbnail of the first record folded under it.
 * @param record - the record.
 * @param assets - the known assets by ID.
 * @param records - the loaded records by ID, to find the still of a video's maker.
 * @param children - the records folded under the row, in `report.scheduled` order.
 * @returns the thumbnail, or null.
 */
export function thumbnailOf(
  record: ProjectRecord,
  assets: ReadonlyMap<string, Asset>,
  records: ReadonlyMap<string, ProjectRecord>,
  children: readonly ProjectRecord[] = [],
): Thumbnail | null {
  const named = [...record.outputs, ...record.inputs.flatMap(input => input.resolved_asset === null ? [] : [input.resolved_asset])]
  const mime = (id: string): string => assets.get(id)?.mime ?? ''
  const image = named.find(id => mime(id).startsWith('image/'))
  if (image !== undefined) return { asset: image, kind: 'image' }
  const video = named.find(id => mime(id).startsWith('video/'))
  if (video !== undefined) {
    const maker = records.get(assets.get(video)?.created_by ?? '')
    const still = maker?.outputs.find(id => mime(id).startsWith('image/'))
    return still === undefined ? { asset: video, kind: 'video' } : { asset: still, kind: 'image' }
  }
  for (const child of children) {
    const shown = thumbnailOf(child, assets, records)
    if (shown !== null) return shown
  }
  return null
}

/**
 * How long ago a time was, in words: 刚刚 under a minute, minutes under an hour, hours under a day, else the date and
 * `HH:MM`.
 * @param iso - an ISO time.
 * @param now - the current time in milliseconds.
 * @returns the Chinese and English text.
 */
export function relativeTime(iso: string, now: number): readonly [string, string] {
  const time = new Date(iso)
  const minutes = Math.floor((now - time.getTime()) / 60_000)
  if (minutes < 1) return ['刚刚', 'just now']
  if (minutes < 60) return [`${String(minutes)} 分钟前`, `${String(minutes)} min ago`]
  if (minutes < 24 * 60) return [`${String(Math.floor(minutes / 60))} 小时前`, `${String(Math.floor(minutes / 60))} h ago`]
  const clock = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  const date = `${String(time.getMonth() + 1)}/${String(time.getDate())} ${clock}`
  return [date, date]
}

/** @returns the text value of a param, or null. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** @returns the clip IDs a finished record assigned (`report.clips`). */
function reportedClips(record: ProjectRecord): string[] {
  const clips = record.report?.['clips']
  return Array.isArray(clips) ? clips.filter((clip): clip is string => typeof clip === 'string') : []
}

/**
 * The timeline each clip belongs to: the timeline of the record that assigned the clip (`timeline.create`, `update`,
 * `clip_insert` name it by `params.timeline`, a create without one makes `t1`; `clip_split` adds to the timeline of the
 * split clip).
 * @param records - a branch's records, oldest first.
 * @returns clip ID → timeline ID.
 */
export function clipTimelines(records: readonly ProjectRecord[]): Map<string, string> {
  const owner = new Map<string, string>()
  for (const record of records) {
    const clips = reportedClips(record)
    if (clips.length === 0) continue
    const timeline = record.operation === 'timeline.clip_split'
      ? owner.get(text(record.params['clip']) ?? '') ?? null
      : text(record.params['timeline']) ?? (record.operation === 'timeline.create' ? 't1' : null)
    if (timeline === null) continue
    for (const clip of clips) owner.set(clip, timeline)
  }
  return owner
}

/**
 * The timeline a record works on: its `timeline` param, else the timeline of its `clip` param, else `t1` for a
 * `timeline.create` without a param.
 * @param record - the record.
 * @param owner - clip ID → timeline ID, from {@link clipTimelines}.
 * @returns the timeline ID, or null when the record names none.
 */
function timelineOf(record: ProjectRecord, owner: ReadonlyMap<string, string>): string | null {
  const named = text(record.params['timeline'])
  if (named !== null) return named
  const clip = text(record.params['clip'])
  if (clip !== null) return owner.get(clip) ?? null
  return record.operation === 'timeline.create' ? 't1' : null
}

/** Where selecting a record moves the center: a canvas node, a timeline clip, or nowhere. */
export type CenterFocus =
  | { event: 'dv:canvas-focus'; detail: DvWorkspaceEventMap['dv:canvas-focus'] }
  | { event: 'dv:timeline-focus'; detail: DvWorkspaceEventMap['dv:timeline-focus'] }
  | null

/**
 * The center focus of a selected entry. Only `current` records are in the state the canvas and the timeline show.
 * Timeline records and timeline exports focus their timeline and clip; `proj.*` records focus nothing; every other
 * record focuses its node.
 * @param entry - the selected entry.
 * @param owner - clip ID → timeline ID of the current branch, from {@link clipTimelines}.
 * @returns the focus, or null.
 */
export function centerFocus(entry: HistoryEntry, owner: ReadonlyMap<string, string>): CenterFocus {
  const { record } = entry
  if (entry.mark !== 'current') return null
  if (record.component === 'proj') return null
  if (record.component === 'timeline' || record.operation === 'deliver.timeline_export') {
    const timelineId = timelineOf(record, owner)
    if (timelineId === null) return null
    const clipId = text(record.params['clip']) ?? reportedClips(record)[0] ?? null
    return { event: 'dv:timeline-focus', detail: { timelineId, clipId } }
  }
  return { event: 'dv:canvas-focus', detail: { recordId: record.id } }
}

/** Where a record stands among the steps of the current branch: the current step, a step before it, or a step redo brings back. */
export type StepPlace = 'current' | 'before' | 'after'

/** The steps of the current branch: its current step, the steps before it, and the steps after it that redo brings back. */
export interface BranchSteps {
  current: string | null
  before: ReadonlySet<string>
  after: ReadonlySet<string>
}

/**
 * The steps of the current branch. Every operation record on the branch's effective chain is a step except the records
 * of `NOT_A_STEP`; the newest is the current step.
 * @param chain - the records of the current branch's effective chain, oldest first (`components.proj.records`).
 * @param redoSteps - the steps redo brings back (`WireState.redo_steps`).
 * @returns the steps.
 */
export function branchSteps(chain: readonly ProjectRecord[], redoSteps: readonly string[]): BranchSteps {
  const steps = chain.filter(record => !NOT_A_STEP.has(record.operation ?? ''))
  const current = steps.at(-1)?.id ?? null
  return { current, before: new Set(steps.slice(0, -1).map(record => record.id)), after: new Set(redoSteps) }
}

/**
 * Where one record stands among the current branch's steps.
 * @param record - the record ID.
 * @param steps - the current branch's steps.
 * @returns the place, or null for a record that is not a step of the current branch.
 */
export function stepPlace(record: string, steps: BranchSteps): StepPlace | null {
  if (record === steps.current) return 'current'
  if (steps.before.has(record)) return 'before'
  return steps.after.has(record) ? 'after' : null
}

/** The most columns the branch tree draws; a branch that finds no free column shares the last one. */
export const TREE_COLUMNS = 6

/** A lane line that passes through one row of the branch tree: whether it reaches the row's top and bottom edges. */
export interface TreeLine {
  /** The lane index, in branch order; it picks the line's color. */
  lane: number
  /** The column the line is drawn in. */
  column: number
  up: boolean
  down: boolean
}

/** A branch that forks at one row of the branch tree: its lane bends into the row's dot. */
export interface TreeFork {
  /** The lane index of the forked branch; it picks the color. */
  lane: number
  /** The column the forked branch's lane is drawn in. */
  column: number
  /** True when the branch has no step of its own yet; its lane then ends in a hollow marker at this row. */
  empty: boolean
}

/** One row of the branch tree: one step, its dot, the lane lines and forks drawn beside it, and its branch labels. */
export interface TreeRow {
  entry: HistoryEntry
  /** The lane of the branch that owns the step; it picks the dot's color. */
  lane: number
  /** The column the dot sits in. */
  column: number
  lines: TreeLine[]
  forks: TreeFork[]
  /** The branches whose lane starts at this row (their newest loaded step, or the fork row of a branch without steps). */
  refs: string[]
}

/** The rows one branch's lane covers, top (newest) to end. */
interface LaneSpan {
  lane: number
  top: number
  end: number
}

/**
 * Lay out the branch tree, `git log --graph` style. Each branch gets a lane; each step is one row, newest first, with
 * its dot in the lane of the branch it belongs to (`entryBranch` without a current branch). A forked branch's lane runs
 * from its newest step down to the row of its `forked_at` record, where it bends into that row's dot; a branch without
 * steps of its own yet shows a marker at its fork row. `main` runs from its newest to its oldest step. When the fork
 * row is not loaded, the lane runs to the bottom. Undo and redo records and records on no branch line are not rows.
 * Lanes take columns: `main` the first, every other lane the leftmost column no other lane covers in its rows, so a column
 * frees up below a branch's fork row; at most {@link TREE_COLUMNS} columns.
 * @param entries - history entries, newest first.
 * @param branches - the project's branches, in lane order.
 * @returns the rows; lane i is `branches[i]`.
 */
export function branchTree(entries: readonly HistoryEntry[], branches: readonly Branch[]): TreeRow[] {
  const steps = entries.filter(entry => !MOVES.has(entry.record.operation ?? '') && entryBranch(entry, null) !== null)
  const laneOf = new Map(branches.map((branch, index) => [branch.name, index]))
  const rows: TreeRow[] = steps.map(entry => ({
    entry, lane: laneOf.get(entryBranch(entry, null) ?? '') ?? 0, column: 0, lines: [], forks: [], refs: [],
  }))
  const rowOf = new Map(rows.map((row, index) => [row.entry.record.id, index]))
  const spans: LaneSpan[] = []
  const forkRows = new Map<number, number>()
  const empty = new Set<number>()
  branches.forEach((branch, lane) => {
    const owned = rows.flatMap((row, index) => row.lane === lane ? [index] : [])
    const forked = branch.forked_at !== null
    const forkRow = forked ? rowOf.get(branch.forked_at ?? '') ?? -1 : -1
    // A branch with nothing to draw: no step of its own and its fork row is not loaded.
    if (owned.length === 0 && forkRow < 0) return
    const top = owned.length === 0 ? forkRow : Math.min(...owned)
    const end = !forked ? Math.max(...owned) : forkRow >= 0 ? forkRow : rows.length
    spans.push({ lane, top, end })
    forkRows.set(lane, forkRow)
    if (owned.length === 0) empty.add(lane)
    rows[top]?.refs.push(branch.name)
  })
  // `main` keeps the first column, loaded or not; the other lanes, newest first, take the leftmost column whose last lane
  // ended above.
  const columnOf = new Map<number, number>([[0, 0]])
  const busyUntil: number[] = [rows.length]
  for (const span of spans.filter(item => item.lane !== 0).sort((a, b) => a.top - b.top)) {
    const free = busyUntil.findIndex(end => end < span.top)
    const column = free >= 0 ? free : Math.min(busyUntil.length, TREE_COLUMNS - 1)
    busyUntil[column] = Math.max(busyUntil[column] ?? -1, span.end)
    columnOf.set(span.lane, column)
  }
  for (const row of rows) row.column = columnOf.get(row.lane) ?? 0
  for (const { lane, top, end } of spans) {
    const column = columnOf.get(lane) ?? 0
    const forkRow = forkRows.get(lane) ?? -1
    for (let index = top; index <= end; index += 1) {
      const row = rows[index]
      if (row === undefined) continue
      if (index === forkRow) row.forks.push({ lane, column, empty: empty.has(lane) })
      else row.lines.push({ lane, column, up: index > top, down: index < end })
    }
  }
  return rows
}
