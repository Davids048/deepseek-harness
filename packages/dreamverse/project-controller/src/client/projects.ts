/**
 * Client for the harness project routes: the project list, one project's stored rounds, segment videos, and project
 * deletion. The harness owns every project; the page reads projects through these routes and stores none of them.
 */
import { isJsonObject, type JsonObject } from './json.ts'

/** One project in the `GET /projects` list. */
export interface ProjectSummary {
  project_id: string
  title: string
  /** ISO-8601 UTC time. */
  created_at: string
  /** ISO-8601 UTC time. */
  updated_at: string
  /** The last frame of the project's last completed segment, or `null` before any segment completes. */
  thumbnail_url: string | null
  round_count: number
}

/** One completed segment of a stored round, with the URLs of its fMP4 video and its last frame. */
export interface ProjectSegment {
  segment_id: string
  prompt: string
  mime: string
  video_url: string
  frame_url: string
}

/** One completed round of a stored project; its segments are in playback order. */
export interface ProjectRound {
  round_index: number
  /** The user's instruction that started the round, or `null` for an authored or automatic round. */
  instruction: string | null
  segments: ProjectSegment[]
}

/** One stored project from `GET /projects/<project_id>`. */
export interface ProjectDetail {
  project_id: string
  title: string
  created_at: string
  updated_at: string
  /** Whether a project socket currently has the project open. */
  open: boolean
  /** The creation settings, in the fields of `gpu_assigned.creation_config`. */
  creation_config: JsonObject
  /** The completed rounds in generation order. */
  rounds: ProjectRound[]
}

/** Decode one project list entry; a missing or mistyped field rejects the entry. */
function parseProjectSummary(value: unknown): ProjectSummary | null {
  if (!isJsonObject(value)) return null
  const thumbnailUrl = value.thumbnail_url
  if (typeof value.project_id !== 'string' || typeof value.title !== 'string' || typeof value.created_at !== 'string'
    || typeof value.updated_at !== 'string' || (thumbnailUrl !== null && typeof thumbnailUrl !== 'string')
    || typeof value.round_count !== 'number') return null
  return {
    project_id: value.project_id,
    title: value.title,
    created_at: value.created_at,
    updated_at: value.updated_at,
    thumbnail_url: thumbnailUrl,
    round_count: value.round_count,
  }
}

/** Decode one stored segment; a missing or mistyped field rejects the segment. */
function parseProjectSegment(value: unknown): ProjectSegment | null {
  if (!isJsonObject(value)) return null
  if (typeof value.segment_id !== 'string' || typeof value.prompt !== 'string' || typeof value.mime !== 'string'
    || typeof value.video_url !== 'string' || typeof value.frame_url !== 'string') return null
  return {
    segment_id: value.segment_id,
    prompt: value.prompt,
    mime: value.mime,
    video_url: value.video_url,
    frame_url: value.frame_url,
  }
}

/** Decode one stored round and its segments; any invalid segment rejects the round. */
function parseProjectRound(value: unknown): ProjectRound | null {
  if (!isJsonObject(value)) return null
  const instruction = value.instruction
  if (typeof value.round_index !== 'number' || (instruction !== null && typeof instruction !== 'string')
    || !Array.isArray(value.segments)) return null
  const segments: ProjectSegment[] = []
  for (const entry of value.segments) {
    const segment = parseProjectSegment(entry)
    if (!segment) return null
    segments.push(segment)
  }
  return { round_index: value.round_index, instruction, segments }
}

/** Decode one stored project and its rounds; any invalid round rejects the project. */
function parseProjectDetail(value: unknown): ProjectDetail | null {
  if (!isJsonObject(value)) return null
  const creationConfig = value.creation_config
  if (typeof value.project_id !== 'string' || typeof value.title !== 'string' || typeof value.created_at !== 'string'
    || typeof value.updated_at !== 'string' || typeof value.open !== 'boolean' || !isJsonObject(creationConfig)
    || !Array.isArray(value.rounds)) return null
  const rounds: ProjectRound[] = []
  for (const entry of value.rounds) {
    const round = parseProjectRound(entry)
    if (!round) return null
    rounds.push(round)
  }
  return {
    project_id: value.project_id,
    title: value.title,
    created_at: value.created_at,
    updated_at: value.updated_at,
    open: value.open,
    creation_config: creationConfig,
    rounds,
  }
}

/** Reject a failed response with the server's `detail` text when it has one. */
async function requireSuccess(response: Response): Promise<void> {
  if (response.ok) return
  const payload: unknown = await response.json().catch(() => null)
  throw new Error(isJsonObject(payload) && typeof payload.detail === 'string'
    ? payload.detail
    : `Project request failed (${response.status}).`)
}

/** The route of one project. */
function projectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`
}

/**
 * List the harness projects.
 * @returns the projects in the server's order, newest update first.
 * @throws when the request fails or the response is not a project list.
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const response = await fetch('/projects', { cache: 'no-store' })
  await requireSuccess(response)
  const body: unknown = await response.json()
  if (!isJsonObject(body) || !Array.isArray(body.projects)) throw new Error('The project list response is invalid.')
  return body.projects.map((entry: unknown) => {
    const project = parseProjectSummary(entry)
    if (!project) throw new Error('The project list response contains an invalid project.')
    return project
  })
}

/**
 * Read one stored project.
 * @param projectId - the harness project ID.
 * @returns the project's creation settings and completed rounds.
 * @throws with the server's `detail` when the project does not exist, or when the response is not a project.
 */
export async function getProject(projectId: string): Promise<ProjectDetail> {
  const response = await fetch(projectPath(projectId), { cache: 'no-store' })
  await requireSuccess(response)
  const project = parseProjectDetail(await response.json())
  if (!project) throw new Error('The project response is invalid.')
  return project
}

/**
 * Delete one stored project.
 * @param projectId - the harness project ID.
 * @throws with the server's `detail` when the server refuses, for example while the project is open.
 */
export async function deleteProject(projectId: string): Promise<void> {
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
