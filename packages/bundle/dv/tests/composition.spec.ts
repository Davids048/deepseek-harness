/**
 * The REAL composition of the bundle: the component rows, the render mode provider rows, the `dv-chat-references` row
 * and the `dv-api` row of `cordis.patch.yml`, with their `!!js` configuration and `disabled` flags, boot through the
 * Loader beside the DSH system prompt and tool registry, with each render mode provider replaced by a fake, and a
 * model-visible tool call becomes a durable record.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import DvAssetPool from '@dv/asset-pool'
import DvDeliver from '@dv/deliver'
import DvFfmpeg from '@dv/ffmpeg'
import DvInspector from '@dv/inspector'
import DvProject, { type OperationToolValue, type ProjectId, type RecordId } from '@dv/project'
import DvShotPlan from '@dv/shot-plan'
import DvShotRender from '@dv/shot-render'
import DvStoryBible from '@dv/story-bible'
import DvTimeline from '@dv/timeline'
import DvApi from '@dv/api'
import DvChatReferences from '@dv/chat-references'
import { T2vaRenderer, type RenderModelFacts, type RenderStreamEvent } from '@dv/render-modes'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeRef2vaRenderer, FFMPEG, FFPROBE } from '../../../dv/api/tests/support.ts'

const disposers: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

/** A `t2va` provider that fails every call; the composition only checks whether its row mounts it. */
class FakeT2vaRenderer extends T2vaRenderer {
  model(): Promise<RenderModelFacts> {
    return Promise.reject(new Error('the composition test renders no t2va shot'))
  }

  ready(): Promise<{ ready: boolean; detail: string | null }> {
    return Promise.resolve({ ready: false, detail: 'composition test' })
  }

  render(): AsyncIterable<RenderStreamEvent> {
    throw new Error('the composition test renders no t2va shot')
  }
}

/**
 * The plugin of each package a bundle row names, resolved through `globalThis` because Node imports the rows outside
 * Vite. Each render mode provider row loads a fake provider of its render mode.
 */
const PLUGINS: Record<string, object> = {
  '@deepseek-ai/dsh-system-prompt': SystemPrompt, '@deepseek-ai/dsh-tools': ToolRuntime, '@dv/project': DvProject,
  '@dv/ffmpeg': DvFfmpeg, '@dv/asset-pool': DvAssetPool, '@dv/inspector': DvInspector, '@dv/story-bible': DvStoryBible,
  '@dv/shot-plan': DvShotPlan, '@dv/shot-render': DvShotRender, '@dv/timeline': DvTimeline, '@dv/deliver': DvDeliver,
  '@dv/api': DvApi, '@dv/chat-references': DvChatReferences,
  '@dv/fasth3-ref2va': FakeRef2vaRenderer, '@dv/fasth3-t2va': FakeT2vaRenderer,
}

/** One row of a Loader entry list. */
interface Row { id: string; name: string; config?: unknown; disabled?: unknown }

/**
 * The rows of the bundle patch that mount host plugins of DreamVerse, as the bundle writes them.
 * @returns the `dv-*` rows of the patch's first insert list, without the interface plugins.
 */
function bundleRows(): Row[] {
  const patch = yaml.load(readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8'), { schema: entryListSchema })
  const [first] = patch as Array<{ insert?: Row[] }>
  return (first?.insert ?? []).filter(row => row.id.startsWith('dv-') && !row.id.startsWith('dv-ui-'))
}

describe('DreamVerse bundle composition', () => {
  it('boots the bundle rows through the Loader and turns a model tool call into a durable record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dv-composition-'))
    disposers.push(() => { rmSync(dir, { recursive: true, force: true }) })
    // The environment the bundle's `!!js` configuration reads.
    vi.stubEnv('DV_STATE_ROOT', dir)
    vi.stubEnv('DV_FFMPEG', FFMPEG)
    vi.stubEnv('DV_FFPROBE', FFPROBE)
    // Without a t2va backend URL the `dv-fasth3-t2va` row stays disabled.
    vi.stubEnv('DV_T2VA_BACKEND_URL', '')
    disposers.push(() => { vi.unstubAllEnvs() })
    const globals = globalThis as typeof globalThis & { __dvComposition?: Record<string, object> }
    globals.__dvComposition = PLUGINS
    disposers.push(() => { delete globals.__dvComposition })
    const rows = bundleRows()
    expect(rows.map(row => row.id)).toEqual(expect.arrayContaining([
      'dv-fasth3-ref2va', 'dv-fasth3-t2va', 'dv-project', 'dv-shot-plan', 'dv-shot-render', 'dv-timeline', 'dv-chat-references', 'dv-api',
    ]))
    // Each row keeps its id and `!!js` config; its package name points at a module that re-exports the plugin class.
    const entries = [
      { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' }, { id: 'tools', name: '@deepseek-ai/dsh-tools' }, ...rows,
    ].map((row) => {
      const plugin = PLUGINS[row.name]
      if (plugin === undefined) throw new Error(`No plugin for bundle row ${row.id} (${row.name}).`)
      const file = join(dir, `${row.id}.mjs`)
      writeFileSync(file, `export default globalThis.__dvComposition[${JSON.stringify(row.name)}]\n`)
      return { ...row, name: pathToFileURL(file).href }
    })
    writeFileSync(join(dir, 'cordis.yml'), yaml.dump(entries, { schema: entryListSchema }))

    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
    await ctx.loader.await()
    disposers.push(async () => { await ctx.fiber.dispose() })

    expect(ctx.get('dvChatReferences')).toBeDefined()
    expect(ctx.get('dvApi')).toBeDefined()
    expect(ctx.get('dvProject')?.listOperations().map(spec => spec.name))
      .toEqual(expect.arrayContaining(['plan.create', 'shot.render_ref2va', 'timeline.create', 'timeline.update']))
    expect(ctx.get('tools')?.get('dv_shot_render_ref2va')).toBeDefined()
    // The disabled t2va row mounts no provider, so Shot render registers no t2va operation and the agent has no t2va tool.
    expect(ctx.get('dvT2va')).toBeUndefined()
    expect(ctx.get('tools')?.get('dv_shot_render_t2va')).toBeUndefined()
    const renderer = ctx.dvRef2va as FakeRef2vaRenderer

    const signal = new AbortController().signal
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await ctx.tools.execute({ callId: ToolCallId(`${name}-1`), name, arguments: args, signal })
      if (result.isError) throw new Error(result.error.message)
      return result
    }
    const created = await call('dv_proj_create', { title: 'composed' })
    const projectId = (created.value as { project_id: ProjectId }).project_id
    writeFileSync(join(dir, 'ref.png'), 'PNG-FAKE')
    await call('dv_asset_import', { reason: 'reference', path: join(dir, 'ref.png'), mime: 'image/png' })
    const reference = ctx.dvAssetPool.list().map(asset => asset.id)
    await call('dv_bible_character_create', { reason: 'lead', character: 'c1', name: 'Lead', inputs: { reference } })
    const shot = await call('dv_shot_render_ref2va', {
      reason: 'the opening shot', prompt: 'Picture 1 looks up', duration_sec: 1, inputs: { reference: 'c1@1' },
    })
    const shotValue = shot.value as OperationToolValue
    expect(shotValue.status).toBe('done')
    // Model-visible: the rendered text names the record and the asset URLs.
    const text = shot.content.find(block => block.type === 'text')
    expect(text?.type === 'text' ? text.text : '').toContain(`done ${shotValue.record}`)
    expect(text?.type === 'text' ? text.text : '').toContain('/dv/assets/')
    // Durable: the project's history holds the record with its outputs, and the asset pool holds the bytes.
    const record = ctx.dvProject.getRecord(projectId, shotValue.record as RecordId)
    expect(record).toMatchObject({ status: 'done', intent: 'the opening shot', operation: 'shot.render_ref2va', actor: 'agent' })
    expect(record.outputs).toHaveLength(2)
    const [video] = record.outputs
    expect(video !== undefined && ctx.dvAssetPool.has(video)).toBe(true)
    expect(renderer.requests).toHaveLength(1)
    await call('dv_timeline_create', { reason: 'lay out the shot', assets: [video] })
    const clips = ctx.dvProject.getState(projectId).components.timeline.timelines[0]?.clips
    expect(clips?.map(clip => [clip.id, clip.asset])).toEqual([['cl1', video]])
    expect(Object.keys(ctx.dvProject.getState(projectId).components.proj.created_by)).toHaveLength(3)
    // The bundle's `!!js` configuration put the project records under the state root the test set.
    expect(readFileSync(join(dir, 'projects', projectId, 'records.jsonl'), 'utf8')).toContain('shot.render_ref2va')
  })
})
