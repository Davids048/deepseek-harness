import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ProjectId } from '@video-harness/oplog'
import { afterEach, describe, expect, it } from 'vitest'
import VhAgent, { PROMPT_SECTION, renderResolverBlock, sessionBranch } from '../src/index.ts'
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

/** A project bound to the live session with one character. */
async function boundProject(fixture: AgentFixture): Promise<string> {
  const created = ok(await fixture.callAs('vh_project_create', { title: 'dance' }))
  ok(await fixture.callAs('vh_asset_upload', { reason: 'reference', path: fixture.writeFile('face.png'), mime: 'image/png' }))
  const image = fixture.assets.list()[0]?.id as string
  ok(await fixture.callAs('vh_entity_character_create', { reason: 'lead', entity: 'c1', name: 'Lead', refs: [image] }))
  return created['project_id'] as string
}

describe('resolver block', () => {
  it('renders the rules alone without a project and a full snapshot with one', async () => {
    const fixture = await start()
    expect(fixture.agent.promptBlock(undefined)).toContain('No project is bound')
    expect(fixture.agent.promptBlock('nobody')).toContain('No project is bound')
    const projectId = await boundProject(fixture)
    const plan = ok(await fixture.callAs('vh_plan_create', { reason: 'propose', continuity: 'chained', references: ['c1@1'], shots: [{ prompt: 'one', duration_sec: 1 }, { prompt: 'two', duration_sec: 1 }] }))
    const block = fixture.agent.promptBlock('s1')
    expect(block).toContain(`Project ${projectId} on branch draft/`)
    expect(block).toContain('c1@1 character "Lead"')
    expect(block).toContain('Timeline: empty.')
    // The uploaded picture is listed, so a chat attachment can be used as a reference.
    expect(block).toMatch(/Uploaded images \(newest last\):\n- asset \S+ \/vh\/assets\//)
    expect(block).toContain(`${plan['op_id']}: proposed, waiting for the user`)
    expect(block).toContain('Open draft')
    expect(block).toContain('from this turn.')
    ok(await fixture.callAs('vh_plan_approve', { reason: 'go', plan: plan['op_id'], user_approved: true }))
    ok(await fixture.callAs('vh_wait', {}))
    const retake = ok(await fixture.callAs('vh_generate_video', { reason: 'again', prompt: 'two again', inputs: { reference: 'c1@1' }, base_op: (ok(await fixture.callAs('vh_project_state', {}))['recent'] as Array<{ tool: string; op_id: string }>).find(record => record.tool === 'generate.video')?.op_id, user_requested: true }))
    ok(await fixture.callAs('vh_entity_character_update', { reason: 'new face', entity: 'c1', refs: [fixture.assets.list()[0]?.id as string], description: 'v2' }))
    const after = fixture.agent.promptBlock('s1')
    expect(after).toContain('Timeline:')
    expect(after).toContain('https://demo.example'.length > 0 ? '/vh/assets/' : '')
    expect(after).toContain('Takes (alternatives')
    expect(after).toContain(String(retake['op_id']))
    expect(after).toContain('Stale records')
    expect(after).toContain('STALE')
    expect(after).toContain('approved by')
    // An exploration branch is named as such and takes a range line when a slot is trimmed.
    ok(await fixture.callAs('vh_turn_accept', {}))
    ok(await fixture.callAs('vh_branch_create', { name: 'style-b' }))
    ok(await fixture.callAs('vh_sequence_set_range', { reason: 'shorten', slot: 1, inSec: 0.2 }))
    const branched = fixture.agent.promptBlock('s1')
    expect(branched).toContain('exploration branch')
    expect(branched).toContain('range 0.2s-end')
    expect(branched).toContain('no draft to accept')
    expect(fixture.agent.promptBlock('s1')).not.toContain('No draft is open.')
  })

  it('renders entity, take, and branch helpers from a plain state', () => {
    const empty = { projectId: null, turn: null, turnProject: null, branch: null, dshTurn: null, turnOpenedAt: null }
    expect(sessionBranch(empty, undefined)).toBe('main')
    expect(sessionBranch({ ...empty, branch: 'b' }, undefined)).toBe('b')
    expect(sessionBranch({ ...empty, branch: 'b' }, 'draft/x')).toBe('draft/x')
    const state = {
      projectId: 'p' as ProjectId, head: 'h' as never, ops: [], assets: new Set<never>(), producers: {}, entities: { c9: [] }, sequence: null,
      stale: {}, superseded: {}, turns: {}, takes: { root: ['root'] }, plans: [],
    }
    const text = renderResolverBlock({ session: { ...empty, turn: 't' as never }, projectId: 'p' as ProjectId, state, branch: 'main', openDraft: true, draftFromEarlierTurn: true, url: id => `/u/${id}` })
    expect(renderResolverBlock({ session: empty, projectId: 'p' as ProjectId, state, branch: 'main', openDraft: false, draftFromEarlierTurn: false, url: id => `/u/${id}` })).toContain('No draft is open.')
    // A turn the user accepted or discarded in a view is no longer an open draft, though the session still names it.
    expect(renderResolverBlock({ session: { ...empty, turn: 't' as never }, projectId: 'p' as ProjectId, state, branch: 'main', openDraft: false, draftFromEarlierTurn: false, url: id => `/u/${id}` })).toContain('No draft is open.')
    expect(renderResolverBlock({ session: { ...empty, branch: 'style-b' }, projectId: 'p' as ProjectId, state, branch: 'style-b', openDraft: false, draftFromEarlierTurn: false, url: id => `/u/${id}` })).toContain('no draft to accept')
    expect(text).toContain('c9: no version')
    expect(text).toContain('from an earlier turn: call vh_turn_accept')
    expect(text).not.toContain('Takes')
    // Uploaded assets have no producing record, a trimmed slot shows its range, and a plan approved by an unnamed actor says "user".
    const uploaded = {
      ...state, entities: {}, producers: { a2: 'g1' as never }, stale: { g1: { because: 'g2' as never } },
      sequence: { items: [{ slot: 1, assetId: 'a1' as never, inSec: null, outSec: 4 }, { slot: 2, assetId: 'a2' as never, inSec: null, outSec: null }] },
      plans: [{ op: 'p1' as never, approved: true, approvedBy: null }],
    }
    const lines = renderResolverBlock({ session: empty, projectId: 'p' as ProjectId, state: uploaded, branch: 'main', openDraft: false, draftFromEarlierTurn: false, url: id => `/u/${id}` })
    expect(lines).toContain('Entities: none.')
    expect(lines).toContain('slot 1: asset a1 from record upload range 0s-4 /u/a1')
    expect(lines).toContain('slot 2: asset a2 from record g1 STALE /u/a2')
    expect(lines).toContain('p1: approved by user')
    const noRefs = { ...state, entities: { c1: [{ version: 1, kind: 'character', name: 'Lead', refs: [], description: '', updatedBy: 'u1' as never }] } }
    expect(renderResolverBlock({ session: empty, projectId: 'p' as ProjectId, state: noRefs, branch: 'main', openDraft: false, draftFromEarlierTurn: false, url: id => `/u/${id}` })).toContain('refs none')
    const picked = renderResolverBlock({ session: empty, projectId: 'p' as ProjectId, state: noRefs, branch: 'main', openDraft: false, draftFromEarlierTurn: false, url: id => `/u/${id}`, selection: { kind: 'op', id: 'g1', surface: 'canvas' } })
    expect(picked).toContain('user selection in the canvas: op g1. "这个 / this" refers to it')
    expect(picked).not.toContain('(timeline slot')
  })
})

describe('turn wiring', () => {
  it('accepts a draft of deterministic work when the turn completes and tells the agent what the user selected', async () => {
    const fixture = await start({ selection: { kind: 'clip', id: 'shot2.mp4', slot: 2, surface: 'timeline' } })
    expect(fixture.agent.promptBlock('s1')).not.toContain('用户当前选中')
    fixture.emit('turn/start', { turn: 1 })
    await boundProject(fixture)
    expect(fixture.agent.promptBlock('s1')).toContain('user selection in the timeline: clip shot2.mp4 (timeline slot 2)')
    fixture.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(fixture.agent.settled.at(-1)).toMatchObject({ turn: 1, outcome: 'accepted' })
    expect(fixture.tools.sessionState('s1')?.turn).toBeNull()
    expect(fixture.agent.promptBlock('s1')).toContain('c1@1')
  })

  it('notes turns, keeps a draft with records, rejects empty or aborted drafts', async () => {
    const fixture = await start()
    fixture.emit('turn/start', { turn: 1 })
    expect(fixture.tools.sessionState('s1')?.dshTurn).toBe(1)
    fixture.emit('step/start', { turn: 1, step: 1 })
    expect(fixture.agent.settled).toEqual([])
    fixture.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(fixture.agent.settled.at(-1)).toEqual({ session: 's1', turn: 1, outcome: 'none' })
    fixture.emit('turn/start', { turn: 2 })
    await boundProject(fixture)
    ok(await fixture.callAs('vh_generate_video', { reason: 'try', prompt: 'one', duration_sec: 1, inputs: { reference: 'c1@1' } }))
    const state = fixture.tools.sessionState('s1')
    expect(state?.turnOpenedAt).toBe(2)
    // The draft holds a generation the user did not ask for by name: it waits for the user.
    fixture.emit('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(fixture.agent.settled.at(-1)?.outcome).toBe('kept')
    expect(state?.turn).not.toBeNull()
    // The next turn may not extend the kept draft until it is accepted or rejected.
    fixture.emit('turn/start', { turn: 3 })
    const blocked = await fixture.callAs('vh_asset_upload', { reason: 'more', path: fixture.writeFile('b.png'), mime: 'image/png' })
    expect(blocked.isError).toBe(true)
    expect(resultText(blocked)).toContain('still open')
    ok(await fixture.callAs('vh_turn_accept', {}))
    ok(await fixture.callAs('vh_asset_upload', { reason: 'more', path: fixture.writeFile('b.png'), mime: 'image/png' }))
    expect(fixture.tools.sessionState('s1')?.turnOpenedAt).toBe(3)
    fixture.emit('turn/end', { turn: 3, reason: { kind: 'aborted', reason: 'user' } })
    expect(fixture.agent.settled.at(-1)?.outcome).toBe('rejected')
    expect(fixture.tools.sessionState('s1')?.turn).toBeNull()
    // A turn whose only record is its intent is rejected on completion; interrupted turns keep their records.
    fixture.emit('turn/start', { turn: 4 })
    ok(await fixture.callAs('vh_project_state', {}))
    fixture.emit('turn/end', { turn: 4, reason: { kind: 'completed' } })
    expect(fixture.agent.settled.at(-1)?.outcome).toBe('none')
    fixture.emit('turn/start', { turn: 5 })
    ok(await fixture.callAs('vh_asset_upload', { reason: 'c', path: fixture.writeFile('c.png'), mime: 'image/png' }))
    fixture.emit('turn/end', { turn: 5, reason: { kind: 'interrupted' } })
    expect(fixture.agent.settled.at(-1)?.outcome).toBe('kept')
    expect(fixture.agent.promptBlock('s1')).toContain('from this turn.')
    fixture.emit('turn/start', { turn: 6 })
    expect(fixture.agent.promptBlock('s1')).toContain('from an earlier turn')
  })

  it('ignores events of sessions the registry does not report as live', async () => {
    const fixture = await start({ registry: true })
    fixture.live.agent.session = { id: 'other' }
    fixture.emit('turn/start', { turn: 1 })
    expect(fixture.tools.sessionState('s1')?.dshTurn).toBeNull()
    fixture.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(fixture.agent.settled).toEqual([])
    fixture.live.agent.session = fixture.live.session
    fixture.emit('turn/start', { turn: 2 })
    expect(fixture.tools.sessionState('s1')?.dshTurn).toBe(2)
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
    expect(fixture.log.get(fixture.tools.sessionState('s1')?.projectId as ProjectId, approved['op_id'] as never).params['user_approved']).toBe(true)
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
    ok(await fixture.callAs('vh_wait', {}))
    const declined = await fixture.callAs('vh_plan_approve', { reason: 'decline-me', plan: plan['op_id'] })
    expect(declined.isError).toBe(true)
    expect(resultText(declined)).toContain('declined')
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
    // user_requested skips the question; a free tool never asks.
    ok(await fixture.callAs('vh_generate_video', { reason: 'second', prompt: 'two', duration_sec: 1, inputs: { reference: 'c1@1' }, user_requested: true }))
    ok(await fixture.callAs('vh_sequence_create', { reason: 'order', assets: [] }))
    expect(asked).toHaveLength(1)
    const state = ok(await fixture.callAs('vh_project_state', {}))
    expect(JSON.stringify(state)).toContain('https://demo.example/vh/assets/')
    ok(await fixture.callAs('vh_wait', {}))
  })

  it('runs cost-gated calls below the budget without asking', async () => {
    const fixture = await start({ registry: true, questions: () => new Error('must not be asked') })
    await boundProject(fixture)
    const shot = await fixture.callAs('vh_generate_video', { reason: 'cheap', prompt: 'one', duration_sec: 1, inputs: { reference: 'c1@1' } })
    expect(shot.isError).toBe(false)
    ok(await fixture.callAs('vh_wait', {}))
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
