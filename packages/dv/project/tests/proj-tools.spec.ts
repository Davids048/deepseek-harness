/**
 * Project's own `dv_proj_*` tools through the `dvProject` service with the real DSH tool registry: session binding,
 * the project summary with the reducers' `agentSummary` fields, history, undo and redo, forking a branch on a write
 * after an undo and on request, stale acceptance, reading another branch, and waiting for scheduled records.
 */
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import DvProject, {
  type AssetId, type OperationSpec, type OperationToolValue, type ProjectId, type RecordId, type SessionId,
} from '../src/index.ts'
import { MemoryAssets, tempRoot } from './support.ts'

declare module '@dv/project' {
  interface ComponentStates {
    /** The slice of the test reducer that adds a field to the project summary: the assets of finished records. */
    proj_tools_test?: { assets: AssetId[] }
  }
}

/** Every `dv_proj_*` tool. */
const PROJ_TOOLS = [
  'dv_proj_create', 'dv_proj_open', 'dv_proj_state', 'dv_proj_history_list', 'dv_proj_branch_create',
  'dv_proj_undo', 'dv_proj_redo', 'dv_proj_stale_accept', 'dv_proj_wait',
]

interface Fixture {
  context: Context
  project: DvProject
  assets: MemoryAssets
  /** The `dvProject` plugin's fiber. */
  fiber: { dispose(): Promise<unknown> }
  /** Run one tool as the agent of chat session `s1`. */
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
}

const contexts: Context[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
})

/**
 * Mount the DSH tool registry and `dvProject` with an in-memory asset store.
 * @returns the fixture.
 */
async function start(): Promise<Fixture> {
  const root = tempRoot()
  const context = new Context()
  contexts.push(context)
  await context.plugin(SystemPrompt, {}).await()
  await context.plugin(ToolRuntime).await()
  const fiber = context.plugin(DvProject, {
    root: join(root, 'projects'), sessionRoot: join(root, 'sessions'), cpuConcurrency: 4, gpuConcurrency: 1,
    confirmGpuSecondsThreshold: 60, promptSectionOrder: 4900,
  })
  await fiber.await()
  const assets = new MemoryAssets()
  context.dvProject.registerAssetStore(assets)
  let calls = 0
  return {
    context, project: context.dvProject, assets, fiber,
    call(name, args) {
      calls += 1
      return context.tools.execute({
        callId: ToolCallId(`call-${calls}`), name, arguments: args, signal: new AbortController().signal, agent: { id: 's1' } as never,
      })
    },
  }
}

/**
 * An operation that renders a still from its `prompt` param and an optional `reference` input.
 * @param overrides - the fields to change.
 * @returns the spec.
 */
function still(overrides: Partial<OperationSpec> = {}): OperationSpec {
  return {
    name: 'asset.grab_still', component: 'asset', version: '1', description: 'A test operation.', params: { prompt: { type: 'string' } },
    inputs: { reference: { type: 'image', description: 'A reference.' } }, outputs: [{ role: 'still', type: 'image' }],
    confirm: 'never', deterministic: false, resource: 'none', summarize: record => `made from ${String(record.params['prompt'])}`,
    execute: context => Promise.resolve({ outputs: [context.importAsset(Buffer.from(`still ${String(context.params['prompt'])}`), { mime: 'image/png', name: 'still.png' })] }),
    ...overrides,
  }
}

/** The JSON value of a successful `dv_proj_*` call. */
function json(result: ToolExecutionResult): Record<string, unknown> {
  if (result.isError) throw new Error(result.error.message)
  return result.value as Record<string, unknown>
}

/** The value of a successful operation tool call. */
function value(result: ToolExecutionResult): OperationToolValue {
  if (result.isError) throw new Error(result.error.message)
  return result.value as OperationToolValue
}

/** The error message of a failed call. */
function errorOf(result: ToolExecutionResult): string {
  return result.isError ? result.error.message : ''
}

describe('dv_proj_* tools', () => {
  it('registers every dv_proj_* tool while the registry is mounted and removes them with the service', async () => {
    const fixture = await start()
    for (const name of PROJ_TOOLS) expect(fixture.context.tools.get(name), name).toBeDefined()
    const state = await fixture.context.tools.get('dv_proj_state')?.output?.render?.({}, { project_id: 'p' })
    expect(state).toEqual([{ type: 'text', text: '{\n "project_id": "p"\n}' }])
    await fixture.fiber.dispose()
    for (const name of PROJ_TOOLS) expect(fixture.context.tools.get(name), name).toBeUndefined()
  })

  it('creates and opens this conversation\'s project, and keeps a bound conversation in its project', async () => {
    const fixture = await start()
    expect(errorOf(await fixture.call('dv_proj_state', {}))).toContain('No project selected: call dv_proj_create or dv_proj_open first')
    const created = json(await fixture.call('dv_proj_create', { title: 'dance' }))
    const projectId = brandString<ProjectId>(String(created['project_id']))
    expect(created).toEqual({
      record: created['head'], project_id: projectId, head: expect.any(String), branch: 'main', branches: [{ name: 'main', title: null }],
      records: 1,
      stale: [],
      recent: [expect.objectContaining({ operation: 'proj.create', status: 'done', summary: 'proj.create', intent: 'create project dance' })],
    })
    expect(fixture.project.sessionProject(brandString<SessionId>('s1'))).toBe(projectId)
    expect(fixture.project.listHistory({ project: projectId })[0]?.record).toMatchObject({ actor: 'agent', surface: 'chat', intent: 'create project dance' })
    expect(errorOf(await fixture.call('dv_proj_create', { title: 'other' }))).toContain(`This conversation belongs to project ${projectId}`)
    const origin = { actor: 'user' as const, surface: 'api' as const, session: null, turn: null, tool_call: null, intent: 'other' }
    const other = await fixture.project.createProject('other', origin)
    expect(errorOf(await fixture.call('dv_proj_open', { project_id: other.id }))).toContain('belongs to project')
    expect(json(await fixture.call('dv_proj_open', { project_id: projectId }))['project_id']).toBe(projectId)
    expect(json(await fixture.call('dv_proj_state', { project_id: other.id }))).toMatchObject({ project_id: other.id, records: 1 })
  })

  it('opens an existing project in an unbound conversation', async () => {
    const fixture = await start()
    const origin = { actor: 'user' as const, surface: 'api' as const, session: null, turn: null, tool_call: null, intent: 'create' }
    const info = await fixture.project.createProject('existing', origin)
    expect((await fixture.call('dv_proj_open', { project_id: 'missing' })).isError).toBe(true)
    expect(json(await fixture.call('dv_proj_open', { project_id: info.id }))).toMatchObject({ project_id: info.id, branch: 'main' })
    expect(fixture.project.sessionProject(brandString<SessionId>('s1'))).toBe(info.id)
  })

  it('adds each reducer\'s agentSummary fields between the record count and the stale records', async () => {
    const fixture = await start()
    fixture.project.registerOperation(still())
    fixture.project.registerReducer('proj_tools_test', {
      initial: () => ({ assets: [] }),
      reduce: (slice, record) => record.status === 'done' && record.operation === 'asset.grab_still'
        ? { assets: [...slice?.assets ?? [], ...record.outputs] } : slice,
      agentSummary: (slice, assets) => ({ stills: (slice?.assets ?? []).map(asset => assets.url(asset)) }),
    })
    const removeVersions = fixture.project.registerReducer('test_bible', {
      initial: () => ({ assets: {}, creators: {} }),
      reduce: slice => slice,
      agentSummary: slice => ({ versions: Object.keys(slice?.creators ?? {}).length }),
    })
    json(await fixture.call('dv_proj_create', { title: 'summary' }))
    const made = value(await fixture.call('dv_asset_grab_still', { reason: 'a still', prompt: 'kite' }))
    const state = json(await fixture.call('dv_proj_state', {}))
    expect(Object.keys(state)).toEqual(['project_id', 'head', 'branch', 'branches', 'records', 'stills', 'versions', 'stale', 'recent'])
    expect(state['stills']).toEqual([made.outputs[0]?.url])
    expect(state['versions']).toBe(0)
    removeVersions()
    // A field that Project or another component already uses refuses the summary.
    fixture.project.registerReducer('test_bible', { initial: () => ({ assets: {}, creators: {} }), reduce: slice => slice, agentSummary: () => ({ stale: 1 }) })
    expect(errorOf(await fixture.call('dv_proj_state', {}))).toContain('Two project summaries use the field stale')
  })

  it('lists recent records with their summaries, failures, outputs and history', async () => {
    const fixture = await start()
    const removeStill = fixture.project.registerOperation(still())
    fixture.project.registerOperation(still({ name: 'asset.import', execute: () => Promise.reject(new Error('no such file')) }))
    const projectId = brandString<ProjectId>(String(json(await fixture.call('dv_proj_create', { title: 'recent' }))['project_id']))
    const made = value(await fixture.call('dv_asset_grab_still', { reason: 'a still', prompt: 'kite' }))
    expect(errorOf(await fixture.call('dv_asset_import', { reason: 'bring it', prompt: 'x' }))).toContain('no such file')
    const state = json(await fixture.call('dv_proj_state', {}))
    expect(state).toMatchObject({ branch: 'main', branches: [{ name: 'main', title: null }] })
    expect(state['recent']).toEqual([
      expect.objectContaining({ operation: 'proj.create' }),
      {
        record: made.record, operation: 'asset.grab_still', status: 'done', intent: 'a still', summary: 'made from kite',
        outputs: [made.outputs[0]?.url], based_on: null, supersedes: [],
      },
      expect.objectContaining({ operation: 'asset.import', status: 'failed', summary: 'no such file', outputs: [] }),
    ])
    // A record whose operation is no longer registered is summarized by its operation name.
    removeStill()
    expect((json(await fixture.call('dv_proj_state', {}))['recent'] as Array<{ summary: string }>)[1]?.summary).toBe('asset.grab_still')
    expect(json(await fixture.call('dv_proj_history_list', { limit: 3 }))).toEqual([
      expect.objectContaining({ operation: 'asset.import', mark: 'current', status: 'failed', actor: 'agent', branches: ['main'] }),
      {
        record: made.record, mark: 'current', operation: 'asset.grab_still', status: 'done', actor: 'agent', intent: 'a still',
        branches: ['main'], outputs: [made.outputs[0]?.asset_id],
      },
      expect.objectContaining({ operation: 'proj.create', mark: 'current', actor: 'agent' }),
    ])
    expect(json(await fixture.call('dv_proj_history_list', { operation: 'asset.grab_still' }))).toHaveLength(1)
    expect(json(await fixture.call('dv_proj_history_list', { project_id: projectId }))).toHaveLength(3)
  })

  it('undoes and redoes, forks a branch on a write after an undo and on request, and accepts a stale record only when called', async () => {
    const fixture = await start()
    fixture.project.registerOperation(still())
    const projectId = brandString<ProjectId>(String(json(await fixture.call('dv_proj_create', { title: 'edits' }))['project_id']))
    value(await fixture.call('dv_asset_grab_still', { reason: 'first', prompt: 'one' }))
    expect(json(await fixture.call('dv_proj_state', {}))).toMatchObject({ branch: 'main', records: 2 })
    expect(json(await fixture.call('dv_proj_undo', {}))).toMatchObject({ branch: 'main', records: 2 })
    expect(json(await fixture.call('dv_proj_redo', {}))).toMatchObject({ branch: 'main', records: 3 })
    // `to` goes back to a record from the history; the project returns to its state just after it.
    const create = fixture.project.listHistory({ project: projectId, operation: 'proj.create' })[0]!.record.id
    expect(json(await fixture.call('dv_proj_undo', { to: create }))).toMatchObject({ branch: 'main', records: 2 })
    expect(fixture.project.listHistory({ project: projectId, operation: 'proj.undo' })[0]?.record).toMatchObject({
      params: { to: create }, intent: `go back to ${create}`,
    })
    // A write after the undo continues on a new branch; main keeps the undone step.
    const second = value(await fixture.call('dv_asset_grab_still', { reason: 'second', prompt: 'two' }))
    expect(json(await fixture.call('dv_proj_state', {}))).toMatchObject({
      branch: 'b2', records: 2, branches: [{ name: 'main', title: null }, { name: 'b2', title: null }],
    })
    expect(json(await fixture.call('dv_proj_state', { branch: 'main' }))).toMatchObject({ branch: 'main', records: 2 })
    expect(json(await fixture.call('dv_proj_branch_create', { title: 'night' }))).toMatchObject({
      branch: 'b3', records: 2, branches: [{ name: 'main', title: null }, { name: 'b2', title: null }, { name: 'b3', title: 'night' }],
    })
    // A consumer of a superseded output is stale until the agent accepts it.
    const consumer = value(await fixture.call('dv_asset_grab_still', { reason: 'from the second', prompt: 'three', inputs: { reference: `${second.record}#0` } }))
    value(await fixture.call('dv_asset_grab_still', { reason: 'retake', prompt: 'two again', supersedes: [second.record] }))
    expect(json(await fixture.call('dv_proj_state', {}))['stale']).toEqual([consumer.record])
    expect(json(await fixture.call('dv_proj_stale_accept', { record: consumer.record }))['stale']).toEqual([])
    expect(fixture.project.listHistory({ project: projectId, operation: 'proj.stale_accept' })[0]?.record.intent).toBe(`accept ${consumer.record}`)
  })

  it('names the record a write tool wrote in its summary and presentation metadata, and gives read tools no metadata', async () => {
    const fixture = await start()
    fixture.project.registerOperation(still())
    const created = json(await fixture.call('dv_proj_create', { title: 'meta' }))
    const projectId = brandString<ProjectId>(String(created['project_id']))
    const metaOf = (name: string, result: unknown): unknown =>
      fixture.context.tools.get(name)?.output?.presentationMeta?.({}, result as never)
    const newest = (operation: string): string | undefined => fixture.project.listHistory({ project: projectId, operation })[0]?.record.id
    expect(metaOf('dv_proj_create', created)).toEqual({ record: newest('proj.create') })
    value(await fixture.call('dv_asset_grab_still', { reason: 'first', prompt: 'one' }))
    const undone = json(await fixture.call('dv_proj_undo', {}))
    expect(undone['record']).toBe(newest('proj.undo'))
    expect(metaOf('dv_proj_undo', undone)).toEqual({ record: newest('proj.undo') })
    const state = json(await fixture.call('dv_proj_state', {}))
    expect(state['record']).toBeUndefined()
    for (const name of ['dv_proj_open', 'dv_proj_state', 'dv_proj_history_list', 'dv_proj_branch_create', 'dv_proj_wait']) {
      expect(fixture.context.tools.get(name)?.output?.presentationMeta, name).toBeUndefined()
    }
  })

  it('reads another branch than the current one', async () => {
    const fixture = await start()
    fixture.project.registerOperation(still())
    json(await fixture.call('dv_proj_create', { title: 'branches' }))
    json(await fixture.call('dv_proj_branch_create', {}))
    value(await fixture.call('dv_asset_grab_still', { reason: 'on the branch', prompt: 'alt' }))
    expect(json(await fixture.call('dv_proj_state', {}))).toMatchObject({ branch: 'b2', records: 2 })
    expect(json(await fixture.call('dv_proj_state', { branch: 'main' }))).toMatchObject({ branch: 'main', records: 1 })
    expect((await fixture.call('dv_proj_state', { branch: 'b9' })).isError).toBe(true)
  })

  it('waits for scheduled records and shows a pending record by its status', async () => {
    const fixture = await start()
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    fixture.project.registerOperation(still({ resource: 'gpu', execute: async (context) => {
      await held
      return { outputs: [context.importAsset(Buffer.from('slow'), { mime: 'image/png', name: 'slow.png' })] }
    } }))
    const projectId = brandString<ProjectId>(String(json(await fixture.call('dv_proj_create', { title: 'wait' }))['project_id']))
    const origin = { actor: 'user' as const, surface: 'api' as const, session: null, turn: null, tool_call: null, intent: 'slow' }
    const scheduled = await fixture.project.run({ ...origin, project: projectId, operation: 'asset.grab_still', params: { prompt: 's' }, inputs: [], after: [] })
    const pending = json(await fixture.call('dv_proj_state', { branch: 'main' }))['recent'] as Array<{ record: string; summary: string }>
    expect(pending.at(-1)?.record).toBe(scheduled.record?.id)
    expect(['pending', 'running']).toContain(pending.at(-1)?.summary)
    const waiting = fixture.call('dv_proj_wait', {})
    release()
    expect(json(await waiting)['branch']).toBe('main')
    expect(fixture.project.getRecord(projectId, brandString<RecordId>(String(scheduled.record?.id))).status).toBe('done')
  })
})
