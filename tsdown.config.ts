import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * The ordinary workspace build consumes JavaScript emitted by the Host
 * TypeScript project and runs Typert. The Client pass selects packages that
 * declare a browser bundle and lets their package-local configs emit both
 * their Node loader entry and browser artifact.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    workspace: {
      include: client
        ? ['vendor/*', 'packages/*/*', 'apps/cli']
        : ['vendor/*', 'packages/*/*', 'apps/cli', 'apps/desktop', 'apps/desktop-host'],
      exclude: [
        // tsdown's default exclusions.
        '**/node_modules/**', '**/dist/**', '**/test?(s)/**', '**/t?(e)mp/**',
        // DreamVerse packages load from source through the dsh launcher's tsx hook and have no build step.
        'packages/dreamverse/**', 'packages/bundle/dreamverse/**', 'packages/bundle/dreamverse-multiverse/**',
        // Video harness host packages load from source the same way; ui-kit is bundled into the two client plugins.
        // One pattern per package: the matcher does not expand braces.
        'packages/video-harness/oplog/**', 'packages/video-harness/runtime/**',
        'packages/dv/chat-references/**',
        'packages/dv/api/**', 'packages/dv/ui-kit/**', 'packages/video-harness/stream/**',
        'packages/bundle/dv/**',
        // The DreamVerse browser stories hold only tests and have no source to build.
        'packages/dv/e2e/**',
      ],
    },
    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
