/**
 * Mounting for the runtime specs and the walkthrough script: the real assets store, operation log, and runtime over a
 * temporary root, with the built-in tools and the placeholder generator.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import VhAssets from '@video-harness/assets'
import VhOpLog from '@video-harness/oplog'
import VhProject from '../src/index.ts'

/** The ffmpeg the fixtures use; the native build on this host, overridable for other machines. */
export const FFMPEG = process.env['VH_FFMPEG'] ?? '/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg'

/** One mounted runtime over a temporary root. */
export interface RuntimeFixture {
  context: Context
  project: VhProject
  assets: VhAssets
  log: VhOpLog
  root: string
  /** Write a small PNG-labelled file and return its path, for uploads. */
  writeImage(name: string, content?: string): string
  dispose(): Promise<void>
}

/**
 * Mount assets, log, and runtime in a fresh Cordis root.
 * @param options - `root` reuses an existing root (a restarted harness); `builtinTools` false mounts no tools.
 * @returns the fixture.
 */
export async function startRuntime(options: { root?: string; builtinTools?: boolean } = {}): Promise<RuntimeFixture> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'vh-runtime-'))
  const context = new Context()
  await context.plugin(VhAssets, { root: join(root, 'assets') }).await()
  await context.plugin(VhOpLog, { root: join(root, 'projects') }).await()
  const builtinTools = options.builtinTools ?? true
  await context.plugin(VhProject, { ffmpegPath: FFMPEG, builtinTools, gpuConcurrency: 1, cpuConcurrency: 4 }).await()
  return {
    context,
    project: context.vhProject,
    assets: context.vhAssets,
    log: context.vhOpLog,
    root,
    writeImage(name, content = name) {
      const path = join(root, name)
      writeFileSync(path, `PNG-FAKE:${content}`)
      return path
    },
    dispose: async () => {
      await context.fiber.dispose()
      if (options.root === undefined) rmSync(root, { recursive: true, force: true })
    },
  }
}
