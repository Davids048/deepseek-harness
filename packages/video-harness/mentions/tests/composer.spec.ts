/** The composer as `dvProject`'s approval channel: ask-first agent calls wait for the user's card. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RecordOrigin, RunRequest, SessionId } from '@dv/project'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VhComposer from '../src/index.ts'
import { startTools, type ToolsFixture } from '../../tools/tests/support.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The tools fixture plus the composer, with the composer modes file under a temporary state root. */
async function start(): Promise<{ fixture: ToolsFixture; composer: VhComposer }> {
  const stateRoot = mkdtempSync(join(tmpdir(), 'vh-composer-'))
  const previous = process.env['VH_STATE_ROOT']
  process.env['VH_STATE_ROOT'] = stateRoot
  cleanups.push(() => {
    if (previous === undefined) delete process.env['VH_STATE_ROOT']
    else process.env['VH_STATE_ROOT'] = previous
    rmSync(stateRoot, { recursive: true, force: true })
  })
  const fixture = await startTools({ dsh: false })
  cleanups.push(() => fixture.dispose())
  await fixture.context.plugin(VhComposer).await()
  return { fixture, composer: fixture.context.vhComposer } // names:allow
}

describe('approval channel', () => {
  it('holds an agent render in ask mode until the card is approved or skipped, and lists every shot of a plan', async () => {
    const { fixture, composer } = await start()
    const session = brandString<SessionId>('s1')
    composer.setMode('s1', { confirm: 'ask' })
    expect(composer.asksFirst(session)).toBe(true)
    const user: RecordOrigin = { actor: 'user', surface: 'canvas', session: null, turn: null, tool_call: null, intent: 'set up' }
    const info = await fixture.project.createProject('cards', user)
    const picture = await fixture.project.run({
      ...user, project: info.id, operation: 'asset.upload', inputs: [], // names:allow
      params: { path: fixture.writeFile('face.png'), mime: 'image/png' },
    })
    await fixture.project.run({
      ...user, project: info.id, operation: 'entity.character.create', inputs: [], // names:allow
      params: { entity: 'c1', name: 'Lead', refs: picture.outputs }, // names:allow
    })
    const agent = (intent: string, operation: string, params: Record<string, unknown>, inputs: RunRequest['inputs'] = []) =>
      fixture.project.run({
        actor: 'agent', surface: 'chat', session, turn: null, tool_call: `call-${intent}`, intent,
        project: info.id, operation, params, inputs,
      })
    const reference: RunRequest['inputs'] = [{ role: 'reference', ref: { character: 'c1', version: 1 } }]

    const approved = agent('first', 'generate.video', { prompt: 'Picture 1 waves', duration_sec: 1 }, reference) // names:allow
    await vi.waitFor(() => { expect(composer.approvals('s1')).toHaveLength(1) })
    const card = composer.approvals('s1')[0]
    expect(card).toMatchObject({ tool: 'generate.video', callId: 'call-first', prompt: 'Picture 1 waves' }) // names:allow
    expect(card).toMatchObject({ durationSec: 1, estimateGpuSeconds: 4 })
    expect(card?.references[0]).toMatchObject({ role: 'reference', ref: 'c1@1', assetId: picture.outputs[0] })
    const waiting = fixture.project.listHistory({ project: info.id, operation: 'generate.video' })[0]?.record // names:allow
    expect(waiting?.status).toBe('pending')
    expect(composer.answer('s1', 'all', true)).toBe(1)
    expect((await approved).record?.status).toBe('done')

    const skipped = agent('second', 'generate.video', { prompt: 'Picture 1 bows', duration_sec: 1 }, reference) // names:allow
    await vi.waitFor(() => { expect(composer.approvals('s1')).toHaveLength(1) })
    composer.answer('s1', composer.approvals('s1')[0]?.id ?? '', false)
    expect((await skipped).record).toMatchObject({ status: 'cancelled', error: { code: 'skipped' } })

    const shots = [{ prompt: 'one', duration_sec: 1 }, { prompt: 'two', duration_sec: 2 }]
    const plan = await agent('propose', 'plan.create', { references: ['c1@1'], shots })
    const approval = agent('go', 'plan.approve', { plan: plan.record?.id })
    await vi.waitFor(() => { expect(composer.approvals('s1')).toHaveLength(1) })
    expect(composer.approvals('s1')[0]).toMatchObject({
      tool: 'plan.approve', prompt: '1. one (1 s)\n2. two (2 s)', durationSec: 3, estimateGpuSeconds: 12,
    })
    expect(composer.approvals('s1')[0]?.references[0]).toMatchObject({ ref: 'c1@1', assetId: picture.outputs[0] })
    composer.answer('s1', 'all', false)
    expect((await approval).record?.status).toBe('cancelled')

    // A session in direct mode is not held.
    composer.setMode('s1', { confirm: 'direct' })
    const direct = await agent('direct', 'generate.video', { prompt: 'Picture 1 sits', duration_sec: 1 }, reference) // names:allow
    expect(direct.record?.status).toBe('done')
  })
})
