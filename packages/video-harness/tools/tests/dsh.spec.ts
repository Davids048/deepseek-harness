import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { AssetId, OpId } from '@video-harness/oplog'
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

/** The JSON value of a successful management tool call. */
function json(result: ToolExecutionResult): Record<string, unknown> {
  if (result.isError) throw new Error(`tool failed: ${result.error.message}`)
  return result.value as Record<string, unknown>
}

/** A session project with an uploaded reference and character c1@1. */
async function sessionProject(fixture: ToolsFixture) {
  const created = json(await fixture.call('vh_project_create', { title: 'dance' }))
  const projectId = created['project_id'] as string
  const upload = value(await fixture.call('vh_asset_upload', { reason: 'bring the reference', path: fixture.writeFile('face.png'), mime: 'image/png' }))
  const image = upload.outputs[0]?.asset_id as string
  value(await fixture.call('vh_entity_character_create', { reason: 'register the lead', entity: 'c1', name: 'Lead', refs: [image] }))
  return { projectId, image, upload }
}

/** A call that must succeed. */
function ok(result: ToolExecutionResult): ToolExecutionResult {
  if (result.isError) throw new Error(`tool failed: ${result.error.message}`)
  return result
}

describe('DSH tools', () => {
  it('names tools and parses input references', () => {
    expect(dshToolName('entity.character.create')).toBe('vh_entity_character_create')
    expect(assetUrl('abc' as AssetId)).toBe('/vh/assets/abc/content')
    expect(sessionKey(undefined)).toBe('anonymous')
    expect(sessionKey({ id: 's1' })).toBe('s1')
    const spec: ToolSpec = {
      name: 't', version: '1', summary: 't', params: {}, outputs: [], deterministic: true, cost: 'free', confirm: 'never', summarize: () => 't', execute: () => Promise.resolve({ outputs: [] }),
      inputs: { clip: { type: 'video', required: true, description: '' }, extra: { type: 'image', many: true, description: '' } },
    }
    expect(parseInputs(spec, { clip: 'a', extra: ['b', 'c'] })).toEqual([{ role: 'clip', ref: 'a' }, { role: 'extra', ref: 'b' }, { role: 'extra', ref: 'c' }])
    expect(() => parseInputs(spec, undefined)).toThrow('needs input "clip"')
    expect(() => parseInputs(spec, 'a')).toThrow('must be an object')
    expect(() => parseInputs(spec, ['a'])).toThrow('must be an object')
    expect(() => parseInputs(spec, { clip: ['a', 'b'] })).toThrow('takes one reference')
    expect(() => parseInputs(spec, { clip: 1 })).toThrow('must be an asset ID')
    expect(() => parseInputs(spec, { clip: 'a', other: 'b' })).toThrow('Unknown input role "other"')
    expect(() => parseInputs({ ...spec, inputs: {} }, { clip: 'a' })).toThrow('roles: none')
  })

  it('renders a result as text plus image blocks', () => {
    const base: ToolCallValue = { op_id: 'op1', status: 'done', summary: 'did it', outputs: [{ role: 'video', asset_id: 'a1', mime: 'video/mp4', url: '/vh/assets/a1/content' }], scheduled: ['op2'], params: { seed: 1 } }
    expect(renderValue(base)).toEqual([{ type: 'text', text: 'done op1: did it\n- video: a1 (video/mp4) /vh/assets/a1/content\nscheduled: op2\nparams: {"seed":1}' }])
    const withImages = renderValue({ ...base, scheduled: [], images: [{ attachmentId: 'att', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }, 'junk', null, ['x'], { attachmentId: 3 }] })
    expect(withImages).toHaveLength(2)
    expect(withImages[1]).toMatchObject({ type: 'image', attachment: { attachmentId: 'att' } })
    expect((withImages[0] as { text: string }).text).not.toContain('scheduled')
  })

  it('exposes every spec and the management tools, and removes them on disposal', async () => {
    const fixture = await start()
    const names = fixture.tools.list().map(spec => dshToolName(spec.name))
    for (const name of [...names, 'vh_project_create', 'vh_project_use', 'vh_project_state', 'vh_turn_accept', 'vh_turn_reject', 'vh_undo', 'vh_branch_create', 'vh_branch_use', 'vh_wait']) {
      expect(fixture.context.tools.get(name), name).toBeDefined()
    }
    const schema = fixture.context.tools.schemas().find(tool => tool.name === 'vh_generate_video')
    expect(schema?.description).toContain('Cost: gpu')
    expect(schema?.description).toContain('ask the user')
    expect(JSON.stringify(schema?.parameters)).toContain('continue_from')
    expect(fixture.context.tools.schemas().find(tool => tool.name === 'vh_clip_trim')?.description).toContain('deterministic')
    expect(JSON.stringify(fixture.context.tools.schemas().find(tool => tool.name === 'vh_plan_approve')?.parameters)).not.toContain('"inputs"')
    await fixture.toolsFiber.dispose()
    expect(fixture.context.tools.get('vh_asset_upload')).toBeUndefined()
    expect(fixture.context.tools.get('vh_project_create')).toBeUndefined()
    expect(fixture.project.toolNames()).toEqual([])
  })

  it('needs a project before any structured call', async () => {
    const fixture = await start()
    const result = await fixture.call('vh_asset_upload', { reason: 'r', path: fixture.writeFile('a.png'), mime: 'image/png' })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('No project selected')
    const unknown = await fixture.call('vh_project_use', { project_id: 'missing' })
    expect(unknown.isError).toBe(true)
  })

  it('records calls as draft-turn records with inputs, images, replaces, base_op, and continue_from', async () => {
    const fixture = await start()
    const { projectId, image, upload } = await sessionProject(fixture)
    expect(upload).toMatchObject({ status: 'done', summary: 'uploaded face.png', outputs: [{ role: 'asset', asset_id: image, mime: 'image/png', url: assetUrl(image as AssetId) }], scheduled: [], params: { mime: 'image/png' } })
    expect(upload.images).toHaveLength(1)
    const uploadOp = fixture.log.get(projectId as never, upload.op_id as OpId)
    expect(uploadOp).toMatchObject({ actor: 'agent', surface: 'chat', intent: 'bring the reference' })
    expect(uploadOp.branch).toMatch(/^draft\//)
    const shotResult = await fixture.call('vh_generate_video', { reason: 'first shot', prompt: 'Picture 1 waves', duration_sec: 1, inputs: { reference: 'c1@1' } })
    const shot = value(shotResult)
    expect(shot.outputs.map(output => output.role)).toEqual(['video', 'last_frame'])
    expect(shot.images).toHaveLength(1)
    expect(shotResult.content.filter(block => block.type === 'image')).toHaveLength(1)
    expect(resultText(shotResult)).toContain('- video:')
    expect(shotResult.meta).toMatchObject({ tool: 'generate.video', status: 'done', op_id: shot.op_id })
    const next = value(await fixture.call('vh_generate_video', { reason: 'second shot', prompt: 'keeps waving', inputs: { reference: ['c1@1'] }, continue_from: shot.op_id }))
    const nextOp = fixture.log.get(projectId as never, next.op_id as OpId)
    expect(nextOp.inputs.find(input => input.role === 'first_frame')).toMatchObject({ ref: `${shot.op_id}#1`, resolved: shot.outputs[1]?.asset_id })
    const retake = value(await fixture.call('vh_generate_video', { reason: 'retake', prompt: 'Picture 1 waves slowly', inputs: { reference: 'c1@1' }, replaces: [shot.op_id], base_op: shot.op_id }))
    const retakeOp = fixture.log.get(projectId as never, retake.op_id as OpId)
    expect(retakeOp.supersedes).toEqual([shot.op_id])
    expect(retakeOp.base_op).toBe(shot.op_id)
    expect(retake.scheduled).toEqual([])
    // Every record so far shares the session's open turn on one draft branch; main is untouched until acceptance.
    const draft = fixture.project.fold(projectId as never, uploadOp.branch)
    expect(new Set(draft.ops.filter(op => op.kind === 'tool').map(op => op.turn)).size).toBe(1)
    expect(fixture.project.fold(projectId as never).ops).toHaveLength(1)
    const state = json(await fixture.call('vh_project_state', {}))
    expect(state).toMatchObject({ project_id: projectId, branch: 'main', open_turn: uploadOp.turn, stale: [nextOp.id] })
    expect((state['recent'] as unknown[]).length).toBeGreaterThanOrEqual(4)
    const bad = await fixture.call('vh_generate_video', { reason: 'r', prompt: 'x', inputs: { nope: 'c1@1' } })
    expect(bad.isError).toBe(true)
    expect(resultText(bad)).toContain('Unknown input role')
    // An empty reason falls back to the tool name; extra outputs beyond the declared roles are numbered.
    const command = value(await fixture.call('vh_command_run', {
      reason: '', inputs: { in: shot.outputs[0]?.asset_id }, argv: ['ffmpeg', '-y', '-loglevel', 'error', '-i', '{{in:0}}', '-frames:v', '1', '{{out:a.png}}', '-frames:v', '1', '{{out:b.png}}'],
      outputs: [{ name: 'a.png', mime: 'image/png' }, { name: 'b.png', mime: 'image/png' }],
    }))
    expect(fixture.log.get(projectId as never, command.op_id as OpId).intent).toBe('command.run')
    expect(command.outputs.map(output => output.role)).toEqual(['output', 'output_1'])
    expect(command.report).toMatchObject({ stdout: '' })
    expect(resultText(await fixture.call('vh_project_state', {}))).toContain('"report"')
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
    const trim = value(await fixture.call('vh_clip_trim', { reason: 'cut the head', startSec: 0.2, inputs: { clip: `${firstShot}#0` } }))
    expect(trim.status).toBe('pending')
    expect(trim.summary).toBe('clip.trim pending')
    expect(trim.outputs).toEqual([])
    const waited = json(await fixture.call('vh_wait', {}))
    expect((waited['sequence'] as unknown[]).length).toBe(2)
    expect(fixture.log.get(projectId as never, trim.op_id as OpId).status).toBe('done')
    const recent = waited['recent'] as Array<{ tool: string; status: string; summary: string }>
    expect(recent.some(record => record.tool === 'clip.trim' && record.status === 'done' && record.summary === 'trimmed from 0.2s')).toBe(true)
    // A record of a tool that is no longer registered is summarized by its kind; a pending record by its status.
    const echo: ToolSpec = { name: 'echo', version: '1', summary: 'echo', inputs: {}, params: {}, outputs: [], deterministic: false, cost: 'free', confirm: 'never', summarize: () => 'echoed', execute: () => Promise.resolve({ outputs: [] }) }
    const removeEcho = fixture.tools.register(echo)
    value(await fixture.call('vh_echo', { reason: 'echo' }))
    removeEcho()
    const second = value(await fixture.call('vh_plan_create', { reason: 'again', references: ['c1@1'], shots: [{ prompt: 'three', duration_sec: 1 }] }))
    value(await fixture.call('vh_plan_approve', { reason: 'go', plan: second.op_id, user_approved: true }))
    const pending = json(await fixture.call('vh_project_state', {}))['recent'] as Array<{ tool: string; summary: string }>
    expect(pending.find(record => record.tool === 'echo')?.summary).toBe('tool')
    expect(pending.some(record => record.summary === 'pending' || record.summary === 'running')).toBe(true)
    json(await fixture.call('vh_wait', {}))
  })

  it('accepts, rejects, undoes, and switches branches', async () => {
    const fixture = await start()
    const { projectId, image } = await sessionProject(fixture)
    expect((await fixture.call('vh_turn_accept', {})).isError).toBe(false)
    expect(fixture.project.fold(projectId as never).entities).toHaveProperty('c1')
    expect(resultText(await fixture.call('vh_turn_accept', {}))).toContain('No open draft')
    expect(resultText(await fixture.call('vh_turn_reject', {}))).toContain('No open draft')
    value(await fixture.call('vh_sequence_create', { reason: 'lay out', assets: [image] }))
    json(await fixture.call('vh_turn_reject', {}))
    expect(fixture.project.fold(projectId as never).sequence).toBeNull()
    value(await fixture.call('vh_sequence_create', { reason: 'lay out again', assets: [image] }))
    json(await fixture.call('vh_turn_accept', {}))
    expect(fixture.project.fold(projectId as never).sequence?.items).toHaveLength(1)
    const undone = json(await fixture.call('vh_undo', {}))
    expect(undone['sequence']).toBeNull()
    // An exploration branch takes records directly, and state reads follow the branch.
    const branched = json(await fixture.call('vh_branch_create', { name: 'alt' }))
    expect(branched).toMatchObject({ branch: 'alt', open_turn: null })
    const alt = value(await fixture.call('vh_sequence_create', { reason: 'alt layout', assets: [image, image] }))
    expect(fixture.log.get(projectId as never, alt.op_id as OpId).branch).toBe('alt')
    expect((json(await fixture.call('vh_project_state', {}))['sequence'] as unknown[]).length).toBe(2)
    expect(json(await fixture.call('vh_project_state', { branch: 'main' }))['sequence']).toBeNull()
    expect(json(await fixture.call('vh_turn_accept', {}))['branch']).toBe('alt')
    expect(resultText(await fixture.call('vh_branch_use', { name: 'ghost' }))).toContain('does not exist')
    expect(json(await fixture.call('vh_branch_use', { name: 'main' }))['branch']).toBe('main')
    // A bound conversation keeps its project: creating or switching to another one is refused.
    const second = await fixture.call('vh_project_create', { title: 'other' })
    expect(second.isError).toBe(true)
    expect(resultText(second)).toContain(`This conversation belongs to project ${projectId}`)
    const other = fixture.project.createProject({ title: 'other' })
    expect(resultText(await fixture.call('vh_project_use', { project_id: other }))).toContain('belongs to project')
    expect(json(await fixture.call('vh_project_use', { project_id: projectId }))['project_id']).toBe(projectId)
    expect(json(await fixture.call('vh_project_state', { project_id: other }))['records']).toBe(1)
    expect(json(await fixture.call('vh_branch_use', { name: 'alt' }))['branch']).toBe('alt')
  })

  it('refuses a cost-gated call above the budget when no question channel is installed', async () => {
    const fixture = await start()
    json(await fixture.call('vh_project_create', { title: 'budget' }))
    // The first structured call of the session has no draft yet, so nothing was spent; 20 s × 4 is still above 60.
    const refused = await fixture.call('vh_generate_video', { reason: 'long shot', prompt: 'one', duration_sec: 20, inputs: { reference: 'a1' } })
    expect(refused.isError).toBe(true)
    expect(resultText(refused)).toContain('about 80 GPU seconds, above the 60 s budget')
    expect(resultText(refused)).toContain('user_requested: true')
  })

  it('asks one question for a gated plan approval, listing every shot with the plan\'s cost', async () => {
    const fixture = await start()
    await sessionProject(fixture)
    const asked: ConfirmRequest[] = []
    fixture.tools.setConfirmGate(spec => spec.name === 'plan.approve')
    fixture.tools.setConfirmPolicy((request) => { asked.push(request); return Promise.resolve(true) })
    const plan = value(await fixture.call('vh_plan_create', { reason: 'propose', references: ['c1@1'], shots: [{ prompt: 'walks', duration_sec: 1 }, { prompt: 'turns', duration_sec: 2 }] }))
    const approved = value(await fixture.call('vh_plan_approve', { reason: 'go', plan: plan.op_id }))
    expect(approved.params).toMatchObject({ plan: plan.op_id, user_approved: true })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ forced: true, estimateGpuSeconds: 12, params: { prompt: '1. walks (1 s)\n2. turns (2 s)', duration_sec: 3 }, inputs: [{ role: 'reference', ref: 'c1@1' }] })
  })

  it('records the images a user attached in a bound chat as project assets on main', async () => {
    const fixture = await start()
    const session = sessionKey(undefined)
    const image = await fixture.attachments.saveImage({ data: Buffer.from('chat-image'), mediaType: 'image/png', name: 'cat.png' })
    expect(await fixture.tools.recordChatImages(session, [image])).toEqual([])
    const { projectId } = await sessionProject(fixture)
    fixture.tools.settleTurn(session, 'completed')
    const [asset] = await fixture.tools.recordChatImages(session, [image])
    const main = fixture.project.fold(projectId as never)
    const upload = main.ops.find(op => op.tool?.name === 'asset.upload' && op.outputs.includes(asset as AssetId))
    expect(upload).toMatchObject({ actor: 'user', surface: 'chat', params: { name: 'cat.png', mime: 'image/png' } })
    expect(fixture.assets.read(asset as AssetId).toString()).toBe('chat-image')
  })

  it('refuses a shot or a plan approval without reference pictures before recording anything', async () => {
    const fixture = await start()
    const { projectId } = await sessionProject(fixture)
    value(await fixture.call('vh_entity_character_create', { reason: 'no pictures', entity: 'c2', name: 'Cat', description: 'an orange cat' }))
    const records = fixture.log.all(projectId as never).length
    const shot = await fixture.call('vh_generate_video', { reason: 'cat', prompt: 'a cat', duration_sec: 1, inputs: { reference: 'c2@1' }, user_requested: true })
    expect(shot.isError).toBe(true)
    expect(resultText(shot)).toContain('1 to 2 reference images, and this shot has none')
    const plan = value(await fixture.call('vh_plan_create', { reason: 'propose', shots: [{ prompt: 'one', duration_sec: 1, references: ['c1@1'] }, { prompt: 'two', duration_sec: 1 }] }))
    const approve = await fixture.call('vh_plan_approve', { reason: 'go', plan: plan.op_id, user_approved: true })
    expect(resultText(approve)).toContain('shot 2 of the plan has none')
    // Only the plan proposal was recorded: no failed shots, no approval.
    expect(fixture.log.all(projectId as never).length).toBe(records + 1)
  })

  it('answers the agent layer without a DSH tool registry', async () => {
    const fixture = await start({ dsh: false })
    expect(fixture.tools.settleTurn('s1', 'completed')).toBe('none')
    expect(fixture.tools.assetUrl('a1' as AssetId)).toBe('/vh/assets/a1/content')
  })

  it('continues the session project and open draft after a restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vh-restart-'))
    const fixture = await start({ root })
    const { projectId } = await sessionProject(fixture)
    const before = json(await fixture.call('vh_project_state', {}))
    expect(before['open_turn']).not.toBeNull()
    await fixture.dispose()
    const restarted = await startTools({ root })
    fixtures.push(restarted)
    const after = json(await restarted.call('vh_project_state', {}))
    expect(after).toMatchObject({ project_id: projectId, open_turn: before['open_turn'] })
    json(await restarted.call('vh_turn_accept', {}))
    expect(restarted.project.fold(projectId as never).entities).toHaveProperty('c1')
    await restarted.dispose()
    const third = await startTools({ root })
    fixtures.push(third)
    expect(json(await third.call('vh_project_state', {}))).toMatchObject({ project_id: projectId, open_turn: null })
    expect(third.project.openTurn(before['open_turn'] as never)).toBeUndefined()
    // A turn the log no longer knows (rejected elsewhere) is dropped and a fresh draft opens; GPU spend starts at zero.
    const stateFile = join(root, 'sessions', `${encodeURIComponent(sessionKey(undefined))}.json`)
    writeFileSync(stateFile, JSON.stringify({ projectId, turn: 'ghost', turnProject: projectId, branch: null, dshTurn: 1, turnOpenedAt: 1 }))
    await third.dispose()
    const stale = await startTools({ root })
    fixtures.push(stale)
    const fresh = value(await stale.call('vh_generate_video', { reason: 'new shot', prompt: 'one', inputs: { reference: 'c1@1' } }))
    expect(stale.log.get(projectId as never, fresh.op_id as OpId).turn).not.toBe('ghost')
    ok(await stale.call('vh_wait', {}))
    for (const content of ['{"projectId":1}', '"text"']) {
      writeFileSync(stateFile, content)
      await fixtures.pop()?.dispose()
      const broken = await startTools({ root })
      fixtures.push(broken)
      expect(resultText(await broken.call('vh_project_state', {}))).toContain('not a session state')
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

describe('turn settlement', () => {
  it('accepts a completed draft of deterministic or named work and keeps the rest for the user', async () => {
    const fixture = await start()
    const session = sessionKey(undefined)
    expect(fixture.tools.sessionProject(session)).toBeNull()
    const { projectId, image } = await sessionProject(fixture)
    expect(fixture.tools.sessionProject(session)).toBe(projectId)
    // An upload and an entity are deterministic: the draft lands without a question, accepted by the system, not the user.
    expect(fixture.tools.settleTurn(session, 'completed')).toBe('accepted')
    expect(fixture.tools.sessionState(session)?.turn).toBeNull()
    expect(fixture.project.fold(projectId as never).entities).toHaveProperty('c1')
    const accepted = fixture.log.get(projectId as never, fixture.log.heads(projectId as never)['main'] as OpId)
    expect([accepted.kind, accepted.actor]).toEqual(['approve', 'system'])
    // Looking at an image changes nothing the user would accept or discard: the draft does not stay open.
    value(await fixture.call('vh_perception_describe', { reason: 'look', inputs: { image } }))
    expect(fixture.tools.settleTurn(session, 'completed')).toBe('accepted')
    // A generation the user did not name waits for the user.
    value(await fixture.call('vh_generate_video', { reason: 'try one', prompt: 'one', duration_sec: 1, inputs: { reference: 'c1@1' } }))
    expect(fixture.tools.settleTurn(session, 'completed')).toBe('kept')
    json(await fixture.call('vh_turn_reject', {}))
    // An interrupted turn keeps even deterministic records for the user.
    value(await fixture.call('vh_asset_upload', { reason: 'interrupted', path: fixture.writeFile('i.png'), mime: 'image/png' }))
    expect(fixture.tools.settleTurn(session, 'interrupted')).toBe('kept')
    json(await fixture.call('vh_turn_reject', {}))
    // A generation the user asked for by name lands.
    value(await fixture.call('vh_generate_video', { reason: 'asked', prompt: 'two', duration_sec: 1, inputs: { reference: 'c1@1' }, user_requested: true }))
    expect(fixture.tools.settleTurn(session, 'completed')).toBe('accepted')
    // A plan approval is a `confirm: always` tool: it never lands by itself, even with the user's word on the call.
    const plan = value(await fixture.call('vh_plan_create', { reason: 'propose', continuity: 'independent', references: ['c1@1'], shots: [{ prompt: 'one', duration_sec: 1 }] }))
    value(await fixture.call('vh_plan_approve', { reason: 'go', plan: plan.op_id, user_approved: true }))
    expect(fixture.tools.settleTurn(session, 'completed')).toBe('kept')
    ok(await fixture.call('vh_wait', {}))
    json(await fixture.call('vh_turn_accept', {}))
    // When a view moved main while the draft was open, the draft waits like any other.
    value(await fixture.call('vh_asset_upload', { reason: 'another reference', path: fixture.writeFile('b.png'), mime: 'image/png' }))
    await fixture.project.invoke(projectId as never, {
      tool: 'asset.upload', inputs: [], params: { path: fixture.writeFile('c.png'), mime: 'image/png' },
      actor: 'user', surface: 'canvas', intent: 'upload from the canvas', turn: fixture.project.beginTurn(projectId as never, { actor: 'user', surface: 'canvas', intent: 'upload' }).turn,
    })
    expect(fixture.tools.settleTurn(session, 'completed')).toBe('kept')
    expect(fixture.tools.sessionState(session)?.turn).not.toBeNull()
  })
})
