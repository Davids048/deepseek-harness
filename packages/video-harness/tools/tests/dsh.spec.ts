import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { AssetId, ProjectId, RecordId, SessionId } from '@dv/project'
import { afterEach, describe, expect, it } from 'vitest'
import { assetUrl, dshToolName, parseInputs, renderValue, sessionKey, type ConfirmRequest, type ToolCallValue, type ToolSpec } from '../src/index.ts'
import { resultText, startTools, type ToolsFixture } from './support.ts'

const fixtures: ToolsFixture[] = []

async function start(options: Parameters<typeof startTools>[0] = {}): Promise<ToolsFixture> {
  const fixture = await startTools(options)
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

/** The value of a successful structured tool call. */
function value(result: ToolExecutionResult): ToolCallValue {
  if (result.isError) throw new Error(`tool failed: ${result.error.message}`)
  return result.value as ToolCallValue
}

/** The JSON value of a successful registry tool call. */
function json(result: ToolExecutionResult): Record<string, unknown> {
  if (result.isError) throw new Error(`tool failed: ${result.error.message}`)
  return result.value as Record<string, unknown>
}

/** The draft branch of calls without an agent. */
const ANONYMOUS_DRAFT = `draft/${sessionKey(undefined)}`

/** A session project with an imported reference and character c1@1. */
async function sessionProject(fixture: ToolsFixture) {
  const created = json(await fixture.call('dv_proj_create', { title: 'dance' }))
  const projectId = brandString<ProjectId>(created['project_id'] as string)
  const imported = value(await fixture.call('vh_asset_upload', { reason: 'bring the reference', path: fixture.writeFile('face.png'), mime: 'image/png' }))
  const image = imported.outputs[0]?.asset_id as string
  value(await fixture.call('vh_entity_character_create', { reason: 'register the lead', entity: 'c1', name: 'Lead', refs: [image] }))
  return { projectId, image, imported }
}

/** A record of the fixture's project by ID. */
function record(fixture: ToolsFixture, projectId: ProjectId, id: string) {
  return fixture.project.getRecord(projectId, brandString<RecordId>(id))
}

/** A spec with the given inputs and no effect. */
function plainSpec(name: string, inputs: ToolSpec['inputs']): ToolSpec {
  return {
    name, component: 'inspect', version: '1', summary: name, params: {}, inputs, inputRoles: Object.keys(inputs), outputs: [], deterministic: false,
    resource: 'none', confirm: 'never', summarize: () => `${name} done`, execute: () => Promise.resolve({ outputs: [] }),
  }
}

describe('DSH tools', () => {
  it('names tools and parses input references against the state', async () => {
    expect(dshToolName('entity.character.create')).toBe('vh_entity_character_create')
    expect(assetUrl(brandString<AssetId>('abc'))).toBe('/vh/assets/abc/content')
    expect(sessionKey(undefined)).toBe('anonymous')
    expect(sessionKey({ id: 's1' })).toBe('s1')
    const fixture = await start()
    const { projectId } = await sessionProject(fixture)
    const state = fixture.project.getState(projectId, ANONYMOUS_DRAFT)
    const spec = plainSpec('t', { clip: { type: 'video', required: true, description: '' }, extra: { type: 'image', many: true, description: '' } })
    expect(parseInputs(spec, { clip: 'a', extra: ['r1#1', 'c1@1'] }, state)).toEqual([
      { role: 'clip', ref: { asset: 'a' } }, { role: 'extra', ref: { record: 'r1', output: 1 } }, { role: 'extra', ref: { character: 'c1', version: 1 } },
    ])
    expect(() => parseInputs(spec, { clip: 'nobody@1' }, state)).toThrow("Unknown character, location, or style version 'nobody@1'")
    expect(() => parseInputs(spec, undefined, state)).toThrow('needs input "clip"')
    expect(() => parseInputs(spec, 'a', state)).toThrow('must be an object')
    expect(() => parseInputs(spec, ['a'], state)).toThrow('must be an object')
    expect(() => parseInputs(spec, { clip: ['a', 'b'] }, state)).toThrow('takes one reference')
    expect(() => parseInputs(spec, { clip: 1 }, state)).toThrow('must be an asset ID')
    expect(() => parseInputs(spec, { clip: 'a', other: 'b' }, state)).toThrow('Unknown input role "other"')
    expect(() => parseInputs({ ...spec, inputs: {} }, { clip: 'a' }, state)).toThrow('roles: none')
  })

  it('renders a result as text plus image blocks', () => {
    const base: ToolCallValue = { op_id: 'r1', status: 'done', summary: 'did it', outputs: [{ role: 'video', asset_id: 'a1', mime: 'video/mp4', url: '/vh/assets/a1/content' }], scheduled: ['r2'], params: { seed: 1 } }
    expect(renderValue(base)).toEqual([{ type: 'text', text: 'done r1: did it\n- video: a1 (video/mp4) /vh/assets/a1/content\nscheduled: r2\nparams: {"seed":1}' }])
    const withImages = renderValue({ ...base, scheduled: [], images: [{ attachmentId: 'att', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }, 'junk', null, ['x'], { attachmentId: 3 }] })
    expect(withImages).toHaveLength(2)
    expect(withImages[1]).toMatchObject({ type: 'image', attachment: { attachmentId: 'att' } })
    expect((withImages[0] as { text: string }).text).not.toContain('scheduled')
    // A read writes no record, so its line names no record.
    expect(renderValue({ ...base, op_id: '', outputs: [], scheduled: [] })[0]).toMatchObject({ text: 'done: did it\nparams: {"seed":1}' })
  })

  it('exposes every spec and the registry tools, and removes them on disposal', async () => {
    const fixture = await start()
    const names = fixture.tools.list().map(spec => dshToolName(spec.name))
    const registry = ['dv_proj_create', 'dv_proj_open', 'dv_proj_state', 'dv_proj_history_list', 'dv_proj_draft_accept', 'dv_proj_draft_discard', 'dv_proj_undo', 'dv_proj_redo', 'dv_proj_stale_accept', 'dv_proj_branch_create', 'dv_proj_branch_switch', 'dv_proj_wait']
    for (const name of [...names, ...registry]) expect(fixture.context.tools.get(name), name).toBeDefined()
    // The export-only trim is an operation without an agent tool.
    expect(names).not.toContain('vh_clip_trim')
    expect(fixture.project.listOperations().map(spec => spec.name)).toContain('clip.trim')
    const schema = fixture.context.tools.schemas().find(tool => tool.name === 'vh_generate_video')
    expect(schema?.description).toContain('Cost: gpu')
    expect(schema?.description).toContain('ask the user')
    expect(JSON.stringify(schema?.parameters)).toContain('continue_from')
    expect(fixture.context.tools.schemas().find(tool => tool.name === 'vh_media_probe')?.description).toContain('deterministic')
    expect(JSON.stringify(fixture.context.tools.schemas().find(tool => tool.name === 'vh_plan_approve')?.parameters)).not.toContain('"inputs"')
    await fixture.toolsFiber.dispose()
    expect(fixture.context.tools.get('vh_asset_upload')).toBeUndefined()
    expect(fixture.context.tools.get('dv_proj_create')).toBeUndefined()
    expect(fixture.project.listOperations()).toEqual([])
  })

  it('needs a project before any structured call', async () => {
    const fixture = await start()
    const result = await fixture.call('vh_asset_upload', { reason: 'r', path: fixture.writeFile('a.png'), mime: 'image/png' })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('No project selected')
    const unknown = await fixture.call('dv_proj_open', { project_id: 'missing' })
    expect(unknown.isError).toBe(true)
  })

  it('runs calls on the session draft with inputs, images, replaces, base_op, and continue_from', async () => {
    const fixture = await start()
    const { projectId, image, imported } = await sessionProject(fixture)
    expect(imported).toMatchObject({ status: 'done', summary: 'uploaded face.png', outputs: [{ role: 'asset', asset_id: image, mime: 'image/png', url: assetUrl(image as AssetId) }], scheduled: [], params: { mime: 'image/png' } })
    expect(imported.images).toHaveLength(1)
    expect(record(fixture, projectId, imported.op_id)).toMatchObject({ actor: 'agent', surface: 'chat', intent: 'bring the reference', branch: ANONYMOUS_DRAFT, component: 'asset' })
    const shotResult = await fixture.call('vh_generate_video', { reason: 'first shot', prompt: 'Picture 1 waves', duration_sec: 1, inputs: { reference: 'c1@1' } })
    const shot = value(shotResult)
    expect(shot.outputs.map(output => output.role)).toEqual(['video', 'last_frame'])
    expect(shot.images).toHaveLength(1)
    expect(shotResult.content.filter(block => block.type === 'image')).toHaveLength(1)
    expect(resultText(shotResult)).toContain('- video:')
    expect(shotResult.meta).toMatchObject({ tool: 'generate.video', status: 'done', op_id: shot.op_id })
    expect(record(fixture, projectId, shot.op_id).inputs).toEqual([{ role: 'reference', ref: { character: 'c1', version: 1 }, resolved_asset: image }])
    const next = value(await fixture.call('vh_generate_video', { reason: 'second shot', prompt: 'keeps waving', inputs: { reference: ['c1@1'] }, continue_from: shot.op_id }))
    expect(record(fixture, projectId, next.op_id).inputs.find(input => input.role === 'first_frame'))
      .toEqual({ role: 'first_frame', ref: { record: shot.op_id, output: 1 }, resolved_asset: shot.outputs[1]?.asset_id })
    const retake = value(await fixture.call('vh_generate_video', { reason: 'retake', prompt: 'Picture 1 waves slowly', inputs: { reference: 'c1@1' }, replaces: [shot.op_id], base_op: shot.op_id }))
    expect(record(fixture, projectId, retake.op_id)).toMatchObject({ supersedes: [shot.op_id], based_on: shot.op_id })
    expect(retake.scheduled).toEqual([])
    // Every record so far is on the session's draft; main holds only the project's creation.
    expect(fixture.project.getState(projectId).components.proj.records.map(item => item.operation)).toEqual(['proj.create'])
    const state = json(await fixture.call('dv_proj_state', {}))
    expect(state).toMatchObject({
      project_id: projectId, branch: ANONYMOUS_DRAFT, draft: { agent_changes: 5, human_edits: 0 }, stale: [next.op_id],
    })
    expect((state['recent'] as unknown[]).length).toBeGreaterThanOrEqual(5)
    // Keeping the stale shot removes its mark.
    expect(json(await fixture.call('dv_proj_stale_accept', { record: next.op_id }))).toMatchObject({ stale: [] })
    const bad = await fixture.call('vh_generate_video', { reason: 'r', prompt: 'x', inputs: { nope: 'c1@1' } })
    expect(bad.isError).toBe(true)
    expect(resultText(bad)).toContain('Unknown input role')
    // An empty reason falls back to the tool name.
    const probe = value(await fixture.call('vh_media_probe', { reason: '', inputs: { media: shot.outputs[0]?.asset_id } }))
    expect(record(fixture, projectId, probe.op_id).intent).toBe('media.probe')
    expect(probe.outputs.map(output => output.role)).toEqual(['info'])
    expect(probe.report).toMatchObject({ hasAudio: false })
    expect(resultText(await fixture.call('dv_proj_state', {}))).toContain('"report"')
    const history = json(await fixture.call('dv_proj_history_list', { limit: 2, operation: 'generate.video' })) as unknown as Array<Record<string, unknown>>
    expect(history).toEqual([
      expect.objectContaining({ record: retake.op_id, mark: 'draft', operation: 'generate.video', status: 'done' }),
      expect.objectContaining({ record: next.op_id, mark: 'draft' }),
    ])
  })

  it('reports a failed record as a tool error', async () => {
    const fixture = await start()
    await sessionProject(fixture)
    const failed = await fixture.call('vh_entity_character_update', { reason: 'no such character', entity: 'c9', description: 'x' })
    expect(failed.isError).toBe(true)
    expect(resultText(failed)).toContain("Unknown character 'c9'")
  })

  it('schedules behind unfinished producers and waits for them', async () => {
    const fixture = await start()
    const { projectId } = await sessionProject(fixture)
    const plan = value(await fixture.call('vh_plan_create', { reason: 'propose', continuity: 'chained', references: ['c1@1'], shots: [{ prompt: 'one', duration_sec: 1 }, { prompt: 'two', duration_sec: 1 }] }))
    expect(plan.outputs[0]?.mime).toBe('application/json')
    const approve = value(await fixture.call('vh_plan_approve', { reason: 'user said go', plan: plan.op_id, user_approved: true }))
    expect(approve.status).toBe('done')
    expect(approve.scheduled).toHaveLength(3)
    const firstShot = approve.scheduled[0] as string
    expect(record(fixture, projectId, firstShot)).toMatchObject({ actor: 'system', operation: 'generate.video', branch: ANONYMOUS_DRAFT })
    const frame = value(await fixture.call('vh_media_extract_frame', { reason: 'look at the start', at: 'first', inputs: { clip: `${firstShot}#0` } }))
    expect(frame.status).toBe('pending')
    expect(frame.summary).toBe('media.extract_frame pending')
    expect(frame.outputs).toEqual([])
    const waited = json(await fixture.call('dv_proj_wait', {}))
    expect((waited['sequence'] as unknown[]).length).toBe(2)
    expect(waited['plans']).toEqual([{ op: plan.op_id, approved: true, approvedBy: approve.op_id }])
    expect(record(fixture, projectId, frame.op_id).status).toBe('done')
    const recent = waited['recent'] as Array<{ tool: string; status: string; summary: string }>
    expect(recent.some(item => item.tool === 'media.extract_frame' && item.status === 'done' && item.summary === 'frame at first')).toBe(true)
    // A record of an operation that is no longer registered is summarized by its name; a pending record by its status.
    const removeEcho = fixture.tools.register(plainSpec('echo', {}))
    value(await fixture.call('vh_echo', { reason: 'echo' }))
    removeEcho()
    const second = value(await fixture.call('vh_plan_create', { reason: 'again', references: ['c1@1'], shots: [{ prompt: 'three', duration_sec: 1 }] }))
    value(await fixture.call('vh_plan_approve', { reason: 'go', plan: second.op_id, user_approved: true }))
    const pending = json(await fixture.call('dv_proj_state', {}))['recent'] as Array<{ tool: string; summary: string }>
    expect(pending.find(item => item.tool === 'echo')?.summary).toBe('echo')
    expect(pending.some(item => item.summary === 'pending' || item.summary === 'running')).toBe(true)
    json(await fixture.call('dv_proj_wait', {}))
  })

  it('accepts, discards, undoes, redoes, and switches branches only when called', async () => {
    const fixture = await start()
    const { projectId, image } = await sessionProject(fixture)
    json(await fixture.call('dv_proj_draft_accept', {}))
    expect(fixture.project.getState(projectId).components.bible.entities).toHaveProperty('c1')
    expect((await fixture.call('dv_proj_draft_accept', {})).isError).toBe(true)
    expect(resultText(await fixture.call('dv_proj_draft_discard', {}))).toContain('No open draft')
    value(await fixture.call('vh_sequence_create', { reason: 'lay out', assets: [image] }))
    expect(json(await fixture.call('dv_proj_draft_discard', {}))['draft']).toBeNull()
    expect(fixture.project.getState(projectId).components.timeline.sequence).toBeNull()
    value(await fixture.call('vh_sequence_create', { reason: 'lay out again', assets: [image] }))
    json(await fixture.call('dv_proj_draft_accept', {}))
    expect(fixture.project.getState(projectId).components.timeline.sequence?.items).toHaveLength(1)
    expect(json(await fixture.call('dv_proj_undo', {}))['sequence']).toBeNull()
    expect((json(await fixture.call('dv_proj_redo', {}))['sequence'] as unknown[]).length).toBe(1)
    // An exploration branch: the draft forks from it, and accepting merges the draft back into it.
    expect(json(await fixture.call('dv_proj_branch_create', { name: 'alt' }))).toMatchObject({ branch: 'explore/alt', draft: null })
    const alt = value(await fixture.call('vh_sequence_create', { reason: 'alt layout', assets: [image, image] }))
    expect(record(fixture, projectId, alt.op_id).branch).toBe(ANONYMOUS_DRAFT)
    expect((json(await fixture.call('dv_proj_state', {}))['sequence'] as unknown[]).length).toBe(2)
    expect((json(await fixture.call('dv_proj_state', { branch: 'main' }))['sequence'] as unknown[]).length).toBe(1)
    expect(json(await fixture.call('dv_proj_draft_accept', {}))['branch']).toBe('explore/alt')
    expect((await fixture.call('dv_proj_branch_switch', { name: 'explore/ghost' })).isError).toBe(true)
    expect(json(await fixture.call('dv_proj_branch_switch', { name: 'main' }))['branch']).toBe('main')
    // A bound conversation keeps its project: creating or opening another one is refused.
    const second = await fixture.call('dv_proj_create', { title: 'other' })
    expect(second.isError).toBe(true)
    expect(resultText(second)).toContain(`This conversation belongs to project ${projectId}`)
    const other = await fixture.project.createProject('other', { actor: 'user', surface: 'api', session: null, turn: null, tool_call: null, intent: 'other' })
    expect(resultText(await fixture.call('dv_proj_open', { project_id: other.id }))).toContain('belongs to project')
    expect(json(await fixture.call('dv_proj_open', { project_id: projectId }))['project_id']).toBe(projectId)
    expect(json(await fixture.call('dv_proj_state', { project_id: other.id }))['records']).toBe(1)
  })

  it('refuses a cost-gated call above the budget when no question channel is installed', async () => {
    const fixture = await start()
    json(await fixture.call('dv_proj_create', { title: 'budget' }))
    // The first call of the turn has spent nothing; 20 s × 4 is still above 60.
    const refused = await fixture.call('vh_generate_video', { reason: 'long shot', prompt: 'one', duration_sec: 20, inputs: { reference: 'a1' } })
    expect(refused.isError).toBe(true)
    expect(resultText(refused)).toContain('about 80 GPU seconds, above the 60 s budget')
    expect(resultText(refused)).toContain('user_requested: true')
  })

  it('asks one question for a plan approval, listing every shot with the plan\'s cost', async () => {
    const fixture = await start()
    await sessionProject(fixture)
    const asked: ConfirmRequest[] = []
    fixture.tools.setConfirmPolicy((request) => { asked.push(request); return Promise.resolve(true) })
    const plan = value(await fixture.call('vh_plan_create', { reason: 'propose', references: ['c1@1'], shots: [{ prompt: 'walks', duration_sec: 1 }, { prompt: 'turns', duration_sec: 2 }] }))
    const approved = value(await fixture.call('vh_plan_approve', { reason: 'go', plan: plan.op_id }))
    expect(approved.params).toEqual({ plan: plan.op_id })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ estimateGpuSeconds: 12, params: { prompt: '1. walks (1 s)\n2. turns (2 s)', duration_sec: 3 }, inputs: [{ role: 'reference', ref: { character: 'c1', version: 1 } }] })
    // A declined question refuses the call before any record.
    fixture.tools.setConfirmPolicy(() => Promise.resolve(false))
    expect(resultText(await fixture.call('vh_plan_approve', { reason: 'again', plan: plan.op_id }))).toContain('The user declined plan.approve')
  })

  it('imports the images a user attached in a bound chat as project assets on the working branch', async () => {
    const fixture = await start()
    const session = sessionKey(undefined)
    const image = await fixture.attachments.saveImage({ data: Buffer.from('chat-image'), mediaType: 'image/png', name: 'cat.png' })
    expect(await fixture.tools.recordChatImages(session, [image])).toEqual([])
    const { projectId } = await sessionProject(fixture)
    const [asset] = await fixture.tools.recordChatImages(session, [image])
    const imported = fixture.project.listHistory({ project: projectId, actor: 'user', operation: 'asset.upload' }).map(entry => entry.record)
    expect(imported).toEqual([expect.objectContaining({ surface: 'chat', turn: null, branch: ANONYMOUS_DRAFT, outputs: [asset], params: expect.objectContaining({ name: 'cat.png', mime: 'image/png' }) })])
    expect(fixture.assets.read(asset as AssetId).toString()).toBe('chat-image')
  })

  it('refuses a shot or a plan approval without reference pictures before recording anything', async () => {
    const fixture = await start()
    const { projectId } = await sessionProject(fixture)
    value(await fixture.call('vh_entity_character_create', { reason: 'no pictures', entity: 'c2', name: 'Cat', description: 'an orange cat' }))
    const records = fixture.project.listHistory({ project: projectId }).length
    const shot = await fixture.call('vh_generate_video', { reason: 'cat', prompt: 'a cat', duration_sec: 1, inputs: { reference: 'c2@1' }, user_requested: true })
    expect(shot.isError).toBe(true)
    expect(resultText(shot)).toContain('and this shot has none')
    const plan = value(await fixture.call('vh_plan_create', { reason: 'propose', shots: [{ prompt: 'one', duration_sec: 1, references: ['c1@1'] }, { prompt: 'two', duration_sec: 1 }] }))
    const approve = await fixture.call('vh_plan_approve', { reason: 'go', plan: plan.op_id, user_approved: true })
    expect(resultText(approve)).toContain('shot 2 of the plan has none')
    // Only the plan proposal was recorded: no failed shots, no approval.
    expect(fixture.project.listHistory({ project: projectId }).length).toBe(records + 1)
  })

  it('answers the agent layer without a DSH tool registry', async () => {
    const fixture = await start({ dsh: false })
    fixture.tools.noteTurn('s1', 1, 'hello')
    expect(fixture.tools.sessionState('s1')).toBeUndefined()
    expect(fixture.tools.assetUrl(brandString<AssetId>('a1'))).toBe('/vh/assets/a1/content')
  })

  it('writes one request record per turn and keeps the draft open across turns', async () => {
    const fixture = await start()
    const session = sessionKey(undefined)
    fixture.tools.noteTurn(session, 1, '')
    fixture.tools.noteTurn(session, 1, 'make a dance video')
    const { projectId } = await sessionProject(fixture)
    const requests = fixture.project.listHistory({ project: projectId, kind: 'request' }).map(entry => entry.record)
    expect(requests).toEqual([expect.objectContaining({ intent: 'make a dance video', actor: 'user', branch: ANONYMOUS_DRAFT })])
    const firstTurn = requests[0]?.turn
    expect(fixture.project.listHistory({ project: projectId, operation: 'asset.upload' })[0]?.record.turn).toBe(firstTurn)
    fixture.tools.noteTurn(session, 2, 'add a second character')
    value(await fixture.call('vh_entity_character_create', { reason: 'second', entity: 'c2', name: 'Friend' }))
    const latest = fixture.project.listHistory({ project: projectId, kind: 'request' })[0]?.record
    expect(latest).toMatchObject({ intent: 'add a second character' })
    expect(latest?.turn).not.toBe(firstTurn)
    // The second turn writes to the same draft; nothing reached main.
    expect(fixture.project.workingBranch(projectId, brandString<SessionId>(session)))
      .toMatchObject({ name: ANONYMOUS_DRAFT, counts: { agent_changes: 3, human_edits: 0 } })
    expect(fixture.project.getState(projectId).components.proj.records).toHaveLength(1)
  })

  it('continues the session project and its draft after a restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vh-restart-'))
    const fixture = await start({ root })
    const { projectId } = await sessionProject(fixture)
    const before = json(await fixture.call('dv_proj_state', {}))
    expect(before['draft']).not.toBeNull()
    await fixture.dispose()
    fixtures.pop()
    const restarted = await start({ root })
    expect(json(await restarted.call('dv_proj_state', {}))).toMatchObject({ project_id: projectId, branch: ANONYMOUS_DRAFT, draft: before['draft'] })
    json(await restarted.call('dv_proj_draft_accept', {}))
    expect(restarted.project.getState(projectId).components.bible.entities).toHaveProperty('c1')
    await restarted.dispose()
    fixtures.pop()
    // A state file with extra fields (`turn`, `turnProject`, `branch`, `dshTurn`, `turnOpenedAt`) still binds the session.
    const stateFile = join(root, 'sessions', `${encodeURIComponent(sessionKey(undefined))}.json`)
    writeFileSync(stateFile, JSON.stringify({ projectId, turn: 'ghost', turnProject: projectId, branch: null, dshTurn: 1, turnOpenedAt: 1 }))
    const third = await start({ root })
    expect(json(await third.call('dv_proj_state', {}))).toMatchObject({ project_id: projectId, branch: 'main', draft: null })
    for (const content of ['{"projectId":1}', '"text"']) {
      writeFileSync(stateFile, content)
      await fixtures.pop()?.dispose()
      const broken = await start({ root })
      expect(resultText(await broken.call('dv_proj_state', {}))).toContain('not a session state')
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('lists outputs by URL only when no attachment service is mounted', async () => {
    const fixture = await start({ perception: false })
    await sessionProject(fixture)
    const shot = value(await fixture.call('vh_generate_video', { reason: 'shot', prompt: 'Picture 1', inputs: { reference: 'c1@1' } }))
    expect(shot.images).toBeUndefined()
    expect(shot.outputs[1]?.url).toBe(assetUrl(shot.outputs[1]?.asset_id as AssetId))
  })
})
