/**
 * The stored-project HTTP routes: `GET /projects`, `GET /projects/{project_id}`,
 * `GET /projects/{project_id}/segments/{segment_id}/video` and `.../frame`, and `DELETE /projects/{project_id}`.
 * The browser reads stored project content through these routes and live generation through `/ws`. Every response
 * body is JSON in the `{"detail": ...}` error form of the other DreamVerse routes, except the segment files.
 *
 * @module @dreamverse/project-controller/project-routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Route } from '@dreamverse/http-routes'
import { sendJson } from '@dreamverse/http-routes'
import { sendFile } from '@dreamverse/assets-manager'
import type { DreamverseProjects, PersistedProject, PersistedSegment } from './dependencies.ts'
import type { OpenProjectRegistry } from './project-connection.ts'

/** The two stored files of a completed segment, with the media type that each is served as. */
const SEGMENT_FILES = {
  video: { mediaType: 'video/mp4', extension: 'mp4' },
  frame: { mediaType: 'image/png', extension: 'png' },
} as const

/**
 * @param projectId - the project ID.
 * @param segmentId - the segment ID.
 * @param kind - the segment's video or last frame.
 * @returns the route path that serves the file.
 */
function segmentFileUrl(projectId: string, segmentId: string, kind: keyof typeof SEGMENT_FILES): string {
  return `/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(segmentId)}/${kind}`
}

/**
 * Each completed round's completed segments, in display order.
 * @param record - the stored project.
 * @returns one list of segment records per entry of `completed_sequences`.
 */
function roundSegments(record: PersistedProject): PersistedSegment[][] {
  const segmentsById = new Map(record.segments.map(segment => [segment.segment_id, segment]))
  return record.completed_sequences.map(sequence => sequence
    .map(segmentId => segmentsById.get(segmentId))
    .filter((segment): segment is PersistedSegment => segment?.status === 'completed'))
}

/**
 * Describe one stored project for the project list.
 * @param projects - the project service.
 * @param record - one stored project.
 * @returns the list entry; `thumbnail_url` serves the last frame of the last completed round's last segment.
 */
function projectSummary(projects: DreamverseProjects, record: PersistedProject): Record<string, unknown> {
  const lastSegment = roundSegments(record).at(-1)?.at(-1)
  const hasFrame = lastSegment !== undefined && projects.segmentFile(record.project_id, lastSegment.segment_id, 'frame') !== undefined
  return {
    project_id: record.project_id,
    title: record.title,
    created_at: record.created_at,
    updated_at: record.updated_at,
    thumbnail_url: hasFrame ? segmentFileUrl(record.project_id, lastSegment.segment_id, 'frame') : null,
    round_count: record.completed_sequences.length,
  }
}

/**
 * Describe one stored project for the page that opens it.
 * @param projects - the project service.
 * @param record - the stored project.
 * @param open - whether a socket serves the project.
 * @returns the project's creation settings and its completed rounds with their segment file URLs; a segment without a
 *   stored last frame reports a null `frame_url`, and a round's `instruction` is the text of its last segment's user
 *   instruction, or null.
 */
function projectDetail(projects: DreamverseProjects, record: PersistedProject, open: boolean): Record<string, unknown> {
  const config = record.creation_config
  return {
    project_id: record.project_id,
    title: record.title,
    created_at: record.created_at,
    updated_at: record.updated_at,
    open,
    creation_config: {
      model_id: config.model_id,
      generation_mode: config.generation_mode,
      aspect_ratio: config.aspect_ratio,
      resolution: config.resolution,
      segment_count: config.segment_count,
      segment_duration_sec: config.segment_duration_sec,
    },
    rounds: roundSegments(record).map((segments, roundIndex) => ({
      round_index: roundIndex,
      instruction: segments.at(-1)?.instruction?.text || null,
      segments: segments.map(segment => ({
        segment_id: segment.segment_id,
        prompt: segment.prompt,
        mime: segment.mime,
        video_url: segmentFileUrl(record.project_id, segment.segment_id, 'video'),
        frame_url: projects.segmentFile(record.project_id, segment.segment_id, 'frame') === undefined
          ? null
          : segmentFileUrl(record.project_id, segment.segment_id, 'frame'),
      })),
    })),
  }
}

/**
 * Serve one stored segment file, or 404 when it is not stored.
 * @param request - the browser request, whose `Range` header selects the bytes.
 * @param response - the browser response.
 * @param projects - the project service.
 * @param path - the decoded project ID, segment ID, and file kind.
 */
async function serveSegmentFile(
  request: IncomingMessage,
  response: ServerResponse,
  projects: DreamverseProjects,
  [projectId = '', segmentId = '', kind = '']: string[],
): Promise<void> {
  // The route pattern admits only `video` and `frame`.
  const fileKind = kind === 'video' ? 'video' : 'frame'
  const path = projects.segmentFile(projectId, segmentId, fileKind)
  if (path === undefined) {
    sendJson(response, 404, { detail: 'Segment file not found.' })
    return
  }
  const file = SEGMENT_FILES[fileKind]
  await sendFile(request, response, { path, mediaType: file.mediaType, filename: `${segmentId}.${file.extension}` })
}

/**
 * Serve `DELETE /projects/{project_id}`: 204, 404 for a project that is not stored, or 409 while a socket serves it.
 * @param response - the browser response.
 * @param projects - the project service.
 * @param registry - the open projects.
 * @param projectId - the decoded project ID.
 */
function deleteProject(response: ServerResponse, projects: DreamverseProjects, registry: OpenProjectRegistry, projectId: string): void {
  if (registry.has(projectId)) {
    sendJson(response, 409, { detail: 'This project is open. Close it before deleting.' })
    return
  }
  if (!projects.deleteProject(projectId)) {
    sendJson(response, 404, { detail: 'Project not found.' })
    return
  }
  response.writeHead(204)
  response.end()
}

/**
 * Build the stored-project routes.
 * @param projects - the project service that owns the stored projects.
 * @param registry - the open projects, which decide `open` and the 409 for deletion.
 * @returns the routes in registration order.
 */
export function projectRoutes(projects: DreamverseProjects, registry: OpenProjectRegistry): Route[] {
  return [
    {
      method: 'GET',
      path: /^\/projects$/,
      handle: (_request, response) => {
        sendJson(response, 200, { projects: projects.listProjects().map(record => projectSummary(projects, record)) })
      },
    },
    {
      method: 'GET',
      path: /^\/projects\/([^/]+)$/,
      handle: (_request, response, [projectId = '']) => {
        const record = projects.readProject(projectId)
        if (record === undefined) sendJson(response, 404, { detail: 'Project not found.' })
        else sendJson(response, 200, projectDetail(projects, record, registry.has(projectId)))
      },
    },
    {
      method: 'DELETE',
      path: /^\/projects\/([^/]+)$/,
      handle: (_request, response, [projectId = '']) => { deleteProject(response, projects, registry, projectId) },
    },
    {
      method: 'GET',
      path: /^\/projects\/([^/]+)\/segments\/([^/]+)\/(video|frame)$/,
      handle: (request, response, pathParams) => serveSegmentFile(request, response, projects, pathParams),
    },
  ]
}
