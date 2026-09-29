/** Verify JSON text extraction and the Python text semantics shared by the prompt features. */
import { describe, expect, it } from 'vitest'

import {
  dumpsJson, parsePythonJson, pythonFloatRepr, reprPython, splitLines, stripCharacters, stripWhitespace, truncateCodePoints,
} from '../src/utils/python-text.ts'
import { parseJsonObject, requirePromptField } from '../src/utils/schemas.ts'

describe('parseJsonObject', () => {
  it('accepts fenced JSON with prose', () => {
    expect(parseJsonObject('Here is the rewrite:\n```json\n{"segment_prompts":["A","B"]}\n```\nThanks.'))
      .toEqual({ segment_prompts: ['A', 'B'] })
  })

  it('extracts the first embedded object', () => {
    expect(parseJsonObject('Model output:\n{"segment_prompts":["A","B"]}\n(complete)'))
      .toEqual({ segment_prompts: ['A', 'B'] })
  })

  it('skips an undecodable brace and ignores text after the first object', () => {
    expect(parseJsonObject('note {bad} then {"a": "}"} {"b": 1}')).toEqual({ a: '}' })
  })

  it.each([
    ['', 'Assistant response is empty.'],
    ['plain prose', 'No JSON object found in assistant response.'],
    ['["one", "two"]', 'No JSON object found in assistant response.'],
  ])('rejects %j', (content, message) => {
    expect(() => parseJsonObject(content)).toThrow(message)
  })
})

describe('requirePromptField', () => {
  it.each([[{}], [{ prompt: '' }], [{ prompt: ['one'] }]])('rejects %j', (response) => {
    expect(() => requirePromptField(response, 'prompt')).toThrow()
  })

  it('ignores inherited object properties', () => {
    expect(() => requirePromptField({}, 'constructor')).toThrow('Missing constructor string.')
  })
})

describe('Python text semantics', () => {
  it('strips Python whitespace, which differs from JavaScript trim', () => {
    expect(stripWhitespace('\x1c\x85 text \u3000\x1f')).toBe('text')
    expect(stripWhitespace('\ufefftext')).toBe('\ufefftext')
    expect(stripCharacters('"\'"quoted"\'', '"')).toBe('\'"quoted"\'')
  })

  it('splits lines like str.splitlines', () => {
    expect(splitLines('a\r\nb\rc\u2028d\x1ce\n')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\n\n')).toEqual(['a', ''])
  })

  it('truncates by code points', () => {
    expect(truncateCodePoints('🌙🌙🌙', 2)).toBe('🌙🌙...')
    expect(truncateCodePoints('🌙🌙', 2)).toBe('🌙🌙')
  })

  // Expected text recorded from Python `repr(float)`.
  it.each([
    [0.7, '0.7'], [1, '1.0'], [0, '0.0'], [2, '2.0'], [1e-5, '1e-05'], [1.5e-7, '1.5e-07'], [0.1 + 0.2, '0.30000000000000004'],
    [1e16, '1e+16'], [1.5e16, '1.5e+16'], [123456789.125, '123456789.125'], [0.0001, '0.0001'], [0.00012, '0.00012'],
    [1e22, '1e+22'], [-0, '-0.0'], [5e-324, '5e-324'], [-2.5, '-2.5'],
  ])('formats %d like Python repr(float)', (value, text) => {
    expect(pythonFloatRepr(value)).toBe(text)
  })

  it('keeps JSON float literals as Python floats through serialization and repr', () => {
    const decoded = parsePythonJson('{"a": 1.0, "b": 1, "c": 0.00001, "d": [2e3, -0]}')
    expect(dumpsJson(decoded)).toBe('{"a": 1.0, "b": 1, "c": 1e-05, "d": [2000.0, 0]}')
    expect(reprPython(decoded)).toBe('{\'a\': 1.0, \'b\': 1, \'c\': 1e-05, \'d\': [2000.0, 0]}')
  })

  it('serializes JSON with Python separators and repr', () => {
    expect(dumpsJson({ a: [1, 'é', null, { b: true }], c: {}, d: [] })).toBe('{"a": [1, "é", null, {"b": true}], "c": {}, "d": []}')
    expect(reprPython({ a: [1, null, true, 'it\'s', 'x\n\u2028'] })).toBe('{\'a\': [1, None, True, "it\'s", \'x\\n\\u2028\']}')
  })
})
