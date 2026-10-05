/**
 * The REAL composition: a test-only `cordis.yml` boots the five harness plugins plus the DSH tool registry through
 * the Loader, with the generation backend as the one fake, and a model-visible tool call becomes a durable record.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import VhAssets from '@video-harness/assets'
import VhMedia from '@video-harness/media'
import VhOpLog from '@video-harness/oplog'
import VhProject from '@video-harness/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import VhTools, { type ToolCallValue } from '../src/index.ts'
import { FakeGeneration, FFMPEG, FFPROBE } from './support.ts'

const disposers: Array<() => Promise<void>> = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The plugin classes the fixture rows resolve through `globalThis`, because Node imports the rows outside Vite. */
const PLUGINS = { SystemPrompt, ToolRuntime, VhAssets, VhOpLog, VhMedia, VhProject, VhTools }

describe('video harness composition', () => {
  it('boots from cordis.yml through the Loader and turns a model tool call into a durable record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vh-composition-'))
    tempDirs.push(dir)
    const globals = globalThis as typeof globalThis & { __vhComposition?: typeof PLUGINS }
    globals.__vhComposition = PLUGINS
    const rows: string[] = []
    const row = (id: string, key: keyof typeof PLUGINS, config: string[]): void => {
      writeFileSync(join(dir, `${id}.mjs`), `export default globalThis.__vhComposition.${key}\n`)
      rows.push(`- id: ${id}`, `  name: ${pathToFileURL(join(dir, `${id}.mjs`)).href}`, ...config.length === 0 ? [] : ['  config:', ...config.map(line => `    ${line}`)])
    }
    row('system-prompt', 'SystemPrompt', [])
    row('tools', 'ToolRuntime', [])
    row('vh-assets', 'VhAssets', [`root: ${join(dir, 'assets')}`])
    row('vh-oplog', 'VhOpLog', [`root: ${join(dir, 'projects')}`])
    row('vh-media', 'VhMedia', [`ffmpegPath: ${FFMPEG}`, `ffprobePath: ${FFPROBE}`])
    row('vh-runtime', 'VhProject', [`ffmpegPath: ${FFMPEG}`, 'builtinTools: false'])
    row('vh-tools', 'VhTools', [`sessionStateRoot: ${join(dir, 'sessions')}`])
    writeFileSync(join(dir, 'cordis.yml'), `${rows.join('\n')}\n`)

    const ctx = new Context()
    const generation = new FakeGeneration()
    ctx.provide('dreamverseGeneration', generation)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
    await ctx.loader.await()
    disposers.push(async () => { await ctx.fiber.dispose() })

    const tools = ctx.get('vhTools')
    expect(tools).toBeDefined()
    expect(tools?.get('generate.video')?.version).toBe('dreamverse-1')
    expect(ctx.get('vhProject')?.toolNames()).toContain('generate.video')
    const registry = ctx.get('tools')
    expect(registry?.get('vh_generate_video')).toBeDefined()

    const signal = new AbortController().signal
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await ctx.tools.execute({ callId: ToolCallId(`${name}-1`), name, arguments: args, signal })
      if (result.isError) throw new Error(result.error.message)
      return result
    }
    const created = await call('vh_project_create', { title: 'composed' })
    const projectId = (created.value as { project_id: string }).project_id
    writeFileSync(join(dir, 'ref.png'), 'PNG-FAKE')
    await call('vh_asset_upload', { reason: 'reference', path: join(dir, 'ref.png'), mime: 'image/png' })
    const refs = ctx.vhAssets.list().map(asset => asset.id)
    await call('vh_entity_character_create', { reason: 'lead', entity: 'c1', name: 'Lead', refs })
    const shot = await call('vh_generate_video', { reason: 'the opening shot', prompt: 'Picture 1 looks up', duration_sec: 1, inputs: { reference: 'c1@1' } })
    const shotValue = shot.value as ToolCallValue
    expect(shotValue.status).toBe('done')
    // Model-visible: the rendered text names the record and the asset URLs.
    const text = shot.content.find(block => block.type === 'text')
    expect(text?.type === 'text' ? text.text : '').toContain(`done ${shotValue.op_id}`)
    expect(text?.type === 'text' ? text.text : '').toContain('/vh/assets/')
    // Durable: the log holds the record with its outputs, and the store holds the bytes.
    const record = ctx.vhOpLog.get(projectId as never, shotValue.op_id as never)
    expect(record).toMatchObject({ status: 'done', intent: 'the opening shot', tool: { name: 'generate.video', version: 'dreamverse-1' } })
    expect(record.outputs).toHaveLength(2)
    expect(ctx.vhAssets.has(record.outputs[0] as never)).toBe(true)
    expect(generation.requests).toHaveLength(1)
    await call('vh_turn_accept', {})
    expect(ctx.vhProject.fold(projectId as never).assets.size).toBe(3)
  })
})
