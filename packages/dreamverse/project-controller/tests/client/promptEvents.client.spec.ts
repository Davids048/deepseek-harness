/** @vitest-environment jsdom */
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'

import type { PromptId } from '../../src/client/ids.ts'
import {
  prependPromptEvent,
  type PromptEvent,
  updatePromptEvent,
} from '../../src/client/promptEvents.ts'

/** The prompt ID that a spec names. */
function id(promptId: string): PromptId {
  return brandString<PromptId>(promptId)
}

describe('updatePromptEvent', () => {
  it('updates only the matching prompt event', () => {
    const events: PromptEvent[] = [
      { promptId: id('a'), status: 'submitted' },
      { promptId: id('b'), status: 'submitted' },
    ]

    const updated = updatePromptEvent(events, id('b'), {
      status: 'ready',
      source: 'enhanced',
    })

    expect(updated).toEqual([
      { promptId: id('a'), status: 'submitted' },
      { promptId: id('b'), status: 'ready', source: 'enhanced' },
    ])
  })
})

describe('prependPromptEvent', () => {
  it('prepends new event', () => {
    const events: PromptEvent[] = [{ promptId: id('a'), status: 'submitted' }]
    const next = prependPromptEvent(events, {
      promptId: id('b'),
      status: 'submitted',
    })

    expect(next[0]?.promptId).toBe('b')
    expect(next[1]?.promptId).toBe('a')
  })

  it('caps list length to 24 entries', () => {
    const events: PromptEvent[] = Array.from({ length: 24 }, (_, i: number) => ({
      promptId: id(`p-${i}`),
      status: 'submitted',
    }))

    const next = prependPromptEvent(events, {
      promptId: id('new'),
      status: 'submitted',
    })

    expect(next).toHaveLength(24)
    expect(next[0]?.promptId).toBe('new')
    expect(next.some(item => item.promptId === 'p-23')).toBe(false)
  })
})
