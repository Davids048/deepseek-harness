import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branch, ProjectId, ProjectState, RecordId } from '@dv/project'
import { afterEach, describe, expect, it } from 'vitest'
import VhAgent, { PROMPT_SECTION, renderResolverBlock } from '../src/index.ts'
import { resultText, startTools, type ToolsFixture } from '../../tools/tests/support.ts'

/** A live session and the agent handle the registry reports for it. */
interface FakeLive {
  session: { id: string }
  agent: { id: string; session: { id: string } }
}

interface AgentFixture extends ToolsFixture {
  agent: VhAgent
  agentFiber: { dispose(): Promise<void> }
  live: FakeLive
  /** Emit one session event for the live session. */
  emit(type: string, data: Record<string, unknown>): void
  /** Call a DSH tool on behalf of the live agent. */
  callAs(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
}

const fixtures: AgentFixture[] = []

/** Mount the tools fixture plus the agent plugin; `registry` adds a fake `agents` service, `questions` a fake channel. */
interface StartOptions {
  registry?: boolean
  questions?: (question: string) => string[] | Error
  threshold?: number
  /** Mount a fake `vhViews` that reports this selection for every project. */
  selection?: { kind: string; id: string; slot?: number; surface: string }
}

async function start(options: StartOptions = {}): Promise<AgentFixture> {
  const base = await startTools()
  const session = { id: 's1' }
  const live: FakeLive = { session, agent: { id: 's1', session } }
  if (options.registry === true) base.context.provide('agents', { get: (id: string) => (id === 's1' ? live.agent : undefined), roots: () => [live.agent] })
  if (options.questions !== undefined) {
    const answer = options.questions
    base.context.provide('userQuestions', {
      ask: (request: { questions: Array<{ id: string; question: string }> }) => {
        const first = request.questions[0]
        const selected = answer(first?.question ?? '')
        if (selected instanceof Error) return Promise.reject(selected)
        return Promise.resolve({ answers: [{ id: first?.id ?? 'approve', selected }] })
      },
    })
  }
  if (options.selection !== undefined) {
    const selection = options.selection
    base.context.provide('vhViews', { selection: () => selection })
  }
  if (options.threshold !== undefined) {
    await base.toolsFiber.dispose()
    const { default: VhTools } = await import('@video-harness/tools')
    await base.context.plugin(VhTools, { perceptionMaxTokens: 1024, imageInput: true, sessionStateRoot: join(base.root, 'sessions'), publicBaseUrl: 'https://demo.example', confirmGpuSecondsThreshold: options.threshold, gpuSecondsPerVideoSecond: 4 }).await()
  }
  const agentFiber = base.context.plugin(VhAgent, { promptSectionOrder: 4900, approveLabel: 'Run it', declineLabel: 'Not now' })
  await agentFiber.await()
  let calls = 0
  const fixture: AgentFixture = {
    ...base,
    agent: base.context.vhAgent,
    agentFiber,
    live,
    emit(type, data) {
      base.context.emit('session/event', live.session as never, { type, data } as never)
    },
    callAs(name, args) {
      calls += 1
      return base.context.tools.execute({ callId: ToolCallId(`as-${calls}`), name, arguments: args, signal: new AbortController().signal, agent: live.agent as never })
    },
  }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

/** The value of a successful call, or a thrown error with the tool's message. */
function ok(result: ToolExecutionResult): Record<string, unknown> {
  if (result.isError) throw new Error(result.error.message)
  return result.value as Record<string, unknown>
}

/** The JSON value of a successful registry tool call. */
function json(result: ToolExecutionResult): Record<string, unknown> {
  return ok(result)
}

/** A project bound to the live session with one character; the import and the character open the session's draft. */
async function boundProject(fixture: AgentFixture): Promise<string> {
  const created = ok(await fixture.callAs('dv_proj_create', { title: 'dance' }))
  ok(await fixture.callAs('vh_asset_upload', { reason: 'reference', path: fixture.writeFile('face.png'), mime: 'image/png' }))
  const image = fixture.assets.list()[0]?.id as string
  ok(await fixture.callAs('vh_entity_character_create', { reason: 'lead', entity: 'c1', name: 'Lead', refs: [image] }))
  return created['project_id'] as string
}

/** A plain state for rendering tests: the given slices over empty ones. */
function plainState(components: Partial<{ [K in keyof ProjectState['components']]: Partial<ProjectState['components'][K]> }> = {}): ProjectState {
  return {
    project: { id: brandString<ProjectId>('p'), title: 'p', created_at: '' }, branch: 'main', head: brandString<RecordId>('h'),
    components: {
      proj: { records: [], stale: {}, superseded: {}, created_by: {}, ...components.proj },
      timeline: { sequence: null, sequences: [], ...components.timeline },
      bible: { entities: {}, ...components.bible }, // names:allow
      plan: { plans: [], ...components.plan },
      shot: { takes: {}, roots: {}, ...components.shot },
    },
  }
}

/** A branch for rendering tests; `counts` makes it a draft. */
function branchOf(name: string, counts: Branch['counts'] = null): Branch {
  return { name, head: brandString<RecordId>('h'), base: counts === null ? null : 'main', forked_at: null, session: null, counts }
}

describe('resolver block', () => {
  it('renders the rules alone without a project and the working branch state with one', async () => {
    const fixture = await start()
    expect(fixture.agent.promptBlock(undefined)).toContain('No project is bound')
    expect(fixture.agent.promptBlock('nobody')).toContain('No project is bound')
    json(await fixture.callAs('dv_proj_create', { title: 'empty' }))
    // A new project has no draft until the agent's first change.
    expect(fixture.agent.promptBlock('s1')).toContain('on branch main.')
    expect(fixture.agent.promptBlock('s1')).toContain('No draft is open.')
    await fixture.dispose()
    fixtures.pop()
    const second = await start()
    const projectId = await boundProject(second)
    const plan = ok(await second.callAs('vh_plan_create', { reason: 'propose', continuity: 'chained', references: ['c1@1'], shots: [{ prompt: 'one', duration_sec: 1 }, { prompt: 'two', duration_sec: 1 }] }))
    const block = second.agent.promptBlock('s1')
    expect(block).toContain(`Project ${projectId} on branch draft/s1.`)
    expect(block).toContain('Draft draft/s1 is open with 3 agent change(s) and 0 human edit(s). Only the user accepts or discards it')
    expect(block).toContain('c1@1 character "Lead"')
    expect(block).toContain('Timeline: empty.')
    // The imported picture is listed, so a chat attachment can be used as a reference.
    expect(block).toMatch(/Uploaded images \(newest last\):\n- asset \S+ \/vh\/assets\//)
    expect(block).toContain(`${plan['op_id']}: proposed, waiting for the user`)
    ok(await second.callAs('vh_plan_approve', { reason: 'go', plan: plan['op_id'], user_approved: true }))
    ok(await second.callAs('dv_proj_wait', {}))
    const recent = ok(await second.callAs('dv_proj_state', {}))['recent'] as Array<{ tool: string; op_id: string }>
    const firstShot = recent.find(record => record.tool === 'generate.video')?.op_id // names:allow
    const retake = ok(await second.callAs('vh_generate_video', { reason: 'again', prompt: 'two again', inputs: { reference: 'c1@1' }, base_op: firstShot, user_requested: true }))
    ok(await second.callAs('vh_entity_character_update', { reason: 'new face', entity: 'c1', refs: [second.assets.list()[0]?.id as string], description: 'v2' }))
    const after = second.agent.promptBlock('s1')
    expect(after).toContain('Timeline:')
    expect(after).toContain('/vh/assets/')
    expect(after).toContain('Takes (alternatives')
    expect(after).toContain(String(retake['op_id']))
    expect(after).toContain('Stale records')
    expect(after).toContain('STALE')
    expect(after).toContain('approved by')
    // After the user's accept the session works on main again.
    ok(await second.callAs('dv_proj_draft_accept', {}))
    expect(second.agent.promptBlock('s1')).toContain('No draft is open.')
    expect(second.agent.promptBlock('s1')).toContain('on branch main.')
  })

  it('renders characters, takes, ranges, and plans from a plain state', () => {
    const url = (id: string): string => `/u/${id}`
    const projectId = brandString<ProjectId>('p')
    const state = plainState({ bible: { entities: { c9: [] } }, shot: { takes: { [brandString<RecordId>('root')]: [brandString<RecordId>('root')] } } }) // names:allow
    const text = renderResolverBlock({ projectId, state, branch: branchOf('draft/s1', { agent_changes: 2, human_edits: 1 }), url })
    expect(text).toContain('Draft draft/s1 is open with 2 agent change(s) and 1 human edit(s).')
    expect(renderResolverBlock({ projectId, state, branch: branchOf('main'), url })).toContain('No draft is open.')
    expect(renderResolverBlock({ projectId: null, state: null, branch: null, url })).toContain('start the work with dv_proj_create')
    expect(text).toContain('c9: no version')
    expect(text).not.toContain('Takes')
    // Imported assets have no producing record, a trimmed clip shows its range, a stale producer is flagged, and a plan
    // approved by an unnamed actor says "user".
    const g1 = brandString<RecordId>('g1')
    const a1 = 'a1' as never
    const a2 = 'a2' as never
    const marked = plainState({
      proj: { created_by: { [a2]: g1 }, stale: { [g1]: brandString<RecordId>('g2') } },
      timeline: {
        sequence: { items: [{ slot: 1, assetId: a1, inSec: null, outSec: 4 }, { slot: 2, assetId: a2, inSec: null, outSec: null }] },
      },
      plan: { plans: [{ op: brandString<RecordId>('p1'), approved: true, approvedBy: null }] },
    })
    const lines = renderResolverBlock({ projectId, state: marked, branch: branchOf('main'), url })
    expect(lines).toContain('Entities: none.')
    expect(lines).toContain('slot 1: asset a1 from record upload range 0s-4 /u/a1')
    expect(lines).toContain('slot 2: asset a2 from record g1 STALE /u/a2')
    expect(lines).toContain('g1 (input replaced by g2)')
    expect(lines).toContain('p1: approved by user')
    const noRefs = plainState({ bible: { entities: { c1: [{ version: 1, kind: 'character', name: 'Lead', refs: [], description: '', updatedBy: brandString<RecordId>('u1') }] } } }) // names:allow
    expect(renderResolverBlock({ projectId, state: noRefs, branch: branchOf('main'), url })).toContain('refs none')
    const picked = renderResolverBlock({ projectId, state: noRefs, branch: branchOf('main'), url, selection: { kind: 'op', id: 'g1', surface: 'canvas' } })
    expect(picked).toContain('user selection in the canvas: op g1. "这个 / this" refers to it')
    expect(picked).not.toContain('(timeline slot')
  })
})

describe('turn wiring', () => {
  it('writes the request record of a turn from the user message and tells the agent what the user selected', async () => {
    const fixture = await start({ selection: { kind: 'clip', id: 'shot2.mp4', slot: 2, surface: 'timeline' } })
    expect(fixture.agent.promptBlock('s1')).not.toContain('用户当前选中')
    fixture.emit('turn/start', { turn: 1 })
    fixture.emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'make a dance video' }] })
    const projectId = brandString<ProjectId>(await boundProject(fixture))
    expect(fixture.agent.promptBlock('s1')).toContain('user selection in the timeline: clip shot2.mp4 (timeline slot 2)')
    const requests = fixture.project.listHistory({ project: projectId, kind: 'request' })
    expect(requests.map(entry => entry.record.intent)).toEqual(['make a dance video'])
    // Every agent record of the turn carries the turn of the request record.
    const turn = requests[0]?.record.turn
    expect(turn).not.toBeNull()
    expect(fixture.project.listHistory({ project: projectId, actor: 'agent', kind: 'operation' }).every(entry => entry.record.turn === turn)).toBe(true)
  })

  it('keeps the draft open across turns: the turn end accepts and discards nothing', async () => {
    const fixture = await start()
    fixture.emit('turn/start', { turn: 1 })
    const projectId = brandString<ProjectId>(await boundProject(fixture))
    fixture.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    fixture.emit('turn/start', { turn: 2 })
    fixture.emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'one more picture' }] })
    ok(await fixture.callAs('vh_asset_upload', { reason: 'more', path: fixture.writeFile('b.png'), mime: 'image/png' }))
    fixture.emit('turn/end', { turn: 2, reason: { kind: 'aborted', reason: 'user' } })
    const branch = fixture.project.workingBranch(projectId, brandString('s1'))
    expect(branch.name).toBe('draft/s1')
    expect(branch.counts).toEqual({ agent_changes: 3, human_edits: 0 })
    expect(fixture.project.getState(projectId).components.bible.entities).not.toHaveProperty('c1') // names:allow
    // Two turns, two request records; only the second had the user's words before its first call.
    const requests = fixture.project.listHistory({ project: projectId, kind: 'request' })
    expect(requests.map(entry => entry.record.intent)).toEqual(['one more picture'])
    ok(await fixture.callAs('dv_proj_draft_discard', {}))
    expect(fixture.agent.promptBlock('s1')).toContain('No draft is open.')
  })

  it('ignores events of sessions the registry does not report as live, and messages the user did not type', async () => {
    const fixture = await start({ registry: true })
    fixture.live.agent.session = { id: 'other' }
    fixture.emit('turn/start', { turn: 1 })
    fixture.emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'ignored' }] })
    fixture.live.agent.session = fixture.live.session
    fixture.emit('user/message', { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'not typed' }] })
    const projectId = brandString<ProjectId>(await boundProject(fixture))
    expect(fixture.project.listHistory({ project: projectId, kind: 'request' })).toEqual([])
  })
})

describe('confirmation', () => {
  it('requires the argument protocol when no question channel applies', async () => {
    const fixture = await start()
    await boundProject(fixture)
    const plan = ok(await fixture.callAs('vh_plan_create', { reason: 'propose', references: ['c1@1'], shots: [{ prompt: 'one', duration_sec: 1 }] }))
    const refused = await fixture.callAs('vh_plan_approve', { reason: 'go', plan: plan['op_id'] })
    expect(refused.isError).toBe(true)
    expect(resultText(refused)).toContain('user_approved: true')
    const approved = ok(await fixture.callAs('vh_plan_approve', { reason: 'go', plan: plan['op_id'], user_approved: true }))
    const projectId = fixture.tools.sessionState('s1')?.projectId as ProjectId
    expect(fixture.project.getRecord(projectId, approved['op_id'] as RecordId).params['user_approved']).toBe(true)
    ok(await fixture.callAs('dv_proj_wait', {}))
    // Without an agent on the call the policy answers null as well.
    expect(await fixture.agent.confirm({ spec: fixture.tools.get('plan.approve') as never, summary: 's', estimateGpuSeconds: 0, exec: { agent: undefined, signal: new AbortController().signal } as never })).toBeNull()
  })

  it('asks through the question channel for live root agents and records the answer', async () => {
    const asked: string[] = []
    const fixture = await start({ registry: true, questions: (question) => { asked.push(question); return question.includes('decline-me') ? ['Not now'] : ['Run it'] } })
    await boundProject(fixture)
    const plan = ok(await fixture.callAs('vh_plan_create', { reason: 'propose', references: ['c1@1'], shots: [{ prompt: 'one', duration_sec: 1 }] }))
    ok(await fixture.callAs('vh_plan_approve', { reason: 'approve the plan', plan: plan['op_id'] }))
    expect(asked[0]).toContain('plan.approve: approve the plan')
    // A plan approval states what the plan's shots will cost.
    expect(asked[0]).toContain('Estimated GPU time for this turn: about 4 s')
    ok(await fixture.callAs('dv_proj_wait', {}))
    const declined = await fixture.callAs('vh_plan_approve', { reason: 'decline-me', plan: plan['op_id'] })
    expect(declined.isError).toBe(true)
    expect(resultText(declined)).toContain('declined')
  })

  it('leaves the question to the approval card in the composer\'s ask mode', async () => {
    const fixture = await start({ registry: true, questions: () => new Error('must not be asked') })
    let confirm: 'ask' | 'direct' = 'ask'
    fixture.agent.setComposer({ mode: () => ({ confirm, speed: 'speed' }) })
    const exec = { agent: fixture.live.agent, signal: new AbortController().signal } as never
    const render = fixture.tools.get('generate.video') as never // names:allow
    expect(await fixture.agent.confirm({ spec: render, summary: 's', estimateGpuSeconds: 100, exec })).toBe(true)
    // An operation that never asks first, or a session in direct mode, goes to the question channel.
    expect(await fixture.agent.confirm({ spec: fixture.tools.get('plan.create') as never, summary: 's', estimateGpuSeconds: 0, exec })).toBeNull()
    confirm = 'direct'
    expect(await fixture.agent.confirm({ spec: render, summary: 's', estimateGpuSeconds: 100, exec })).toBeNull()
    await boundProject(fixture)
    expect(fixture.agent.promptBlock('s1')).toContain('User preference: speed.')
    expect(fixture.agent.promptBlock('s1')).not.toContain('approval card')
    confirm = 'ask'
    expect(fixture.agent.promptBlock('s1')).toContain('waits for the user\'s approval card')
    fixture.agent.setComposer({ mode: () => ({ confirm: 'direct', speed: 'quality' }) })
    expect(fixture.agent.promptBlock('s1')).toContain('User preference: quality.')
  })

  it('falls back to the argument protocol when the channel throws or the agent is not a root', async () => {
    const fixture = await start({ registry: true, questions: () => new Error('ASK_ABORTED') })
    await boundProject(fixture)
    const plan = ok(await fixture.callAs('vh_plan_create', { reason: 'propose', references: ['c1@1'], shots: [{ prompt: 'one', duration_sec: 1 }] }))
    const refused = await fixture.callAs('vh_plan_approve', { reason: 'go', plan: plan['op_id'] })
    expect(resultText(refused)).toContain('user_approved: true')
    const child = { id: 's1', session: fixture.live.session }
    expect(await fixture.agent.confirm({ spec: fixture.tools.get('plan.approve') as never, summary: 's', estimateGpuSeconds: 0, exec: { agent: child, signal: new AbortController().signal } as never })).toBeNull()
  })

  it('applies the GPU budget to cost-gated tools and reports the estimate', async () => {
    const asked: string[] = []
    const fixture = await start({ registry: true, threshold: 3, questions: (question) => { asked.push(question); return ['Run it'] } })
    await boundProject(fixture)
    // 1 s at 4 GPU s/s is above the 3 s budget: the channel is asked and its estimate names the cost.
    const shot = ok(await fixture.callAs('vh_generate_video', { reason: 'first', prompt: 'one', duration_sec: 1, inputs: { reference: 'c1@1' } }))
    expect(asked[0]).toContain('GPU time')
    expect((shot['outputs'] as Array<{ url: string }>)[0]?.url).toMatch(/^https:\/\/demo\.example\/vh\/assets\//)
    // user_requested skips the question; an operation that uses no GPU never asks.
    ok(await fixture.callAs('vh_generate_video', { reason: 'second', prompt: 'two', duration_sec: 1, inputs: { reference: 'c1@1' }, user_requested: true }))
    ok(await fixture.callAs('vh_sequence_create', { reason: 'order', assets: [] }))
    expect(asked).toHaveLength(1)
    const state = ok(await fixture.callAs('dv_proj_state', {}))
    expect(JSON.stringify(state)).toContain('https://demo.example/vh/assets/')
    ok(await fixture.callAs('dv_proj_wait', {}))
  })

  it('runs cost-gated calls below the budget without asking', async () => {
    const fixture = await start({ registry: true, questions: () => new Error('must not be asked') })
    await boundProject(fixture)
    const shot = await fixture.callAs('vh_generate_video', { reason: 'cheap', prompt: 'one', duration_sec: 1, inputs: { reference: 'c1@1' } })
    expect(shot.isError).toBe(false)
    ok(await fixture.callAs('dv_proj_wait', {}))
  })
})

describe('prompt section', () => {
  it('is registered with the system prompt and removed on disposal', async () => {
    const fixture = await start()
    const assembled = await fixture.context.systemPrompt.assemble({})
    expect(assembled.sections.some(section => section.name === PROMPT_SECTION)).toBe(true)
    await fixture.agentFiber.dispose()
    const after = await fixture.context.systemPrompt.assemble({})
    expect(after.sections.some(section => section.name === PROMPT_SECTION)).toBe(false)
  })
})
