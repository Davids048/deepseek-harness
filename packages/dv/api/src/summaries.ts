/**
 * Project card summaries for the DreamVerse shell's entry page and session switcher: per project, the cover, the shot
 * count and total duration of its plans, and the last edit time, computed from each project's current state so the
 * browser reads one small list instead of every project's whole state.
 *
 * @module @dv/api/summaries
 */
import type { AssetId, ComponentStates, ProjectId } from '@dv/project'
import type {} from '@dv/shot-plan'
import { RENDER_OPERATIONS } from '@dv/shot-render'

/**
 * The media a project card shows as its cover. A render's image output is the take's last frame, kept for the next
 * shot to continue from, so a card shows the first frame of `video` when it has one and `image` otherwise.
 */
export interface WireProjectCover {
  video: AssetId | null
  image: AssetId | null
}

/**
 * What a project card shows besides the title (`GET /api/dv/projects/summary`). In the list of every project, a project
 * whose state cannot be read gets `cover` null, `shots` and `duration_sec` 0, and `edited_at` null.
 */
export interface WireProjectSummary {
  project: ProjectId
  /** The first finished rendered take, else the first imported image; null when the project has neither. */
  cover: WireProjectCover | null
  /** Shots in the latest version of every plan. */
  shots: number
  /** Total duration of those shots in seconds; 0 when no shot states one. */
  duration_sec: number
  /** When the last record of the current state was written (its `finished_at`, else `created_at`), ISO-8601. */
  edited_at: string | null
}

/** The slices of the project's current state that a summary reads: the records and the plans. */
export interface SummarySource {
  components: Pick<ComponentStates, 'proj' | 'plan'>
}

/**
 * Summarize a project from its current state.
 * @param projectId - the project.
 * @param state - the project's current state.
 * @param mimeOf - the MIME type of an asset, or null for an asset the pool does not hold.
 * @returns the cover (the outputs of the first finished `shot.render_*` record with a video or image output, else the
 *   first image of a finished `asset.import` record), the shot count and total duration, and the last edit time.
 */
export function summarizeProject(projectId: ProjectId, state: SummarySource, mimeOf: (id: AssetId) => string | null): WireProjectSummary {
  const records = state.components.proj.records
  const firstOf = (outputs: AssetId[], kind: 'image/' | 'video/'): AssetId | null =>
    outputs.find(id => mimeOf(id)?.startsWith(kind) === true) ?? null
  let cover: WireProjectCover | null = null
  for (const record of records) {
    if (record.status !== 'done' || record.operation === null || !RENDER_OPERATIONS.includes(record.operation)) continue
    const video = firstOf(record.outputs, 'video/')
    const image = firstOf(record.outputs, 'image/')
    if (video === null && image === null) continue
    cover = { video, image }
    break
  }
  if (cover === null) {
    for (const record of records) {
      if (record.status !== 'done' || record.operation !== 'asset.import') continue
      const image = firstOf(record.outputs, 'image/')
      if (image === null) continue
      cover = { video: null, image }
      break
    }
  }
  const latest = Object.values(state.components.plan.plans).map(versions => versions.at(-1)?.shots ?? [])
  const shots = latest.reduce((sum, list) => sum + list.length, 0)
  const durationSec = latest.flat().reduce((sum, shot) => sum + (shot.duration_sec ?? 0), 0)
  const last = records.at(-1)
  const editedAt = last === undefined ? null : last.finished_at ?? last.created_at
  return { project: projectId, cover, shots, duration_sec: durationSec, edited_at: editedAt }
}
