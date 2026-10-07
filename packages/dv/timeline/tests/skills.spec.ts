/**
 * The `timeline-editing` skill of the Timeline component in a REAL composition: a test-only `cordis.yml` boots the DSH
 * skill registry, the DSH tool registry, `dvProject`, the asset pool and `dvTimeline` through the Loader, and the agent
 * reads the skill through `ctx.skills` while `dvTimeline` is mounted.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import DvAssetPool from '@dv/asset-pool'
import DvFfmpeg from '@dv/ffmpeg'
import DvProject from '@dv/project'
import { afterEach, describe, expect, it } from 'vitest'
import DvTimeline from '../src/index.ts'

/** The plugin classes the fixture rows resolve through `globalThis`, because Node imports the rows outside Vite. */
const PLUGINS = { SkillRegistry, SystemPrompt, ToolRuntime, DvProject, DvFfmpeg, DvAssetPool, DvTimeline }

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

/**
 * Boot the composition from a test-only `cordis.yml`.
 * @param withSkills - whether the DSH skill registry is mounted.
 * @returns the root context.
 */
async function start(withSkills: boolean): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'dv-timeline-skills-'))
  const globals = globalThis as typeof globalThis & { __dvTimelineSkills?: typeof PLUGINS }
  globals.__dvTimelineSkills = PLUGINS
  const rows: string[] = []
  const row = (id: string, key: keyof typeof PLUGINS, config: string[]): void => {
    writeFileSync(join(dir, `${id}.mjs`), `export default globalThis.__dvTimelineSkills.${key}\n`)
    rows.push(`- id: ${id}`, `  name: ${pathToFileURL(join(dir, `${id}.mjs`)).href}`, ...config.length === 0 ? [] : ['  config:', ...config.map(line => `    ${line}`)])
  }
  if (withSkills) row('skills', 'SkillRegistry', [])
  row('system-prompt', 'SystemPrompt', [])
  row('tools', 'ToolRuntime', [])
  row('dv-project', 'DvProject', [`root: ${join(dir, 'projects')}`, `sessionRoot: ${join(dir, 'sessions')}`])
  row('dv-ffmpeg', 'DvFfmpeg', ['ffmpegPath: ffmpeg', 'ffprobePath: ffprobe'])
  row('dv-asset-pool', 'DvAssetPool', [`root: ${join(dir, 'assets')}`])
  row('dv-timeline', 'DvTimeline', [])
  writeFileSync(join(dir, 'cordis.yml'), `${rows.join('\n')}\n`)

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  return ctx
}

describe('dvTimeline timeline-editing skill', () => {
  it('registers the skill with the skill registry while dvTimeline is mounted, and removes it on disposal', async () => {
    const ctx = await start(true)
    const skill = await ctx.skills.get('timeline-editing')
    expect(skill).toMatchObject({ name: 'timeline-editing', source: 'runtime', invocation: { modelInvocable: true } })
    expect(skill?.whenToUse).toContain('existing shot or timeline')
    expect(skill?.content.startsWith('# Timeline editing\n')).toBe(true)
    expect(skill?.content).toContain('`dv_shot_render_ref2va` or `dv_shot_render_t2va`')
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name.endsWith('/dv-timeline.mjs'))
    await entry?.fiber?.dispose()
    expect(await ctx.skills.get('timeline-editing')).toBeUndefined()
  })

  it('mounts its operations without the skill registry', async () => {
    const ctx = await start(false)
    expect(ctx.get('skills')).toBeUndefined()
    expect(ctx.tools.get('dv_timeline_clip_trim')).toBeDefined()
  })
})
