/** Verify in-memory request defaults and per-request model and temperature choices. */
import fs from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { PromptSettings } from '../src/settings.ts'
import { PromptValueError } from '../src/utils/errors.ts'
import { testSettings } from './support.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PromptSettings', () => {
  it('constructs request defaults without file I/O', () => {
    const fileOperations = (['openSync', 'readFileSync', 'statSync', 'mkdirSync', 'writeFileSync'] as const)
      .map(method => vi.spyOn(fs, method))
    const settings = new PromptSettings(undefined)
    for (const operation of fileOperations) expect(operation).not.toHaveBeenCalled()
    expect(settings.rewriteModelOptions).toContain(settings.rewriteDefaultModel)
    expect(settings.maxCompletionTokens).toBe(3000)
    expect(settings.temperature).toBe(1.0)
    expect(settings.rewriteDefaultTemperature).toBe(1.0)
  })

  it('returns request defaults with the reference field names', () => {
    const settings = testSettings()
    expect(settings.getConfig()).toEqual({
      rewrite_model: 'gpt-test',
      rewrite_model_options: ['gpt-test', 'gpt-alt'],
      rewrite_temperature: 0.4,
    })
  })

  it('stores an allowed model after stripping it', () => {
    const settings = testSettings()
    expect(settings.setRewriteDefaultModel(' gpt-alt ')).toBe('gpt-alt')
    expect(settings.rewriteDefaultModel).toBe('gpt-alt')
    expect(settings.getConfig().rewrite_model_options).toEqual(['gpt-test', 'gpt-alt'])
  })

  it.each(['', '  ', 'unsupported', null])('rejects model %j and keeps the default', (value) => {
    const settings = testSettings()
    expect(() => settings.setRewriteDefaultModel(value)).toThrow(PromptValueError)
    expect(() => settings.setRewriteDefaultModel(value)).toThrow(/rewrite_model/)
    expect(settings.rewriteDefaultModel).toBe('gpt-test')
  })

  it.each([
    ['unsupported', 'Unsupported rewrite_model \'unsupported\'. Expected one of: gpt-test, gpt-alt.'],
    ['it\'s', 'Unsupported rewrite_model "it\'s". Expected one of: gpt-test, gpt-alt.'],
    ['a"b\'c', 'Unsupported rewrite_model \'a"b\\\'c\'. Expected one of: gpt-test, gpt-alt.'],
    ['', 'rewrite_model cannot be empty.'],
  ])('formats the reference validation message for %j', (value, message) => {
    expect(() => testSettings().validateRewriteModel(value)).toThrow(new PromptValueError(message))
  })

  it.each([[null, 'gpt-test'], ['unknown', 'gpt-test'], [' gpt-alt ', 'gpt-alt'], [7, 'gpt-test']])(
    'resolves model %j to %j', (value, expected) => {
      expect(testSettings().resolveRewriteModel(value)).toBe(expected)
    })

  it('stores a numeric temperature', () => {
    const settings = testSettings()
    expect(settings.setRewriteDefaultTemperature(1.3)).toBe(1.3)
    expect(settings.getConfig().rewrite_temperature).toBe(1.3)
    expect(settings.setRewriteDefaultTemperature(true)).toBe(1)
  })

  it.each(['1.3', null])('rejects non-numeric temperature %j', (value) => {
    expect(() => testSettings().setRewriteDefaultTemperature(value)).toThrow('rewrite_temperature must be numeric')
  })

  // Expected values recorded from the Python reference `resolve_rewrite_temperature`.
  it.each([
    [null, 0.4], ['invalid', 0.4], [-1, 0.0], [3, 2.0], [1.3, 1.3], ['1.3', 1.3], [' 1_0 ', 2.0], ['nan', 0.0],
    ['-inf', 0.0], [true, 1.0], [[1], 0.4], ['0x10', 0.4], ['', 0.4], ['1e-1', 0.1], ['5.', 2.0], ['.5', 0.5],
    ['1__0', 0.4], ['\x1c2', 0.4], ['2\x85', 2.0], ['\u20002', 2.0], ['Infinity', 2.0], ['\ufeff1', 0.4],
  ])('resolves temperature %j to %j', (value, expected) => {
    expect(testSettings().resolveRewriteTemperature(value)).toBe(expected)
  })

  it.each([
    [undefined, 'gpt-oss-120b'], ['', 'gpt-oss-120b'], [' \t\n ', 'gpt-oss-120b'], ['  logical-model \n', 'logical-model'],
  ])('selects the configured model %j', (value, expected) => {
    const configured = new PromptSettings(value)
    expect(configured.getConfig().rewrite_model).toBe(expected)
    expect(configured.getConfig().rewrite_model_options).toEqual([expected])
    expect(configured.resolveRewriteModel(null)).toBe(expected)
  })
})
