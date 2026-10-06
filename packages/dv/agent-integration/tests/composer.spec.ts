/** The composer as `dvProject`'s approval channel: ask-first agent calls wait for the user's card; the composer routes. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CharacterId, RecordOrigin, RunRequest, SessionId } from '@dv/project'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DvAgentIntegration, { COMPOSER_ROUTES } from '../src/index.ts'
import { expansionMessage } from '../src/composer.ts'
import { startBase, type BaseFixture } from '../../api/tests/support.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The base fixture plus the agent integration, with the composer modes file under a temporary state root. */
async function start(): Promise<{ fixture: BaseFixture; composer: DvAgentIntegration; stateRoot: string }> {
  const stateRoot = mkdtempSync(join(tmpdir(), 'dv-composer-'))
  cleanups.push(() => { rmSync(stateRoot, { recursive: true, force: true }) })
  const fixture = await startBase({ dsh: false })
  cleanups.push(() => fixture.dispose())
  const config = { promptSectionOrder: 4900, approveLabel: 'Run it', declineLabel: 'Not now', confirmGpuSecondsThreshold: 60, stateRoot }
  await fixture.context.plugin(DvAgentIntegration, config).await()
  return { fixture, composer: fixture.context.dvAgentIntegration, stateRoot }
}

describe('approval channel', () => {
  it('holds an agent render in ask mode until the card is approved or skipped, and lists the shots a plan approval renders', async () => {
    const { fixture, composer } = await start()
    const session = brandString<SessionId>('s1')
    composer.updateComposerMode('s1', { confirm: 'ask' })
    expect(composer.asksFirst(session)).toBe(true)
    const user: RecordOrigin = { actor: 'user', surface: 'canvas', session: null, turn: null, tool_call: null, intent: 'set up' }
    const info = await fixture.project.createProject('cards', user)
    const picture = await fixture.project.run({
      ...user, project: info.id, operation: 'asset.import', inputs: [],
      params: { path: fixture.writeFile('face.png'), mime: 'image/png' },
    })
    await fixture.project.run({
      ...user, project: info.id, operation: 'bible.character_create',
      inputs: picture.outputs.map(asset => ({ role: 'reference', ref: { asset } })), params: { character: 'c1', name: 'Lead' },
    })
    const agent = (intent: string, operation: string, params: Record<string, unknown>, inputs: RunRequest['inputs'] = []) =>
      fixture.project.run({
        actor: 'agent', surface: 'chat', session, turn: null, tool_call: `call-${intent}`, intent,
        project: info.id, operation, params, inputs,
      })
    const reference: RunRequest['inputs'] = [{ role: 'reference', ref: { character: brandString<CharacterId>('c1'), version: 1 } }]

    const approved = agent('first', 'shot.render', { prompt: 'Picture 1 waves', duration_sec: 1 }, reference)
    await vi.waitFor(() => { expect(composer.approvals('s1')).toHaveLength(1) })
    const card = composer.approvals('s1')[0]
    expect(card).toMatchObject({ operation: 'shot.render', tool_call: 'call-first', session: 's1', prompt: 'Picture 1 waves' })
    expect(card).toMatchObject({ duration_sec: 1, gpu_seconds: 4 })
    expect(card?.references[0]).toMatchObject({ role: 'reference', ref: 'c1@1', asset: picture.outputs[0] })
    const waiting = fixture.project.listHistory({ project: info.id, operation: 'shot.render' })[0]?.record
    expect(waiting?.status).toBe('pending')
    expect(composer.answer('s1', 'all', true)).toBe(1)
    expect((await approved).record?.status).toBe('done')

    const skipped = agent('second', 'shot.render', { prompt: 'Picture 1 bows', duration_sec: 1 }, reference)
    await vi.waitFor(() => { expect(composer.approvals('s1')).toHaveLength(1) })
    composer.answer('s1', composer.approvals('s1')[0]?.id ?? '', false)
    expect((await skipped).record).toMatchObject({ status: 'cancelled', error: { code: 'skipped' } })

    const shots = [{ prompt: 'one', duration_sec: 1 }, { prompt: 'two', duration_sec: 2 }]
    const plan = await agent('propose', 'plan.create', { references: ['c1@1'], shots })
    const approval = agent('go', 'plan.approve', { plan: plan.record?.report?.['plan'] })
    await vi.waitFor(() => { expect(composer.approvals('s1')).toHaveLength(1) })
    expect(composer.approvals('s1')[0]).toMatchObject({
      operation: 'plan.approve', prompt: '1. one (1 s)\n2. two (2 s)', duration_sec: 3, gpu_seconds: 12,
    })
    expect(composer.approvals('s1')[0]?.references[0]).toMatchObject({ ref: 'c1@1', asset: picture.outputs[0] })
    composer.answer('s1', 'all', false)
    expect((await approval).record?.status).toBe('cancelled')

    // A session in direct mode is not held.
    composer.updateComposerMode('s1', { confirm: 'direct' })
    const direct = await agent('direct', 'shot.render', { prompt: 'Picture 1 sits', duration_sec: 1 }, reference)
    expect(direct.record?.status).toBe('done')
  })

  it('serves the composer modes and approval cards on the composer routes, and keeps the modes under the state root', async () => {
    const { composer, stateRoot } = await start()
    const routes = new Map(composer.fetchRoutes().map(route => [route.path, route]))
    const call = async (path: string, init: { query?: string; body?: unknown } = {}): Promise<{ status: number; json: unknown }> => {
      const route = routes.get(path)
      if (route === undefined) throw new Error(`No route ${path}`)
      const request = new Request(`http://localhost${path}${init.query ?? ''}`, init.body === undefined
        ? {}
        : { method: 'POST', body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } })
      const response = await route.fetch(request)
      return { status: response.status, json: await response.json() }
    }
    expect(await call(COMPOSER_ROUTES.mode, { query: '?session=s1' }))
      .toEqual({ status: 200, json: { confirm: 'direct', speed: 'quality' } })
    expect((await call(COMPOSER_ROUTES.mode, { body: { session: 's1', confirm: 'ask' } })).json)
      .toEqual({ confirm: 'ask', speed: 'quality' })
    expect(readFileSync(join(stateRoot, 'composer-modes.json'), 'utf8')).toContain('"ask"')
    expect((await call(COMPOSER_ROUTES.mode, { query: '?session=' })).status).toBe(400)
    expect(await call(COMPOSER_ROUTES.approvals, { query: '?session=s1' })).toEqual({ status: 200, json: [] })
    expect((await call(COMPOSER_ROUTES.approvals, { body: { session: 's1', all: true, action: 'skip' } })).json).toEqual({ answered: 0 })
  })
})

describe('mention expansion', () => {
  it('expands a character mention from the chat session\'s open draft, not from main', async () => {
    const { fixture } = await start()
    const session = brandString<SessionId>('s1')
    const user: RecordOrigin = { actor: 'user', surface: 'canvas', session: null, turn: null, tool_call: null, intent: 'set up' }
    const info = await fixture.project.createProject('mentions', user)
    fixture.project.bindSession(session, info.id)
    const picture = await fixture.project.run({
      ...user, project: info.id, operation: 'asset.import', inputs: [],
      params: { path: fixture.writeFile('face.png'), mime: 'image/png' },
    })
    const reference: RunRequest['inputs'] = picture.outputs.map(asset => ({ role: 'reference', ref: { asset } }))
    await fixture.project.run({
      ...user, project: info.id, operation: 'bible.character_create', inputs: reference, params: { character: 'c1', name: 'Lead' },
    })
    // The agent's update opens draft/s1; version 2 of c1 exists only there.
    await fixture.project.run({
      actor: 'agent', surface: 'chat', session, turn: null, tool_call: 'call-update', intent: 'rename the lead',
      project: info.id, operation: 'bible.character_update', inputs: reference, params: { character: 'c1', name: 'Lead on draft' },
    })
    expect(fixture.project.workingBranch(info.id, session).name).toBe('draft/s1')
    expect(fixture.project.getState(info.id).components.bible.characters[brandString<CharacterId>('c1')]).toHaveLength(1)

    const message = createUserMessage({ content: [{ type: 'text', text: 'make @[Lead](dv:character/c1) wave' }], source: { kind: 'user' } })
    const expansion = expansionMessage(fixture.context, 's1', [message])
    const text = expansion?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
    expect(text).toContain('character c1@2 "Lead on draft"')
    expect(text).toContain('pass it as input c1@2')
  })
})
