/**
 * The Story bible component in a REAL composition: a test-only `cordis.yml` boots the DSH tool registry, `dvProject`,
 * `dvFfmpeg`, the asset pool and `dvStoryBible` through the Loader. The agent's `dv_bible_*` calls write versions,
 * `<id>@<version>` inputs resolve to the version's reference images, and an update makes the records that read the
 * previous version stale. The only fake is a test `shot.render` that stands for the generation backend.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import DvAssetPool from '@dv/asset-pool'
import DvFfmpeg from '@dv/ffmpeg'
import DvProject, { DraftConflictError, type AssetId, type OperationToolValue, type ProjectId, type RecordOrigin, type SessionId } from '@dv/project'
import { afterEach, describe, expect, it } from 'vitest'
import DvStoryBible, { type CharacterId } from '../src/index.ts'

/** The plugin classes the fixture rows resolve through `globalThis`, because Node imports the rows outside Vite. */
const PLUGINS = { SystemPrompt, ToolRuntime, DvProject, DvFfmpeg, DvAssetPool, DvStoryBible }

/** The six operations, in registration order. */
const OPERATIONS = [
  'bible.character_create', 'bible.character_update', 'bible.location_create', 'bible.location_update', 'bible.style_create',
  'bible.style_update',
]

/** A human edit on `main`, outside any chat session. */
const HUMAN: RecordOrigin = { actor: 'user', surface: 'canvas', session: null, turn: null, tool_call: null, intent: 'edit' }

interface Fixture {
  ctx: Context
  project: ProjectId
  /** Store bytes in the asset pool. */
  put(text: string): AssetId
  /** Run one tool as the agent of chat session `s1`, which is bound to `project`. */
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
}

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

/**
 * Boot the composition from a test-only `cordis.yml`, and register a test `shot.render` whose `reference` input takes
 * character, location and style versions.
 * @returns the fixture, with a project bound to chat session `s1`.
 */
async function start(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'dv-story-bible-'))
  const globals = globalThis as typeof globalThis & { __dvStoryBibleComposition?: typeof PLUGINS }
  globals.__dvStoryBibleComposition = PLUGINS
  const rows: string[] = []
  const row = (id: string, key: keyof typeof PLUGINS, config: string[]): void => {
    writeFileSync(join(dir, `${id}.mjs`), `export default globalThis.__dvStoryBibleComposition.${key}\n`)
    rows.push(`- id: ${id}`, `  name: ${pathToFileURL(join(dir, `${id}.mjs`)).href}`, ...config.length === 0 ? [] : ['  config:', ...config.map(line => `    ${line}`)])
  }
  row('system-prompt', 'SystemPrompt', [])
  row('tools', 'ToolRuntime', [])
  row('dv-project', 'DvProject', [`root: ${join(dir, 'projects')}`, `sessionRoot: ${join(dir, 'sessions')}`])
  row('dv-ffmpeg', 'DvFfmpeg', ['ffmpegPath: ffmpeg', 'ffprobePath: ffprobe'])
  row('dv-asset-pool', 'DvAssetPool', [`root: ${join(dir, 'assets')}`])
  row('dv-story-bible', 'DvStoryBible', [])
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
  ctx.dvProject.registerOperation({
    name: 'shot.render', component: 'shot', version: '1', description: 'Test render.', params: {},
    inputs: { reference: { type: 'image', many: true, bible: true, description: 'References.' } },
    outputs: [], deterministic: false, resource: 'none', confirm: 'never', summarize: () => 'rendered',
    execute: () => Promise.resolve({ outputs: [] }),
  })
  const project = (await ctx.dvProject.createProject('bible', HUMAN)).id
  ctx.dvProject.bindSession(brandString<SessionId>('s1'), project)
  let calls = 0
  return {
    ctx, project,
    put: text => ctx.dvAssetPool.importAsset(Buffer.from(text), { mime: 'image/png', name: `${text}.png` }, null),
    call(name, args) {
      calls += 1
      return ctx.tools.execute({ callId: ToolCallId(`call-${calls}`), name, arguments: args, signal: new AbortController().signal, agent: { id: 's1' } as never })
    },
  }
}

/** The value of a successful operation tool call. */
function value(result: ToolExecutionResult): OperationToolValue {
  if (result.isError) throw new Error(result.error.message)
  return result.value as OperationToolValue
}

/** The error message of a failed tool call. */
function failure(result: ToolExecutionResult): string {
  return result.isError ? result.error.message : ''
}

describe('dvStoryBible', () => {
  it('registers six operations with their dv_bible_* tools and the reducer, and removes them on disposal', async () => {
    const fixture = await start()
    const specs = fixture.ctx.dvProject.listOperations().filter(spec => spec.component === 'bible')
    expect(specs.map(spec => spec.name)).toEqual(OPERATIONS)
    for (const name of OPERATIONS) expect(fixture.ctx.tools.get(`dv_${name.replace('.', '_')}`)).toBeDefined()
    expect(fixture.ctx.dvProject.getState(fixture.project).components.bible).toEqual({ characters: {}, locations: {}, styles: {} })
    const entry = [...fixture.ctx.loader.entries()].find(candidate => candidate.options.name.endsWith('/dv-story-bible.mjs'))
    await entry?.fiber?.dispose()
    expect(fixture.ctx.dvProject.listOperations().filter(spec => spec.component === 'bible')).toEqual([])
    expect(fixture.ctx.tools.get('dv_bible_character_create')).toBeUndefined()
    expect(fixture.ctx.dvProject.getState(fixture.project).components).not.toHaveProperty('bible')
  })

  it('creates a character from the agent tool and resolves <id>@1 to its reference images', async () => {
    const fixture = await start()
    const face = fixture.put('face')
    const created = value(await fixture.call('dv_bible_character_create', {
      reason: 'register the lead', character: 'c1', name: 'Lead', description: 'red coat', inputs: { reference: [face] },
    }))
    expect(created).toMatchObject({ status: 'done', summary: 'character Lead created', outputs: [], params: { character: 'c1', name: 'Lead' } })
    const state = fixture.ctx.dvProject.getState(fixture.project, 'draft/s1')
    const record = state.components.proj.records.find(entry => entry.operation === 'bible.character_create')
    expect(record).toMatchObject({
      actor: 'agent', surface: 'chat', component: 'bible', params: { character: 'c1', name: 'Lead', description: 'red coat' },
      inputs: [{ role: 'reference', ref: { asset: face }, resolved_asset: face }], outputs: [], deterministic: false,
    })
    expect(state.components.bible.characters).toEqual({
      c1: [{ id: 'c1', version: 1, name: 'Lead', description: 'red coat', references: [face], created_by: record?.id }],
    })
    const ref = { character: brandString<CharacterId>('c1'), version: 1 }
    expect(fixture.ctx.dvProject.assetsOf(state, ref)).toEqual([face])
    expect(fixture.ctx.dvProject.parseInputs('shot.render', { reference: ['c1@1'] }, state)).toEqual([{ role: 'reference', ref }])
    value(await fixture.call('dv_shot_render', { reason: 'shoot', inputs: { reference: ['c1@1'] } }))
    const render = fixture.ctx.dvProject.getState(fixture.project, 'draft/s1').components.proj.records.at(-1)
    expect(render?.inputs).toEqual([{ role: 'reference', ref, resolved_asset: face }])
  })

  it('updates to the next version, keeps what the call leaves out, and marks what read the old version stale', async () => {
    const fixture = await start()
    const face = fixture.put('face')
    const coat = fixture.put('coat')
    value(await fixture.call('dv_bible_location_create', { reason: 'beach', location: 'l1', name: 'Beach', inputs: { reference: [face] } }))
    const render = value(await fixture.call('dv_shot_render', { reason: 'shoot', inputs: { reference: ['l1@1'] } }))
    const renamed = value(await fixture.call('dv_bible_location_update', { reason: 'rename', location: 'l1', name: 'Shore' }))
    expect(renamed.summary).toBe('location l1 updated')
    const restyled = value(await fixture.call('dv_bible_location_update', { reason: 'new reference image', location: 'l1', inputs: { reference: [coat] } }))
    const state = fixture.ctx.dvProject.getState(fixture.project, 'draft/s1')
    expect(state.components.bible.locations['l1' as never]?.map(version => [version.version, version.name, version.references]))
      .toEqual([[1, 'Beach', [face]], [2, 'Shore', [face]], [3, 'Shore', [coat]]])
    const records = state.components.proj.records
    const first = records.find(entry => entry.operation === 'bible.location_create')
    expect(records.find(entry => entry.id === renamed.record)?.supersedes).toEqual([first?.id])
    expect(records.find(entry => entry.id === restyled.record)?.supersedes).toEqual([renamed.record])
    expect(state.components.proj.stale).toEqual({ [render.record]: renamed.record })
  })

  it('refuses a used ID, an unknown ID, an ID with @, and invalid params', async () => {
    const fixture = await start()
    value(await fixture.call('dv_bible_style_create', { reason: 'film', style: 's1', name: 'Film' }))
    expect(failure(await fixture.call('dv_bible_character_create', { reason: 'clash', character: 's1', name: 'X' })))
      .toBe("The ID 's1' already names a style; update it, or choose another ID.")
    expect(failure(await fixture.call('dv_bible_character_update', { reason: 'unknown', character: 's1', name: 'X' })))
      .toBe("Unknown character 's1'.")
    expect(failure(await fixture.call('dv_bible_character_create', { reason: 'bad', character: 'c@1', name: 'X' })))
      .toBe("The character ID 'c@1' must be non-empty and contain no @ or #.")
    const before = fixture.ctx.dvProject.listHistory({ project: fixture.project }).length
    await expect(fixture.ctx.dvProject.run({
      ...HUMAN, project: fixture.project, operation: 'bible.character_create', params: { character: 'c1' }, inputs: [],
    })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(fixture.ctx.dvProject.listHistory({ project: fixture.project })).toHaveLength(before)
    const failed = fixture.ctx.dvProject.getState(fixture.project, 'draft/s1').components.proj.records
      .filter(record => record.status === 'failed').map(record => record.error?.code)
    expect(failed).toEqual(['operation_failed', 'operation_failed', 'operation_failed'])
    expect(Object.keys(fixture.ctx.dvProject.getState(fixture.project, 'draft/s1').components.bible.characters)).toEqual([])
  })

  it('stops accept replay when main created the same ID after the draft did', async () => {
    const fixture = await start()
    const lead = fixture.put('lead')
    value(await fixture.call('dv_bible_character_create', { reason: 'lead', character: 'c1', name: 'Lead', inputs: { reference: [lead] } }))
    await fixture.ctx.dvProject.run({
      ...HUMAN, project: fixture.project, operation: 'bible.location_create', params: { location: 'c1', name: 'Cave' }, inputs: [],
    })
    const session = { ...HUMAN, session: brandString<SessionId>('s1') }
    const accept = fixture.ctx.dvProject.acceptDraft(fixture.project, session)
    await expect(accept).rejects.toBeInstanceOf(DraftConflictError)
    await expect(accept).rejects.toThrow('main already has a location with the ID c1.')
  })
})
