/**
 * Project card summaries for the DreamVerse shell's entry page and session switcher: per project, the cover, the shot
 * count and total duration of its plans, and the last edit time, computed from branch states so the browser reads one
 * small list instead of every project's whole state.
 *
 * @module @dv/api/summaries
 */
import type { AssetId, ComponentStates, ProjectId } from '@dv/project'
import type {} from '@dv/shot-plan'

/** The render operations whose finished records are a project's rendered takes. */
const RENDER_OPERATIONS: ReadonlySet<string> = new Set(['shot.render_ref2va', 'shot.render_t2va'])

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
  /** When the last record of the summarized branch was written (its `finished_at`, else `created_at`), ISO-8601. */
  edited_at: string | null
}

/** One branch's summary, with whether its cover is a rendered take. */
export interface BranchSummary extends Omit<WireProjectSummary, 'project'> {
  /** Whether the cover is a rendered take; false for an imported image or no cover. */
  rendered: boolean
}

/** The slices of a branch state that a summary reads: the records and the plans. */
export interface SummarySource {
  components: Pick<ComponentStates, 'proj' | 'plan'>
}

/**
 * Summarize one branch state of a project.
 * @param state - the branch state.
 * @param mimeOf - the MIME type of an asset, or null for an asset the pool does not hold.
 * @returns the cover (the outputs of the first finished `shot.render_*` record with a video or image output, else the
 *   first image of a finished `asset.import` record), the shot count and total duration, and the last edit time.
 */
export function summarizeBranch(state: SummarySource, mimeOf: (id: AssetId) => string | null): BranchSummary {
  const records = state.components.proj.records
  const firstOf = (outputs: AssetId[], kind: 'image/' | 'video/'): AssetId | null =>
    outputs.find(id => mimeOf(id)?.startsWith(kind) === true) ?? null
  let cover: WireProjectCover | null = null
  let rendered = false
  for (const record of records) {
    if (record.status !== 'done' || record.operation === null || !RENDER_OPERATIONS.has(record.operation)) continue
    const video = firstOf(record.outputs, 'video/')
    const image = firstOf(record.outputs, 'image/')
    if (video === null && image === null) continue
    cover = { video, image }
    rendered = true
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
  return { cover, rendered, shots, duration_sec: durationSec, edited_at: last === undefined ? null : last.finished_at ?? last.created_at }
}

/**
 * Summarize a project from `main` when `main` has a rendered take, else from its first open draft branch, because the
 * plans and takes of a chat session stay on its draft until they are accepted and a draft state includes `main`.
 * @param projectId - the project.
 * @param readState - reads a branch state of the project.
 * @param draftBranch - the name of the project's first open draft branch, or null when none is open.
 * @param mimeOf - the MIME type of an asset, or null for an asset the pool does not hold.
 * @returns the project's card summary.
 */
export function summarizeProject(
  projectId: ProjectId,
  readState: (branch: string) => SummarySource,
  draftBranch: string | null,
  mimeOf: (id: AssetId) => string | null,
): WireProjectSummary {
  let summary = summarizeBranch(readState('main'), mimeOf)
  if (!summary.rendered && draftBranch !== null) summary = summarizeBranch(readState(draftBranch), mimeOf)
  const { cover, shots, duration_sec: durationSec, edited_at: editedAt } = summary
  return { project: projectId, cover, shots, duration_sec: durationSec, edited_at: editedAt }
}
