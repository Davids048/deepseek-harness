/**
 * The agent tools of operations and the chat session bindings, through the `dvProject` service with the real DSH tool
 * registry: one `dv_*` tool per registered operation, calls that run as the agent on the session's project and turn,
 * reads, held calls, and input parsing.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import DvProject, {
  formatInputRef, toolNameOf, type OperationSpec, type OperationToolValue, type ProjectId,
  type RecordId, type SessionId, type ToolCallCheck,
} from '../src/index.ts'
import { formatToolResult } from '../src/agent-tools.ts'
import { MemoryAssets, tempRoot, versionKey } from './support.ts'

/** An attachment service that accepts every image. */
class MemoryAttachments {
  readonly saved: Array<{ mediaType: string }> = []

  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }) {
    this.saved.push(input)
    return Promise.resolve({ attachmentId: `att-${this.saved.length}`, mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1 })
  }
}

interface Fixture {
  context: Context
  project: DvProject
  assets: MemoryAssets
  root: string
  /** Run one tool as the agent of chat session `session`. */
  call(name: string, args: Record<string, unknown>, session?: string): Promise<ToolExecutionResult>
}

const contexts: Context[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
})

/**
 * Mount the DSH tool registry and `dvProject` with an in-memory asset store.
 * @param root - the store root; a fresh one by default.
 * @param attachments - whether an attachment service is mounted.
 * @returns the fixture.
 */
async function start(root = tempRoot(), attachments = true): Promise<Fixture> {
  const context = new Context()
  contexts.push(context)
  if (attachments) context.provide('attachments', new MemoryAttachments())
  await context.plugin(SystemPrompt, {}).await()
  await context.plugin(ToolRuntime).await()
  await context.plugin(DvProject, { root: join(root, 'projects'), sessionRoot: join(root, 'sessions'), cpuConcurrency: 4, gpuConcurrency: 1 }).await()
  const assets = new MemoryAssets()
  context.dvProject.registerAssetStore(assets)
  let calls = 0
  return {
    context, project: context.dvProject, assets, root,
    call(name, args, session = 's1') {
      calls += 1
      const agent = { id: session }
      return context.tools.execute({ callId: ToolCallId(`call-${calls}`), name, arguments: args, signal: new AbortController().signal, agent: agent as never })
    },
  }
}

/**
 * An operation spec with test defaults: a `reference` input that accepts versions, an optional `prompt`.
 * @param overrides - the fields to set; `name` and `component` are required.
 * @returns the spec.
 */
function operation(overrides: Partial<OperationSpec> & Pick<OperationSpec, 'name' | 'component'>): OperationSpec {
  return {
    version: '1', description: 'A test operation.', params: { prompt: { type: 'string' } },
    inputs: { reference: { type: 'image', description: 'A reference.', many: true, bible: true } }, outputs: [{ role: 'still', type: 'image' }],
    confirm: 'never', deterministic: false, resource: 'none', summarize: record => `made from ${String(record.params['prompt'])}`,
    execute: context => Promise.resolve({ outputs: [context.importAsset(Buffer.from(`still ${String(context.params['prompt'])}`), { mime: 'image/png', name: 'still.png' })] }),
    ...overrides,
  }
}

/** The value of a successful operation tool call. */
function value(result: ToolExecutionResult): OperationToolValue {
  if (result.isError) throw new Error(result.error.message)
  return result.value as OperationToolValue
}

/** A project bound to chat session `s1`. */
async function boundProject(fixture: Fixture): Promise<ProjectId> {
  const origin = { actor: 'user' as const, surface: 'api' as const, session: null, turn: null, tool_call: null, intent: 'create' }
  const info = await fixture.project.createProject('demo', origin)
  fixture.project.bindSession(brandString<SessionId>('s1'), info.id)
  return info.id
}

describe('agent tools', () => {
  it('names each operation\'s tool, registers it while the registry is mounted, and removes it with the operation', async () => {
    expect(toolNameOf({ name: 'timeline.clip_move' })).toBe('dv_timeline_clip_move')
    const fixture = await start()
    const remove = fixture.project.registerOperation(operation({ name: 'asset.grab_still', component: 'asset' }))
    const schema = fixture.context.tools.schemas().find(tool => tool.name === 'dv_asset_grab_still')
    expect(schema?.description).toBe('A test operation.')
    expect(Object.keys((schema?.parameters as { properties: object }).properties).sort())
      .toEqual(['based_on', 'inputs', 'project_id', 'prompt', 'reason', 'supersedes'])
    // The description ends with the resource hint and, for a read or a deterministic operation, how calls reuse work.
    const removeRender = fixture.project.registerOperation(operation({
      name: 'shot.render', component: 'shot', resource: 'gpu', deterministic: true,
    }))
    const removeRead = fixture.project.registerOperation(operation({
      name: 'inspect.asset', component: 'inspect', resource: 'cpu', readOnly: true, outputs: [],
    }))
    const descriptionOf = (name: string): string | undefined => fixture.context.tools.schemas()
      .find(tool => tool.name === name)?.description
    expect(descriptionOf('dv_shot_render'))
      .toBe('A test operation. Uses the GPU. Repeating a call with the same inputs and params reuses the earlier result.')
    expect(descriptionOf('dv_inspect_asset')).toBe('A test operation. Runs on the CPU. A read that writes no record.')
    removeRender()
    removeRead()
    remove()
    expect(fixture.context.tools.get('dv_asset_grab_still')).toBeUndefined()
    expect(fixture.project.listOperations()).toEqual([])
  })

  it('runs a call as the agent on its conversation\'s project and turn, and describes the record with URLs and images', async () => {
    const fixture = await start()
    fixture.project.registerOperation(operation({ name: 'asset.grab_still', component: 'asset' }))
    const refused = await fixture.call('dv_asset_grab_still', { reason: 'no project yet', prompt: 'x' })
    expect(refused.isError && refused.error.message).toContain('No project selected')
    const projectId = await boundProject(fixture)
    const session = brandString<SessionId>('s1')
    fixture.project.noteTurn(session, 1, '')
    fixture.project.noteTurn(session, 1, 'grab a still of the kite')
    const turn = fixture.project.sessionTurn(session)
    const result = await fixture.call('dv_asset_grab_still', { reason: 'the kite', prompt: 'kite' })
    const grabbed = value(result)
    const record = fixture.project.getRecord(projectId, brandString<RecordId>(grabbed.record))
    expect(record).toMatchObject({
      actor: 'agent', surface: 'chat', session: 's1', turn, tool_call: 'call-2', intent: 'the kite', params: { prompt: 'kite' }, branch: 'draft/s1',
    })
    expect(grabbed).toMatchObject({
      status: 'done', summary: 'made from kite', scheduled: [], params: { prompt: 'kite' },
      outputs: [{ role: 'still', mime: 'image/png', url: `https://assets.example/${record.outputs[0]}` }],
    })
    expect(grabbed.images).toHaveLength(1)
    expect(result.content.filter(block => block.type === 'image')).toHaveLength(1)
    expect(result.meta).toMatchObject({ record: grabbed.record, tool: 'asset.grab_still', status: 'done' })
    const requests = fixture.project.listHistory({ project: projectId, kind: 'request' })
    expect(requests.map(entry => entry.record.intent)).toEqual(['grab a still of the kite'])
    // An empty reason falls back to the operation name; based_on and supersedes reach the record.
    const again = value(await fixture.call('dv_asset_grab_still', { reason: '', prompt: 'kite 2', based_on: grabbed.record, supersedes: [grabbed.record] }))
    expect(fixture.project.getRecord(projectId, brandString<RecordId>(again.record)))
      .toMatchObject({ intent: 'asset.grab_still', based_on: grabbed.record, supersedes: [grabbed.record] })
    // A failed record is a tool error with the failure message.
    fixture.project.registerOperation(operation({ name: 'shot.render', component: 'shot', execute: () => Promise.reject(new Error('out of memory')) }))
    const failed = await fixture.call('dv_shot_render', { reason: 'render', prompt: 'x' })
    expect(failed.isError && failed.error.message).toBe('out of memory')
  })

  it('answers a read with its report and writes nothing; lists outputs without images when no attachment service is mounted', async () => {
    const fixture = await start(tempRoot(), false)
    const projectId = await boundProject(fixture)
    fixture.project.registerOperation(operation({
      name: 'inspect.asset', component: 'inspect', readOnly: true, outputs: [],
      execute: context => Promise.resolve({ outputs: [], report: { prompt: context.params['prompt'] } }),
    }))
    const before = fixture.project.listHistory({ project: projectId }).length
    const read = await fixture.call('dv_inspect_asset', { reason: 'look', prompt: 'p' })
    expect(value(read)).toMatchObject({ record: '', status: 'done', summary: 'dv_inspect_asset answered', report: { prompt: 'p' } })
    const text = read.content.find(block => block.type === 'text')
    expect(text?.type === 'text' ? text.text : '').toBe('done: dv_inspect_asset answered\nparams: {"prompt":"p"}\nreport: {"prompt":"p"}')
    expect(Object.keys((fixture.context.tools.schemas().find(tool => tool.name === 'dv_inspect_asset')?.parameters as { properties: object }).properties))
      .not.toContain('supersedes')
    expect(fixture.project.listHistory({ project: projectId })).toHaveLength(before)
    fixture.project.registerOperation(operation({ name: 'asset.grab_still', component: 'asset' }))
    expect(value(await fixture.call('dv_asset_grab_still', { reason: 'still', prompt: 'q' })).images).toBeUndefined()
  })

  it('lets an operation prepare its call, keeps tool-only arguments out of params, and schedules behind unfinished producers', async () => {
    const fixture = await start()
    const projectId = await boundProject(fixture)
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    fixture.project.registerOperation(operation({
      name: 'shot.render', component: 'shot', execute: async (context) => {
        await held
        return { outputs: [context.importAsset(Buffer.from('take'), { mime: 'video/mp4', name: 'take.mp4' })] }
      },
    }))
    fixture.project.registerOperation(operation({
      name: 'asset.grab_still', component: 'asset',
      toolParams: { from_take: { type: 'string', description: 'A take record.' } },
      prepareToolCall: (call) => {
        const from = call.args['from_take']
        if (typeof from === 'string') call.request.inputs.push({ role: 'reference', ref: { record: brandString<RecordId>(from), output: 0 } })
        return Promise.resolve()
      },
    }))
    const rendering = fixture.call('dv_shot_render', { reason: 'take', prompt: 'r' })
    await new Promise(resolve => setTimeout(resolve, 30))
    const take = fixture.project.listHistory({ project: projectId, operation: 'shot.render' })[0]?.record.id as RecordId
    const still = value(await fixture.call('dv_asset_grab_still', { reason: 'still of the take', prompt: 's', from_take: take }))
    expect(still).toMatchObject({ status: 'pending', summary: 'dv_asset_grab_still pending', outputs: [], params: { prompt: 's' } })
    expect(fixture.project.getRecord(projectId, brandString<RecordId>(still.record)).inputs)
      .toEqual([{ role: 'reference', ref: { record: take, output: 0 }, resolved_asset: null }])
    release()
    await rendering
    await fixture.project.wait(projectId)
    expect(fixture.project.getRecord(projectId, brandString<RecordId>(still.record)).status).toBe('done')
  })

  it('adds the tool call check\'s arguments to every tool, and stops a call the check refuses before any record', async () => {
    const fixture = await start()
    const projectId = await boundProject(fixture)
    fixture.project.registerOperation(operation({ name: 'shot.render', component: 'shot' }))
    const seen: Array<Record<string, unknown>> = []
    const remove = fixture.project.registerToolCallCheck({
      params: spec => spec.name === 'shot.render' ? { user_requested: { type: 'boolean' } } : {},
      check: (spec, call) => {
        seen.push(call.args)
        if (call.args['user_requested'] !== true) return Promise.reject(new Error(`${spec.name} needs the user's agreement`))
        call.request.params['user_requested'] = true
        return Promise.resolve()
      },
    })
    const properties = () => Object.keys((fixture.context.tools.schemas().find(tool => tool.name === 'dv_shot_render')?.parameters as { properties: object }).properties)
    expect(properties()).toContain('user_requested')
    const before = fixture.project.listHistory({ project: projectId }).length
    const refused = await fixture.call('dv_shot_render', { reason: 'render', prompt: 'x' })
    expect(refused.isError && refused.error.message).toBe('shot.render needs the user\'s agreement')
    expect(fixture.project.listHistory({ project: projectId })).toHaveLength(before)
    const agreed = value(await fixture.call('dv_shot_render', { reason: 'render', prompt: 'x', user_requested: true }))
    expect(agreed.params).toEqual({ prompt: 'x', user_requested: true })
    expect(seen).toHaveLength(2)
    remove()
    expect(properties()).not.toContain('user_requested')
  })

  it('keeps every operation tool when the fiber that registered the tool call check unloads', async () => {
    const fixture = await start()
    fixture.project.registerOperation(operation({ name: 'shot.render', component: 'shot' }))
    fixture.project.registerOperation(operation({ name: 'asset.grab_still', component: 'asset' }))
    const check: ToolCallCheck = { params: () => ({ user_requested: { type: 'boolean' } }), check: () => Promise.resolve() }
    const checker = fixture.context.plugin({
      name: 'test-check', inject: ['dvProject'],
      apply: (ctx: Context) => { ctx.effect(() => ctx.dvProject.registerToolCallCheck(check), 'test check') },
    })
    await checker.await()
    const properties = (name: string) => {
      const schema = fixture.context.tools.schemas().find(tool => tool.name === name)
      return Object.keys((schema?.parameters as { properties?: object } | undefined)?.properties ?? {})
    }
    expect(properties('dv_shot_render')).toContain('user_requested')
    await checker.dispose()
    for (const name of ['dv_shot_render', 'dv_asset_grab_still']) {
      expect(fixture.context.tools.get(name), name).toBeDefined()
      expect(properties(name), name).not.toContain('user_requested')
    }
  })

  it('holds a session\'s calls until its held work settles, even when that work fails', async () => {
    const fixture = await start()
    await boundProject(fixture)
    fixture.project.registerOperation(operation({ name: 'asset.grab_still', component: 'asset' }))
    const order: string[] = []
    let finish = (): void => {}
    const work = new Promise<void>((_resolve, reject) => { finish = () => { order.push('work'); reject(new Error('import failed')) } })
    fixture.project.holdToolCalls(brandString<SessionId>('s1'), work)
    const call = fixture.call('dv_asset_grab_still', { reason: 'after the import', prompt: 'a' }).then((result) => { order.push('call'); return result })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(order).toEqual([])
    finish()
    expect(value(await call).status).toBe('done')
    expect(order).toEqual(['work', 'call'])
  })

  it('parses input references: assets, record outputs, and character, location or style versions', async () => {
    const fixture = await start()
    const projectId = await boundProject(fixture)
    fixture.project.registerOperation(operation({ name: 'shot.render', component: 'shot', inputs: {
      first_frame: { type: 'image', description: 'A frame.', required: true }, reference: { type: 'image', description: 'refs', many: true, bible: true },
    } }))
    fixture.project.registerOperation(operation({ name: 'plan.create', component: 'plan', inputs: {} }))
    const creators: Record<string, RecordId> = { 'location:l1@2': brandString<RecordId>('r-location') }
    fixture.project.registerReducer('test_bible', {
      initial: () => ({ assets: {}, creators }),
      reduce: slice => slice,
      createdBy: (slice, ref) => slice?.creators[versionKey(ref) ?? ''] ?? null,
    })
    const state = fixture.project.getState(projectId)
    const parse = (name: string, raw: unknown) => fixture.project.parseInputs(name, raw, state)
    expect(parse('shot.render', { first_frame: 'r1#1', reference: ['a1', 'l1@2'] })).toEqual([
      { role: 'first_frame', ref: { record: 'r1', output: 1 } }, { role: 'reference', ref: { asset: 'a1' } },
      { role: 'reference', ref: { location: 'l1', version: 2 } },
    ])
    expect(() => parse('shot.render', { first_frame: 'a', reference: 'nobody@1' })).toThrow("Unknown character, location, or style version 'nobody@1'")
    expect(() => parse('shot.render', undefined)).toThrow('needs input "first_frame"')
    expect(() => parse('shot.render', 'a')).toThrow('must be an object')
    expect(() => parse('shot.render', ['a'])).toThrow('must be an object')
    expect(() => parse('shot.render', { first_frame: ['a', 'b'] })).toThrow('takes one reference')
    expect(() => parse('shot.render', { first_frame: 1 })).toThrow('must be <asset>, <record>#<output>, or <id>@<version>')
    expect(() => parse('shot.render', { first_frame: 'a', other: 'b' })).toThrow('Unknown input role "other"')
    expect(() => parse('plan.create', { first_frame: 'a' })).toThrow('roles: none')
    expect(() => parse('no.such', {})).toThrow(expect.objectContaining({ code: 'unknown_operation' }))
    // formatInputRef writes each reference form as the text parseInputs reads back.
    const inputs = parse('shot.render', { first_frame: 'r1#1', reference: ['a1', 'l1@2'] })
    const texts = inputs.map(input => formatInputRef(input.ref))
    expect(texts).toEqual(['r1#1', 'a1', 'l1@2'])
    expect(parse('shot.render', { first_frame: texts[0], reference: texts.slice(1) })).toEqual(inputs)
  })
})

describe('session bindings and the asset store', () => {
  it('keeps a session\'s project across a restart and refuses a broken binding file', async () => {
    const root = tempRoot()
    const first = await start(root)
    const projectId = await boundProject(first)
    await first.context.fiber.dispose()
    contexts.splice(0)
    const second = await start(root)
    expect(second.project.sessionProject(brandString<SessionId>('s1'))).toBe(projectId)
    expect(second.project.sessionProject(brandString<SessionId>('s2'))).toBeNull()
    expect(second.project.sessionTurn(brandString<SessionId>('s1'))).toBeNull()
    writeFileSync(join(root, 'sessions', 's3.json'), '{"project":null}')
    expect(second.project.sessionProject(brandString<SessionId>('s3'))).toBeNull()
    writeFileSync(join(root, 'sessions', 's4.json'), '"text"')
    expect(() => second.project.sessionProject(brandString<SessionId>('s4'))).toThrow('is not a session binding')
  })

  it('fails a run that needs the asset pool while no asset store is registered', async () => {
    const fixture = await start()
    const projectId = await boundProject(fixture)
    // A later registration replaces the store; its disposer leaves no store behind.
    const removeOther = fixture.project.registerAssetStore(new MemoryAssets())
    removeOther()
    fixture.project.registerOperation(operation({ name: 'asset.grab_still', component: 'asset' }))
    const origin = { actor: 'user' as const, surface: 'api' as const, session: null, turn: null, tool_call: null, intent: 'still' }
    const result = await fixture.project.run({ ...origin, project: projectId, operation: 'asset.grab_still', params: { prompt: 'z' }, inputs: [] })
    expect(result.record).toMatchObject({ status: 'failed', error: { message: 'No asset store is registered with dvProject; mount the asset pool.' } })
  })

  it('formats a result as text plus image blocks', () => {
    const base: OperationToolValue = {
      record: 'r1', status: 'done', summary: 'did it', outputs: [{ role: 'video', asset_id: 'a1', mime: 'video/mp4', url: '/a1' }], scheduled: ['r2'],
      params: { seed: 1 },
    }
    expect(formatToolResult(base)).toEqual([{ type: 'text', text: 'done r1: did it\n- video: a1 (video/mp4) /a1\nscheduled: r2\nparams: {"seed":1}' }])
    const withImages = formatToolResult({ ...base, scheduled: [], images: [{ attachmentId: 'att', mediaType: 'image/png' }, 'junk', null, ['x'], { attachmentId: 3 }] })
    expect(withImages).toHaveLength(2)
    expect(withImages[1]).toMatchObject({ type: 'image', attachment: { attachmentId: 'att' } })
  })
})
