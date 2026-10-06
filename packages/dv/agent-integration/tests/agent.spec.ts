import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId, Branch, CharacterId, ProjectId, ProjectRecord, ProjectState, RecordId, SessionId } from '@dv/project'
import type { Clip, ClipId, TimelineId } from '@dv/timeline'
import type { PlanId } from '@dv/shot-plan'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DvAgentIntegration, { PROMPT_SECTION } from '../src/index.ts'
import { renderResolverBlock } from '../src/resolver.ts'
import { resultText, startBase, type AgentBase } from './support.ts'

/** A live session and the agent handle the registry reports for it. */
interface FakeLive {
  session: { id: string }
  agent: { id: string; session: { id: string } }
}

interface AgentFixture extends AgentBase {
  agent: DvAgentIntegration
  agentFiber: { dispose(): Promise<void> }
  live: FakeLive
  /** Emit one session event for the live session. */
  emit(type: string, data: Record<string, unknown>): void
  /** Call a DSH tool on behalf of the live agent. */
  callAs(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
}

const fixtures: AgentFixture[] = []

/** Mount the composition plus the agent plugin; `registry` adds a fake `agents` service, `questions` a fake channel. */
interface StartOptions {
  registry?: boolean
  questions?: (question: string) => string[] | Error
  /** The agent's GPU budget per turn; 60 by default. */
  threshold?: number
  /** The asset pool's public URL base; empty by default. */
  publicBaseUrl?: string
  /** Mount a fake `dvApi` that reports this selection for every project. */
  selection?: { kind: 'record' | 'clip' | 'asset' | 'character' | 'location' | 'style'; id: string; surface: 'canvas' | 'timeline' }
}

async function start(options: StartOptions = {}): Promise<AgentFixture> {
  const base = await startBase(options.publicBaseUrl)
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
    base.context.provide('dvApi', { selection: () => selection })
  }
  const agentFiber = base.context.plugin(DvAgentIntegration, {
    promptSectionOrder: 4900, approveLabel: 'Run it', declineLabel: 'Not now', confirmGpuSecondsThreshold: options.threshold ?? 60,
    stateRoot: join(base.root, 'state'),
  })
  await agentFiber.await()
  let calls = 0
  const fixture: AgentFixture = {
    ...base,
    agent: base.context.dvAgentIntegration,
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
  ok(await fixture.callAs('dv_asset_import', { reason: 'reference', path: fixture.writeFile('face.png'), mime: 'image/png' }))
  const image = fixture.assets.list()[0]?.id as string
  ok(await fixture.callAs('dv_bible_character_create', { reason: 'lead', character: 'c1', name: 'Lead', inputs: { reference: [image] } }))
  return created['project_id'] as string
}

/** A plain state for rendering tests: the given slices over empty ones. */
function plainState(components: Partial<{ [K in keyof ProjectState['components']]: Partial<ProjectState['components'][K]> }> = {}): ProjectState {
  return {
    project: { id: brandString<ProjectId>('p'), title: 'p', created_at: '' }, branch: 'main', head: brandString<RecordId>('h'),
    redo_steps: [],
    components: {
      proj: { records: [], stale: {}, superseded: {}, created_by: {}, ...components.proj },
      timeline: { timelines: [], ...components.timeline },
      bible: { characters: {}, locations: {}, styles: {}, ...components.bible },
      plan: { plans: {}, ...components.plan },
      shot: { takes: {}, roots: {}, ...components.shot },
    },
  }
}

/** A branch for rendering tests; `counts` makes it a draft. */
function branchOf(name: string, counts: Branch['counts'] = null): Branch {
  return { name, head: brandString<RecordId>('h'), base: counts === null ? null : 'main', forked_at: null, session: null, counts }
}

describe('resolver block', () => {
  it('tells the agent to roll back with dv_proj_undo and a history record, never with forward edits', () => {
    const rules = renderResolverBlock({ projectId: null, state: null, branch: null, url: id => id })
    expect(rules).toContain('- To roll back ("撤销 / 回到之前 / 撤销到… / 回到上一版 / roll back / go back to"), call dv_proj_undo: '
      + 'without to it undoes one step; with to = a record ID from dv_proj_history_list the project returns to its state just after '
      + 'that record. dv_proj_redo moves forward one step. Both act on the branch you write to (your draft, else main). '
      + 'Never rebuild an earlier state with new edits (dv_timeline_clip_replace, a new plan version) when the user asked to go back.')
    // The skills say the same, and no longer offer a branch in place of an undo to an earlier step.
    const skill = (name: string): string => readFileSync(join(import.meta.dirname, '..', 'skills', name, 'SKILL.md'), 'utf8')
    expect(skill('timeline-editing')).toContain('| `dv_proj_history_list` → `dv_proj_undo` | list: find the record of the step to return to. '
      + 'undo: `to` = that record ID; the project returns to its state just after it.')
    expect(skill('video-directing')).toContain('pass `to` = that record ID, and the project returns to its state just after that record.')
    for (const name of ['timeline-editing', 'video-directing']) {
      expect(skill(name)).not.toContain('one accepted draft')
      expect(skill(name)).not.toContain('offer `dv_proj_branch_create` at the record before')
    }
  })

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
    const plan = ok(await second.callAs('dv_plan_create', { reason: 'propose', continuity: 'chained', references: ['c1@1'], shots: [{ prompt: 'one', duration_sec: 1 }, { prompt: 'two', duration_sec: 1 }] }))
    const block = second.agent.promptBlock('s1')
    expect(block).toContain(`Project ${projectId} on branch draft/s1.`)
    expect(block).toContain('Draft draft/s1 is open with 3 agent change(s) and 0 human edit(s). Only the user accepts or discards it')
    expect(block).toContain('c1@1 character "Lead"')
    expect(block).toContain('Timelines: none.')
    // The imported picture is listed, so a chat attachment can be used as a reference.
    expect(block).toMatch(/Imported images \(newest last\):\n- asset \S+ \/dv\/assets\//)
    expect(plan['report']).toEqual({ plan: 'p1', version: 1 })
    expect(block).toContain('Plans:\n- p1: latest v1 (2 shots), not approved yet')
    ok(await second.callAs('dv_plan_approve', { reason: 'go', plan: 'p1', user_approved: true }))
    ok(await second.callAs('dv_proj_wait', {}))
    const recent = ok(await second.callAs('dv_proj_state', {}))['recent'] as Array<{ operation: string; record: string }>
    const firstShot = recent.find(entry => entry.operation === 'shot.render')?.record
    const retake = ok(await second.callAs('dv_shot_render', { reason: 'again', prompt: 'two again', inputs: { reference: 'c1@1' }, based_on: firstShot, user_requested: true }))
    ok(await second.callAs('dv_bible_character_update', {
      reason: 'new face', character: 'c1', inputs: { reference: [second.assets.list()[0]?.id as string] }, description: 'v2',
    }))
    const after = second.agent.promptBlock('s1')
    expect(after).toContain('Timelines:\n- t1: 2 clips\n  - clip 1 cl1: asset ')
    expect(after).toContain('/dv/assets/')
    expect(after).toContain('Takes (alternatives')
    expect(after).toContain(String(retake['record']))
    expect(after).toContain('Stale records')
    expect(after).toContain('STALE')
    expect(after).toContain('- p1: latest v1 (2 shots), v1 approved')
    // After the user's accept the session works on main again.
    ok(await second.callAs('dv_proj_draft_accept', {}))
    expect(second.agent.promptBlock('s1')).toContain('No draft is open.')
    expect(second.agent.promptBlock('s1')).toContain('on branch main.')
  })

  it('renders characters, takes, ranges, and plans from a plain state', () => {
    const url = (id: string): string => `/u/${id}`
    const projectId = brandString<ProjectId>('p')
    const state = plainState({ shot: { takes: { [brandString<RecordId>('root')]: [brandString<RecordId>('root')] } } })
    const text = renderResolverBlock({ projectId, state, branch: branchOf('draft/s1', { agent_changes: 2, human_edits: 1 }), url })
    expect(text).toContain('Draft draft/s1 is open with 2 agent change(s) and 1 human edit(s).')
    expect(renderResolverBlock({ projectId, state, branch: branchOf('main'), url })).toContain('No draft is open.')
    expect(renderResolverBlock({ projectId: null, state: null, branch: null, url })).toContain('start the work with dv_proj_create')
    expect(text).toContain('Characters, locations and styles: none.')
    expect(text).not.toContain('Takes')
    // Imported assets have no producing record, a trimmed clip shows its range, a stale producer is flagged, a placeholder
    // clip shows its render's status, and a plan is listed once with its latest and approved versions.
    const g1 = brandString<RecordId>('g1')
    const rendering = { id: brandString<RecordId>('g4'), status: 'running' } as ProjectRecord
    const placeholder = (id: string, record: RecordId): Clip => ({
      id: brandString<ClipId>(id), asset: null, source: { record, output: 0 }, in_sec: null, out_sec: null,
    })
    const a1 = 'a1' as never
    const a2 = 'a2' as never
    const marked = plainState({
      proj: { records: [rendering], created_by: { [a2]: g1 }, stale: { [g1]: brandString<RecordId>('g2') } },
      timeline: {
        timelines: [{
          id: brandString<TimelineId>('t1'), name: 'Opening',
          clips: [
            { id: brandString<ClipId>('cl1'), asset: a1, source: null, in_sec: null, out_sec: 4 },
            { id: brandString<ClipId>('cl2'), asset: a2, source: null, in_sec: null, out_sec: null },
          ],
        }, {
          id: brandString<TimelineId>('t2'), name: '', clips: [placeholder('cl3', rendering.id), placeholder('cl4', brandString<RecordId>('g5'))],
        }],
      },
      plan: {
        plans: {
          [brandString<PlanId>('p1')]: [
            { title: 'Dance', shots: [{ prompt: 'a' }], version: 1, created_by: g1, approved_by: brandString<RecordId>('g3') },
            { title: 'Dance', shots: [{ prompt: 'a' }, { prompt: 'b' }], version: 2, created_by: g1, approved_by: null },
          ],
          [brandString<PlanId>('p2')]: [],
        },
      },
    })
    const lines = renderResolverBlock({ projectId, state: marked, branch: branchOf('main'), url })
    expect(lines).toContain('Timelines:\n- t1 "Opening": 2 clips\n  - clip 1 cl1: asset a1 range 0s-4 /u/a1\n  - clip 2 cl2: asset a2 from record g1 STALE /u/a2')
    expect(lines).toContain('- t2: 2 clips\n  - clip 1 cl3: rendering, record g4\n  - clip 2 cl4: render failed, record g5')
    expect(lines).toContain('g1 (input replaced by g2)')
    expect(lines.endsWith('Plans:\n- p1 "Dance": latest v2 (2 shots), v1 approved')).toBe(true)
    const lead = { id: brandString<CharacterId>('c1'), version: 1, name: 'Lead', references: [], description: '', created_by: brandString<RecordId>('u1') }
    const noRefs = plainState({ bible: { characters: { [lead.id]: [lead] } } })
    expect(renderResolverBlock({ projectId, state: noRefs, branch: branchOf('main'), url })).toContain('- c1@1 character "Lead" references none')
    const picked = renderResolverBlock({ projectId, state: noRefs, branch: branchOf('main'), url, selection: { kind: 'record', id: 'g1', surface: 'canvas' } })
    expect(picked).toContain('user selection in the canvas: record g1. "这个 / this" refers to it')
  })
})

describe('turn wiring', () => {
  it('writes the request record of a turn from the user message and tells the agent what the user selected', async () => {
    const fixture = await start({ selection: { kind: 'clip', id: 'cl2', surface: 'timeline' } })
    expect(fixture.agent.promptBlock('s1')).not.toContain('用户当前选中')
    fixture.emit('turn/start', { turn: 1 })
    fixture.emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'make a dance video' }] })
    const projectId = brandString<ProjectId>(await boundProject(fixture))
    expect(fixture.agent.promptBlock('s1')).toContain('user selection in the timeline: clip cl2. ')
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
    ok(await fixture.callAs('dv_asset_import', { reason: 'more', path: fixture.writeFile('b.png'), mime: 'image/png' }))
    fixture.emit('turn/end', { turn: 2, reason: { kind: 'aborted', reason: 'user' } })
    const branch = fixture.project.workingBranch(projectId, brandString<SessionId>('s1'))
    expect(branch.name).toBe('draft/s1')
    expect(branch.counts).toEqual({ agent_changes: 3, human_edits: 0 })
    expect(fixture.project.getState(projectId).components.bible.characters).not.toHaveProperty('c1')
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
    ok(await fixture.callAs('dv_plan_create', { reason: 'propose', references: ['c1@1'], shots: [{ prompt: 'one', duration_sec: 1 }] }))
    const refused = await fixture.callAs('dv_plan_approve', { reason: 'go', plan: 'p1' })
    expect(refused.isError).toBe(true)
    expect(resultText(refused)).toContain('user_approved: true')
    const approved = ok(await fixture.callAs('dv_plan_approve', { reason: 'go', plan: 'p1', user_approved: true }))
    const projectId = fixture.project.sessionProject(brandString<SessionId>('s1')) as ProjectId
    expect(fixture.project.getRecord(projectId, approved['record'] as RecordId).params['user_approved']).toBe(true)
    ok(await fixture.callAs('dv_proj_wait', {}))
    // Without an agent on the call the policy answers null as well.
    expect(await fixture.agent.confirm({ spec: fixture.project.listOperations().find(spec => spec.name === 'plan.approve') as never, summary: 's', gpuSeconds: 0, exec: { agent: undefined, signal: new AbortController().signal } as never })).toBeNull()
  })

  it('asks through the question channel for live root agents and records the answer', async () => {
    const asked: string[] = []
    const fixture = await start({ registry: true, questions: (question) => { asked.push(question); return question.includes('decline-me') ? ['Not now'] : ['Run it'] } })
    await boundProject(fixture)
    ok(await fixture.callAs('dv_plan_create', { reason: 'propose', references: ['c1@1'], shots: [{ prompt: 'one', duration_sec: 1 }] }))
    ok(await fixture.callAs('dv_plan_approve', { reason: 'approve the plan', plan: 'p1' }))
    expect(asked[0]).toContain('dv_plan_approve: approve the plan')
    // A plan approval states what the plan's shots will cost.
    expect(asked[0]).toContain('Estimated GPU time for this turn: about 4 s')
    ok(await fixture.callAs('dv_proj_wait', {}))
    const declined = await fixture.callAs('dv_plan_approve', { reason: 'decline-me', plan: 'p1' })
    expect(declined.isError).toBe(true)
    expect(resultText(declined)).toContain('declined')
  })

  it('leaves the question to the approval card in the composer\'s ask mode', async () => {
    const fixture = await start({ registry: true, questions: () => new Error('must not be asked') })
    fixture.agent.updateComposerMode('s1', { confirm: 'ask', speed: 'speed' })
    const exec = { agent: fixture.live.agent, signal: new AbortController().signal } as never
    const render = fixture.project.listOperations().find(spec => spec.name === 'shot.render') as never
    expect(await fixture.agent.confirm({ spec: render, summary: 's', gpuSeconds: 100, exec })).toBe(true)
    // An operation that never asks first, or a session in direct mode, goes to the question channel.
    expect(await fixture.agent.confirm({ spec: fixture.project.listOperations().find(spec => spec.name === 'plan.create') as never, summary: 's', gpuSeconds: 0, exec })).toBeNull()
    fixture.agent.updateComposerMode('s1', { confirm: 'direct' })
    expect(await fixture.agent.confirm({ spec: render, summary: 's', gpuSeconds: 100, exec })).toBeNull()
    await boundProject(fixture)
    expect(fixture.agent.promptBlock('s1')).toContain('User preference: speed.')
    expect(fixture.agent.promptBlock('s1')).not.toContain('approval card')
    fixture.agent.updateComposerMode('s1', { confirm: 'ask' })
    expect(fixture.agent.promptBlock('s1')).toContain('waits for the user\'s approval card')
    fixture.agent.updateComposerMode('s1', { confirm: 'direct', speed: 'quality' })
    expect(fixture.agent.promptBlock('s1')).toContain('User preference: quality.')
  })

  it('falls back to the argument protocol when the channel throws or the agent is not a root', async () => {
    const fixture = await start({ registry: true, questions: () => new Error('ASK_ABORTED') })
    await boundProject(fixture)
    ok(await fixture.callAs('dv_plan_create', { reason: 'propose', references: ['c1@1'], shots: [{ prompt: 'one', duration_sec: 1 }] }))
    const refused = await fixture.callAs('dv_plan_approve', { reason: 'go', plan: 'p1' })
    expect(resultText(refused)).toContain('user_approved: true')
    const child = { id: 's1', session: fixture.live.session }
    expect(await fixture.agent.confirm({ spec: fixture.project.listOperations().find(spec => spec.name === 'plan.approve') as never, summary: 's', gpuSeconds: 0, exec: { agent: child, signal: new AbortController().signal } as never })).toBeNull()
  })

  it('applies the GPU budget to cost-gated tools and reports the estimate', async () => {
    const asked: string[] = []
    const fixture = await start({
      registry: true, threshold: 3, publicBaseUrl: 'https://demo.example', questions: (question) => { asked.push(question); return ['Run it'] },
    })
    await boundProject(fixture)
    // 1 s at 4 GPU s/s is above the 3 s budget: the channel is asked and its estimate names the cost.
    const shot = ok(await fixture.callAs('dv_shot_render', { reason: 'first', prompt: 'one', duration_sec: 1, inputs: { reference: 'c1@1' } }))
    expect(asked[0]).toContain('GPU time')
    expect((shot['outputs'] as Array<{ url: string }>)[0]?.url).toMatch(/^https:\/\/demo\.example\/dv\/assets\//)
    // user_requested skips the question; an operation that uses no GPU never asks.
    ok(await fixture.callAs('dv_shot_render', { reason: 'second', prompt: 'two', duration_sec: 1, inputs: { reference: 'c1@1' }, user_requested: true }))
    ok(await fixture.callAs('dv_timeline_create', { reason: 'order', assets: [] }))
    expect(asked).toHaveLength(1)
    const state = ok(await fixture.callAs('dv_proj_state', {}))
    expect(JSON.stringify(state)).toContain('https://demo.example/dv/assets/')
    ok(await fixture.callAs('dv_proj_wait', {}))
  })

  it('runs cost-gated calls below the budget without asking', async () => {
    const fixture = await start({ registry: true, questions: () => new Error('must not be asked') })
    await boundProject(fixture)
    const shot = await fixture.callAs('dv_shot_render', { reason: 'cheap', prompt: 'one', duration_sec: 1, inputs: { reference: 'c1@1' } })
    expect(shot.isError).toBe(false)
    ok(await fixture.callAs('dv_proj_wait', {}))
  })
})

describe('question rule', () => {
  it('adds user_approved and user_requested to the two tools while the agent is mounted', async () => {
    const fixture = await start()
    const parameters = (name: string): string =>
      JSON.stringify(fixture.context.tools.schemas().find(tool => tool.name === name)?.parameters)
    expect(parameters('dv_plan_approve')).toContain('user_approved')
    expect(parameters('dv_shot_render')).toContain('user_requested')
    expect(parameters('dv_plan_create')).not.toContain('user_')
    await fixture.agentFiber.dispose()
    expect(parameters('dv_plan_approve')).not.toContain('user_approved')
    expect(parameters('dv_shot_render')).not.toContain('user_requested')
  })

  it('refuses a cost-gated call above the budget when no question channel applies', async () => {
    const fixture = await start()
    await boundProject(fixture)
    // 20 s at 4 GPU s/s is 80, above the 60 s budget; the turn has spent nothing yet.
    const refused = await fixture.callAs('dv_shot_render', { reason: 'long shot', prompt: 'one', duration_sec: 20, inputs: { reference: 'c1@1' } })
    expect(refused.isError).toBe(true)
    expect(resultText(refused)).toContain('about 80 GPU seconds, above the 60 s budget')
    expect(resultText(refused)).toContain('user_requested: true')
  })

  it('asks one question per plan version, listing the shots it renders with their cost', async () => {
    const fixture = await start()
    await boundProject(fixture)
    const asked = vi.spyOn(fixture.agent, 'confirm').mockResolvedValue(true)
    ok(await fixture.callAs('dv_plan_create', {
      reason: 'propose', references: ['c1@1'], shots: [{ prompt: 'walks', duration_sec: 1 }, { prompt: 'turns', duration_sec: 2 }],
    }))
    const approved = ok(await fixture.callAs('dv_plan_approve', { reason: 'go', plan: 'p1' }))
    expect(approved['params']).toEqual({ plan: 'p1' })
    expect(asked).toHaveBeenCalledTimes(1)
    expect(asked.mock.calls[0]?.[0]).toMatchObject({
      gpuSeconds: 12, params: { prompt: '1. walks (1 s)\n2. turns (2 s)', duration_sec: 3, plan: 'p1', version: 1 },
      inputs: [{ role: 'reference', ref: { character: 'c1', version: 1 } }],
    })
    ok(await fixture.callAs('dv_proj_wait', {}))
    // Version 2 appends shot 3: the question lists only that shot and its cost.
    ok(await fixture.callAs('dv_plan_update', {
      reason: 'longer', plan: 'p1', references: ['c1@1'],
      shots: [{ prompt: 'walks', duration_sec: 1 }, { prompt: 'turns', duration_sec: 2 }, { prompt: 'jumps', duration_sec: 1 }],
    }))
    ok(await fixture.callAs('dv_plan_approve', { reason: 'go on', plan: 'p1' }))
    expect(asked.mock.calls[1]?.[0]).toMatchObject({ gpuSeconds: 4, params: { prompt: '3. jumps (1 s)', duration_sec: 1, plan: 'p1', version: 2 } })
    ok(await fixture.callAs('dv_proj_wait', {}))
    // A declined question refuses the call before any record.
    asked.mockResolvedValue(false)
    expect(resultText(await fixture.callAs('dv_plan_approve', { reason: 'again', plan: 'p1' }))).toContain('The user declined dv_plan_approve')
  })

  it('refuses a plan approval without reference images before asking the user', async () => {
    const asked: string[] = []
    const fixture = await start({ registry: true, questions: (question) => { asked.push(question); return ['Run it'] } })
    const projectId = brandString<ProjectId>(await boundProject(fixture))
    ok(await fixture.callAs('dv_plan_create', {
      reason: 'propose', shots: [{ prompt: 'one', duration_sec: 1, references: ['c1@1'] }, { prompt: 'two', duration_sec: 1 }],
    }))
    const records = fixture.project.listHistory({ project: projectId }).length
    const refused = await fixture.callAs('dv_plan_approve', { reason: 'go', plan: 'p1' })
    expect(resultText(refused)).toContain('Shot 2 of the plan has no reference image. The video model renders every shot from 1 to 2')
    expect(asked).toEqual([])
    expect(fixture.project.listHistory({ project: projectId })).toHaveLength(records)
  })
})

describe('chat images', () => {
  it('imports the images a user attached in a bound chat as project assets on the working branch', async () => {
    const fixture = await start()
    const image = await fixture.attachments.saveImage({ data: Buffer.from('chat-image'), mediaType: 'image/png', name: 'cat.png' })
    const message = { source: { kind: 'user' }, content: [{ type: 'image', attachment: image }] }
    // Without a bound project the image stays in the chat only.
    fixture.emit('user/message', message)
    const projectId = brandString<ProjectId>(await boundProject(fixture))
    fixture.emit('user/message', message)
    // The session's next tool call waits for the import.
    ok(await fixture.callAs('dv_timeline_create', { reason: 'order', assets: [] }))
    const imported = fixture.project.listHistory({ project: projectId, actor: 'user', operation: 'asset.import' }).map(entry => entry.record)
    expect(imported).toEqual([expect.objectContaining({
      surface: 'chat', turn: null, branch: 'draft/s1', params: expect.objectContaining({ name: 'cat.png', mime: 'image/png' }),
    })])
    const asset = imported[0]?.outputs[0] as AssetId
    expect(fixture.assets.read(asset).toString()).toBe('chat-image')
    expect(fixture.agent.promptBlock('s1')).toContain(`asset ${asset} "cat.png"`)
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
