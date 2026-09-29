/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'

import {
  normalizePromptWindowSnapshot,
} from '../../../src/client/prompts/promptWindowSnapshot.ts'

describe('normalizePromptWindowSnapshot', () => {
  it('trims prompts and removes empty entries while preserving order', () => {
    expect(normalizePromptWindowSnapshot([
      ' first ',
      '',
      '   ',
      'second',
      ' third  ',
    ])).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  it('returns an empty array for non-array input', () => {
    expect(normalizePromptWindowSnapshot(null)).toEqual([])
    expect(normalizePromptWindowSnapshot({})).toEqual([])
  })
})
