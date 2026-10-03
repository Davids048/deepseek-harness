/**
 * The DreamVerse file store as the `dreamverseAssetsManager` Cordis service: every file that DreamVerse workloads use,
 * owned either by the user's library or by one project.
 *
 * Library uploads follow `apps/dreamverse/dreamverse/assets/` (`inspect_media`, `upload_policy_as_dict`, and the
 * reference messages); files that the harness writes or copies for a project skip the upload limits. The service opens
 * the store under the configured root when the plugin starts and closes it when the plugin unloads. While the DSH web
 * server (`webServer`) is available, the service registers the `/assets` routes on it; other GET and HEAD requests
 * under `/assets` serve the DSH page shell's files, which the shell loads from `./assets/`.
 *
 * @module @dreamverse/assets-manager
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

import { assetsRouteHandler } from './asset-routes.ts'
import { AssetLibrary, type AssetId, type AssetOwner, type AssetRecord, type AssetWriteOptions, type AssetWriter } from './library.ts'
import { uploadPolicy } from './media.ts'
import { shellFileResponder } from './shell-files.ts'

export { sendFile, type FileDelivery } from './file-response.ts'
export {
  AssetNotFoundError, SCHEMA_VERSION, projectOwner, type AssetId, type AssetOwner, type AssetRecord, type AssetWriteOptions,
  type AssetWriter,
} from './library.ts'
export { MediaValidationError, UploadTooLargeError, type MediaType } from './media.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DreamVerse files of the library and of projects, their SQLite index, upload validation, and file retention. */
    dreamverseAssetsManager: DreamverseAssetsManager
  }
}

/** The library location. */
export interface Config {
  /** The `<state root>/assets` directory holding `files/<asset_id>` and `index.sqlite3`. */
  root: string
}

/** Loader validation; `root` is required. */
export const Config = z.object({
  root: z.string().required(),
})

/**
 * The `dreamverseAssetsManager` service: one `AssetLibrary` for the plugin's lifetime.
 *
 * `add` accepts library uploads; `createWriter`, `addBytes`, and `copy` publish files for any owner. `retain` and
 * `release` bracket each accepted generation request and each content response, and `delete` and `deleteOwnedBy`
 * defer file removal until the last retention is released.
 */
export default class DreamverseAssetsManager extends Service {
  static Config = Config
  private readonly root: string
  /** Assigned by `[Service.init]`, which runs before the plugin becomes active and dependents can use the service. */
  private library!: AssetLibrary

  constructor(ctx: Context, config: Config) {
    super(ctx, 'dreamverseAssetsManager')
    this.root = config.root
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: '/assets',
        handler: assetsRouteHandler(this, webCtx.logger('dreamverse'), shellFileResponder()),
      }), 'dreamverse /assets routes')
    })
  }

  /** Open the library and finish persisted deletions; the returned disposer closes the index. */
  [Service.init](): () => void {
    const library = new AssetLibrary(this.root)
    this.library = library
    return () => {
      library.close()
    }
  }

  /**
   * Copy, validate, and publish one upload; the route answers 413 for `UploadTooLargeError` and 400 for any other
   * `MediaValidationError`.
   * @param content - the complete upload.
   * @param name - the uploaded file name, sanitized as the reference display name.
   * @param mimeType - the MIME type the browser declared.
   * @returns the published record; images carry the MIME type detected from their content.
   */
  add(content: Uint8Array, name: string, mimeType: string): Promise<AssetRecord> {
    return this.library.add(content, name, mimeType)
  }

  /**
   * Start writing one file in pieces; `commit` reads its facts without upload limits and publishes it, and any failure
   * or `abort` leaves no file. Throws `MediaValidationError` when the MIME type is not an image, video, or audio type.
   * @param options - the file's owner, display name, and MIME type.
   * @returns the writer.
   */
  createWriter(options: AssetWriteOptions): AssetWriter {
    return this.library.createWriter(options)
  }

  /**
   * Publish one complete file, such as a last-frame PNG; rejects with `MediaValidationError` for content that is not
   * a decodable image, video, or audio file, leaving no file.
   * @param options - the file's owner, display name, and MIME type.
   * @param bytes - the file content.
   * @returns the published record.
   */
  addBytes(options: AssetWriteOptions, bytes: Uint8Array): Promise<AssetRecord> {
    return this.library.addBytes(options, bytes)
  }

  /**
   * Copy a published file for another owner, for example a library image that a project starts to use; rejects with
   * `AssetNotFoundError` when the source is absent or deleted.
   * @param assetId - the source file.
   * @param owner - the owner of the copy.
   * @returns the copy's record, with a new asset ID.
   */
  copy(assetId: AssetId, owner: AssetOwner): Promise<AssetRecord> {
    return this.library.copy(assetId, owner)
  }

  /**
   * List one owner's published files.
   * @param owner - the owner; the user's library by default.
   * @returns every file of the owner that is not deleted, most recently added first.
   */
  list(owner: AssetOwner = 'library'): AssetRecord[] {
    return this.library.list(owner)
  }

  /**
   * Resolve one published asset; throws `AssetNotFoundError` when it is absent or deleted.
   * @param assetId - the asset ID.
   * @returns the asset record.
   */
  get(assetId: AssetId): AssetRecord {
    return this.library.get(assetId)
  }

  /**
   * Resolve every ID, then protect the files from deletion until `release`; throws `AssetNotFoundError` for the first
   * unavailable ID without retaining any file.
   * @param assetIds - the asset IDs one request uses.
   * @returns the records in `assetIds` order.
   */
  retain(assetIds: readonly AssetId[]): AssetRecord[] {
    return this.library.retain(assetIds)
  }

  /**
   * Release the IDs one `retain` call accepted and remove files whose deletion waited for them; throws `Error`
   * `Asset release must match an accepted retention.` without changing any count when an ID is released more often
   * than it is retained.
   * @param assetIds - the IDs to release.
   */
  release(assetIds: readonly AssetId[]): void {
    this.library.release(assetIds)
  }

  /**
   * Hide a file immediately and remove it once no retention holds it; throws `AssetNotFoundError` when the file is
   * absent or already deleted.
   * @param assetId - the asset ID.
   */
  delete(assetId: AssetId): void {
    this.library.delete(assetId)
  }

  /**
   * Delete every file of one owner, for example when its project is deleted. The caller ensures that no writer for
   * this owner is still open.
   * @param owner - the owner whose files to delete.
   */
  deleteOwnedBy(owner: AssetOwner): void {
    this.library.deleteOwnedBy(owner)
  }

  /**
   * The upload rules that `GET /creation-capabilities` reports as `asset_upload`.
   * @returns a fresh copy of the reference `upload_policy_as_dict()` payload.
   */
  uploadPolicy(): Record<string, unknown> {
    return uploadPolicy()
  }
}
