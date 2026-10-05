/** Run the video harness package tests with source-level resolution of harness packages. */
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../vitest.shared.ts'

export default defineConfig({
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: ['../../tsconfig.base.json'] })],
  test: {
    include: ['*/tests/**/*.spec.{ts,tsx}'],
    testTimeout: 60_000,
  },
})
