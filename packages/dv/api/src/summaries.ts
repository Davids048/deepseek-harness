/**
 * Project card summaries for the DreamVerse shell's entry page and session switcher: per project, the cover and the
 * last edit time, computed from each project's current state so the browser reads one small list instead of every
 * project's whole state.
 *
 * @module @dv/api/summaries
 */
import type { AssetId, ComponentStates, ProjectId } from '@dv/project'
import type {} from '@dv/timeline'

/** The media a project card shows as its cover: a video, whose first frame the card shows, or an image. */
export interface WireProjectCover {
  video: AssetId | null
  image: AssetId | null
}

/**
 * What a project card shows besides the title (`GET /api/dv/projects/summary`). In the list of every project, a project
 * whose state cannot be read gets `cover` null and `edited_at` null.
 */
export interface WireProjectSummary {
  project: ProjectId
  /**
   * The first clip that has media on the chosen timeline (the one the request names, else the first timeline), else
   * the first image output of a finished record; null when the project has neither.
   */
  cover: WireProjectCover | null
  /** When the last record of the current state was written (its `finished_at`, else `created_at`), ISO-8601. */
  edited_at: string | null
}

/** The slices of the project's current state that a summary reads: the records and the timelines. */
export interface SummarySource {
  components: Pick<ComponentStates, 'proj' | 'timeline'>
}

/**
 * Summarize a project from its current state.
 * @param projectId - the project.
 * @param state - the project's current state.
 * @param mimeOf - the MIME type of an asset, or null for an asset the pool does not hold.
 * @param timelineId - the timeline whose first clip is the cover, when the project has it; else the first timeline.
 * @returns the cover and the last edit time.
 */
export function summarizeProject(
  projectId: ProjectId, state: SummarySource, mimeOf: (id: AssetId) => string | null, timelineId: string | null = null,
): WireProjectSummary {
  const coverOf = (id: AssetId): WireProjectCover | null => {
    const mime = mimeOf(id)
    if (mime?.startsWith('video/') === true) return { video: id, image: null }
    if (mime?.startsWith('image/') === true) return { video: null, image: id }
    return null
  }
  const timelines = state.components.timeline.timelines
  const timeline = timelines.find(entry => entry.id === timelineId) ?? timelines[0]
  let cover: WireProjectCover | null = null
  for (const clip of timeline?.clips ?? []) {
    cover = clip.asset === null ? null : coverOf(clip.asset)
    if (cover !== null) break
  }
  const records = state.components.proj.records
  if (cover === null) {
    // A project without a timeline clip yet, such as one whose plan is not approved, shows its first image.
    const image = records.flatMap(record => record.status === 'done' ? record.outputs : [])
      .find(id => mimeOf(id)?.startsWith('image/') === true)
    cover = image === undefined ? null : { video: null, image }
  }
  const last = records.at(-1)
  const editedAt = last === undefined ? null : last.finished_at ?? last.created_at
  return { project: projectId, cover, edited_at: editedAt }
}
