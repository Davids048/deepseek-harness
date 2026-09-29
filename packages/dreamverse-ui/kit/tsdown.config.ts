/**
 * Build the DreamVerse UI kit: generate the Tailwind stylesheet for every dreamverse-ui package, then bundle the
 * browser half with the shared DSH client preset. The DSH preset compiles plain CSS but does not run Tailwind.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import tailwindcss from '@tailwindcss/postcss'
import postcss from 'postcss'
import { clientBundle } from '../../client/tsdown.client.ts'

const stylesDirectory = join(import.meta.dirname, 'src/client/styles')
const input = join(stylesDirectory, 'app.css')
const generated = await postcss([tailwindcss()]).process(await readFile(input, 'utf8'), { from: input })
await writeFile(join(stylesDirectory, 'app.generated.css'), generated.css)

export default clientBundle('@dreamverse/ui-kit', ['lib/types/index.js'])
