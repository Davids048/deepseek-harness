/** Browser smoke lane of the video harness: boots the shipped profile with fake services and drives Chromium. */
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../vitest.shared.ts'

const packageDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: [fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url))] })],
  test: {
    execArgv: vitestExecArgv,
    include: [`${packageDir}tests/**/*.e2e.ts`],
    testTimeout: 180_000,
    hookTimeout: 150_000,
    fileParallelism: false,
  },
})
