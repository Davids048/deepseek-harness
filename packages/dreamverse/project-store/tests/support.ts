/**
 * Fakes for the project-store specs: a file store that records `deleteOwnedBy` calls and lists the files that a spec
 * gives each owner, and a temporary store root.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { AssetOwner, AssetRecord } from '@dreamverse/assets-manager'
import type { ProjectFiles } from '../src/dependencies.ts'
import DreamverseProjectStore from '../src/index.ts'

/** File store whose files per owner the spec sets; `deleteOwnedBy` records the owner and drops its files. */
export class FakeFiles implements ProjectFiles {
  readonly deletedOwners: AssetOwner[] = []
  private readonly files = new Map<AssetOwner, AssetRecord[]>()

  /**
   * Store an image for an owner.
   * @param owner - the file's owner.
   * @param assetId - the file ID.
   * @returns the stored record.
   */
  addImage(owner: AssetOwner, assetId: string): AssetRecord {
    const record: AssetRecord = {
      assetId, owner, name: `${assetId}.png`, mediaType: 'image', mimeType: 'image/png', filePath: `/files/${assetId}`,
      sizeBytes: 3, width: 16, height: 9, durationSec: null, createdAt: '2026-10-02T00:00:00.000Z',
    }
    this.files.set(owner, [record, ...this.files.get(owner) ?? []])
    return record
  }

  list(owner: AssetOwner): AssetRecord[] {
    return [...this.files.get(owner) ?? []]
  }

  deleteOwnedBy(owner: AssetOwner): void {
    this.deletedOwners.push(owner)
    this.files.delete(owner)
  }
}

/** One mounted store over a temporary root. */
export interface StoreFixture {
  context: Context
  store: DreamverseProjectStore
  files: FakeFiles
  root: string
  /** Dispose the plugins and remove the root. */
  dispose(): Promise<void>
}

/**
 * Mount the project store over a fresh temporary root and a fake file store.
 * @returns the context, the service, the fake, and the root.
 */
export async function startStore(): Promise<StoreFixture> {
  const root = mkdtempSync(join(tmpdir(), 'dreamverse-project-store-'))
  const context = new Context()
  const files = new FakeFiles()
  context.provide('dreamverseAssetsManager', files)
  await context.plugin(DreamverseProjectStore, { root }).await()
  return {
    context,
    store: context.dreamverseProjectStore,
    files,
    root,
    dispose: async () => {
      await context.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
