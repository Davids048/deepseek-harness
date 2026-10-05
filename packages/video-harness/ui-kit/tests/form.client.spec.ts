/** The parameter form model: controls per schema type, seeding, coercion, and the errors it raises. */
import { describe, expect, it } from 'vitest'
import { controlOf, FieldParseError, fieldsOf, paramsOf, textOf, valueOf } from '../src/client/form.ts'
import { TOOLS } from './fixture.client.tsx'

const generate = TOOLS[0]

describe('fieldsOf', () => {
  it('maps schema types to controls and seeds from values, then defaults', () => {
    if (generate === undefined) throw new Error('fixture')
    const fields = fieldsOf({ ...generate.params, fps: { type: 'number', default: 24 } }, { prompt: 'hi', loop: true, extra: { a: 1 } })
    expect(fields.map(field => [field.key, field.control, field.text, field.required])).toEqual([
      ['prompt', 'text', 'hi', true],
      ['seed', 'number', '', false],
      ['aspect', 'select', '', false],
      ['loop', 'checkbox', 'true', false],
      ['extra', 'json', '{"a":1}', false],
      ['fps', 'number', '24', false],
    ])
    expect(fields[2]?.options).toEqual(['16:9', '9:16'])
    expect(fields[0]?.description).toBe('What happens.')
    expect(fields[2]?.description).toBe('')
  })

  it('treats a oneOf or untyped property as JSON', () => {
    expect(controlOf({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toBe('json')
    expect(controlOf({})).toBe('json')
    expect(textOf('text', 7)).toBe('7')
    expect(textOf('json', undefined)).toBe('')
  })
})

describe('paramsOf', () => {
  it('coerces each control and leaves unset optional fields out', () => {
    const fields = fieldsOf({
      prompt: { type: 'string', required: true }, seed: { type: 'integer' }, loop: { type: 'boolean' }, aspect: { type: 'string', enum: ['16:9'] }, extra: { type: 'object' }, skip: { type: 'string' },
    }, { prompt: 'go', seed: 3, loop: false, aspect: '16:9', extra: [1] })
    expect(paramsOf(fields)).toEqual({ prompt: 'go', seed: 3, loop: false, aspect: '16:9', extra: [1] })
  })

  it('names the field that is missing or malformed', () => {
    expect(() => paramsOf(fieldsOf({ prompt: { type: 'string', required: true } }))).toThrow(FieldParseError)
    try {
      paramsOf(fieldsOf({ seed: { type: 'integer' } }, { seed: 'x' }))
      throw new Error('unreachable')
    } catch (failure) {
      expect(failure).toBeInstanceOf(FieldParseError)
      expect((failure as FieldParseError).key).toBe('seed')
      expect((failure as FieldParseError).name).toBe('FieldParseError')
    }
    expect(() => valueOf({ key: 'extra', control: 'json', required: false, description: '', options: [], text: '{bad' })).toThrow(/JSON/)
    expect(valueOf({ key: 'x', control: 'text', required: false, description: '', options: [], text: '  ' })).toBeUndefined()
    expect(valueOf({ key: 'x', control: 'checkbox', required: false, description: '', options: [], text: 'false' })).toBe(false)
  })
})
