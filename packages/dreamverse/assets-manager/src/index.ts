/**
 * DreamVerse asset library as the `dreamverseAssetsManager` Cordis service.
 *
 * A port of `apps/dreamverse/dreamverse/assets/`: `AssetLibrary`, `inspect_media`, and `upload_policy_as_dict` with
 * the reference messages, plus the reference `/assets` HTTP routes. The service opens the library under the configured
 * root when the plugin starts and closes it when the plugin unloads. While the DSH web server (`webServer`) is
 * available, the service registers the `/assets` routes on it; other GET and HEAD requests under `/assets` serve the
 * DSH page shell's files, which the shell loads from `./assets/`.
 *
 * @module @dreamverse/assets-manager
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

import { assetsRouteHandler } from './asset-routes.ts'
import { AssetLibrary, type AssetRecord } from './library.ts'
import { uploadPolicy } from './media.ts'
import { shellFileResponder } from './shell-files.ts'

export { sendFile, type FileDelivery } from './file-response.ts'
export { AssetInUseError, AssetNotFoundError, type AssetRecord } from './library.ts'
export { MediaValidationError, UploadTooLargeError, type MediaType } from './media.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DreamVerse asset files, their SQLite index, upload validation, file retention, and project references. */
    dreamverseAssetsManager: DreamverseAssetsManager
  }
}

/** The library location. */
export interface Config {
  /** The reference `<state root>/assets` directory holding `files/<asset_id>` and `index.sqlite3`. */
  root: string
}

/** Loader validation; `root` is required. */
export const Config = z.object({
  root: z.string().required(),
})

/**
 * The `dreamverseAssetsManager` service: one `AssetLibrary` for the plugin's lifetime.
 *
 * `add` accepts HTTP uploads; `retain` and `release` bracket each accepted generation request and each content
 * response, and `delete` defers file removal until the last retention is released. `addProjectReferences` and
 * `removeProjectReferences` record which stored projects use which assets; `delete` refuses an asset in use.
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
   * List the published assets.
   * @returns every asset that is not deleted, most recently added first.
   */
  list(): AssetRecord[] {
    return this.library.list()
  }

  /**
   * Resolve one published asset; throws `AssetNotFoundError` when it is absent or deleted.
   * @param assetId - the asset ID.
   * @returns the asset record.
   */
  get(assetId: string): AssetRecord {
    return this.library.get(assetId)
  }

  /**
   * Resolve every ID, then protect the files from deletion until `release`; throws `AssetNotFoundError` for the first
   * unavailable ID without retaining any file.
   * @param assetIds - the asset IDs one request uses.
   * @returns the records in `assetIds` order.
   */
  retain(assetIds: readonly string[]): AssetRecord[] {
    return this.library.retain(assetIds)
  }

  /**
   * Release the IDs one `retain` call accepted and remove files whose deletion waited for them; throws `Error`
   * `Asset release must match an accepted retention.` without changing any count when an ID is released more often
   * than it is retained.
   * @param assetIds - the IDs to release.
   */
  release(assetIds: readonly string[]): void {
    this.library.release(assetIds)
  }

  /**
   * Hide an asset immediately and remove its file once no retention holds it; throws `AssetNotFoundError` when the
   * asset is absent or already deleted, and `AssetInUseError` when a stored project uses it.
   * @param assetId - the asset ID.
   */
  delete(assetId: string): void {
    this.library.delete(assetId)
  }

  /**
   * Record that a stored project uses assets; the record survives restarts until `removeProjectReferences`.
   * @param projectId - the project ID.
   * @param assetIds - the asset IDs that the project uses.
   */
  addProjectReferences(projectId: string, assetIds: readonly string[]): void {
    this.library.addProjectReferences(projectId, assetIds)
  }

  /**
   * Remove every asset reference of a project, when the project is deleted.
   * @param projectId - the project ID.
   */
  removeProjectReferences(projectId: string): void {
    this.library.removeProjectReferences(projectId)
  }

  /**
   * The upload rules that `GET /creation-capabilities` reports as `asset_upload`.
   * @returns a fresh copy of the reference `upload_policy_as_dict()` payload.
   */
  uploadPolicy(): Record<string, unknown> {
    return uploadPolicy()
  }
}
