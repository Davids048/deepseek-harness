/**
 * Run the e2e fake streaming_v2 backend as a long-lived process for manual and exploratory browser testing. Prints the
 * backend URL; renders clips into the directory given as the first argument.
 */
import { startFakeBackend } from './harness.ts'

const backend = await startFakeBackend(process.argv[2] ?? '.')
console.log(`fake backend ${backend.url}`)
