/**
 * Pure readings behind the History panel: the action rows of history entries (a plan approval folds the renders it
 * scheduled), the label of an action with its subject, the thumbnail of a record, relative times, where selecting a
 * record focuses the center, and which rows offer 回到这一步. Nothing here touches the DOM or the network, so the unit
 * tests cover it directly.
 *
 * @module @dv/ui-history/rows
 */
import { DV_TOOL_LABELS } from '@dv/ui-kit/tool-labels.ts'
import type { Asset, HistoryEntry, ProjectRecord } from '@dv/ui-kit/types.ts'
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

/**
 * Turn history entries into panel rows: one row per step, newest first. The records a loaded
 * plan approval scheduled fold under the approval's row instead of standing alone.
 * @param entries - history entries, newest first.
 * @returns the rows, newest first.
 */
export function actionRows(entries: readonly HistoryEntry[]): ActionRow[] {
  const loaded = new Map(entries.map(entry => [entry.record.id, entry]))
  const folded = new Map<string, string>()
  for (const { record } of entries) {
    for (const id of scheduledBy(record)) if (loaded.has(id)) folded.set(id, record.id)
  }
  const rows: ActionRow[] = []
  for (const entry of entries) {
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
 * @param records - the records of the current state, oldest first.
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
 * The center focus of a selected entry. Only steps at or before the current position are what the canvas and the
 * timeline show. Timeline records and timeline exports focus their timeline and clip; `proj.*` records focus nothing;
 * every other record focuses its node.
 * @param entry - the selected entry.
 * @param owner - clip ID → timeline ID of the current state, from {@link clipTimelines}.
 * @returns the focus, or null.
 */
export function centerFocus(entry: HistoryEntry, owner: ReadonlyMap<string, string>): CenterFocus {
  const { record } = entry
  if (entry.place === 'after') return null
  if (record.component === 'proj') return null
  if (record.component === 'timeline' || record.operation === 'deliver.timeline_export') {
    const timelineId = timelineOf(record, owner)
    if (timelineId === null) return null
    const clipId = text(record.params['clip']) ?? reportedClips(record)[0] ?? null
    return { event: 'dv:timeline-focus', detail: { timelineId, clipId } }
  }
  return { event: 'dv:canvas-focus', detail: { recordId: record.id } }
}
