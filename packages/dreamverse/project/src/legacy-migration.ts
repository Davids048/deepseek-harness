/**
 * Convert the schema-1 DreamVerse projects that `@dreamverse/project` stored under the project store's root before the
 * shared project store into `dreamverse` projects.
 *
 * For each schema-1 `project.json` that `dreamverseProjectStore.listUnrecognized()` reports, the migration moves the
 * completed segments' files from `<project directory>/segments/` into the file store, owned by the project, copies the
 * library images that the segments reference into the project, writes the project record with `migrate`, sets the
 * thumbnail, and removes `segments/`. A run that stops before `migrate` leaves the schema-1 record in place, and the
 * next run first deletes the project's partly imported files and starts again.
 *
 * @module @dreamverse/project/legacy-migration
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { projectOwner } from '@dreamverse/assets-manager'
import type { AssetId, AssetOwner, DreamverseAssetsManager, DreamverseProjectStore } from './dependencies.ts'
import { errorMessage } from './errors.ts'
import {
  DREAMVERSE_DATA_SCHEMA_VERSION,
  DREAMVERSE_PROJECT_KIND,
  parseLegacyProject,
  type DreamverseProjectData,
  type LegacyProject,
  type LegacySegment,
  type StoredSegment,
} from './project-data.ts'

/** The services that the migration calls. */
export interface LegacyMigrationServices {
  store: DreamverseProjectStore
  assets: DreamverseAssetsManager
  warn(message: string): void
}

/**
 * Migrate every schema-1 DreamVerse project under the project store's root. A record whose `schema_version` is not 1
 * belongs to another workload and is skipped; a project that fails to migrate is reported with a warning and left
 * for the next run.
 * @param services - the project store, the file store, and the warning log.
 */
export async function migrateLegacyProjects(services: LegacyMigrationServices): Promise<void> {
  for (const entry of services.store.listUnrecognized()) {
    if (!isSchemaOneRecord(entry.record)) continue
    try {
      const legacy = parseLegacyProject(entry.record, entry.projectId)
      await migrateLegacyProject(services, entry.directory, legacy)
    } catch (error) {
      services.warn(`Failed to migrate DreamVerse project ${entry.projectId}: ${errorMessage(error)}`)
    }
  }
}

/**
 * @param record - a parsed `project.json`, or null for invalid JSON.
 * @returns whether the record declares schema version 1.
 */
function isSchemaOneRecord(record: unknown): boolean {
  return typeof record === 'object' && record !== null && 'schema_version' in record && record.schema_version === 1
}

/**
 * Migrate one schema-1 project.
 * @param services - the project store, the file store, and the warning log.
 * @param directory - the project's directory under the store root.
 * @param legacy - the parsed schema-1 record.
 */
async function migrateLegacyProject(services: LegacyMigrationServices, directory: string, legacy: LegacyProject): Promise<void> {
  const { store, assets } = services
  const owner = projectOwner(legacy.project_id)
  // Files of a run that stopped before `migrate` belong to no record; import them again.
  assets.deleteOwnedBy(owner)
  const referenceCopies = await copyReferenceImages(services, owner, legacy)
  const segments: StoredSegment[] = []
  for (const segment of legacy.segments) {
    segments.push(await importSegment(assets, owner, join(directory, 'segments'), segment, referenceCopies))
  }
  const data: DreamverseProjectData = {
    creation_config: legacy.creation_config,
    prompt_enhancement_enabled: legacy.prompt_enhancement_enabled,
    prompt_sequence_id: legacy.prompt_sequence_id,
    prompt_sequence_label: legacy.prompt_sequence_label,
    segments,
    completed_sequences: legacy.completed_sequences,
    reference_copies: Object.fromEntries(referenceCopies),
  }
  store.migrate(legacy.project_id, {
    kind: DREAMVERSE_PROJECT_KIND, title: legacy.title, createdAt: legacy.created_at,
    workload: { schemaVersion: DREAMVERSE_DATA_SCHEMA_VERSION, data },
  })
  const lastSegmentId = legacy.completed_sequences.at(-1)?.at(-1)
  const thumbnailAssetId = segments.find(segment => segment.segment_id === lastSegmentId)?.last_frame_asset_id ?? null
  if (thumbnailAssetId !== null) {
    const lease = await store.acquire(legacy.project_id, { revoke: () => Promise.resolve() })
    try {
      store.setThumbnail(lease, thumbnailAssetId)
    } finally {
      store.release(lease)
    }
  }
  rmSync(join(directory, 'segments'), { recursive: true, force: true })
}

/**
 * Copy every library image that the project's segments reference into the project, once per image.
 * @param services - the file store and the warning log.
 * @param owner - the project's file owner.
 * @param legacy - the schema-1 record.
 * @returns each library asset ID to its project-owned copy; an image that the library no longer holds is skipped
 *   with a warning.
 */
async function copyReferenceImages(
  services: LegacyMigrationServices,
  owner: AssetOwner,
  legacy: LegacyProject,
): Promise<Map<AssetId, AssetId>> {
  const copies = new Map<AssetId, AssetId>()
  for (const assetId of new Set(legacy.segments.flatMap(segment => segment.reference_asset_ids))) {
    try {
      copies.set(assetId, (await services.assets.copy(assetId, owner)).assetId)
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AssetNotFoundError')) throw error
      services.warn(`DreamVerse project ${legacy.project_id}: reference image ${assetId} is gone; its segments keep no copy.`)
    }
  }
  return copies
}

/**
 * Store a completed segment's video and last frame in the file store, and point the segment at its reference copies.
 * @param assets - the file store.
 * @param owner - the project's file owner.
 * @param segmentsDirectory - the schema-1 `segments/` directory.
 * @param segment - the schema-1 segment.
 * @param referenceCopies - each library asset ID to its project-owned copy.
 * @returns the segment with the file store IDs of its files; a segment that is not completed, or a missing file,
 *   keeps a null ID.
 */
async function importSegment(
  assets: DreamverseAssetsManager,
  owner: AssetOwner,
  segmentsDirectory: string,
  segment: LegacySegment,
  referenceCopies: ReadonlyMap<AssetId, AssetId>,
): Promise<StoredSegment> {
  let videoAssetId: AssetId | null = null
  let lastFrameAssetId: AssetId | null = null
  if (segment.status === 'completed') {
    const videoPath = join(segmentsDirectory, `${segment.segment_id}.mp4`)
    if (existsSync(videoPath)) {
      const options = { owner, name: `${segment.segment_id}.mp4`, mimeType: segment.mime ?? 'video/mp4' }
      videoAssetId = (await assets.addBytes(options, readFileSync(videoPath))).assetId
    }
    const framePath = join(segmentsDirectory, `${segment.segment_id}.png`)
    if (existsSync(framePath)) {
      const options = { owner, name: `${segment.segment_id}.png`, mimeType: 'image/png' }
      lastFrameAssetId = (await assets.addBytes(options, readFileSync(framePath))).assetId
    }
  }
  return {
    ...segment,
    reference_asset_ids: segment.reference_asset_ids.flatMap((assetId) => {
      const copyId = referenceCopies.get(assetId)
      return copyId === undefined ? [] : [copyId]
    }),
    video_asset_id: videoAssetId,
    last_frame_asset_id: lastFrameAssetId,
  }
}
