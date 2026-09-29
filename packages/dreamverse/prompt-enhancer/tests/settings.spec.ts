/** Verify in-memory request defaults. */
import fs from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { PromptSettings } from '../src/settings.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PromptSettings', () => {
  it('constructs request defaults without file I/O', () => {
    const fileOperations = (['openSync', 'readFileSync', 'statSync', 'mkdirSync', 'writeFileSync'] as const)
      .map(method => vi.spyOn(fs, method))
    const settings = new PromptSettings(undefined)
    for (const operation of fileOperations) expect(operation).not.toHaveBeenCalled()
    expect(settings.maxCompletionTokens).toBe(3000)
    expect(settings.temperature).toBe(1.0)
    expect(settings.rewriteDefaultTemperature).toBe(1.0)
  })

  it.each([
    [undefined, 'gpt-oss-120b'], ['', 'gpt-oss-120b'], [' \t\n ', 'gpt-oss-120b'], ['  logical-model \n', 'logical-model'],
  ])('selects the configured model %j', (value, expected) => {
    expect(new PromptSettings(value).rewriteDefaultModel).toBe(expected)
  })
})
