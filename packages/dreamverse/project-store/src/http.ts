/**
 * The `/projects` routes of the shared project layer: list, read, and delete projects of every workload. A project's
 * files are served by the file store's `GET /assets/<asset_id>/content`; these routes return those URLs. Error bodies
 * use the `{"detail": ...}` form of the other DreamVerse routes.
 *
 * @module @dreamverse/project-store/http
 */
import type { IncomingMessage } from 'node:http'
import { brandString } from '@deepseek-ai/dsh-brand'
import { projectOwner, type AssetId, type AssetRecord } from '@dreamverse/assets-manager'
import { sendJson, type Route } from '@dreamverse/http-routes'
import type { ProjectFiles } from './dependencies.ts'
import type { ProjectId, ProjectRecord } from './records.ts'
import type DreamverseProjectStore from './index.ts'
import { ProjectInUseError, ProjectNotFoundError } from './index.ts'

/**
 * @param assetId - a file store asset ID.
 * @returns the route that serves the file's content.
 */
function contentUrl(assetId: AssetId): string {
  return `/assets/${encodeURIComponent(assetId)}/content`
}

/**
 * Describe a project for the project list.
 * @param record - the stored project.
 * @returns the list entry.
 */
function projectSummary(record: ProjectRecord): Record<string, unknown> {
  return {
    project_id: record.projectId,
    kind: record.kind,
    title: record.title,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    thumbnail_url: record.thumbnailAssetId === null ? null : contentUrl(record.thumbnailAssetId),
  }
}

/**
 * Describe one file of a project.
 * @param asset - the file store record.
 * @returns the file's facts and content URL.
 */
function projectAsset(asset: AssetRecord): Record<string, unknown> {
  return {
    asset_id: asset.assetId,
    name: asset.name,
    media_type: asset.mediaType,
    mime_type: asset.mimeType,
    size_bytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    duration_sec: asset.durationSec,
    created_at: asset.createdAt,
    content_url: contentUrl(asset.assetId),
  }
}

/**
 * @param request - the HTTP request.
 * @returns the `kind` query parameter, or undefined when absent.
 */
function kindFilter(request: IncomingMessage): string | undefined {
  return new URL(request.url ?? '/', 'http://localhost').searchParams.get('kind') ?? undefined
}

/**
 * Build the `/projects` routes.
 * @param store - the project store.
 * @param files - the file store that holds the projects' files.
 * @returns the routes in match order.
 */
export function projectRoutes(store: DreamverseProjectStore, files: ProjectFiles): Route[] {
  return [
    {
      method: 'GET',
      path: /^\/projects$/,
      handle: (request, response) => {
        const kind = kindFilter(request)
        sendJson(response, 200, { projects: store.list(kind === undefined ? {} : { kind }).map(projectSummary) })
      },
    },
    {
      method: 'GET',
      path: /^\/projects\/([^/]+)$/,
      handle: (_request, response, [id = '']) => {
        const projectId = brandString<ProjectId>(id)
        const record = store.get(projectId)
        if (record === undefined) {
          sendJson(response, 404, { detail: 'Project not found.' })
          return
        }
        sendJson(response, 200, {
          ...projectSummary(record),
          held: store.isHeld(projectId),
          workload: { schema_version: record.workload.schemaVersion, data: record.workload.data },
          assets: files.list(projectOwner(projectId)).map(projectAsset),
        })
      },
    },
    {
      method: 'DELETE',
      path: /^\/projects\/([^/]+)$/,
      handle: (_request, response, [id = '']) => {
        try {
          store.delete(brandString<ProjectId>(id))
        } catch (error) {
          if (error instanceof ProjectNotFoundError) sendJson(response, 404, { detail: 'Project not found.' })
          else if (error instanceof ProjectInUseError) sendJson(response, 409, { detail: 'This project is open. Close it before deleting.' })
          else throw error
          return
        }
        response.writeHead(204)
        response.end()
      },
    },
  ]
}
