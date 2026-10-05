/**
 * The parameter form the canvas generates from a tool's parameter schema: one field per top-level property, typed
 * coercion from the text the user typed, and the values the form starts from (a record's params when editing one).
 *
 * @module @video-harness/ui-kit/form
 */
import type { WireParamSpec } from './types.ts'

/** How a field is edited. */
export type FieldControl = 'text' | 'number' | 'checkbox' | 'select' | 'json'

/** One form field. */
export interface FormField {
  key: string
  control: FieldControl
  required: boolean
  description: string
  options: string[]
  /** The text the input shows. */
  text: string
}

/**
 * The control for a schema node.
 * @param spec - the property schema.
 * @returns the control.
 */
export function controlOf(spec: WireParamSpec): FieldControl {
  if (spec.enum !== undefined && spec.enum.length > 0) return 'select'
  switch (spec.type) {
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'checkbox'
    case 'string':
      return 'text'
    default:
      return 'json'
  }
}

/**
 * The text an input shows for a value.
 * @param control - the field's control.
 * @param value - the current value, or undefined.
 * @returns the text.
 */
export function textOf(control: FieldControl, value: unknown): string {
  if (value === undefined) return ''
  if (control === 'json') return JSON.stringify(value)
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * Build the fields of a schema, seeded with values.
 * @param params - the tool's parameter schema.
 * @param values - the values to show, such as a record's params.
 * @returns the fields in schema order.
 */
export function fieldsOf(params: Record<string, WireParamSpec>, values: Record<string, unknown> = {}): FormField[] {
  return Object.entries(params).map(([key, spec]) => {
    const control = controlOf(spec)
    const value = values[key] ?? spec.default
    return {
      key, control, required: spec.required === true, description: spec.description ?? '',
      options: (spec.enum ?? []).map(String), text: textOf(control, value),
    }
  })
}

/** A field whose text cannot become a value of its type. */
export class FieldParseError extends Error {
  constructor(readonly key: string, message: string) {
    super(message)
    this.name = 'FieldParseError'
  }
}

/**
 * Turn the text of one field into its typed value; empty text is "unset".
 * @param field - the field.
 * @returns the value, or undefined when unset.
 * @throws FieldParseError when the text does not parse.
 */
export function valueOf(field: FormField): unknown {
  const text = field.text.trim()
  if (text.length === 0) return undefined
  switch (field.control) {
    case 'number': {
      const value = Number(text)
      if (!Number.isFinite(value)) throw new FieldParseError(field.key, `${field.key} must be a number.`)
      return value
    }
    case 'checkbox':
      return text === 'true'
    case 'json':
      try {
        return JSON.parse(text)
      } catch {
        throw new FieldParseError(field.key, `${field.key} must be JSON.`)
      }
    default:
      // `text` and `select` keep the text as typed, spaces included.
      return field.text
  }
}

/**
 * Collect the params of a form.
 * @param fields - the fields.
 * @returns the params with unset fields left out.
 * @throws FieldParseError when a required field is unset or a field does not parse.
 */
export function paramsOf(fields: FormField[]): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const field of fields) {
    const value = valueOf(field)
    if (value === undefined) {
      if (field.required) throw new FieldParseError(field.key, `${field.key} is required.`)
      continue
    }
    params[field.key] = value
  }
  return params
}
