/**
 * `dvChatReferences` over the real Project service and components: `dv:` mentions of a step's user messages become a
 * `dv-mentions` context message read from the session's working branch, chat images become `asset.import` records of
 * the session's project, and disposal removes both listeners.
 */
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { AssetId, CharacterId, ProjectId, RecordOrigin, RunRequest, SessionId } from '@dv/project'
import { afterEach, describe, expect, it } from 'vitest'
import DvChatReferences from '../src/index.ts'
import { startBase, type BaseFixture } from '../../api/tests/support.ts'

/** An attachment service that accepts every image and reads it back. */
class FakeAttachments {
  readonly saved: SaveImageAttachment[] = []

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    return Promise.resolve({
      attachmentId: brandString<ImageAttachmentRef['attachmentId']>(`att-${this.saved.length}`), mediaType: input.mediaType,
      bytes: input.data.byteLength, width: 192, height: 112, ...input.name === undefined ? {} : { name: input.name },
    })
  }

  /** Read back a saved image by its reference. */
  readImage(ref: ImageAttachmentRef): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }> {
    const saved = this.saved[Number(ref.attachmentId.slice('att-'.length)) - 1]
    if (saved === undefined) return Promise.reject(new Error(`unknown attachment ${ref.attachmentId}`))
    return Promise.resolve({ ref, data: saved.data })
  }
}

/** The mounted base fixture with the chat references plugin, a live session `s1`, and its fake agent. */
interface ChatFixture {
  fixture: BaseFixture
  attachments: FakeAttachments
  plugin: { dispose(): Promise<void> }
  session: { id: string }
  /** Emit one session event for the live session. */
  emit(type: string, data: Record<string, unknown>): void
  /** Call a DSH tool on behalf of the live session's agent. */
  callAs(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>
  /** Run the `agent/pre-step` waterfall for one user message; returns the step's messages. */
  preStep(text: string): Promise<UserMessage[]>
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * Mount the components, a fake attachment service, a fake agent registry that reports session `s1` as live, and the
 * chat references plugin.
 * @returns the fixture.
 */
async function start(): Promise<ChatFixture> {
  const fixture = await startBase({ generation: 'none' })
  cleanups.push(() => fixture.dispose())
  const attachments = new FakeAttachments()
  fixture.context.provide('attachments', attachments)
  const session = { id: 's1' }
  const agent = { id: 's1', session, options: {} }
  fixture.context.provide('agents', { get: (id: string) => (id === 's1' ? agent : undefined), roots: () => [agent] })
  const plugin = fixture.context.plugin(DvChatReferences)
  await plugin.await()
  let calls = 0
  return {
    fixture, attachments, plugin, session,
    emit(type, data) {
      fixture.context.emit('session/event', session as never, { type, data } as never)
    },
    callAs(name, args) {
      calls += 1
      const call = { callId: ToolCallId(`as-${calls}`), name, arguments: args, signal: new AbortController().signal, agent: agent as never }
      return fixture.context.tools.execute(call)
    },
    async preStep(text) {
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      const decision = await agentEvents(fixture.context, agent as never).waterfall('agent/pre-step',
        { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
        () => Promise.resolve({ kind: 'enter' as const, messages: [message] }))
      if (decision.kind !== 'enter') throw new Error('expected step entry')
      return decision.messages
    },
  }
}

/** The text of a message's text blocks. */
function textOf(message: UserMessage | undefined): string {
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
}

describe('mention expansion', () => {
  it('appends a dv-mentions message that reads the character from the chat session\'s open draft, not from main', async () => {
    const { fixture, preStep } = await start()
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

    const messages = await preStep('make @[Lead](dv:character/c1) wave')
    expect(messages).toHaveLength(2)
    expect(messages[1]?.source).toMatchObject({ kind: 'dv-mentions' })
    expect(textOf(messages[1])).toContain('character c1@2 "Lead on draft"')
    expect(textOf(messages[1])).toContain('pass it as input c1@2')
    // A message without mentions enters unchanged.
    expect(await preStep('hello')).toHaveLength(1)
  })

  it('removes the expansion and the image import on disposal', async () => {
    const { fixture, plugin, preStep } = await start()
    await fixture.project.createProject('p', { actor: 'user', surface: 'canvas', session: null, turn: null, tool_call: null, intent: 'set up' })
    expect(await preStep('@[a](dv:asset/none)')).toHaveLength(2)
    await plugin.dispose()
    expect(fixture.context.get('dvChatReferences')).toBeUndefined()
    expect(await preStep('@[a](dv:asset/none)')).toHaveLength(1)
  })
})

describe('chat images', () => {
  it('imports the images a user attached in a bound chat as project assets on the working branch', async () => {
    const { fixture, attachments, emit, callAs } = await start()
    const image = await attachments.saveImage({ data: Buffer.from('chat-image'), mediaType: 'image/png', name: 'cat.png' })
    const message = { source: { kind: 'user' }, content: [{ type: 'image', attachment: image }] }
    // Without a bound project the image stays in the chat only.
    emit('user/message', message)
    const created = await callAs('dv_proj_create', { title: 'dance' })
    if (created.isError) throw new Error(created.error.message)
    const projectId = (created.value as { project_id: ProjectId }).project_id
    emit('user/message', message)
    // A message the user did not type imports nothing.
    emit('user/message', { source: { kind: 'plugin' }, content: [{ type: 'image', attachment: image }] })
    // The session's next tool call waits for the import.
    const timeline = await callAs('dv_timeline_create', { reason: 'order', assets: [] })
    if (timeline.isError) throw new Error(timeline.error.message)
    const imported = fixture.project.listHistory({ project: projectId, actor: 'user', operation: 'asset.import' }).map(entry => entry.record)
    expect(imported).toEqual([expect.objectContaining({
      surface: 'chat', turn: null, session: 's1', params: expect.objectContaining({ name: 'cat.png', mime: 'image/png' }),
    })])
    const asset = imported[0]?.outputs[0] as AssetId
    expect(fixture.assets.read(asset).toString()).toBe('chat-image')
  })
})
