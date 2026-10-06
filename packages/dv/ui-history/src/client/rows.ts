/**
 * Pure readings behind the History panel: turn groups of history entries, the badge of a mark, the label of an
 * operation, the query of the branch filter, the record set of a timeline, and where selecting a record focuses the
 * center. Nothing here touches the DOM or the network, so the unit tests cover it directly.
 *
 * @module @dv/ui-history/rows
 */
import { DV_TOOL_LABELS } from '@dv/ui-kit/tool-labels.ts'
import type { HistoryEntry, HistoryQuery, ProjectRecord } from '@dv/ui-kit/types.ts'
import type { DvWorkspaceEventMap } from '@dv/ui-kit/workspace-events.ts'

/** One turn group of the panel: consecutive operation entries of one agent turn, or one entry without a turn. */
export interface TurnGroup {
  /** The turn; null for an entry that no agent turn made. */
  turn: string | null
  /** The entries, newest first. */
  entries: HistoryEntry[]
}

/**
 * Group history entries for the panel. Request records head their turn group and are not rows; consecutive entries
 * with the same non-null turn form one group, so a turn interleaved with other records shows as more than one group.
 * @param entries - history entries, newest first.
 * @returns the groups, newest first.
 */
export function groupByTurn(entries: readonly HistoryEntry[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  for (const entry of entries) {
    if (entry.record.kind === 'request') continue
    const turn = entry.record.turn
    const last = groups.at(-1)
    if (turn !== null && last !== undefined && last.turn === turn) last.entries.push(entry)
    else groups.push({ turn, entries: [entry] })
  }
  return groups
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
 * @param operation - the operation name; null on a request record.
 * @returns the Chinese and English label.
 */
export function operationLabel(operation: string | null): readonly [string, string] {
  if (operation === null) return ['', '']
  return DV_TOOL_LABELS[toolNameOf(operation)] ?? [operation, operation]
}

/** What a mark badge says: a fixed word pair, or a branch name shown as is. */
export type MarkBadge = { zh: string; en: string } | { branch: string } | null

/**
 * The badge of an entry: 已接受 for an accepted draft record, 草稿, 已撤销, 已丢弃, 已重放, or the exploration branch name.
 * @param entry - the history entry.
 * @returns the badge, or null for a record made on `main`.
 */
export function markBadge(entry: HistoryEntry): MarkBadge {
  switch (entry.mark) {
    case 'main': return entry.record.branch.startsWith('draft/') ? { zh: '已接受', en: 'Accepted' } : null
    case 'draft': return { zh: '草稿', en: 'Draft' }
    case 'undone': return { zh: '已撤销', en: 'Undone' }
    case 'discarded': return { zh: '已丢弃', en: 'Discarded' }
    case 'replayed': return { zh: '已重放', en: 'Replayed' }
    case 'branch': return { branch: entry.record.branch }
  }
}

/** How a row looks for its mark: undone and discarded rows are dimmed and struck, replayed rows dimmed. */
export function markStyle(mark: HistoryEntry['mark']): 'normal' | 'struck' | 'dimmed' {
  if (mark === 'undone' || mark === 'discarded') return 'struck'
  return mark === 'replayed' ? 'dimmed' : 'normal'
}

/**
 * The query fields of the branch filter. `main` shows the main line including what undo took back; a draft shows its
 * open records; an exploration branch shows the records appended to it.
 * @param branch - the selected branch name; empty for all branches.
 * @returns the query fields.
 */
export function branchQuery(branch: string): Pick<HistoryQuery, 'branch' | 'marks'> {
  if (branch === '') return {}
  if (branch === 'main') return { marks: ['main', 'undone'] }
  if (branch.startsWith('draft/')) return { branch, marks: ['draft'] }
  return { branch }
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

/**
 * The records of one timeline on a branch, for the timeline filter: Timeline records and exports that name the
 * timeline or one of its clips, and the records that created the assets of its clips.
 * @param records - the branch's records, oldest first.
 * @param createdBy - asset ID → the record that created it (`components.proj.created_by`).
 * @param timeline - the timeline ID.
 * @param clipAssets - the assets of the timeline's clips.
 * @returns the record IDs.
 */
export function timelineRecords(
  records: readonly ProjectRecord[], createdBy: Readonly<Record<string, string>>, timeline: string, clipAssets: readonly string[],
): string[] {
  const owner = clipTimelines(records)
  const set = new Set<string>()
  for (const record of records) {
    const timelineRecord = record.component === 'timeline' || record.operation === 'deliver.timeline_export'
    if (timelineRecord && timelineOf(record, owner) === timeline) set.add(record.id)
  }
  for (const asset of clipAssets) {
    const maker = createdBy[asset]
    if (maker !== undefined) set.add(maker)
  }
  return [...set]
}

/** Where selecting a record moves the center: a canvas node, a timeline clip, or nowhere. */
export type CenterFocus =
  | { event: 'dv:canvas-focus'; detail: DvWorkspaceEventMap['dv:canvas-focus'] }
  | { event: 'dv:timeline-focus'; detail: DvWorkspaceEventMap['dv:timeline-focus'] }
  | null

/**
 * The center focus of a selected entry. Only `main` and `draft` records are on the shown branch. Timeline records and
 * timeline exports focus their timeline and clip; `proj.*` records focus nothing; every other record focuses its node.
 * @param entry - the selected entry.
 * @param owner - clip ID → timeline ID of the working branch, from {@link clipTimelines}.
 * @returns the focus, or null.
 */
export function centerFocus(entry: HistoryEntry, owner: ReadonlyMap<string, string>): CenterFocus {
  const { record } = entry
  if (entry.mark !== 'main' && entry.mark !== 'draft') return null
  if (record.kind !== 'operation' || record.component === 'proj') return null
  if (record.component === 'timeline' || record.operation === 'deliver.timeline_export') {
    const timelineId = timelineOf(record, owner)
    if (timelineId === null) return null
    const clipId = text(record.params['clip']) ?? reportedClips(record)[0] ?? null
    return { event: 'dv:timeline-focus', detail: { timelineId, clipId } }
  }
  return { event: 'dv:canvas-focus', detail: { recordId: record.id } }
}

/**
 * The tool call a turn header's 在轨迹中查看 opens: the turn's oldest loaded record with a session and a tool call.
 * @param entries - the turn group's entries, newest first.
 * @returns the session and tool call, or null when no loaded record of the turn has them.
 */
export function turnToolCall(entries: readonly HistoryEntry[]): { session: string; toolCall: string } | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const record = entries[index]?.record
    if (record?.session != null && record.tool_call !== null) return { session: record.session, toolCall: record.tool_call }
  }
  return null
}
