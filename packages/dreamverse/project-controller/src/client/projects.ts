/**
 * Client for the stored DreamVerse projects: the project list, one project's completed rounds, segment videos, and
 * project deletion. The project store's routes (`@dreamverse/project-store/routes`) serve every project as its record,
 * its workload data, and the files that it owns; this module reads the `dreamverse` projects and rebuilds each one's
 * rounds from its DreamVerse workload data. The page stores no project.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId } from '@dreamverse/assets-manager/client/assets.ts'
import type { ProjectId, SegmentId } from './ids.ts'
import { isJsonObject, type JsonObject } from './json.ts'

/** One project in the project list. */
export interface ProjectSummary {
  project_id: ProjectId
  title: string
  /** ISO-8601 UTC time. */
  created_at: string
  /** ISO-8601 UTC time. */
  updated_at: string
  /** The last frame of the project's last completed segment, or `null` before any segment completes. */
  thumbnail_url: string | null
}

/** One completed segment of a stored round, with the URLs of its fMP4 video and its last frame. */
export interface ProjectSegment {
  segment_id: SegmentId
  prompt: string
  mime: string
  video_url: string
  /** The last frame's URL, or `null` when the project keeps no last frame for the segment. */
  frame_url: string | null
}

/** One completed round of a stored project; its segments are in playback order. */
export interface ProjectRound {
  round_index: number
  /** The user's instruction that started the round, or `null` for an authored or automatic round. */
  instruction: string | null
  segments: ProjectSegment[]
}

/** One stored project, rebuilt from `GET /projects/<project_id>`. */
export interface ProjectDetail {
  project_id: ProjectId
  title: string
  created_at: string
  updated_at: string
  /** Whether a project socket currently holds the project. */
  open: boolean
  /** The creation settings, in the fields of `gpu_assigned.creation_config`. */
  creation_config: JsonObject
  /** The completed rounds in generation order. */
  rounds: ProjectRound[]
}

/** The `kind` of DreamVerse projects in the project store. */
const DREAMVERSE_PROJECT_KIND = 'dreamverse'

/** The DreamVerse workload data version that this client reads. */
const DREAMVERSE_DATA_SCHEMA_VERSION = 1

/** The `creation_config` fields that `gpu_assigned` reports and the page reads. */
const CREATION_CONFIG_FIELDS = ['model_id', 'generation_mode', 'aspect_ratio', 'resolution', 'segment_count', 'segment_duration_sec']

/** The fields of one stored DreamVerse segment that the rounds use. */
interface StoredSegment {
  segment_id: SegmentId
  prompt: string
  status: string
  mime: string | null
  instruction_text: string | null
  video_asset_id: AssetId | null
  last_frame_asset_id: AssetId | null
}

/** Decode one project list entry; a missing or mistyped field rejects the entry. */
function parseProjectSummary(value: unknown): ProjectSummary | null {
  if (!isJsonObject(value)) return null
  const thumbnailUrl = value.thumbnail_url
  if (typeof value.project_id !== 'string' || typeof value.title !== 'string' || typeof value.created_at !== 'string'
    || typeof value.updated_at !== 'string' || (thumbnailUrl !== null && typeof thumbnailUrl !== 'string')) return null
  return {
    project_id: brandString<ProjectId>(value.project_id),
    title: value.title,
    created_at: value.created_at,
    updated_at: value.updated_at,
    thumbnail_url: thumbnailUrl,
  }
}

/** @returns the asset ID that a stored segment names, or `null`. */
function assetIdOrNull(value: string | null): AssetId | null {
  return value === null ? null : brandString<AssetId>(value)
}

/** @returns whether a JSON value is a string or `null`. */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/** Decode one segment of the DreamVerse workload data; a missing or mistyped field rejects the segment. */
function parseStoredSegment(value: unknown): StoredSegment | null {
  if (!isJsonObject(value)) return null
  const instruction = value.instruction
  if (typeof value.segment_id !== 'string' || typeof value.prompt !== 'string' || typeof value.status !== 'string'
    || !isNullableString(value.mime) || !isNullableString(value.video_asset_id)
    || !isNullableString(value.last_frame_asset_id)
    || (instruction !== null && !(isJsonObject(instruction) && typeof instruction.text === 'string'))) return null
  return {
    segment_id: brandString<SegmentId>(value.segment_id),
    prompt: value.prompt,
    status: value.status,
    mime: value.mime,
    instruction_text: instruction === null ? null : String(instruction.text),
    video_asset_id: assetIdOrNull(value.video_asset_id),
    last_frame_asset_id: assetIdOrNull(value.last_frame_asset_id),
  }
}

/**
 * Decode the content URLs of the files that a project owns.
 * @returns each file's asset ID to its `content_url`, or null when an entry is invalid.
 */
function parseAssetUrls(value: unknown): Map<AssetId, string> | null {
  if (!Array.isArray(value)) return null
  const urls = new Map<AssetId, string>()
  for (const asset of value) {
    if (!isJsonObject(asset) || typeof asset.asset_id !== 'string' || typeof asset.content_url !== 'string') return null
    urls.set(brandString<AssetId>(asset.asset_id), asset.content_url)
  }
  return urls
}

/**
 * Rebuild the completed rounds of a DreamVerse project: one round per completed sequence, holding the sequence's
 * completed segments whose video the project keeps, in display order. A round's instruction is the text of its last
 * segment's user instruction.
 * @param data - the DreamVerse workload data.
 * @param assetUrls - each project file's asset ID to its content URL.
 * @returns the rounds, or null when the workload data is invalid.
 */
function parseRounds(data: JsonObject, assetUrls: ReadonlyMap<AssetId, string>): ProjectRound[] | null {
  if (!Array.isArray(data.segments) || !Array.isArray(data.completed_sequences)) return null
  const segmentsById = new Map<SegmentId, StoredSegment>()
  for (const entry of data.segments) {
    const segment = parseStoredSegment(entry)
    if (!segment) return null
    segmentsById.set(segment.segment_id, segment)
  }
  const rounds: ProjectRound[] = []
  for (const sequence of data.completed_sequences) {
    if (!Array.isArray(sequence)) return null
    const segments: ProjectSegment[] = []
    let instruction: string | null = null
    for (const segmentId of sequence) {
      const segment = typeof segmentId === 'string' ? segmentsById.get(brandString<SegmentId>(segmentId)) : undefined
      if (segment === undefined) return null
      const videoUrl = segment.video_asset_id === null ? undefined : assetUrls.get(segment.video_asset_id)
      if (segment.status !== 'completed' || segment.mime === null || videoUrl === undefined) continue
      instruction = segment.instruction_text || null
      segments.push({
        segment_id: segment.segment_id,
        prompt: segment.prompt,
        mime: segment.mime,
        video_url: videoUrl,
        frame_url: (segment.last_frame_asset_id === null ? undefined : assetUrls.get(segment.last_frame_asset_id)) ?? null,
      })
    }
    rounds.push({ round_index: rounds.length, instruction, segments })
  }
  return rounds
}

/** Decode one stored DreamVerse project and rebuild its rounds; any invalid field rejects the project. */
function parseProjectDetail(value: unknown): ProjectDetail | null {
  const summary = parseProjectSummary(value)
  if (!summary || !isJsonObject(value) || value.kind !== DREAMVERSE_PROJECT_KIND || typeof value.held !== 'boolean') return null
  const workload = value.workload
  if (!isJsonObject(workload) || workload.schema_version !== DREAMVERSE_DATA_SCHEMA_VERSION || !isJsonObject(workload.data)) return null
  const creationConfig = workload.data.creation_config
  const assetUrls = parseAssetUrls(value.assets)
  if (!isJsonObject(creationConfig) || !assetUrls) return null
  const rounds = parseRounds(workload.data, assetUrls)
  if (!rounds) return null
  return {
    project_id: summary.project_id,
    title: summary.title,
    created_at: summary.created_at,
    updated_at: summary.updated_at,
    open: value.held,
    creation_config: Object.fromEntries(CREATION_CONFIG_FIELDS.map(field => [field, creationConfig[field]])),
    rounds,
  }
}

/**
 * Why a project request failed without a server explanation: an error status, or a response body that is not the
 * expected list, entry, or project.
 */
export type ProjectRequestFailure =
  | { code: 'status'; status: number }
  | { code: 'list-invalid' }
  | { code: 'list-entry-invalid' }
  | { code: 'project-invalid' }

/** A project request failure that carries no server text; the page translates its `failure` when it shows it. */
export class ProjectRequestError extends Error {
  /**
   * @param failure - the reason, with the HTTP status for an error status.
   */
  constructor(readonly failure: ProjectRequestFailure) {
    super(failure.code === 'status' ? `project-request:status:${failure.status}` : `project-request:${failure.code}`)
  }
}

/** Reject a failed response with the server's `detail` text, or with a {@link ProjectRequestError} without one. */
async function requireSuccess(response: Response): Promise<void> {
  if (response.ok) return
  const payload: unknown = await response.json().catch(() => null)
  throw isJsonObject(payload) && typeof payload.detail === 'string'
    ? new Error(payload.detail)
    : new ProjectRequestError({ code: 'status', status: response.status })
}

/** The route of one project. */
function projectPath(projectId: ProjectId): string {
  return `/projects/${encodeURIComponent(projectId)}`
}

/**
 * List the stored DreamVerse projects.
 * @returns the projects in the server's order, newest update first.
 * @throws when the request fails or the response is not a project list.
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const response = await fetch(`/projects?kind=${DREAMVERSE_PROJECT_KIND}`, { cache: 'no-store' })
  await requireSuccess(response)
  const body: unknown = await response.json()
  if (!isJsonObject(body) || !Array.isArray(body.projects)) throw new ProjectRequestError({ code: 'list-invalid' })
  return body.projects.map((entry: unknown) => {
    const project = parseProjectSummary(entry)
    if (!project) throw new ProjectRequestError({ code: 'list-entry-invalid' })
    return project
  })
}

/**
 * Read one stored DreamVerse project.
 * @param projectId - the project ID.
 * @returns the project's creation settings and completed rounds.
 * @throws with the server's `detail` when the project does not exist, or when the response is not a DreamVerse
 *   project.
 */
export async function getProject(projectId: ProjectId): Promise<ProjectDetail> {
  const response = await fetch(projectPath(projectId), { cache: 'no-store' })
  await requireSuccess(response)
  const project = parseProjectDetail(await response.json())
  if (!project) throw new ProjectRequestError({ code: 'project-invalid' })
  return project
}

/**
 * Delete one stored project with its files.
 * @param projectId - the project ID.
 * @throws with the server's `detail` when the server refuses, for example while the project is open.
 */
export async function deleteProject(projectId: ProjectId): Promise<void> {
  const response = await fetch(projectPath(projectId), { method: 'DELETE' })
  await requireSuccess(response)
}

/**
 * Download one stored segment video.
 * @param videoUrl - the segment's `video_url`.
 * @returns the segment's fMP4 bytes.
 * @throws with the server's `detail` when the video is unavailable.
 */
export async function fetchSegmentVideo(videoUrl: string): Promise<ArrayBuffer> {
  const response = await fetch(videoUrl)
  await requireSuccess(response)
  return await response.arrayBuffer()
}
