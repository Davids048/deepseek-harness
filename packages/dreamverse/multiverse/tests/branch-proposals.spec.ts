/**
 * Branch proposals: the story message sent to the harness LLM and the validation of the model's two-branch JSON reply.
 */
import { describe, expect, it } from 'vitest'
import { parseProposals, proposalMessage, proposalRequest, readProposals, requestProposals } from '../src/branch-proposals.ts'
import { DEFAULT_ROUTE, FakeLlm, branchReply } from './support.ts'

describe('parseProposals', () => {
  it('reads two trimmed branches from JSON surrounded by prose or a code fence', () => {
    const reply = '```json\n{"branches": [{"label": " Run ", "direction": " They run. "}, {"label": "Hide", "direction": "They hide."}]}\n```'
    expect(parseProposals(reply)).toEqual([{ label: 'Run', direction: 'They run.' }, { label: 'Hide', direction: 'They hide.' }])
  })

  it.each([
    ['no JSON object', 'I cannot help with that.', 'Branch proposal reply contains no JSON object.'],
    ['invalid JSON', '{"branches": [}', /^Branch proposal reply is not valid JSON: /],
    ['no branches list', '{"options": []}', 'Branch proposal reply must hold two branches.'],
    ['three branches', JSON.stringify({ branches: [1, 2, 3] }), 'Branch proposal reply must hold two branches.'],
    ['an empty direction', JSON.stringify({ branches: [{ label: 'A', direction: ' ' }, { label: 'B', direction: 'b' }] }),
      'Each proposed branch needs a nonempty label and direction.'],
    ['a non-object branch', JSON.stringify({ branches: ['A', { label: 'B', direction: 'b' }] }),
      'Each proposed branch needs a nonempty label and direction.'],
    ['equal labels', JSON.stringify({ branches: [{ label: 'A', direction: 'a' }, { label: 'A', direction: 'b' }] }),
      'The two proposed branches need different labels.'],
  ])('rejects a reply with %s', (_case, reply, message) => {
    expect(() => parseProposals(reply)).toThrow(message)
  })
})

describe('requestProposals', () => {
  const scenes = [{ label: 'Beginning', direction: 'A fox meets an owl.' }, { label: 'Fly away', direction: 'The owl flies off.' }]

  it('asks the default model for two branches after the story so far', async () => {
    const llm = new FakeLlm()
    llm.replies.push(branchReply('Next'))
    const reply = await requestProposals(llm, proposalRequest(DEFAULT_ROUTE, scenes, 640), new AbortController().signal)
    expect(reply).toEqual({ output: branchReply('Next'), reasoning: '', finish: { kind: 'stop' } })
    expect(readProposals(reply).map(draft => draft.label)).toEqual(['Next A', 'Next B'])
    expect(llm.requests[0]).toMatchObject({ ...DEFAULT_ROUTE, maxTokens: 640 })
    expect(proposalMessage(scenes)).toBe([
      'Premise: A fox meets an owl.', '', 'Scenes so far:', '1. Beginning: A fox meets an owl.', '2. Fly away: The owl flies off.',
    ].join('\n'))
  })

  it('reports a failed model call', async () => {
    const llm = new FakeLlm()
    llm.replies.push(new Error('rate limited'))
    const reply = await requestProposals(llm, proposalRequest(DEFAULT_ROUTE, scenes, 640), new AbortController().signal)
    expect(reply.output).toBe('')
    expect(() => readProposals(reply)).toThrow('Branch proposal failed: rate limited')
  })
})
