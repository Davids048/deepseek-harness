/**
 * The members of the `dreamverseAssetsManager` file store that the project store and its routes call.
 *
 * @module @dreamverse/project-store/dependencies
 */
import type { AssetOwner, AssetRecord } from '@dreamverse/assets-manager'

/** The file store operations on a project's files. */
export interface ProjectFiles {
  /**
   * @param owner - the files' owner.
   * @returns the owner's files, newest first.
   */
  list(owner: AssetOwner): AssetRecord[]
  /**
   * Delete every file of an owner.
   * @param owner - the files' owner.
   */
  deleteOwnedBy(owner: AssetOwner): void
}
